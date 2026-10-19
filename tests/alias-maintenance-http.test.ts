import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { useDb, schema } from '../db/client'
import { reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../scripts/lib/isolated-local-services.mjs'

const dir = mkdtempSync(join(tmpdir(), 'alias-maintenance-99-'))
const path = join(dir, 'roster.db')
const db = useDb({ dbPath: path })
const ent = db.insert(schema.enterprise).values({ name: '宁波别名维护企业', nameNorm: '宁波别名维护企业', usccNorm: '91330211255994457P' }).returning().get()
const query = db.insert(schema.platformQuery).values({ interface: 'business_list', queryKey: ent.usccNorm!, rdjb: '2', queriedAt: '2026-10-19T00:00:00Z', status: 'success', rawResponse: 'SECRET_RAW_QUERY' }).returning().get()
const rel = db.insert(schema.platformRelation).values({ queryId: query.id, sequenceNo: 1, enterpriseId: ent.id, usccRaw: ent.usccNorm, nameRaw: '宁波别名维护旧名', rawFields: { secret: 'SECRET_RAW_RELATION' } }).returning().get()
const alias = db.insert(schema.enterpriseAlias).values({ enterpriseId: ent.id, name: '宁波别名维护旧名', nameNorm: '宁波别名维护旧名', sourceKind: 'platform_business', sourceRefId: rel.id }).returning().get()
let url: string
let stop: () => Promise<void>
beforeAll(async () => {
  const port = await reserveLoopbackPort()
  const cwd = resolve(import.meta.dirname, '..')
  const child = spawn(process.execPath, [join(cwd, 'node_modules/nuxt/bin/nuxt.mjs'), 'dev', '--host', '127.0.0.1', '--port', String(port)], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NUXT_BUILD_DIR: join(dir, 'build'), NUXT_DB_PATH: path, NUXT_FILES_DIR: join(dir, 'files'), NUXT_INCOMING_DIR: join(dir, 'incoming'), NUXT_API_TOKEN: 'test-alias-token', NUXT_MCP_TOKEN: 'test-alias-token' } })
  let logs = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { logs = (logs + data).slice(-8000) })
  url = `http://127.0.0.1:${port}`
  stop = () => stopOwnedChild(child)
  try { await waitForHttp(`${url}/api/roster/enterprises?pageSize=1`, { timeoutMs: 60000, child }) }
  catch (error) { await stop(); throw new Error(`${error}\n${logs}`) }
}, 90000)
afterAll(async () => { await stop?.(); db.$client.close(); rmSync(dir, { recursive: true, force: true }) })
const base = () => `/api/roster/enterprises/${ent.id}/aliases`
async function read(route: string) { const res = await fetch(url + route); expect(res.status).toBe(200); if (route.includes('/aliases')) expect(res.headers.get('cache-control')).toContain('no-store'); return res.json() }
async function mutate(id: number, body: Record<string, unknown>) { return fetch(`${url}${base()}/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: 'Bearer test-alias-token' }, body: JSON.stringify(body) }) }
const decision = (action: string, expectedVersion: number, idempotencyKey: string, extra = {}) => ({ action, expectedVersion, idempotencyKey, actor: 'test-agent', basis: '人工核实平台原行', ...extra })

it('lists pending aliases by stable enterprise and alias IDs then confirms with version and exact bounded history', async () => {
  const pending = await read(`${base()}?status=pending&pageSize=1`)
  expect(pending).toMatchObject({ total: 1, rows: [{ id: alias.id, enterpriseId: ent.id, version: 1, originalName: alias.name, verificationStatus: 'pending', sourceRefId: rel.id }] })
  const confirmed = await mutate(alias.id, decision('confirm', 1, 'confirm-1'))
  expect(confirmed.status).toBe(200)
  expect(await confirmed.json()).toMatchObject({ alias: { id: alias.id, version: 2, verificationStatus: 'confirmed', originalName: alias.name }, replayed: false })
  expect(await read(`${base()}/${alias.id}`)).toMatchObject({ id: alias.id, version: 2 })
  expect(await read(`${base()}/${alias.id}/history?pageSize=1`)).toMatchObject({ total: 1, rows: [{ action: 'confirm', actor: 'test-agent', basis: '人工核实平台原行', before: { verificationStatus: 'pending' }, after: { version: 2 } }] })
})

it('corrects and withdraws without changing original facts then explicitly restores the same stable alias', async () => {
  const row = db.insert(schema.enterpriseAlias).values({ enterpriseId: ent.id, name: '别名生命周期错误写法', nameNorm: '别名生命周期错误写法', sourceKind: 'manual', verificationStatus: 'confirmed' }).returning().get()
  const corrected = await mutate(row.id, decision('correct', 1, 'correct-1', { changes: { name: '别名生命周期有效写法', note: '更正笔误' } }))
  expect(corrected.status).toBe(200)
  expect(await corrected.json()).toMatchObject({ alias: { id: row.id, version: 2, name: '别名生命周期有效写法', originalName: '别名生命周期错误写法', originalSourceKind: 'manual', verificationStatus: 'confirmed' } })
  const search = () => read(`/api/roster/enterprises?q=${encodeURIComponent('别名生命周期有效写法')}`)
  expect((await search()).rows.map((r: { enterpriseId: number }) => r.enterpriseId)).toContain(ent.id)
  expect((await mutate(row.id, decision('withdraw', 2, 'withdraw-1'))).status).toBe(200)
  expect((await search()).rows).toEqual([])
  expect(await read(`${base()}?status=withdrawn`)).toMatchObject({ total: 1, rows: [{ id: row.id, version: 3, verificationStatus: 'withdrawn' }] })
  const restored = await mutate(row.id, decision('confirm', 3, 'restore-1'))
  expect(restored.status).toBe(200)
  expect(await restored.json()).toMatchObject({ alias: { id: row.id, version: 4, verificationStatus: 'confirmed' } })
  expect((await search()).rows.map((r: { enterpriseId: number }) => r.enterpriseId)).toContain(ent.id)
  const history = await read(`${base()}/${row.id}/history?page=2&pageSize=1`)
  expect(history).toMatchObject({ total: 3, rows: [{ action: 'withdraw', before: { name: '别名生命周期有效写法' }, after: { verificationStatus: 'withdrawn' } }] })
  const detail = await read(`/api/roster/enterprises/${ent.id}`)
  expect(detail.platform.relations).toMatchObject([{ id: rel.id, nameRaw: alias.name }])
  const raw = await read(`/api/platform/queries/${query.id}/evidence?field=rawResponse`)
  expect(Buffer.from(raw.data, 'base64').toString()).toBe('SECRET_RAW_QUERY')
})

async function rpc(method: string, params: Record<string, unknown>, token = true) {
  const res = await fetch(`${url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: 'Bearer test-alias-token' } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 99, method, params }) })
  const raw = await res.text()
  const payload = raw.startsWith('event:') ? raw.split('\n').find(line => line.startsWith('data: '))!.slice(6) : raw
  return { status: res.status, body: JSON.parse(payload) }
}
async function call(name: string, args: Record<string, unknown>) {
  const result = await rpc('tools/call', { name, arguments: args })
  expect(result.status).toBe(200)
  expect(result.body.result.isError).not.toBe(true)
  return JSON.parse(result.body.result.content[0].text)
}
it('exposes authenticated MCP lifecycle tools and equivalent bounded REST reads with public OpenAPI', async () => {
  const discovery = await rpc('tools/list', {})
  expect(discovery.body.result.tools.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(['list_enterprise_aliases', 'get_enterprise_alias', 'get_enterprise_alias_history', 'maintain_enterprise_alias']))
  const publicTools = await rpc('tools/list', {}, false)
  expect(publicTools.body.result.tools.map((t: { name: string }) => t.name)).not.toContain('maintain_enterprise_alias')
  expect((await rpc('tools/call', { name: 'maintain_enterprise_alias', arguments: {} }, false)).status).toBe(401)
  const row = db.insert(schema.enterpriseAlias).values({ enterpriseId: ent.id, name: 'MCP生命周期原名', nameNorm: 'MCP生命周期原名', sourceKind: 'manual' }).returning().get()
  const args = { enterpriseId: ent.id, aliasId: row.id }
  const confirmed = await call('maintain_enterprise_alias', { ...args, ...decision('confirm', 1, 'mcp-confirm') })
  expect(confirmed.alias).toMatchObject({ version: 2, verificationStatus: 'confirmed' })
  expect(await call('get_enterprise_alias', args)).toEqual(await read(`${base()}/${row.id}`))
  expect(await call('list_enterprise_aliases', { enterpriseId: ent.id, status: 'confirmed', pageSize: 1 })).toEqual(await read(`${base()}?status=confirmed&pageSize=1`))
  await call('maintain_enterprise_alias', { ...args, ...decision('correct', 2, 'mcp-correct', { changes: { name: 'MCP生命周期更正名' } }) })
  await call('maintain_enterprise_alias', { ...args, ...decision('withdraw', 3, 'mcp-withdraw') })
  expect(await call('get_enterprise_alias_history', { ...args, page: 2, pageSize: 1 })).toEqual(await read(`${base()}/${row.id}/history?page=2&pageSize=1`))
  const invalid = await rpc('tools/call', { name: 'maintain_enterprise_alias', arguments: { ...args, ...decision('confirm', 1, 'mcp-stale') } })
  expect(invalid.body.result.isError).toBe(true)
  expect((await mutate(row.id, decision('confirm', 1, 'rest-stale'))).status).toBe(409)
  const openapi = await read('/_openapi.json')
  expect(openapi.paths['/api/roster/enterprises/{id}/aliases/{aliasId}'].patch).toBeTruthy()
  expect(openapi.paths['/api/roster/enterprises/{id}/aliases/{aliasId}/history'].get).toBeTruthy()
})

