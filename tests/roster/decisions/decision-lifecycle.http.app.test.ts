import { readDevelopmentDiscovery } from '../current-export/fixtures/specialized-export'
import { spawnCompiledApp } from '../../support/owned-process.mjs'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { enterprise as enterpriseTable } from '../../../db/postgresql/enterprise-tables'
import { record } from '../../../db/postgresql/ledger-tables'
import { differenceReason } from '../../../db/postgresql/roster-selection-tables'
import { evidenceReviewReceipt114 } from '../../../db/postgresql/evidence-review-tables'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import { seedPostgresPlatformQuery } from '../../platform/fixtures/postgres-query'
import { reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../../support/owned-process.mjs'
import historicalReceipts from '../../fixtures/decision-102-pre-browser-receipts.json'

const dir = mkdtempSync(join(tmpdir(), 'decision-102-'))
const curatedPath = join(dir, 'legacy.json')
const enterprise = { id: 1, name: '合成决定企业', nameNorm: '合成决定企业', usccNorm: '91330211255994457P' }
let query: { id: number }
let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>>
let pool: Pool
let db: ReturnType<typeof drizzle<Record<string, never>>>
async function insertEnterprise(values: typeof enterpriseTable.$inferInsert) {
 const [row] = await db.insert(enterpriseTable).values(values).returning()
 return row!
}
async function insertDecision(values: Omit<typeof differenceReason.$inferInsert, 'createdAt'>) {
 const [row] = await db.insert(differenceReason).values({ ...values, createdAt: values.recordedAt }).returning()
 return row!
}
async function rejectDecision(key: string, message: string) {
 await db.execute(sql`
   CREATE FUNCTION reject_fixture_decision() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF NEW.idempotency_key = TG_ARGV[0] THEN RAISE EXCEPTION USING MESSAGE = TG_ARGV[1]; END IF;
     RETURN NEW;
   END $$`)
 await db.execute(sql`CREATE TRIGGER reject_fixture_decision AFTER INSERT ON difference_reason
   FOR EACH ROW EXECUTE FUNCTION reject_fixture_decision(${sql.raw("'" + key + "'")},${sql.raw("'" + message + "'")})`)
}
async function removeDecisionRejection() {
 await db.execute(sql`DROP TRIGGER reject_fixture_decision ON difference_reason; DROP FUNCTION reject_fixture_decision()`)
}
async function installImportRace(queryKey: string, enterpriseId: number) {
 await db.execute(sql`
   CREATE FUNCTION fixture_import_race() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF NEW.query_key = TG_ARGV[0] THEN
       INSERT INTO difference_reason(enterprise_id,title_code,direction,status,recorded_at,created_at,lifecycle_action)
       VALUES(TG_ARGV[1]::bigint,'specialized_sme','missing_in_miit','needs_review','2099-01-01T00:00:00.000Z','2026-10-19','replace');
     END IF;
     RETURN NEW;
   END $$`)
 await db.execute(sql`CREATE TRIGGER fixture_import_race AFTER INSERT ON platform_collection
   FOR EACH ROW EXECUTE FUNCTION fixture_import_race(${sql.raw("'" + queryKey + "'")},${sql.raw("'" + enterpriseId + "'")})`)
}
async function removeImportRace() {
 await db.execute(sql`DROP TRIGGER fixture_import_race ON platform_collection; DROP FUNCTION fixture_import_race()`)
}
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
  await readDevelopmentDiscovery()
  postgres = await postgresRuntimeFixture({ dir })
  pool = new Pool({ connectionString: postgres.url, options: '-c search_path=business,public' })
  db = drizzle({ client: pool })
  await db.insert(enterpriseTable).values({ name: enterprise.name, nameNorm: enterprise.nameNorm, usccNorm: enterprise.usccNorm })
  const source = await seedPostgresPlatformQuery(db, {
    interface: 'apply_list', queryKey: enterprise.usccNorm, rdjb: '2', titleCode: 'specialized_sme',
    queriedAt: '2026-10-18T00:00:00Z', status: 'success', rawResponse: 'SYNTHETIC_RAW_UNCHANGED',
  })
  query = { id: source.queryId }
  const cwd = resolve(import.meta.dirname, '../../..'); const port = await reserveLoopbackPort()
  const child = spawnCompiledApp(port, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NUXT_BUILD_DIR: join(dir, 'build'), ...postgres.env, NUXT_DB_READONLY: '0', NUXT_API_TOKEN: 'synthetic-api-token', NUXT_MCP_TOKEN: 'synthetic-mcp-token', NUXT_CURATED_PATH: curatedPath, NUXT_FILES_DIR: join(dir, 'files'), NUXT_INCOMING_DIR: join(dir, 'incoming') } })
  let output = ''; for (const stream of [child.stdout,child.stderr]) stream.on('data', data => { output = (output + data).slice(-8000) })
  service = { baseUrl: `http://127.0.0.1:${port}`, stop: () => stopOwnedChild(child) }
  try { await waitForHttp(service.baseUrl + '/api/roster/differences', { timeoutMs: 60000, child }) } catch (e) { await service.stop(); throw new Error(String(e) + output) }
}, 90000)
afterAll(async () => {
  try { if (service) await service.stop() }
  finally {
    await pool?.end()
    postgres?.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('ticket 102 public decision lifecycle', () => {
  it.each(historicalReceipts.fixtures)('replays pre-browser normalized receipts across HTTP and MCP: $name', async ({ name, command, hash }) => {
    // These normalized commands/hashes were generated with the actual 0ceb918 schema,
    // not the current parser. Include omitted optionals, explicit nulls and movedIn.
    expect(createHash('sha256').update(JSON.stringify(command)).digest('hex')).toBe(hash)
    await insertEnterprise({ id: command.enterpriseId, name, nameNorm: name })
    const review = 'reviewedEvidence' in command
    const row = await insertDecision({
      enterpriseId: command.enterpriseId, titleCode: command.titleCode, direction: 'missing_in_miit',
      status: 'needs_review', measureCode: 'manual_review', verificationStatus: 'pending',
      lifecycleAction: command.action === 'withdraw' ? 'withdraw' : 'replace',
      recordedAt: '2026-10-19T01:00:00.000Z',
      ...(!review ? { idempotencyKey: command.idempotencyKey, requestHash: hash } : {}),
    })
    const receipt = { versionId: row.id, currentId: command.action === 'withdraw' ? null : row.id, previousId: null, action: command.action, recordedAt: row.recordedAt,
      ...(review ? { reviewedRevisionId: 98765 } : {}) }
    if (review) await db.insert(evidenceReviewReceipt114).values({
      idempotencyKey: command.idempotencyKey, requestHash: hash, kind: command.action,
      enterpriseId: command.enterpriseId, titleCode: command.titleCode, direction: command.direction,
      decisionId: row.id, reviewedRevisionId: 98765, actor: JSON.stringify(command.actor), basis: command.basis,
      ruleVersion: command.ruleVersion, effectiveAt: command.effectiveAt, response: JSON.stringify(receipt), recordedAt: row.recordedAt,
    })
    const persisted = async () => ({
      decisions: (await db.execute(sql`select * from difference_reason where enterprise_id=${command.enterpriseId}`)).rows,
      reviews: (await db.execute(sql`select * from evidence_review_receipt_114 where enterprise_id=${command.enterpriseId}`)).rows,
    })
    const before = await persisted()
    // Reorder every object and exercise trimming: wire order must not affect normalized replay.
    const reverse = (value: unknown): unknown => value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverse(item)])) : value
    const wire = reverse({ ...command, basis: '  ' + command.basis + '  ', actor: { ...command.actor, id: '  ' + command.actor.id + '  ' }, ruleVersion: '  ' + command.ruleVersion + '  ' }) as Record<string, unknown>
    // expectedCurrentId=null is now stale, and review revision 98765 was never committed.
    // Existing receipts must win over both version and evidence validation.
    const replay = await post(wire)
    expect(replay.status, await replay.clone().text()).toBe(200)
    expect(await json(replay)).toEqual(receipt)
    const mcp = await rpc('save_difference_decision', wire, 'synthetic-mcp-token')
    expect(mcp.status).toBe(200)
    expect(mcp.body.result.isError).not.toBe(true)
    expect(value(mcp)).toEqual(receipt)
    const changed = { ...wire, basis: 'different request' }
    const conflict = await post(changed)
    expect(conflict.status).toBe(409)
    expect(await json(conflict)).toMatchObject({ error: { code: 'idempotency_conflict' } })
    const mcpConflict = await rpc('save_difference_decision', changed, 'synthetic-mcp-token')
    expect(mcpConflict.body.result.isError).toBe(true)
    expect(value(mcpConflict)).toMatchObject({ error: { code: 'idempotency_conflict' } })
    expect(await persisted()).toEqual(before)
  })

  it.each([
    { case: 'null-actor', metadata: { actor: null } },
    { case: 'null-rule', metadata: { ruleVersion: null } },
    { case: 'both-null', metadata: { actor: null, ruleVersion: null } },
  ])('rejects null identity metadata on external transports: $case', async ({ case: key, metadata }) => {
    const invalid = { ...request(key), ...metadata }
    const http = await post(invalid)
    expect(http.status).toBe(400)
    expect(await json(http)).toMatchObject({ error: { code: 'invalid_request' } })
    const mcp = await rpc('save_difference_decision', invalid, 'synthetic-mcp-token')
    expect(mcp.status).toBe(400)
    expect(mcp.body.error).toMatchObject({ code: -32602, data: { code: 'invalid_request' } })
  })

  it.each([
    { case: 'maintain-without-reviewed-evidence', action: 'maintain', includeDecision: false },
    { case: 'replace-without-decision', action: 'replace', includeDecision: false },
    { case: 'withdraw-with-decision', action: 'withdraw', includeDecision: true },
  ])('rejects semantic MCP requests before handler execution: $case', async ({ case: key, action, includeDecision }) => {
    const original = request(key)
    const { decision, ...base } = original
    const invalid = { ...base, action, ...(includeDecision ? { decision } : {}) }
    const response = await rpc('save_difference_decision', invalid, 'synthetic-mcp-token')
    expect(response.status).toBe(400)
    expect(response.body.error).toMatchObject({ code: -32602, data: { code: 'invalid_request' } })
  })

  it('preserves the public legacy PATCH payload output and note omission semantics without creating a decision', async () => {
    const target = await insertEnterprise({ name: '旧标注兼容企业', nameNorm: '旧标注兼容企业', usccNorm: 'LEGACY-COMPAT-102' })
    await db.insert(record).values({ enterpriseId: target.id, titleCode: 'innovative_sme', source: 'jxj' })
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
    const first = await insertEnterprise({ name: '旧标注同名甲', nameNorm: '旧标注同名', usccNorm: 'EXACT-AMBIGUOUS-102' })
    const second = await insertEnterprise({ name: '旧标注同名乙', nameNorm: '旧标注同名' })
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
    const target = await insertEnterprise({ name: '标注接管边界企业', nameNorm: '标注接管边界企业', usccNorm: 'ADOPT-COMPAT-102' })
    const historical = await insertDecision({ enterpriseId: target.id, titleCode: 'specialized_sme', direction: 'missing_in_miit', status: 'needs_review', reasonNote: '未接管的正式旧解释', recordedAt: '2026-10-01T00:00:00Z' })
    const legacy = { uscc: target.usccNorm, nameNorm: target.nameNorm, titleCode: 'specialized_sme', direction: 'missing_in_miit', curated: true, note: '原标注保留' }
    const patch = (body: unknown) => fetch(service.baseUrl + '/api/comparison/curated', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect(await json(await patch(legacy))).toEqual({ curated: true })
    expect((await json(await fetch(api(String(historical.id))))).reasonNote).toBe('未接管的正式旧解释')
    const adoptedResponse = await post({ ...request('compat-explicit-adopt', historical.id), enterpriseId: target.id, decision: { status: 'needs_review', measureCode: 'manual_review', verificationStatus: 'pending' } })
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
    const sourcePath = service.baseUrl + '/api/platform/queries?queryId=' + query.id
    const originalSource = await json(await fetch(sourcePath))
    expect(originalSource.rows[0].query.id).toBe(query.id)
    const a = request('race-a', before.versionId), b = request('race-b', before.versionId)
    const raced = await Promise.all([post(a), post(b)])
    expect(raced.map(r => r.status).sort()).toEqual([200,409])
    const winner = await json(raced.find(r => r.status === 200)!)
    expect(await json(raced.find(r => r.status === 409)!)).toMatchObject({ error: { code: 'stale_version' } })
    const replay = raced[0]!.status === 200 ? a : b
    expect(value(await rpc('save_difference_decision', replay, 'synthetic-mcp-token'))).toEqual(winner)
    expect((await post({ ...replay, basis: 'different request' })).status).toBe(409)
    const failure = request('rollback', winner.versionId)
    await rejectDecision('rollback', 'synthetic transaction fault')
    try {
      const response = await post(failure)
      expect(response.status).toBe(500)
      expect(await json(response)).toMatchObject({ error: { code: 'transaction_failed' } })
      expect((await json(await fetch(api('current?' + scope)))).versionId).toBe(winner.versionId)
      expect((await json(await fetch(api('history?' + scope)))).total).toBe(4)
    } finally { await removeDecisionRejection() }
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
    expect(await json(await fetch(sourcePath))).toEqual(originalSource)
    expect(JSON.stringify(originalSource)).not.toContain('SYNTHETIC_RAW_UNCHANGED')
  })

  it('previews exact legacy mappings and conflicts without promoting reviewed annotations or modifying either store', async () => {
    const duplicate1 = await insertEnterprise({ name: '同名甲', nameNorm: '同名' })
    await insertEnterprise({ name: '同名乙', nameNorm: '同名' })
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
    const other = await insertEnterprise({ name: '旧决定企业', nameNorm: '旧决定企业', usccNorm: 'LEGACY102' })
    const original = await insertDecision({ enterpriseId: other.id, titleCode: 'specialized_sme', direction: 'missing_in_miit', status: 'needs_review', recordedAt: '2099-01-01T00:00:00Z', reasonNote: '不可删除的旧原因' })
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
    const wrong = (await seedPostgresPlatformQuery(db, { interface: 'business_list', queryKey: 'OTHER-SUBJECT', rdjb: '3', titleCode: 'little_giant', queriedAt: '2026-10-19', status: 'success', rawResponse: 'Explicit synthetic empty source' })).queryId
    const bad = { ...request('wrong-evidence', before.versionId), decision: { ...request('x').decision, evidenceQueryId: wrong } }
    const rejected = await post(bad)
    expect(rejected.status).toBe(422)
    expect(await json(rejected)).toMatchObject({ error: { code: 'evidence_mismatch' } })
    const stale = await rpc('save_difference_decision', request('mcp-stale', null), 'synthetic-mcp-token')
    expect(stale.body.result.isError).toBe(true)
    expect(value(stale)).toMatchObject({ error: { code: 'stale_version' } })
    const invalid = await rpc('save_difference_decision', { ...request('mcp-unknown', before.versionId), arbitrary: 'not a field' }, 'synthetic-mcp-token')
    expect(invalid.status).toBe(400)
    expect(invalid.body.error.data.code).toBe('invalid_request')
    await rejectDecision('mcp-fault', 'SYNTHETIC_INTERNAL_SECRET')
    try {
      const failed = await rpc('save_difference_decision', request('mcp-fault', before.versionId), 'synthetic-mcp-token')
      expect(failed.body.result.isError).toBe(true)
      expect(value(failed)).toMatchObject({ error: { code: 'transaction_failed' } })
      expect(JSON.stringify(failed)).not.toMatch(/SYNTHETIC_INTERNAL_SECRET|INSERT INTO|insert into|synthetic-api-token/)
    } finally { await removeDecisionRejection() }
    expect(await json(await fetch(api('current?' + scope)))).toEqual(before)
  })

  it('discovers full HTTP and MCP contracts and disables writes when tokens are unconfigured', async () => {
    const spec = await json(await Promise.resolve(new Response(JSON.stringify(await readDevelopmentDiscovery()))))
    const commandSchema = spec.paths['/api/roster/decision-lifecycle/commands'].post.requestBody.content['application/json'].schema
    expect(commandSchema.required).toEqual(expect.arrayContaining(['action','expectedCurrentId','actor','basis','ruleVersion','effectiveAt','idempotencyKey']))
    expect(commandSchema.properties.action.enum).toEqual(['replace','withdraw','maintain'])
    expect(commandSchema.properties.reviewedEvidence).toMatchObject({ type: 'object', additionalProperties: false, required: ['latestRevisionId','projectionReady'], properties: { latestRevisionId: { type: 'integer', minimum: 0 }, projectionReady: { type: 'boolean', enum: [true] } } })
    for (const path of ['current','history','legacy-preview','{id}']) expect(spec.paths['/api/roster/decision-lifecycle/' + path].get).toBeTruthy()
    const listResponse = await fetch(service.baseUrl + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) })
    const listRaw = await listResponse.text()
    const list = JSON.parse(listRaw.startsWith('event:') ? listRaw.split('\n').find(line => line.startsWith('data: '))!.slice(6) : listRaw)
    const names = list.result.tools.map((t: any) => t.name)
    expect(names).toEqual(expect.arrayContaining(['get_difference_decision','get_current_difference_decision','list_difference_decision_history','preview_legacy_difference_decisions']))
    expect(names).not.toContain('save_difference_decision')
    for (const retired of ['list_evidence_impacts', 'get_evidence_impact', 'preview_evidence_impacts',
      'list_evidence_impact_sources', 'list_evidence_revision_events', 'process_evidence_impacts', 'release_evidence_rule']) {
      expect(names).not.toContain(retired)
    }
    expect(Object.keys(spec.paths).filter(path => /^\/api\/roster\/evidence-(impacts|review)(?:\/|$)/.test(path))).toEqual([])
    const cwd = resolve(import.meta.dirname, '../../..'); const port = await reserveLoopbackPort()
    const child = spawnCompiledApp(port, { cwd, stdio: ['ignore','pipe','pipe'], env: { ...process.env, NUXT_BUILD_DIR: join(dir,'no-token-build'), ...postgres.env, NUXT_DB_READONLY: '0', NUXT_API_TOKEN: '', NUXT_MCP_TOKEN: '', NUXT_CURATED_PATH: curatedPath, NUXT_FILES_DIR: join(dir,'files'), NUXT_INCOMING_DIR: join(dir,'incoming') } })
    let output = ''; for (const stream of [child.stdout,child.stderr]) stream.on('data', data => { output = (output + data).slice(-4000) })
    const base = `http://127.0.0.1:${port}`
    try {
      try { await waitForHttp(base + '/api/roster/differences', { timeoutMs: 60000, child }) } catch(e) { throw new Error(String(e) + output) }
      expect((await fetch(base + '/api/roster/decision-lifecycle/current?' + scope)).status).toBe(200)
      expect((await fetch(base + '/api/roster/decision-lifecycle/commands', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-api-token' }, body: JSON.stringify(request('no-token')) })).status).toBe(401)
      expect((await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer synthetic-mcp-token' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'save_difference_decision', arguments: request('no-token') } }) })).status).toBe(401)
    } finally { await stopOwnedChild(child) }
  }, 90000)

  it('rechecks lifecycle ownership inside legacy import execution and preserves failed receipts across atomic rollback and retry', async () => {
    const target = await insertEnterprise({ name: '执行期接管企业', nameNorm: '执行期接管企业', usccNorm: 'RACE102' })
    await installImportRace('import-race-102', target.id)
    const body = { idempotencyKey: 'legacy-execution-race', sourceKind: 'alias_evidence', sourceIdentity: 'synthetic/race', payload: { platformQueries: [{ interface: 'apply_list', queryKey: 'import-race-102', rawResponse: 'Explicit synthetic empty source', rdjb: '2', queriedAt: '2026-10-19T00:00:00Z', status: 'no_record' }], differences: [{ enterpriseName: target.name, uscc: target.usccNorm, titleCode: 'specialized_sme', direction: 'missing_in_miit', recordedAt: '2199-01-01T00:00:00Z', status: 'confirmed_no_diff', measureCode: 'none', verificationStatus: 'confirmed' }] } }
    const submit = () => fetch(service.baseUrl + '/api/roster/import/commit', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-api-token' }, body: JSON.stringify(body) })
    const receipt = async (suffix: string) => json(await fetch(service.baseUrl + '/api/roster/import/receipts' + suffix, { headers: { authorization: 'Bearer synthetic-api-token' } }))
    let failed: any
    try {
      const response = await submit()
      const result = await json(response)
      expect(result.status).toBe('failed')
      expect(result.items).toEqual(expect.arrayContaining([expect.objectContaining({ error: expect.objectContaining({ code: 'decision_lifecycle_required' }) })]))
      expect((await json(await fetch(api('history?enterpriseId=' + target.id + '&titleCode=specialized_sme&direction=missing_in_miit')))).total).toBe(0)
      expect((await db.execute(sql`select count(*)::int as n from platform_collection where query_key='import-race-102'`)).rows).toEqual([{ n: 0 }])
      failed = await receipt('?idempotencyKey=' + body.idempotencyKey)
      expect(failed).toMatchObject({ status: 'failed', receiptId: expect.any(Number) })
      expect((await receipt('/items?receiptId=' + failed.receiptId)).rows).toEqual(expect.arrayContaining([expect.objectContaining({ ok: false, errorCode: 'decision_lifecycle_required' })]))
      expect(value(await rpc('get_roster_import_receipt', { receiptId: failed.receiptId }, 'synthetic-mcp-token'))).toEqual(failed)
    } finally { await removeImportRace() }
    expect(await json(await submit())).toMatchObject({ status: 'committed', batchId: failed.batchId })
    expect((await json(await fetch(api('current?enterpriseId=' + target.id + '&titleCode=specialized_sme&direction=missing_in_miit')))).current.status).toBe('confirmed_no_diff')
    const committed = await receipt('?batchId=' + failed.batchId)
    expect(committed).toMatchObject({ status: 'committed', receiptId: expect.any(Number) })
    expect(committed.receiptId).not.toBe(failed.receiptId)
    expect(await receipt('?receiptId=' + failed.receiptId)).toEqual(failed)
    expect(await receipt('/history?batchId=' + failed.batchId)).toMatchObject({ total: 2, rows: [{ status: 'failed' }, { status: 'committed' }] })
    expect(await json(await submit())).toMatchObject({ status: 'committed', batchId: failed.batchId })
    expect(await receipt('/history?batchId=' + failed.batchId)).toMatchObject({ total: 2 })
  })
  it.each([
    { case: 'managed-source-collision', side: 'source', clash: true },
    { case: 'managed-target-collision', side: 'target', clash: true },
    { case: 'managed-source-reassignment', side: 'source', clash: false },
    { case: 'adopted-target-coordinate', side: 'target', clash: false },
  ])('rejects identity merges affecting lifecycle history: $case', async ({ case: caseId, side, clash }) => {
    const source = await insertEnterprise({ name: caseId + '源', nameNorm: caseId + '源' })
    const target = await insertEnterprise({ name: caseId + '目标', nameNorm: caseId + '目标', usccNorm: 'MERGE-' + caseId.toUpperCase() })
    const managed = side === 'source' ? source : target
    const legacy = side === 'source' ? target : source
    const command = { ...request(caseId), enterpriseId: managed.id, decision: { status: 'needs_review', measureCode: 'manual_review', verificationStatus: 'pending' } }
    const saved = await post(command)
    expect(saved.status).toBe(200)
    const originalReceipt = await json(saved)
    const historical = await insertDecision({ enterpriseId: legacy.id, titleCode: 'specialized_sme', direction: 'missing_in_miit', status: 'needs_review', measureCode: 'manual_review', verificationStatus: 'pending', recordedAt: clash ? originalReceipt.recordedAt : '2199-01-01T00:00:00Z' })
    const readScope = async (id: number, path: string) => json(await fetch(api(path + '?enterpriseId=' + id + '&titleCode=specialized_sme&direction=missing_in_miit')))
    const originals = await Promise.all([json(await fetch(api(String(originalReceipt.versionId)))), json(await fetch(api(String(historical.id))))])
    const histories = await Promise.all([readScope(source.id, 'history'), readScope(target.id, 'history')])
    const merge = { idempotencyKey: 'merge-' + caseId, sourceKind: 'alias_evidence', sourceIdentity: 'synthetic/merge-history', payload: { merges: [{ fromEnterpriseId: source.id, intoUscc: target.usccNorm, sourceKind: 'manual' }] } }
    const submit = (action: string, body: unknown = merge) => fetch(service.baseUrl + '/api/roster/import/' + action, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-api-token' }, body: JSON.stringify(body) })
    const preflight = await json(await submit('preflight'))
    expect(preflight.preflight.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ error: expect.objectContaining({ code: 'merge_difference_lifecycle_conflict', message: expect.stringContaining(String(originalReceipt.versionId)) }) })]))
    const result = await json(await submit('commit'))
    expect(result).toMatchObject({ status: 'failed', summary: { written: 0 } })
    expect(result.items).toEqual(expect.arrayContaining([expect.objectContaining({ error: expect.objectContaining({ code: 'merge_difference_lifecycle_conflict' }) })]))
    expect(await json(await fetch(api(String(originalReceipt.versionId))))).toEqual(originals[0])
    expect(await json(await fetch(api(String(historical.id))))).toEqual(originals[1])
    expect(await Promise.all([readScope(source.id, 'history'), readScope(target.id, 'history')])).toEqual(histories)
    const replay = await post(command)
    expect(replay.status).toBe(200)
    expect(await json(replay)).toEqual(originalReceipt)
    const legacyWrite = { ...merge, idempotencyKey: 'legacy-after-' + caseId, payload: { differences: [{ enterpriseName: managed.name, titleCode: 'specialized_sme', direction: 'missing_in_miit', status: 'needs_review', recordedAt: '2299-01-01T00:00:00Z' }] } }
    expect((await json(await submit('commit', legacyWrite))).items).toEqual(expect.arrayContaining([expect.objectContaining({ error: expect.objectContaining({ code: 'decision_lifecycle_required' }) })]))
  })

  it('rolls back an execution-time managed merge collision and retains the failed receipt after safe retry', async () => {
    const source = await insertEnterprise({ name: '归并执行竞态源', nameNorm: '归并执行竞态源' })
    const target = await insertEnterprise({ name: '归并执行竞态目标', nameNorm: '归并执行竞态目标', usccNorm: 'MERGE-RACE-102' })
    const legacy = await insertDecision({ enterpriseId: source.id, titleCode: 'specialized_sme', direction: 'missing_in_miit', status: 'needs_review', recordedAt: '2099-01-01T00:00:00Z' })
    const original = await json(await fetch(api(String(legacy.id))))
    const body = { idempotencyKey: 'merge-execution-race-102', sourceKind: 'alias_evidence', sourceIdentity: 'synthetic/merge-race', payload: { platformQueries: [{ interface: 'apply_list', queryKey: 'merge-race-102', rawResponse: 'Explicit synthetic empty source', rdjb: '2', queriedAt: '2026-10-19T00:00:00Z', status: 'no_record' }], merges: [{ fromEnterpriseId: source.id, intoUscc: target.usccNorm, sourceKind: 'manual' }] } }
    const submit = (action: string) => fetch(service.baseUrl + '/api/roster/import/' + action, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-api-token' }, body: JSON.stringify(body) })
    const receipt = async (suffix: string) => json(await fetch(service.baseUrl + '/api/roster/import/receipts' + suffix, { headers: { authorization: 'Bearer synthetic-api-token' } }))
    expect((await json(await submit('preflight'))).preflight.conflicts).toEqual([])
    await installImportRace('merge-race-102', target.id)
    let failed: any
    try {
      const result = await json(await submit('commit'))
      expect(result).toMatchObject({ status: 'failed', summary: { written: 0 } })
      expect(result.items).toEqual(expect.arrayContaining([expect.objectContaining({ error: expect.objectContaining({ code: 'merge_difference_lifecycle_conflict' }) })]))
      expect(await json(await fetch(api(String(legacy.id))))).toEqual(original)
      expect(await json(await fetch(api('history?enterpriseId=' + target.id + '&titleCode=specialized_sme&direction=missing_in_miit')))).toMatchObject({ total: 0, rows: [] })
      expect(await json(await fetch(service.baseUrl + '/api/platform/queries?queryKey=merge-race-102'))).toMatchObject({ total: 0, rows: [] })
      failed = await receipt('?idempotencyKey=' + body.idempotencyKey)
      expect(failed).toMatchObject({ status: 'failed', receiptId: expect.any(Number) })
      expect((await receipt('/items?receiptId=' + failed.receiptId)).rows).toEqual(expect.arrayContaining([expect.objectContaining({ errorCode: 'merge_difference_lifecycle_conflict' })]))
    } finally { await removeImportRace() }
    expect(await json(await submit('commit'))).toMatchObject({ status: 'committed', batchId: failed.batchId })
    expect(await json(await fetch(api(String(legacy.id))))).toMatchObject({ id: legacy.id, enterpriseId: target.id, origin: 'legacy_import' })
    expect(await receipt('?receiptId=' + failed.receiptId)).toEqual(failed)
    expect(await receipt('/history?batchId=' + failed.batchId)).toMatchObject({ rows: [{ status: 'preflight' }, { status: 'failed' }, { status: 'committed' }] })
  })

  it('keeps legacy merge deduplication and reassignment compatible outside the adopted target coordinate', async () => {
    const source = await insertEnterprise({ name: '兼容归并源', nameNorm: '兼容归并源' })
    const target = await insertEnterprise({ name: '兼容归并目标', nameNorm: '兼容归并目标', usccNorm: 'MERGE-COMPAT-102' })
    const command = { ...request('merge-unrelated-managed'), enterpriseId: target.id, titleCode: 'little_giant', direction: 'extra_in_miit', decision: { status: 'needs_review', measureCode: 'manual_review', verificationStatus: 'pending' } }
    const originalReceipt = await json(await post(command))
    expect(originalReceipt.versionId).toEqual(expect.any(Number))
    const original = await json(await fetch(api(String(originalReceipt.versionId))))
    const content = { titleCode: 'specialized_sme', direction: 'missing_in_miit' as const, status: 'needs_review' as const, recordedAt: '2026-01-01T00:00:00Z' }
    const duplicate = await insertDecision({ ...content, enterpriseId: source.id })
    const survivor = await insertDecision({ ...content, enterpriseId: target.id })
    const moved = await insertDecision({ ...content, enterpriseId: source.id, titleCode: 'innovative_sme' })
    const body = { idempotencyKey: 'merge-legacy-compatible-102', sourceKind: 'alias_evidence', sourceIdentity: 'synthetic/compatible', payload: { merges: [{ fromEnterpriseId: source.id, intoUscc: target.usccNorm, sourceKind: 'manual' }] } }
    const response = await fetch(service.baseUrl + '/api/roster/import/commit', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-api-token' }, body: JSON.stringify(body) })
    expect(await json(response)).toMatchObject({ status: 'committed', summary: { written: 1 } })
    expect((await fetch(api(String(duplicate.id)))).status).toBe(404)
    expect(await json(await fetch(api(String(survivor.id))))).toMatchObject({ id: survivor.id, enterpriseId: target.id, origin: 'legacy_import' })
    expect(await json(await fetch(api(String(moved.id))))).toMatchObject({ id: moved.id, enterpriseId: target.id, origin: 'legacy_import' })
    expect(await json(await fetch(api(String(originalReceipt.versionId))))).toEqual(original)
    expect(await json(await post(command))).toEqual(originalReceipt)
  })

  it('bounds scoped history and legacy preview while unrelated large raw evidence is never materialized', async () => {
    const other = await insertEnterprise({ name: '性能夹具企业', nameNorm: '性能夹具企业' })
    const hugeReason = '原始历史长说明'.repeat(2000)
    await db.insert(differenceReason).values(Array.from({ length: 200 }, (_, n): typeof differenceReason.$inferInsert => ({
      enterpriseId: other.id, titleCode: 'specialized_sme', direction: 'extra_in_miit',
      status: 'needs_review', reasonNote: hugeReason,
      recordedAt: '2026-' + String(n).padStart(4, '0'), createdAt: '2026-01-01',
    })))
    await seedPostgresPlatformQuery(db, { interface: 'apply_list', queryKey: 'unrelated102', rdjb: '2', queriedAt: '2026-10-19', status: 'success', rawResponse: 'LARGE_RAW_UNRELATED'.repeat(400000) })
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
    await db.execute(sql`ANALYZE difference_reason`)
    const plan = await db.execute(sql`EXPLAIN (COSTS OFF) SELECT id FROM difference_reason
     WHERE enterprise_id=${other.id} AND title_code='specialized_sme' AND direction='extra_in_miit'
     ORDER BY recorded_at DESC,id DESC LIMIT 50 OFFSET 50`)
    expect(JSON.stringify(plan.rows)).toContain('Index Only Scan Backward using difference_reason_impact_head_113_idx')
    expect(JSON.stringify(plan.rows)).not.toContain('Sort')
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
