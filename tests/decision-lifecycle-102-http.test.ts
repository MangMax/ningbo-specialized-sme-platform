import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { useDb, schema } from '../db/client'
import { reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../scripts/lib/isolated-local-services.mjs'

const dir = mkdtempSync(join(tmpdir(), 'decision-102-'))
const dbPath = join(dir, 'synthetic.db')
const curatedPath = join(dir, 'legacy.json')
const db = useDb({ dbPath })
const enterprise = db.insert(schema.enterprise).values({ name: '合成决定企业', nameNorm: '合成决定企业', usccNorm: '91330211255994457P' }).returning().get()
const query = db.insert(schema.platformQuery).values({ interface: 'apply_list', queryKey: enterprise.usccNorm!, rdjb: '2', titleCode: 'specialized_sme', queriedAt: '2026-10-18T00:00:00Z', status: 'success', rawResponse: 'SYNTHETIC_RAW_UNCHANGED' }).returning().get()
const legacyKey = JSON.stringify([enterprise.usccNorm, 'specialized_sme', 'missing_in_miit'])
writeFileSync(curatedPath, JSON.stringify({ [legacyKey]: { note: '已看过/不算差异', at: '2026-10-18T00:00:00Z' } }))
let service: { baseUrl: string; stop: () => Promise<void> }
const coordinate = { enterpriseId: enterprise.id, titleCode: 'specialized_sme', direction: 'missing_in_miit' }
const request = (key: string, expectedCurrentId: number | null = null) => ({ ...coordinate, action: 'replace', expectedCurrentId, idempotencyKey: key, actor: { type: 'agent', id: 'synthetic-reviewer' }, basis: '人工核对指定平台证据；不推断原因', ruleVersion: 'manual-1', effectiveAt: '2025-01-01T00:00:00Z', decision: { status: 'confirmed_reason', reasonCode: 'platform_stale', measureCode: 'mark_platform_snapshot', verificationStatus: 'confirmed', evidenceQueryId: query.id, reasonNote: '旧解释' } })
const api = (path: string) => service.baseUrl + '/api/roster/decision-lifecycle/' + path
const post = (body: unknown, token = 'synthetic-api-token') => fetch(api('commands'), { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
async function json(response: Response) { return response.json() as Promise<any> }
async function rpc(name: string, args: Record<string, unknown>, token = '') {
  const response = await fetch(service.baseUrl + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
  const raw = await response.text()
  const payload = raw.startsWith('event:') ? raw.split('\n').find(line => line.startsWith('data: '))?.slice(6) : raw
  return { status: response.status, body: JSON.parse(payload!) }
}
const value = (r: any) => JSON.parse(r.body.result.content[0].text)
const scope = new URLSearchParams(Object.entries(coordinate).map(([k,v]) => [k,String(v)])).toString()
beforeAll(async () => {
  const cwd = resolve(import.meta.dirname, '..'); const port = await reserveLoopbackPort()
  const child = spawn(process.execPath, [join(cwd, 'node_modules/nuxt/bin/nuxt.mjs'), 'dev', '--host', '127.0.0.1', '--port', String(port)], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NUXT_BUILD_DIR: join(dir, 'build'), NUXT_DB_PATH: dbPath, NUXT_API_TOKEN: 'synthetic-api-token', NUXT_MCP_TOKEN: 'synthetic-mcp-token', NUXT_CURATED_PATH: curatedPath, NUXT_FILES_DIR: join(dir, 'files'), NUXT_INCOMING_DIR: join(dir, 'incoming') } })
  let output = ''; for (const stream of [child.stdout,child.stderr]) stream.on('data', data => { output = (output + data).slice(-8000) })
  service = { baseUrl: `http://127.0.0.1:${port}`, stop: () => stopOwnedChild(child) }
  try { await waitForHttp(service.baseUrl + '/api/roster/differences', { timeoutMs: 60000, child }) } catch (e) { await service.stop(); throw new Error(String(e) + output) }
}, 90000)
afterAll(async () => { if (service) await service.stop(); rmSync(dir, { recursive: true, force: true }) })

describe('ticket 102 public decision lifecycle', () => {
  it('preserves the public legacy PATCH payload output and note omission semantics without creating a decision', async () => {
    const target = db.insert(schema.enterprise).values({ name: '旧标注兼容企业', nameNorm: '旧标注兼容企业', usccNorm: 'LEGACY-COMPAT-102' }).returning().get()
    db.insert(schema.record).values({ enterpriseId: target.id, titleCode: 'innovative_sme', source: 'jxj' }).run()
    const body = { uscc: target.usccNorm, nameNorm: target.nameNorm, titleCode: 'innovative_sme', direction: 'missing_in_miit', curated: true }
    const patch = (input: unknown) => fetch(service.baseUrl + '/api/comparison/curated', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
    const read = async () => json(await fetch(service.baseUrl + '/api/comparison?showCurated=true&title=innovative_sme'))
    const first = await patch({ ...body, note: '原标注说明' })
    expect(first.status).toBe(200)
    expect(await json(first)).toEqual({ curated: true })
    expect((await read()).rows.find((r: any) => r.enterpriseId === target.id)).toMatchObject({ curated: true, note: '原标注说明' })
    const bytes = readFileSync(curatedPath, 'utf8')
    expect(await json(await patch(body))).toEqual({ curated: true })
    expect(readFileSync(curatedPath, 'utf8')).toBe(bytes)
    expect(await json(await patch({ ...body, note: '' }))).toEqual({ curated: true })
    expect((await read()).rows.find((r: any) => r.enterpriseId === target.id).note).toBe('')
    expect(await json(await patch({ ...body, curated: false }))).toEqual({ curated: false })
    expect((await read()).rows.find((r: any) => r.enterpriseId === target.id)).toMatchObject({ curated: false })
    expect((await read()).rows.find((r: any) => r.enterpriseId === target.id).note).toBeUndefined()
    const current = await json(await fetch(api('current?enterpriseId=' + target.id + '&titleCode=innovative_sme&direction=missing_in_miit')))
    expect(current).toEqual({ enterpriseId: target.id, titleCode: 'innovative_sme', direction: 'missing_in_miit', versionId: null, current: null })
    expect((await json(await fetch(api('history?enterpriseId=' + target.id + '&titleCode=innovative_sme&direction=missing_in_miit')))).total).toBe(0)
    const invalid = await patch({ ...body, curated: 'true' })
    expect(invalid.status).toBe(400)
    // Unknown exact identifiers keep the baseline JSON-only annotation behavior.
    expect(await json(await patch({ ...body, uscc: 'NO-SUCH-EXACT-102', note: '仅旧标注' }))).toEqual({ curated: true })
  })
  it('rejects ambiguous legacy identities without selecting or adopting an enterprise', async () => {
    const first = db.insert(schema.enterprise).values({ name: '旧标注同名甲', nameNorm: '旧标注同名', usccNorm: 'EXACT-AMBIGUOUS-102' }).returning().get()
    const second = db.insert(schema.enterprise).values({ name: '旧标注同名乙', nameNorm: '旧标注同名' }).returning().get()
    const bytes = readFileSync(curatedPath, 'utf8')
    const response = await fetch(service.baseUrl + '/api/comparison/curated', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nameNorm: '旧标注同名', titleCode: 'specialized_sme', direction: 'missing_in_miit', curated: true }) })
    expect(response.status).toBe(409)
    expect(await json(response)).toMatchObject({ error: { code: 'ambiguous_enterprise' }, preview: '/api/roster/decision-lifecycle/legacy-preview' })
    expect(readFileSync(curatedPath, 'utf8')).toBe(bytes)
    for (const id of [first.id, second.id]) expect((await json(await fetch(api('current?enterpriseId=' + id + '&titleCode=specialized_sme&direction=missing_in_miit')))).versionId).toBeNull()
    const exact = await fetch(service.baseUrl + '/api/comparison/curated', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uscc: first.usccNorm, nameNorm: '旧标注同名', titleCode: 'specialized_sme', direction: 'missing_in_miit', curated: true }) })
    expect(exact.status).toBe(200)
    expect(await json(exact)).toEqual({ curated: true })
  })


  it('blocks only the explicitly adopted legacy coordinate even after withdrawal and preserves both stores on conflict', async () => {
    const target = db.insert(schema.enterprise).values({ name: '标注接管边界企业', nameNorm: '标注接管边界企业', usccNorm: 'ADOPT-COMPAT-102' }).returning().get()
    const legacy = { uscc: target.usccNorm, nameNorm: target.nameNorm, titleCode: 'specialized_sme', direction: 'missing_in_miit', curated: true, note: '原标注保留' }
    const patch = (body: unknown) => fetch(service.baseUrl + '/api/comparison/curated', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect(await json(await patch(legacy))).toEqual({ curated: true })
    const adoptedResponse = await post({ ...request('compat-explicit-adopt'), enterpriseId: target.id, decision: { status: 'needs_review', measureCode: 'manual_review', verificationStatus: 'pending' } })
    expect(adoptedResponse.status).toBe(200)
    const adopted = await json(adoptedResponse)
    const currentUrl = api('current?enterpriseId=' + target.id + '&titleCode=specialized_sme&direction=missing_in_miit')
    const before = await json(await fetch(currentUrl))
    const bytes = readFileSync(curatedPath, 'utf8')
    for (const body of [legacy, { ...legacy, curated: false }, { ...legacy, note: '' }, { ...legacy, uscc: target.usccNorm!.toLowerCase() }, { nameNorm: target.nameNorm, titleCode: legacy.titleCode, direction: legacy.direction, curated: true }]) {
      const response = await patch(body)
      expect(response.status).toBe(409)
      expect(await json(response)).toMatchObject({ error: { code: 'decision_lifecycle_required' }, replacement: '/api/roster/decision-lifecycle/commands', preview: '/api/roster/decision-lifecycle/legacy-preview' })
      expect(readFileSync(curatedPath, 'utf8')).toBe(bytes)
      expect(await json(await fetch(currentUrl))).toEqual(before)
    }
    const { decision, ...metadata } = request('compat-explicit-withdraw', adopted.versionId)
    const withdrawn = await json(await post({ ...metadata, enterpriseId: target.id, action: 'withdraw' }))
    expect(withdrawn.action).toBe('withdraw')
    expect((await patch({ ...legacy, curated: false })).status).toBe(409)
    expect(readFileSync(curatedPath, 'utf8')).toBe(bytes)
    expect(await json(await fetch(currentUrl))).toMatchObject({ versionId: withdrawn.versionId, current: null })
    // Adoption is scoped to enterprise × title × direction, rather than the whole enterprise.
    expect(await json(await patch({ ...legacy, direction: 'extra_in_miit' }))).toEqual({ curated: true })
    expect(await json(await patch({ ...legacy, titleCode: 'innovative_sme' }))).toEqual({ curated: true })
  })
  it('appends a version with explicit actor basis rule and business time and reads it by stable ID', async () => {
    const response = await post(request('first'))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('no-store')
    const receipt = await json(response)
    expect(receipt).toMatchObject({ action: 'replace', previousId: null, currentId: expect.any(Number), versionId: expect.any(Number) })
    const exact = await json(await fetch(api(String(receipt.versionId))))
    expect(exact).toMatchObject({ id: receipt.versionId, isCurrent: true, actor: { id: 'synthetic-reviewer' }, basis: '人工核对指定平台证据；不推断原因', ruleVersion: 'manual-1', effectiveAt: '2025-01-01T00:00:00Z', status: 'confirmed_reason', reasonNote: '旧解释' })
    expect(JSON.stringify(exact)).not.toContain('SYNTHETIC_RAW')
    expect(value(await rpc('get_difference_decision', { id: receipt.versionId }))).toEqual(exact)
    expect(await json(await fetch(api('current?' + scope)))).toMatchObject({ versionId: receipt.versionId, current: { id: receipt.versionId } })
  })
  it('replaces then withdraws without resurfacing old reasons and pages immutable history across transports', async () => {
    const first = (await json(await fetch(api('current?' + scope)))).versionId
    const replacement = { ...request('replace-2', first), effectiveAt: '2024-01-01T00:00:00Z', decision: { status: 'confirmed_no_diff', measureCode: 'none', verificationStatus: 'confirmed', evidenceQueryId: query.id } }
    const second = value(await rpc('save_difference_decision', replacement, 'synthetic-mcp-token'))
    expect(second).toMatchObject({ previousId: first, currentId: expect.any(Number) })
    expect(await json(await post(replacement))).toEqual(second)
    expect((await json(await fetch(api(String(first))))).reasonNote).toBe('旧解释')
    expect((await json(await fetch(api(String(first))))).isCurrent).toBe(false)
    const withdraw = { ...request('withdraw-3', second.versionId), action: 'withdraw' }
    delete (withdraw as any).decision
    const thirdResponse = await post(withdraw)
    expect(thirdResponse.status).toBe(200)
    const third = await json(thirdResponse)
    expect(third).toMatchObject({ previousId: second.versionId, action: 'withdraw', currentId: null })
    expect(value(await rpc('save_difference_decision', withdraw, 'synthetic-mcp-token'))).toEqual(third)
    expect(await json(await post(replacement))).toEqual(second)
    expect((await post({ ...withdraw, idempotencyKey: 'withdraw-again', expectedCurrentId: third.versionId })).status).toBe(409)
    expect(value(await rpc('get_current_difference_decision', coordinate))).toEqual({ ...coordinate, versionId: third.versionId, current: null })
    const history = await json(await fetch(api('history?' + scope + '&page=2&pageSize=1')))
    expect(history).toMatchObject({ total: 3, page: 2, pageSize: 1, rows: [{ id: second.versionId, status: 'confirmed_no_diff', isCurrent: false }] })
    expect(value(await rpc('list_difference_decision_history', { ...coordinate, page: 2, pageSize: 1 }))).toEqual(history)
    expect((await json(await fetch(api('history?id=' + first + '&pageSize=1')))).rows[0]).toMatchObject({ id: third.versionId, lifecycleAction: 'withdraw' })
    expect((await json(await fetch(api('history?' + scope + '&page=4&pageSize=1')))).rows).toEqual([])
    // All current readers must agree: a withdrawal cannot resurrect the first explanation.
    const restList = await json(await fetch(service.baseUrl + '/api/roster/differences'))
    expect(restList.rows.find((r: any) => r.enterpriseId === enterprise.id)).toMatchObject({ status: 'not_queried', reasonCode: null })
    const mcpList = value(await rpc('list_differences', {}))
    expect(mcpList.rows.find((r: any) => r.enterpriseId === enterprise.id)).toMatchObject({ status: 'not_queried', reasonCode: null })
  })

  it('rejects absent or wrong transport auth and malformed decisions without changing current state', async () => {
    const before = await json(await fetch(api('current?' + scope)))
    const next = request('auth-guard', before.versionId)
    for (const token of ['', 'synthetic-mcp-token']) expect((await post(next, token)).status).toBe(401)
    for (const token of ['', 'synthetic-api-token']) expect((await rpc('save_difference_decision', next, token)).status).toBe(401)
    const malformed = await fetch(api('commands'), { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-api-token' }, body: '{broken' })
    expect(malformed.status).toBe(400)
    expect(await json(malformed)).toMatchObject({ error: { code: 'invalid_request' } })
    for (const bad of [
      { ...next, actor: undefined }, { ...next, basis: '' }, { ...next, ruleVersion: '' }, { ...next, expectedCurrentId: undefined }, { ...next, effectiveAt: 'yesterday' }, { ...next, extraField: 'not allowed' },
      { ...next, decision: { ...next.decision, unexpected: true } },
      { ...next, decision: { ...next.decision, status: 'confirmed_no_diff', measureCode: 'none' } },
      { ...next, decision: { ...next.decision, reasonCode: null } },
      { ...next, decision: { ...next.decision, reasonCode: 'pending_review', measureCode: 'none' } },
    ]) expect((await post(bad)).status).toBe(400)
    expect(await json(await fetch(api('current?' + scope)))).toEqual(before)
    expect((await fetch(api('history?enterpriseId=' + enterprise.id))).status).toBe(400)
    expect((await fetch(api('history?' + scope + '&pageSize=51'))).status).toBe(400)
    expect((await fetch(api('9999999'))).status).toBe(404)
    expect((await fetch(api('current?' + scope.replace('enterpriseId=1', 'enterpriseId=9999999')))).status).toBe(404)
  })
  it('serializes competing expected versions, rejects key reuse, and rolls back an injected post-insert failure', async () => {
    const before = await json(await fetch(api('current?' + scope)))
    const a = request('race-a', before.versionId), b = request('race-b', before.versionId)
    const raced = await Promise.all([post(a), post(b)])
    expect(raced.map(r => r.status).sort()).toEqual([200,409])
    const winner = await json(raced.find(r => r.status === 200)!)
    expect(await json(raced.find(r => r.status === 409)!)).toMatchObject({ error: { code: 'stale_version' } })
    const replay = raced[0]!.status === 200 ? a : b
    expect(value(await rpc('save_difference_decision', replay, 'synthetic-mcp-token'))).toEqual(winner)
    expect((await post({ ...replay, basis: 'different request' })).status).toBe(409)
    const failure = request('rollback', winner.versionId)
    db.run(sql`CREATE TRIGGER decision102_fault AFTER INSERT ON difference_reason WHEN NEW.idempotency_key='rollback' BEGIN SELECT RAISE(ABORT,'synthetic transaction fault'); END`)
    try {
      const response = await post(failure)
      expect(response.status).toBe(500)
      expect(await json(response)).toMatchObject({ error: { code: 'transaction_failed' } })
      expect((await json(await fetch(api('current?' + scope)))).versionId).toBe(winner.versionId)
      expect((await json(await fetch(api('history?' + scope)))).total).toBe(4)
    } finally { db.run(sql`DROP TRIGGER decision102_fault`) }
    const recovered = await json(await post(failure))
    expect(recovered).toMatchObject({ previousId: winner.versionId, currentId: expect.any(Number) })
    // Warm current/list/detail responses before changing status: all must show the next committed version.
    await fetch(service.baseUrl + '/api/roster/differences')
    await fetch(service.baseUrl + '/api/roster/enterprises/' + enterprise.id)
    const changed = { ...request('fresh-result', recovered.versionId), decision: { status: 'needs_review', measureCode: 'manual_review', verificationStatus: 'pending' } }
    const saved = value(await rpc('save_difference_decision', changed, 'synthetic-mcp-token'))
    expect((await json(await fetch(api('current?' + scope)))).current).toMatchObject({ id: saved.versionId, status: 'needs_review' })
    expect((await json(await fetch(service.baseUrl + '/api/roster/differences'))).rows.find((r: any) => r.enterpriseId === enterprise.id)).toMatchObject({ status: 'needs_review', reasonCode: null })
    expect(value(await rpc('list_differences', {})).rows.find((r: any) => r.enterpriseId === enterprise.id)).toMatchObject({ status: 'needs_review', reasonCode: null })
    expect((await json(await fetch(service.baseUrl + '/api/roster/enterprises/' + enterprise.id))).differences[0]).toMatchObject({ status: 'needs_review', reasonCode: null })
    expect(db.get(sql`SELECT raw_response as raw FROM platform_query WHERE id=${query.id}`)).toEqual({ raw: 'SYNTHETIC_RAW_UNCHANGED' })
  })

  it('previews exact legacy mappings and conflicts without promoting reviewed annotations or modifying either store', async () => {
    const duplicate1 = db.insert(schema.enterprise).values({ name: '同名甲', nameNorm: '同名' }).returning().get()
    db.insert(schema.enterprise).values({ name: '同名乙', nameNorm: '同名' }).run()
    const unknown = JSON.stringify(['MISSING', 'specialized_sme', 'missing_in_miit'])
    const ambiguous = JSON.stringify(['name:同名', 'specialized_sme', 'missing_in_miit'])
    const legacy = { [legacyKey]: { note: '已看过/不算差异', at: '2026-10-18T00:00:00Z' }, [unknown]: { at: '2026-10-18' }, [ambiguous]: { at: '2026-10-18' }, malformed: { note: '旧格式待核', at: '2026-10-18' } }
    writeFileSync(curatedPath, JSON.stringify(legacy))
    const bytes = readFileSync(curatedPath, 'utf8')
    const current = await json(await fetch(api('current?' + scope)))
    const response = await fetch(api('legacy-preview?pageSize=2'))
    expect(response.headers.get('cache-control')).toContain('no-store')
    const first = await json(response)
    expect(first).toMatchObject({ total: 4, pageSize: 2, migrationApplied: false })
    const rows = [...first.rows, ...(await json(await fetch(api('legacy-preview?page=2&pageSize=2')))).rows]
    expect(rows.find((r: any) => r.legacyKey === legacyKey)).toMatchObject({ enterpriseId: enterprise.id, equivalentToConfirmedNoDiff: false, currentVersionId: current.versionId, currentStatus: 'needs_review', conflicts: expect.arrayContaining(['legacy_not_equivalent', 'formal_decision_exists']) })
    expect(rows.find((r: any) => r.legacyKey === unknown)).toMatchObject({ enterpriseId: null, conflicts: expect.arrayContaining(['enterprise_not_found']) })
    expect(rows.find((r: any) => r.legacyKey === ambiguous)).toMatchObject({ enterpriseId: null, conflicts: expect.arrayContaining(['ambiguous_enterprise']), candidates: expect.arrayContaining([expect.objectContaining({ id: duplicate1.id })]) })
    expect(rows.find((r: any) => r.legacyKey === 'malformed').conflicts).toContain('invalid_legacy_key')
    expect(value(await rpc('preview_legacy_difference_decisions', { page: 1, pageSize: 2 }))).toEqual(first)
    const legacyPatch = await fetch(service.baseUrl + '/api/comparison/curated', { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-api-token' }, body: JSON.stringify({ uscc: enterprise.usccNorm, titleCode: coordinate.titleCode, direction: coordinate.direction, curated: false }) })
    expect(legacyPatch.status).toBe(409)
    expect(await json(legacyPatch)).toMatchObject({ error: { code: 'decision_lifecycle_required' }, replacement: '/api/roster/decision-lifecycle/commands' })
    expect(readFileSync(curatedPath, 'utf8')).toBe(bytes)
    expect(await json(await fetch(api('current?' + scope)))).toEqual(current)
  })
  it('keeps legacy imports readable but requires lifecycle commands after explicit adoption', async () => {
    const other = db.insert(schema.enterprise).values({ name: '旧决定企业', nameNorm: '旧决定企业', usccNorm: 'LEGACY102' }).returning().get()
    const original = db.insert(schema.differenceReason).values({ enterpriseId: other.id, titleCode: 'specialized_sme', direction: 'missing_in_miit', status: 'needs_review', recordedAt: '2099-01-01T00:00:00Z', reasonNote: '不可删除的旧原因' }).returning().get()
    expect(await json(await fetch(api(String(original.id))))).toMatchObject({ origin: 'legacy_import', reasonNote: '不可删除的旧原因' })
    const adopted = await json(await post({ ...request('adopt', original.id), enterpriseId: other.id, decision: { status: 'needs_review', measureCode: 'manual_review', verificationStatus: 'pending' } }))
    expect(adopted).toMatchObject({ previousId: original.id, currentId: expect.any(Number) })
    expect((await json(await fetch(service.baseUrl + '/api/roster/differences'))).rows.find((r: any) => r.enterpriseId === other.id)).toMatchObject({ explanationId: adopted.versionId, status: 'needs_review', reasonNote: null })
    const imported = { idempotencyKey: 'old-import-after-adopt', sourceKind: 'alias_evidence', sourceIdentity: 'synthetic/legacy', payload: { differences: [{ enterpriseName: other.name, uscc: other.usccNorm, titleCode: 'specialized_sme', direction: 'missing_in_miit', recordedAt: '2199-01-01T00:00:00Z', status: 'confirmed_no_diff', measureCode: 'none', verificationStatus: 'confirmed' }] } }
    const rejected = await fetch(service.baseUrl + '/api/roster/import/commit', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-api-token' }, body: JSON.stringify(imported) })
    expect(await json(rejected)).toMatchObject({ status: 'failed', items: [expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'decision_lifecycle_required' }) })] })
    expect((await json(await fetch(api('current?enterpriseId=' + other.id + '&titleCode=specialized_sme&direction=missing_in_miit')))).current.id).toBe(adopted.versionId)
    expect((await json(await fetch(api(String(original.id))))).reasonNote).toBe('不可删除的旧原因')
  })


  it('rejects mismatched evidence and gives typed MCP failures without leaking internal SQL', async () => {
    const before = await json(await fetch(api('current?' + scope)))
    const wrong = db.insert(schema.platformQuery).values({ interface: 'recognized_list', queryKey: 'OTHER-SUBJECT', rdjb: '3', titleCode: 'little_giant', queriedAt: '2026-10-19', status: 'success' }).returning().get()
    const bad = { ...request('wrong-evidence', before.versionId), decision: { ...request('x').decision, evidenceQueryId: wrong.id } }
    const rejected = await post(bad)
    expect(rejected.status).toBe(422)
    expect(await json(rejected)).toMatchObject({ error: { code: 'evidence_mismatch' } })
    const stale = await rpc('save_difference_decision', request('mcp-stale', null), 'synthetic-mcp-token')
    expect(stale.body.result.isError).toBe(true)
    expect(value(stale)).toMatchObject({ error: { code: 'stale_version' } })
    const invalid = await rpc('save_difference_decision', { ...request('mcp-unknown', before.versionId), arbitrary: 'not a field' }, 'synthetic-mcp-token')
    expect(invalid.status).toBe(400)
    expect(invalid.body.error.data.code).toBe('invalid_request')
    db.run(sql`CREATE TRIGGER decision102_mcp_fault AFTER INSERT ON difference_reason WHEN NEW.idempotency_key='mcp-fault' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_INTERNAL_SECRET'); END`)
    try {
      const failed = await rpc('save_difference_decision', request('mcp-fault', before.versionId), 'synthetic-mcp-token')
      expect(failed.body.result.isError).toBe(true)
      expect(value(failed)).toMatchObject({ error: { code: 'transaction_failed' } })
      expect(JSON.stringify(failed)).not.toMatch(/SYNTHETIC_INTERNAL_SECRET|INSERT INTO|insert into|synthetic-api-token/)
    } finally { db.run(sql`DROP TRIGGER decision102_mcp_fault`) }
    expect(await json(await fetch(api('current?' + scope)))).toEqual(before)
  })

  it('discovers full HTTP and MCP contracts and disables writes when tokens are unconfigured', async () => {
    const spec = await json(await fetch(service.baseUrl + '/_openapi.json'))
    const commandSchema = spec.paths['/api/roster/decision-lifecycle/commands'].post.requestBody.content['application/json'].schema
    expect(commandSchema.required).toEqual(expect.arrayContaining(['action','expectedCurrentId','actor','basis','ruleVersion','effectiveAt','idempotencyKey']))
    expect(commandSchema.properties.action.enum).toEqual(['replace','withdraw'])
    for (const path of ['current','history','legacy-preview','{id}']) expect(spec.paths['/api/roster/decision-lifecycle/' + path].get).toBeTruthy()
    const listResponse = await fetch(service.baseUrl + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) })
    const listRaw = await listResponse.text()
    const list = JSON.parse(listRaw.startsWith('event:') ? listRaw.split('\n').find(line => line.startsWith('data: '))!.slice(6) : listRaw)
    const names = list.result.tools.map((t: any) => t.name)
    expect(names).toEqual(expect.arrayContaining(['get_difference_decision','get_current_difference_decision','list_difference_decision_history','preview_legacy_difference_decisions']))
    expect(names).not.toContain('save_difference_decision')
    const cwd = resolve(import.meta.dirname, '..'); const port = await reserveLoopbackPort()
    const child = spawn(process.execPath, [join(cwd, 'node_modules/nuxt/bin/nuxt.mjs'), 'dev', '--host', '127.0.0.1', '--port', String(port)], { cwd, stdio: ['ignore','pipe','pipe'], env: { ...process.env, NUXT_BUILD_DIR: join(dir,'no-token-build'), NUXT_DB_PATH: dbPath, NUXT_API_TOKEN: '', NUXT_MCP_TOKEN: '', NUXT_CURATED_PATH: curatedPath, NUXT_FILES_DIR: join(dir,'files'), NUXT_INCOMING_DIR: join(dir,'incoming') } })
    let output = ''; for (const stream of [child.stdout,child.stderr]) stream.on('data', data => { output = (output + data).slice(-4000) })
    const base = `http://127.0.0.1:${port}`
    try {
      try { await waitForHttp(base + '/api/roster/differences', { timeoutMs: 60000, child }) } catch(e) { throw new Error(String(e) + output) }
      expect((await fetch(base + '/api/roster/decision-lifecycle/current?' + scope)).status).toBe(200)
      expect((await fetch(base + '/api/roster/decision-lifecycle/commands', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-api-token' }, body: JSON.stringify(request('no-token')) })).status).toBe(401)
      expect((await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer synthetic-mcp-token' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'save_difference_decision', arguments: request('no-token') } }) })).status).toBe(401)
    } finally { await stopOwnedChild(child) }
  }, 90000)

  it('rechecks lifecycle ownership inside legacy import execution and rolls back the whole batch', async () => {
    const target = db.insert(schema.enterprise).values({ name: '执行期接管企业', nameNorm: '执行期接管企业', usccNorm: 'RACE102' }).returning().get()
    db.run(sql`CREATE TRIGGER decision102_import_race AFTER INSERT ON platform_query WHEN NEW.query_key='import-race-102' BEGIN INSERT INTO difference_reason(enterprise_id,title_code,direction,status,recorded_at,created_at,lifecycle_action) VALUES(${sql.raw(String(target.id))},'specialized_sme','missing_in_miit','needs_review','2099-01-01T00:00:00.000Z','2026-10-19','replace'); END`)
    const body = { idempotencyKey: 'legacy-execution-race', sourceKind: 'alias_evidence', sourceIdentity: 'synthetic/race', payload: { platformQueries: [{ interface: 'apply_list', queryKey: 'import-race-102', rdjb: '2', queriedAt: '2026-10-19T00:00:00Z', status: 'no_record' }], differences: [{ enterpriseName: target.name, uscc: target.usccNorm, titleCode: 'specialized_sme', direction: 'missing_in_miit', recordedAt: '2199-01-01T00:00:00Z', status: 'confirmed_no_diff', measureCode: 'none', verificationStatus: 'confirmed' }] } }
    try {
      const response = await fetch(service.baseUrl + '/api/roster/import/commit', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-api-token' }, body: JSON.stringify(body) })
      const result = await json(response)
      expect(result.status).toBe('failed')
      expect(result.items).toEqual(expect.arrayContaining([expect.objectContaining({ error: expect.objectContaining({ code: 'decision_lifecycle_required' }) })]))
      expect((await json(await fetch(api('history?enterpriseId=' + target.id + '&titleCode=specialized_sme&direction=missing_in_miit')))).total).toBe(0)
      expect(db.get(sql`select count(*) as n from platform_query where query_key='import-race-102'`)).toEqual({ n: 0 })
    } finally { db.run(sql`DROP TRIGGER decision102_import_race`) }
  })
  it('bounds scoped history and legacy preview while unrelated large raw evidence is never materialized', async () => {
    const other = db.insert(schema.enterprise).values({ name: '性能夹具企业', nameNorm: '性能夹具企业' }).returning().get()
    const hugeReason = '原始历史长说明'.repeat(2000)
    const insert = db.$client.prepare("INSERT INTO difference_reason(enterprise_id,title_code,direction,status,reason_note,recorded_at,created_at) VALUES(?, 'specialized_sme','extra_in_miit','needs_review',?,?,?)")
    db.$client.transaction(() => { for (let n = 0; n < 200; n++) insert.run(other.id, hugeReason, '2026-' + String(n).padStart(4,'0'), '2026-01-01') })()
    db.run(sql`INSERT INTO platform_query(interface,query_key,rdjb,queried_at,status,raw_response,collection_evidence,created_at) VALUES('apply_list','unrelated102','2','2026-10-19','success',${'LARGE_RAW_UNRELATED'.repeat(400000)},'invalid-json-poison','2026-10-19')`)
    const scoped = { enterpriseId: other.id, titleCode: 'specialized_sme', direction: 'extra_in_miit', page: 2, pageSize: 50 }
    const search = new URLSearchParams(Object.entries(scoped).map(([k,v]) => [k,String(v)])).toString()
    const response = await fetch(api('history?' + search))
    expect(response.status).toBe(200)
    const history = await json(response)
    expect(history).toMatchObject({ total: 200, page: 2, pageSize: 50 })
    expect(history.rows).toHaveLength(50)
    expect(JSON.stringify(history).includes(hugeReason)).toBe(false)
    expect(history.rows[0]).toMatchObject({ detailsAvailable: true })
    expect(Buffer.byteLength(JSON.stringify(history))).toBeLessThan(256 * 1024)
    expect(value(await rpc('list_difference_decision_history', scoped))).toEqual(history)
    const exact = await json(await fetch(api(String(history.rows[0].id))))
    expect(exact.reasonNote).toBe(hugeReason)
    const mcpList = await rpc('list_differences', { pageSize: 1 })
    expect(mcpList.body.result.isError).not.toBe(true)
    expect(value(mcpList).rows).toHaveLength(1)
    expect(JSON.stringify(value(mcpList))).not.toContain('LARGE_RAW_UNRELATED')
    expect((await json(await fetch(api('current?' + scope)))).current.status).toBe('needs_review')
    const legacyBounded = await fetch(service.baseUrl + '/api/comparison/curated', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uscc: 'UNRELATED-LEGACY-102', titleCode: 'little_giant', direction: 'extra_in_miit', curated: true }) })
    expect(legacyBounded.status).toBe(200)
    expect(await json(legacyBounded)).toEqual({ curated: true })
    const plan = db.all(sql`EXPLAIN QUERY PLAN SELECT id FROM difference_reason WHERE enterprise_id=${other.id} AND title_code='specialized_sme' AND direction='extra_in_miit' ORDER BY recorded_at DESC,id DESC LIMIT 50 OFFSET 50`)
    expect(JSON.stringify(plan)).toContain('SEARCH difference_reason USING COVERING INDEX difference_reason_version_uq')
    expect(JSON.stringify(plan)).not.toContain('USE TEMP B-TREE')
    const previousFile = readFileSync(curatedPath, 'utf8')
    try {
      writeFileSync(curatedPath, ' '.repeat(2 * 1024 * 1024 + 1))
      expect((await fetch(api('legacy-preview'))).status).toBe(413)
      writeFileSync(curatedPath, JSON.stringify(Object.fromEntries(Array.from({ length: 50 }, (_,i) => ['bad-key-' + String(i).padStart(4,'0') + 'x'.repeat(6000), { at: '2026' }]))))
      expect((await fetch(api('legacy-preview?pageSize=50'))).status).toBe(413)
      writeFileSync(curatedPath, '{broken')
      expect((await fetch(api('legacy-preview'))).status).toBe(422)
    } finally { writeFileSync(curatedPath, previousFile) }
  })

})