it('rejects invalid evidence and subject conflicts without changing version or history', async () => {
  const row = db.insert(schema.enterpriseAlias).values({ enterpriseId: ent.id, name: '证据边界待核名', nameNorm: '证据边界待核名', sourceKind: 'platform_business', sourceRefId: 999999 }).returning().get()
  const invalid = await mutate(row.id, decision('confirm', 1, 'missing-evidence'))
  expect(invalid.status).toBe(400)
  expect((await invalid.json()).data.code).toBe('alias_source_evidence_required')
  const other = db.insert(schema.enterprise).values({ name: '其他企业使用的名称', nameNorm: '其他企业使用的名称', usccNorm: '91330206793007818K' }).returning().get()
  const wrongRel = db.insert(schema.platformRelation).values({ queryId: query.id, sequenceNo: 2, enterpriseId: other.id, usccRaw: ent.usccNorm, nameRaw: row.name }).returning().get()
  expect((await mutate(row.id, decision('correct', 1, 'wrong-owner', { changes: { sourceRefId: wrongRel.id } }))).status).toBe(400)
  expect((await mutate(row.id, decision('correct', 1, 'wrong-qymc', { changes: { sourceRefId: rel.id } }))).status).toBe(400)
  expect((await mutate(row.id, decision('correct', 1, 'wrong-interface', { changes: { sourceRefId: rel.id, sourceKind: 'platform_apply', name: alias.name } }))).status).toBe(400)
  expect(await read(`${base()}/${row.id}`)).toMatchObject({ version: 1, name: row.name, sourceRefId: 999999 })
  expect(await read(`${base()}/${row.id}/history`)).toMatchObject({ total: 0, rows: [] })
  const manual = db.insert(schema.enterpriseAlias).values({ enterpriseId: ent.id, name: other.name, nameNorm: other.nameNorm, sourceKind: 'manual' }).returning().get()
  expect((await mutate(manual.id, decision('confirm', 1, 'subject-conflict'))).status).toBe(409)
  const wrongEnterprise = await fetch(`${url}/api/roster/enterprises/${other.id}/aliases/${row.id}`)
  expect(wrongEnterprise.status).toBe(404)
  for (const body of [decision('confirm', 1, 'extra', { enterpriseId: other.id }), decision('confirm', 1, 'blank', { basis: ' ' }), decision('correct', 1, 'empty', { changes: {} }), decision('correct', 1, 'protected', { changes: { enterpriseId: other.id } }), decision('correct', 1, 'null-name', { changes: { name: null } }), decision('confirm', 1, 'no-version', { expectedVersion: undefined }), decision('confirm', 1, 'extra-changes', { changes: { note: 'x' } })]) {
    expect((await mutate(manual.id, body)).status).toBe(400)
  }
  for (const suffix of ['?pageSize=51', '?page=0', '?status=unknown', '?includeRaw=true']) expect((await fetch(url + base() + suffix)).status).toBe(400)
  expect((await fetch(`${url}${base()}/${row.id}/history?pageSize=51`)).status).toBe(400)
  expect((await fetch(`${url}${base()}/999999`)).status).toBe(404)
})

it('serializes competing versions and replays the exact decision while rolling back audit failures', async () => {
  const row = db.insert(schema.enterpriseAlias).values({ enterpriseId: ent.id, name: '并发重放待核名', nameNorm: '并发重放待核名', sourceKind: 'manual' }).returning().get()
  const requests = [decision('confirm', 1, 'race-a'), decision('confirm', 1, 'race-b')]
  const responses = await Promise.all(requests.map(body => mutate(row.id, body)))
  expect(responses.map(r => r.status).sort()).toEqual([200, 409])
  const winnerIndex = responses.findIndex(r => r.status === 200)
  const winner = await responses[winnerIndex]!.json()
  const winnerRequest = requests[winnerIndex]!
  const replay = await mutate(row.id, winnerRequest)
  expect(await replay.json()).toEqual({ ...winner, replayed: true })
  const conflict = await mutate(row.id, { ...winnerRequest, basis: '另一份依据' })
  expect(conflict.status).toBe(409)
  expect((await conflict.json()).data.code).toBe('alias_idempotency_conflict')
  await mutate(row.id, decision('withdraw', 2, 'race-withdraw'))
  expect(await (await mutate(row.id, winnerRequest)).json()).toEqual({ ...winner, replayed: true })
  expect(await read(`${base()}/${row.id}`)).toMatchObject({ version: 3, verificationStatus: 'withdrawn' })
  expect(await read(`${base()}/${row.id}/history`)).toMatchObject({ total: 2 })
  const collision = db.insert(schema.enterpriseAlias).values({ enterpriseId: ent.id, name: '已占用自然键', nameNorm: '已占用自然键', sourceKind: 'manual' }).returning().get()
  expect((await mutate(row.id, decision('correct', 3, 'duplicate-key', { changes: { name: collision.name } }))).status).toBe(409)
  expect(await read(`${base()}/${row.id}/history`)).toMatchObject({ total: 2 })
  const rollback = db.insert(schema.enterpriseAlias).values({ enterpriseId: ent.id, name: '回滚验证名', nameNorm: '回滚验证名', sourceKind: 'manual' }).returning().get()
  db.$client.exec("CREATE TRIGGER alias_test_audit_failure BEFORE INSERT ON enterprise_alias_audit WHEN NEW.actor='fail-audit' BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END")
  try {
    expect((await mutate(rollback.id, decision('confirm', 1, 'rollback', { actor: 'fail-audit' }))).status).toBe(500)
    expect(await read(`${base()}/${rollback.id}`)).toMatchObject({ version: 1, verificationStatus: 'pending' })
    expect(await read(`${base()}/${rollback.id}/history`)).toMatchObject({ total: 0, rows: [] })
  } finally { db.$client.exec('DROP TRIGGER alias_test_audit_failure') }
  expect((await mutate(rollback.id, decision('confirm', 1, 'rollback', { actor: 'fail-audit' }))).status).toBe(200)
})

it('maintains imported aliases explicitly and same-key reimport preserves withdrawal until versioned restore', async () => {
  const item = { enterpriseName: ent.name, uscc: ent.usccNorm, name: '公开导入维护旧名', sourceKind: 'manual', sourceRefId: 0, verificationStatus: 'pending' }
  const imported = async (key: string) => {
    const response = await fetch(`${url}/api/roster/import/commit`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test-alias-token' }, body: JSON.stringify({ idempotencyKey: key, sourceKind: 'alias_evidence', sourceIdentity: 'synthetic/99', payload: { aliases: [item] } }) })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'committed' })
  }
  await imported('import-99-a')
  const created = (await read(`${base()}?status=pending&pageSize=50`)).rows.find((r: { name: string }) => r.name === item.name)
  expect(created).toMatchObject({ version: 1, originalName: item.name })
  expect((await mutate(created.id, decision('confirm', 1, 'import-confirm'))).status).toBe(200)
  expect((await mutate(created.id, decision('withdraw', 2, 'import-withdraw'))).status).toBe(200)
  await imported('import-99-b')
  expect(await read(`${base()}/${created.id}`)).toMatchObject({ version: 3, verificationStatus: 'withdrawn' })
  expect((await mutate(created.id, decision('confirm', 3, 'import-restore'))).status).toBe(200)
  expect(await read(`${base()}/${created.id}/history`)).toMatchObject({ total: 3, rows: [{ action: 'confirm' }, { action: 'withdraw' }, { action: 'confirm' }] })
})

it('withdrawal excludes aliases from the public identity matching plan while retaining platform originals', async () => {
  const name = '宁波匹配撤回机床有限公司'
  const active = db.insert(schema.enterpriseAlias).values({ enterpriseId: ent.id, name, nameNorm: name, sourceKind: 'manual', verificationStatus: 'confirmed' }).returning().get()
  const target = db.insert(schema.enterprise).values({ name, nameNorm: name }).returning().get()
  const record = db.insert(schema.record).values({ enterpriseId: target.id, titleCode: 'specialized_sme', source: 'jxj', nameRaw: name }).returning().get()
  db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2026 }).run()
  const plan = async () => {
    const response = await fetch(`${url}/api/roster/uscc-research`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enterpriseIds: [target.id] }) })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.plan.outcomes).toHaveLength(1)
    return body.plan.outcomes[0]
  }
  const before = await plan()
  expect(before).toMatchObject({ enterpriseId: target.id, outcome: 'manual', candidates: [{ enterpriseId: ent.id, matchedBy: 'alias' }] })
  expect((await mutate(active.id, decision('withdraw', 1, 'matching-withdraw'))).status).toBe(200)
  expect(await plan()).toMatchObject({ enterpriseId: target.id, outcome: 'not_found', candidates: [] })
  expect(await read(`${base()}/${active.id}/history`)).toMatchObject({ total: 1, rows: [{ before: { name }, after: { verificationStatus: 'withdrawn' } }] })
})

it('corrects source references using import identity validation and preserves the original name and source', async () => {
  const source = db.insert(schema.platformRelation).values({ queryId: query.id, sequenceNo: 10, enterpriseId: ent.id, usccRaw: ent.usccNorm, nameRaw: '平台来源维护正确名' }).returning().get()
  const row = db.insert(schema.enterpriseAlias).values({ enterpriseId: ent.id, name: '平台来源维护错名', nameNorm: '平台来源维护错名', sourceKind: 'platform_apply', sourceRefId: 987654 }).returning().get()
  const changed = await mutate(row.id, decision('correct', 1, 'source-correct', { changes: { name: source.nameRaw, sourceKind: 'platform_business', sourceRefId: source.id, validFrom: '2020-01-01', note: '来源更正' } }))
  expect(changed.status).toBe(200)
  expect(await changed.json()).toMatchObject({ alias: { version: 2, verificationStatus: 'pending', originalName: row.name, originalSourceKind: 'platform_apply', originalSourceRefId: 987654, sourceRefId: source.id } })
  expect((await mutate(row.id, decision('confirm', 2, 'source-confirm'))).status).toBe(200)
  expect((await mutate(row.id, decision('correct', 3, 'source-null', { changes: { validFrom: null, note: null } }))).status).toBe(200)
  expect(await read(`${base()}/${row.id}`)).toMatchObject({ version: 4, validFrom: null, note: null, sourceRefId: source.id, originalSourceRefId: 987654 })
  const raw = await read(`/api/platform/queries/${query.id}/evidence?field=relation&relationId=${source.id}`)
  expect(JSON.parse(Buffer.from(raw.data, 'base64').toString())).toMatchObject({ id: source.id, nameRaw: source.nameRaw, enterpriseId: ent.id })
})

it('keeps fixed pages and exact history unchanged as unrelated aliases, audit rows and raw archives grow', async () => {
  const fixed = await read(`${base()}?page=2&pageSize=2`)
  const fixedHistory = await read(`${base()}/${alias.id}/history?pageSize=1`)
  const other = db.insert(schema.enterprise).values({ name: '分页缩放无关企业', nameNorm: '分页缩放无关企业' }).returning().get()
  const samples: Array<{ scale: number; aliases: number; rawBytes: number; milliseconds: number[]; listBytes: number; historyBytes: number }> = []
  let seeded = 0
  for (const scale of [1, 2, 5]) {
    db.transaction(tx => {
      while (seeded < 100 * scale) {
        seeded++
        const row = tx.insert(schema.enterpriseAlias).values({ enterpriseId: other.id, name: `无关别名${seeded}`, nameNorm: `无关别名${seeded}`, sourceKind: 'manual' }).returning().get()
        tx.insert(schema.enterpriseAliasAudit).values({ aliasId: row.id, enterpriseId: other.id, action: 'confirm', actor: 'synthetic', basis: 'synthetic', idempotencyKey: `noise-${seeded}`, requestHash: 'noise', before: { note: 'irrelevant'.repeat(500) }, after: { note: 'irrelevant'.repeat(500) }, createdAt: '2026-10-19T00:00:00Z' }).run()
        tx.insert(schema.platformQuery).values({ interface: 'business_list', queryKey: `noise-${seeded}`, rdjb: '1', queriedAt: '2026-10-19T00:00:00Z', rawResponse: 'SECRET_UNRELATED_RAW'.repeat(500) }).run()
      }
    })
    const durations: number[] = []
    let listBytes = 0
    let historyBytes = 0
    for (let sample = 0; sample < 5; sample++) {
      const start = performance.now()
      const response = await fetch(url + `${base()}?page=2&pageSize=2`)
      expect(response.status).toBe(200)
      const raw = await response.text()
      listBytes = Buffer.byteLength(raw)
      const history = await read(`${base()}/${alias.id}/history?pageSize=1`)
      historyBytes = Buffer.byteLength(JSON.stringify(history))
      durations.push(performance.now() - start)
      expect(JSON.parse(raw)).toEqual(fixed)
      expect(history).toEqual(fixedHistory)
      expect(raw).not.toContain('SECRET_UNRELATED_RAW')
      expect(listBytes + historyBytes).toBeLessThan(256 * 1024)
    }
    samples.push({ scale, aliases: seeded, rawBytes: seeded * Buffer.byteLength('SECRET_UNRELATED_RAW'.repeat(500)), milliseconds: durations, listBytes, historyBytes })
  }
  if (process.env.ALIAS99_MEASUREMENTS) writeFileSync(process.env.ALIAS99_MEASUREMENTS, JSON.stringify(samples, null, 2))
  console.info('alias99 bounded synthetic samples', JSON.stringify(samples))
})

async function mergeRequest(fromId: number, key: string, extraPayload = {}) {
  const request = { idempotencyKey: key, sourceKind: 'alias_evidence', sourceIdentity: 'synthetic/99-merge', payload: { ...extraPayload, merges: [{ fromEnterpriseId: fromId, intoUscc: ent.usccNorm, sourceKind: 'manual' }] } }
  const send = async (action: string) => {
    const response = await fetch(`${url}/api/roster/import/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test-alias-token' }, body: JSON.stringify(request) })
    expect(response.status).toBe(200)
    return response.json()
  }
  return { preflight: () => send('preflight'), commit: () => send('commit') }
}
function sourceEnterprise(name: string) { return db.insert(schema.enterprise).values({ name, nameNorm: name }).returning().get() }
async function sourceDecision(owner: number, id: number, body: Record<string, unknown>) {
  const response = await fetch(`${url}/api/roster/enterprises/${owner}/aliases/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: 'Bearer test-alias-token' }, body: JSON.stringify(body) })
  expect(response.status).toBe(200)
  return response.json()
}
it('moves audited aliases without a clash and folds clash histories without losing immutable decision provenance', async () => {
  const source = sourceEnterprise('归并审计非冲突企业')
  const moved = db.insert(schema.enterpriseAlias).values({ enterpriseId: source.id, name: '审计别名非冲突', nameNorm: '审计别名非冲突', sourceKind: 'manual' }).returning().get()
  const originalDecision = decision('correct', 1, 'move-audit', { changes: { note: '原企业审计' } })
  const originalResult = await sourceDecision(source.id, moved.id, originalDecision)
  const oldHistory = await read(`/api/roster/enterprises/${source.id}/aliases/${moved.id}/history`)
  const merge = await mergeRequest(source.id, 'audited-nonclash-merge')
  const result = await merge.commit()
  expect(result.status).toBe('committed')
  expect(await read(`${base()}/${moved.id}`)).toMatchObject({ id: moved.id, enterpriseId: ent.id, version: 2 })
  expect(await read(`${base()}/${moved.id}/history`)).toEqual(oldHistory)
  expect((await fetch(`${url}/api/roster/enterprises/${source.id}/aliases/${moved.id}/history`)).status).toBe(404)
  expect(await (await mutate(moved.id, originalDecision)).json()).toEqual({ ...originalResult, replayed: true })
  expect(await merge.commit()).toEqual(result)

  const foldedSource = sourceEnterprise('归并审计冲突企业')
  const name = '审计别名同键折叠'
  const survivor = db.insert(schema.enterpriseAlias).values({ enterpriseId: ent.id, name, nameNorm: name, sourceKind: 'manual' }).returning().get()
  const folded = db.insert(schema.enterpriseAlias).values({ enterpriseId: foldedSource.id, name, nameNorm: name, sourceKind: 'manual' }).returning().get()
  await sourceDecision(ent.id, survivor.id, decision('correct', 1, 'survivor-history', { changes: { note: '保留方审计' } }))
  const foldedDecision = decision('correct', 1, 'folded-history', { changes: { note: '被并方审计' } })
  const foldedResult = await sourceDecision(foldedSource.id, folded.id, foldedDecision)
  const priorSource = await read(`/api/roster/enterprises/${foldedSource.id}/aliases/${folded.id}/history`)
  const priorTarget = await read(`${base()}/${survivor.id}/history`)
  const foldMerge = await mergeRequest(foldedSource.id, 'audited-clash-merge')
  const foldResult = await foldMerge.commit()
  expect(foldResult.status).toBe('committed')
  const history = await read(`${base()}/${survivor.id}/history`)
  expect(history.total).toBe(2)
  expect(history.rows).toEqual([...priorTarget.rows, ...priorSource.rows.map((r: Record<string, unknown>) => ({ ...r, aliasId: survivor.id }))].sort((a, b) => a.id - b.id))
  expect(history.rows.find((r: { id: number }) => r.id === priorSource.rows[0].id)).toMatchObject({ enterpriseId: foldedSource.id, before: { id: folded.id, enterpriseId: foldedSource.id }, after: { id: folded.id, enterpriseId: foldedSource.id } })
  expect((await fetch(`${url}${base()}/${folded.id}/history`)).status).toBe(404)
  expect(await (await mutate(survivor.id, foldedDecision)).json()).toEqual({ ...foldedResult, replayed: true })
  expect(await foldMerge.commit()).toEqual(foldResult)
  expect(await read(`${base()}/${survivor.id}/history`)).toEqual(history)
})

it('rejects alias merge key collisions even with equal hashes and rolls back unrelated batch writes', async () => {
  const source = sourceEnterprise('归并同审计键冲突企业')
  const name = '同审计键历史不可删除'
  const survivor = db.insert(schema.enterpriseAlias).values({ enterpriseId: ent.id, name, nameNorm: name, sourceKind: 'manual' }).returning().get()
  const folded = db.insert(schema.enterpriseAlias).values({ enterpriseId: source.id, name, nameNorm: name, sourceKind: 'manual' }).returning().get()
  const sameRequest = decision('correct', 1, 'identical-key-and-hash', { changes: { note: '相同请求仍为两条历史' } })
  await sourceDecision(ent.id, survivor.id, sameRequest)
  await sourceDecision(source.id, folded.id, sameRequest)
  const beforeSource = await read(`/api/roster/enterprises/${source.id}/aliases/${folded.id}/history`)
  const beforeSurvivor = await read(`${base()}/${survivor.id}/history`)
  expect(beforeSource.rows[0].requestHash).toBe(beforeSurvivor.rows[0].requestHash)
  const merge = await mergeRequest(source.id, 'merge-key-conflict', { aliases: [{ uscc: ent.usccNorm, name: '归并冲突批次不应创建别名', sourceKind: 'manual' }] })
  const preflight = await merge.preflight()
  expect(preflight.preflight.conflicts.find((r: { kind: string }) => r.kind === 'merge').error.code).toBe('merge_alias_audit_key_conflict')
  const rejected = await merge.commit()
  expect(rejected.status).toBe('failed')
  expect(rejected.items.find((r: { kind: string }) => r.kind === 'merge').error.code).toBe('merge_alias_audit_key_conflict')
  expect(await read(`/api/roster/enterprises/${source.id}/aliases/${folded.id}/history`)).toEqual(beforeSource)
  expect(await read(`${base()}/${survivor.id}/history`)).toEqual(beforeSurvivor)
  expect((await read(`${base()}?status=all&pageSize=50`)).rows.some((r: { name: string }) => r.name === '归并冲突批次不应创建别名')).toBe(false)
})

it('rejects withdrawn versus confirmed merge clashes and recovers the same failed batch only after explicit decisions', async () => {
  const source = sourceEnterprise('归并撤回确认状态冲突企业')
  const name = '不可静默复活的旧名'
  const survivor = db.insert(schema.enterpriseAlias).values({ enterpriseId: ent.id, name, nameNorm: name, sourceKind: 'manual', verificationStatus: 'confirmed' }).returning().get()
  const folded = db.insert(schema.enterpriseAlias).values({ enterpriseId: source.id, name, nameNorm: name, sourceKind: 'manual', verificationStatus: 'confirmed' }).returning().get()
  await sourceDecision(source.id, folded.id, decision('withdraw', 1, 'source-explicit-withdraw'))
  const merge = await mergeRequest(source.id, 'merge-state-conflict')
  expect((await merge.preflight()).preflight.conflicts.find((r: { kind: string }) => r.kind === 'merge').error.code).toBe('merge_alias_lifecycle_conflict')
  const rejected = await merge.commit()
  expect(rejected.status).toBe('failed')
  expect(rejected.items.find((r: { kind: string }) => r.kind === 'merge').error.code).toBe('merge_alias_lifecycle_conflict')
  expect(await read(`${base()}/${survivor.id}`)).toMatchObject({ verificationStatus: 'confirmed', version: 1 })
  expect(await read(`/api/roster/enterprises/${source.id}/aliases/${folded.id}`)).toMatchObject({ verificationStatus: 'withdrawn', version: 2 })
  expect((await mutate(survivor.id, decision('withdraw', 1, 'target-explicit-withdraw'))).status).toBe(200)
  const recovered = await merge.commit()
  expect(recovered.status).toBe('committed')
  expect(await read(`${base()}/${survivor.id}`)).toMatchObject({ verificationStatus: 'withdrawn', version: 2 })
  expect(await read(`${base()}/${survivor.id}/history`)).toMatchObject({ total: 2 })
  expect(await merge.commit()).toEqual(recovered)
})

it('rejects oversized alias and history pages explicitly so callers can fetch every row with smaller pages', async () => {
  const owner = sourceEnterprise('大备注分页边界企业')
  db.insert(schema.enterpriseAlias).values(Array.from({ length: 25 }, (_, index) => ({ enterpriseId: owner.id, name: `大备注${index}`, nameNorm: `大备注${index}`, sourceKind: 'manual' as const, note: '证'.repeat(4000) }))).run()
  const route = `/api/roster/enterprises/${owner.id}/aliases`
  const tooLarge = await fetch(`${url}${route}?pageSize=50`)
  expect(tooLarge.status).toBe(413)
  expect((await tooLarge.json()).data.code).toBe('alias_page_response_too_large')
  const page = await read(`${route}?pageSize=1`)
  expect(page).toMatchObject({ total: 25 })
  expect(page.rows).toHaveLength(1)
  const row = page.rows[0]
  for (let version = 1; version <= 15; version++) await sourceDecision(owner.id, row.id, decision('correct', version, `large-history-${version}`, { changes: { note: (version % 2 ? '据' : '证').repeat(4000) } }))
  expect((await fetch(`${url}${route}/${row.id}/history?pageSize=50`)).status).toBe(413)
  const exact = await read(`${route}/${row.id}/history?pageSize=1&page=15`)
  expect(exact).toMatchObject({ total: 15, rows: [{ after: { version: 16, note: '据'.repeat(4000) } }] })
})

it('rolls back earlier alias moves and creations when the merge itself introduces an audited lifecycle clash', async () => {
  const source = sourceEnterprise('执行阶段别名生命周期冲突企业')
  const safe = db.insert(schema.enterpriseAlias).values({ enterpriseId: source.id, name: '先迁移但须回滚别名', nameNorm: '先迁移但须回滚别名', sourceKind: 'manual' }).returning().get()
  const clash = db.insert(schema.enterpriseAlias).values({ enterpriseId: source.id, name: source.name, nameNorm: source.nameNorm, sourceKind: 'manual' }).returning().get()
  await sourceDecision(source.id, safe.id, decision('correct', 1, 'safe-before-merge', { changes: { note: '回滚前的审计' } }))
  await sourceDecision(source.id, clash.id, decision('correct', 1, 'clash-before-merge', { changes: { note: '保持待核' } }))
  const history = await read(`/api/roster/enterprises/${source.id}/aliases/${safe.id}/history`)
  const merge = await mergeRequest(source.id, 'execute-stage-lifecycle-conflict', { aliases: [{ uscc: ent.usccNorm, name: '执行阶段失败不创建', sourceKind: 'manual' }] })
  expect((await merge.preflight()).preflight.conflicts).toEqual([])
  const result = await merge.commit()
  expect(result).toMatchObject({ status: 'failed', summary: { written: 0 } })
  expect(result.items.find((r: { kind: string }) => r.kind === 'merge')).toMatchObject({ error: { code: 'merge_alias_lifecycle_conflict' } })
  expect(await read(`/api/roster/enterprises/${source.id}/aliases/${safe.id}`)).toMatchObject({ id: safe.id, enterpriseId: source.id, version: 2 })
  expect(await read(`/api/roster/enterprises/${source.id}/aliases/${safe.id}/history`)).toEqual(history)
  const aliases = await read(`${base()}?pageSize=50`)
  expect(aliases.rows.some((r: { name: string }) => [source.name, '执行阶段失败不创建'].includes(r.name))).toBe(false)
})

it('accepts announcement provenance only for the same enterprise original name and rejects wrong USCC evidence', async () => {
  const document = db.insert(schema.sourceDocument).values({ source: 'jxj', title: '合成公布文件', path: 'synthetic/99-source.pdf' }).returning().get()
  const record = db.insert(schema.record).values({ enterpriseId: ent.id, titleCode: 'innovative_sme', source: 'jxj', nameRaw: '公告依据正确旧名' }).returning().get()
  const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2026 }).returning().get()
  db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: document.path, page: 1 }).run()
  const supported = db.insert(schema.enterpriseAlias).values({ enterpriseId: ent.id, name: '公告依据正确旧名', nameNorm: '公告依据正确旧名', sourceKind: 'announcement', sourceRefId: document.id }).returning().get()
  expect((await mutate(supported.id, decision('confirm', 1, 'announcement-confirm'))).status).toBe(200)
  const unsupported = db.insert(schema.enterpriseAlias).values({ enterpriseId: ent.id, name: '公告不支持的名称', nameNorm: '公告不支持的名称', sourceKind: 'announcement', sourceRefId: document.id }).returning().get()
  expect((await mutate(unsupported.id, decision('confirm', 1, 'announcement-reject'))).status).toBe(400)
  const wrongCode = db.insert(schema.platformRelation).values({ queryId: query.id, sequenceNo: 99, nameRaw: unsupported.name, usccRaw: '91330206793007818K' }).returning().get()
  expect((await mutate(unsupported.id, decision('correct', 1, 'wrong-uscc', { changes: { sourceKind: 'platform_business', sourceRefId: wrongCode.id } }))).status).toBe(400)
  expect((await mutate(unsupported.id, decision('correct', 1, 'manual-wrong-ref', { changes: { sourceKind: 'manual' } }))).status).toBe(400)
  expect(await read(`${base()}/${unsupported.id}/history`)).toMatchObject({ total: 0 })
  expect(await read(`${base()}/${unsupported.id}`)).toMatchObject({ version: 1, sourceKind: 'announcement', sourceRefId: document.id })
})
