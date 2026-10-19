import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { useDb, schema } from '../db/client'
import { minimalPdf } from './helpers/minimal-pdf'
import { reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../scripts/lib/isolated-local-services.mjs'

const dir = mkdtempSync(join(tmpdir(), 'evidence-correction-101-'))
const dbPath = join(dir, 'synthetic.db')
const filesDir = join(dir, 'files')
mkdirSync(filesDir)
const bytes = minimalPdf({ pages: 3 })
writeFileSync(join(filesDir, 'notice.pdf'), bytes)
const sha256 = createHash('sha256').update(bytes).digest('hex')
const db = useDb({ dbPath })
const file = db.insert(schema.storedFile).values({ relPath: 'notice.pdf', filename: 'notice.pdf', ext: 'pdf', bytes: Buffer.byteLength(bytes), sha256, source: 'jxj', kind: 'announcement' }).returning().get()
const enterprise = db.insert(schema.enterprise).values({ name: '合成出处核对企业', nameNorm: '合成出处核对企业' }).returning().get()
const record = db.insert(schema.record).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', source: 'jxj' }).returning().get()
const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2022 }).returning().get()
const seedEvidence = (listNo: number) => db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: 'notice.pdf', attachment: '附件1', listNo, page: 1 }).returning().get()
const evidence = seedEvidence(6)
let service: { baseUrl: string; stop: () => Promise<void> }
const api = (path: string) => `${service.baseUrl}/api/roster/${path}`
const post = (path: string, body: unknown, authorized = true) => fetch(api(path), { method: 'POST', headers: { 'content-type': 'application/json', ...(authorized ? { authorization: 'Bearer synthetic-api-token' } : {}) }, body: JSON.stringify(body) })
const json = (r: Response): Promise<any> => r.json()
const read = (id: number) => fetch(api(`evidence/${id}`)).then(json)
function request(key: string, row: any, page = 3) { return { idempotencyKey: key, actor: { type: 'agent', id: 'synthetic-reviewer' }, basis: '逐页核对原始公布附件及名单行', operations: [{ evidenceId: row.evidenceId, eventId: row.eventId, recordId: row.recordId, enterpriseId: row.enterpriseId, expectedVersion: row.version, coordinate: { sourceFile: 'notice.pdf', attachment: '附件1', listNo: row.coordinate.listNo, page } }] } }
async function rpc(method: string, params?: Record<string, unknown>, authorized = true) {
  const response = await fetch(`${service.baseUrl}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...(authorized ? { authorization: 'Bearer synthetic-mcp-token' } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const raw = await response.text()
  const payload = raw.startsWith('event:') ? raw.split('\n').find(line => line.startsWith('data: '))?.slice(6) : raw
  return { status: response.status, body: JSON.parse(payload!) }
}
const mcpValue = (r: any) => JSON.parse(r.body.result.content[0].text)
beforeAll(async () => {
  const cwd = resolve(import.meta.dirname, '..')
  const port = await reserveLoopbackPort()
  const child = spawn(process.execPath, [join(cwd, 'node_modules/nuxt/bin/nuxt.mjs'), 'dev', '--host', '127.0.0.1', '--port', String(port)], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NUXT_BUILD_DIR: join(dir, 'nuxt-build'), NUXT_DB_PATH: dbPath, NUXT_API_TOKEN: 'synthetic-api-token', NUXT_MCP_TOKEN: 'synthetic-mcp-token', NUXT_FILES_DIR: filesDir, NUXT_INCOMING_DIR: join(dir, 'incoming') } })
  let startupOutput = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { startupOutput = (startupOutput + data).slice(-8000) })
  service = { baseUrl: `http://127.0.0.1:${port}`, stop: () => stopOwnedChild(child) }
  try { await waitForHttp(`${service.baseUrl}/api/stats`, { timeoutMs: 60000, child }) } catch (error) { await service.stop(); throw new Error(`${String(error)}\n${startupOutput}`) }
}, 90000)
afterAll(async () => { if (service) await service.stop(); rmSync(dir, { recursive: true, force: true }) })

describe('ticket 101 exact evidence correction through HTTP and MCP', () => {
  it('preflights the exact evidence and event with old and new coordinates and file identity', async () => {
    const response = await fetch(api(`evidence/${evidence.id}`))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    const row = await json(response)
    expect(row).toMatchObject({ evidenceId: evidence.id, eventId: event.id, recordId: record.id, enterpriseId: enterprise.id, coordinate: { sourceFile: 'notice.pdf', attachment: '附件1', listNo: 6, page: 1 }, file: { id: file.id, sha256 } })
    const result = await post('evidence/corrections/preflight', request('first-plan', row))
    expect(result.status).toBe(200)
    const plan = await json(result)
    expect(plan).toMatchObject({ status: 'preflight', impact: { updated: 1, audit: 1 }, targets: [{ evidenceId: evidence.id, eventId: event.id, before: { page: 1 }, after: { page: 3 }, file: { id: file.id, sha256, pageCount: 3 } }] })
    expect(plan.planHash).toMatch(/^[a-f0-9]{64}$/)
    expect((await read(evidence.id)).coordinate.page).toBe(1)
  })
  it('commits atomically with stable IDs and durable audit receipt and replay', async () => {
    const target = seedEvidence(7)
    const row = await read(target.id)
    const req = request('commit-audit', row)
    const plan = await json(await post('evidence/corrections/preflight', req))
    const result = await post('evidence/corrections/commit', { request: req, planHash: plan.planHash })
    expect(result.status).toBe(200)
    const receipt = await json(result)
    expect(receipt).toMatchObject({ status: 'committed', evidenceIds: [target.id], impact: { updated: 1, audit: 1 } })
    expect(await json(await post('evidence/corrections/commit', { request: req, planHash: plan.planHash }))).toEqual(receipt)
    const after = await read(target.id)
    expect(after).toMatchObject({ evidenceId: target.id, eventId: event.id, recordId: record.id, enterpriseId: enterprise.id, coordinate: { page: 3 } })
    expect(after.version).not.toBe(row.version)
    expect(after.sourceHref).toContain('page=3')
    const audit = await json(await fetch(api('evidence/' + target.id + '/audit')))
    expect(audit).toMatchObject({ total: 1, rows: [{ evidenceId: target.id, eventId: event.id, actor: req.actor, basis: req.basis, before: { coordinate: { page: 1 } }, after: { coordinate: { page: 3 } }, entryPoint: 'correction' }] })
    expect(audit.rows[0].createdAt).toMatch(/^20/)
    expect(createHash('sha256').update(readFileSync(join(filesDir, 'notice.pdf'))).digest('hex')).toBe(sha256)
    const recovered = await fetch(api('evidence/corrections/batches/commit-audit'), { headers: { authorization: 'Bearer synthetic-api-token' } })
    expect(await json(recovered)).toEqual(receipt)
  })

  it('exposes equivalent authenticated correction tools and bounded audit over real MCP', async () => {
    const target = seedEvidence(8)
    const listed = await rpc('tools/list', {}, false)
    expect(listed.body.result.tools.map((t: any) => t.name)).toContain('get_roster_evidence')
    expect(listed.body.result.tools.map((t: any) => t.name)).not.toContain('commit_roster_evidence_corrections')
    const row = mcpValue(await rpc('tools/call', { name: 'get_roster_evidence', arguments: { id: target.id } }, false))
    expect(row).toEqual(await read(target.id))
    const req = request('mcp-commit', row, 2)
    expect((await rpc('tools/call', { name: 'preflight_roster_evidence_corrections', arguments: req }, false)).status).toBe(401)
    const plan = mcpValue(await rpc('tools/call', { name: 'preflight_roster_evidence_corrections', arguments: req }))
    expect(plan).toEqual(await json(await post('evidence/corrections/preflight', req)))
    const receipt = mcpValue(await rpc('tools/call', { name: 'commit_roster_evidence_corrections', arguments: { request: req, planHash: plan.planHash } }))
    expect(mcpValue(await rpc('tools/call', { name: 'get_roster_evidence_correction_batch', arguments: { idempotencyKey: req.idempotencyKey } }))).toEqual(receipt)
    const audit = mcpValue(await rpc('tools/call', { name: 'get_roster_evidence_audit', arguments: { id: target.id, pageSize: 1 } }, false))
    expect(audit).toMatchObject({ total: 1, pageSize: 1, rows: [{ before: { coordinate: { page: 1 } }, after: { coordinate: { page: 2 } } }] })
    expect(audit).toEqual(await json(await fetch(api('evidence/' + target.id + '/audit?pageSize=1'))))
  })

  it('keeps legacy partial application and records the same coordinate audit', async () => {
    const target = seedEvidence(9)
    const result = await post('evidence/pages', { entries: [
      { sourceFile: 'notice.pdf', listNo: 9, page: 2, enterpriseId: enterprise.id, basis: '旧入口已核对页图' },
      { sourceFile: 'notice.pdf', listNo: 9, page: 3 },
    ] })
    expect(result.status).toBe(200)
    expect(await json(result)).toMatchObject({ status: 'applied', summary: { requested: 2, assigned: 1, written: 1, pending: 1 }, pending: [{ reason: 'entry_incomplete' }] })
    expect((await read(target.id)).coordinate.page).toBe(2)
    const audit = await json(await fetch(api('evidence/' + target.id + '/audit')))
    expect(audit).toMatchObject({ total: 1, rows: [{ entryPoint: 'legacy_pages', basis: '旧入口已核对页图', before: { coordinate: { page: 1 } }, after: { coordinate: { page: 2 } } }] })
    const again = await post('evidence/pages', { entries: [{ sourceFile: 'notice.pdf', listNo: 9, page: 2, enterpriseId: enterprise.id }] })
    expect(await json(again)).toMatchObject({ summary: { written: 0, unchanged: 1 } })
    expect((await json(await fetch(api('evidence/' + target.id + '/audit')))).total).toBe(1)
  })

  it('rejects bare locators mismatched owners and missing basis without changing evidence', async () => {
    const target = seedEvidence(10), row = await read(target.id)
    const req = request('invalid-locator', row)
    for (const bad of [{ ...req, basis: ' ' }, { ...req, operations: [{ listNo: 10, page: 2 }] }, { ...req, operations: [{ ...req.operations[0], evidenceId: undefined }] }]) {
      expect((await post('evidence/corrections/preflight', bad)).status).toBe(400)
    }
    for (const field of ['eventId', 'recordId', 'enterpriseId']) {
      const bad = { ...req, operations: [{ ...req.operations[0], [field]: 999999 }] }
      expect(await json(await post('evidence/corrections/preflight', bad))).toMatchObject({ error: { code: 'target_mismatch' } })
    }
    expect(await read(target.id)).toEqual(row)
    expect((await fetch(api('evidence/999999'))).status).toBe(404)
  })
  it('validates PDF limits file identity and declared attachments and changes all coordinate fields', async () => {
    const target = seedEvidence(11), row = await read(target.id)
    const req = request('source-repoint', row, 4)
    expect(await json(await post('evidence/corrections/preflight', req))).toMatchObject({ error: { code: 'page_invalid' } })
    const nextBytes = minimalPdf({ pages: 2 })
    writeFileSync(join(filesDir, 'corrected.pdf'), nextBytes)
    const nextHash = createHash('sha256').update(nextBytes).digest('hex')
    const nextFile = db.insert(schema.storedFile).values({ relPath: 'corrected.pdf', filename: 'corrected.pdf', ext: 'pdf', bytes: Buffer.byteLength(nextBytes), sha256: nextHash, source: 'jxj', kind: 'announcement' }).returning().get()
    db.insert(schema.storedFilePart).values({ fileId: nextFile.id, titleCode: 'specialized_sme', eventKind: 'award', year: 2022, batch: null, attachment: '附件2', origin: 'agent' }).run()
    req.operations[0]!.coordinate = { sourceFile: 'corrected.pdf', attachment: '附件1', listNo: 22, page: 2 }
    expect(await json(await post('evidence/corrections/preflight', req))).toMatchObject({ error: { code: 'attachment_conflict' } })
    req.operations[0]!.coordinate.attachment = '附件二'
    db.$client.prepare('UPDATE stored_file_part SET has_conflict = 1 WHERE file_id = ?').run(nextFile.id)
    expect(await json(await post('evidence/corrections/preflight', req))).toMatchObject({ error: { code: 'attachment_conflict' } })
    db.$client.prepare('UPDATE stored_file_part SET has_conflict = 0 WHERE file_id = ?').run(nextFile.id)
    const plan = await json(await post('evidence/corrections/preflight', req))
    expect(plan.targets[0].after).toEqual({ sourceFile: 'corrected.pdf', attachment: '附件2', listNo: 22, page: 2 })
    expect((await post('evidence/corrections/commit', { request: req, planHash: plan.planHash })).status).toBe(200)
    const after = await read(target.id)
    expect(after).toMatchObject({ evidenceId: target.id, eventId: event.id, coordinate: { sourceFile: 'corrected.pdf', attachment: '附件2', listNo: 22, page: 2 }, file: { id: nextFile.id, sha256: nextHash } })
    const href = new URL(after.sourceHref, service.baseUrl)
    expect(href.searchParams.get('file')).toBe('corrected.pdf')
    expect(href.searchParams.get('page')).toBe('2')
    const source = await fetch(service.baseUrl + '/api/files/corrected.pdf')
    expect(source.status).toBe(200)
    expect(createHash('sha256').update(Buffer.from(await source.arrayBuffer())).digest('hex')).toBe(nextHash)
    req.operations[0] = { ...req.operations[0]!, expectedVersion: after.version }
    writeFileSync(join(filesDir, 'corrected.pdf'), minimalPdf({ pages: 3 }))
    expect(await json(await post('evidence/corrections/preflight', req))).toMatchObject({ error: { code: 'file_changed' } })
    writeFileSync(join(filesDir, 'corrected.pdf'), nextBytes)
  })
  it('rejects database and same batch coordinate conflicts and duplicate evidence IDs atomically', async () => {
    const a = seedEvidence(12), b = seedEvidence(13)
    const ar = await read(a.id), br = await read(b.id)
    const req = request('coordinate-conflicts', ar, 2)
    req.operations[0]!.coordinate.listNo = 13
    expect(await json(await post('evidence/corrections/preflight', req))).toMatchObject({ error: { code: 'coordinate_conflict' } })
    req.operations = [...request('a', ar, 2).operations, ...request('b', br, 2).operations]
    req.operations[0]!.coordinate.listNo = 900
    req.operations[1]!.coordinate.listNo = 900
    expect(await json(await post('evidence/corrections/preflight', req))).toMatchObject({ error: { code: 'coordinate_conflict' } })
    req.operations = [...request('a', ar, 2).operations, ...request('a', ar, 2).operations]
    expect(await json(await post('evidence/corrections/preflight', req))).toMatchObject({ error: { code: 'ambiguous_target' } })
    expect(await read(a.id)).toEqual(ar)
    expect(await read(b.id)).toEqual(br)
  })
  it('serializes competing commits and detects external connection changes and key reuse', async () => {
    const target = seedEvidence(14), row = await read(target.id)
    const a = request('race-a', row, 2), b = request('race-b', row, 3)
    const ap = await json(await post('evidence/corrections/preflight', a)), bp = await json(await post('evidence/corrections/preflight', b))
    const responses = await Promise.all([post('evidence/corrections/commit', { request: a, planHash: ap.planHash }), post('evidence/corrections/commit', { request: b, planHash: bp.planHash })])
    expect(responses.map(r => r.status).sort()).toEqual([200, 409])
    expect((await json(await fetch(api('evidence/' + target.id + '/audit')))).total).toBe(1)
    const current = await read(target.id), req = request('external-stale', current, 1)
    const plan = await json(await post('evidence/corrections/preflight', req))
    const connection = new Database(dbPath)
    try { connection.prepare('UPDATE record_event SET decided_year = 2023 WHERE id = ?').run(event.id) } finally { connection.close() }
    expect(await json(await post('evidence/corrections/commit', { request: req, planHash: plan.planHash }))).toMatchObject({ error: { code: 'stale_version' } })
    expect((await read(target.id)).coordinate.page).toBe(current.coordinate.page)
    const winner = responses[0]!.status === 200 ? a : b, winnerPlan = responses[0]!.status === 200 ? ap : bp
    expect(await json(await post('evidence/corrections/commit', { request: { ...winner, basis: 'different basis' }, planHash: winnerPlan.planHash }))).toMatchObject({ error: { code: 'idempotency_conflict' } })
  })
  it('rolls back every coordinate audit and receipt if a later write fails', async () => {
    const a = seedEvidence(15), b = seedEvidence(16)
    const ar = await read(a.id), br = await read(b.id)
    const req = { ...request('rollback-batch', ar, 2), operations: [...request('a', ar, 2).operations, ...request('b', br, 2).operations] }
    const plan = await json(await post('evidence/corrections/preflight', req))
    db.$client.exec('CREATE TRIGGER fail_evidence_101 BEFORE UPDATE ON record_evidence WHEN NEW.id = ' + b.id + " BEGIN SELECT RAISE(ABORT, 'synthetic fault'); END")
    try { expect((await post('evidence/corrections/commit', { request: req, planHash: plan.planHash })).status).toBe(500) } finally { db.$client.exec('DROP TRIGGER fail_evidence_101') }
    expect(await read(a.id)).toEqual(ar)
    expect(await read(b.id)).toEqual(br)
    for (const id of [a.id, b.id]) expect((await json(await fetch(api('evidence/' + id + '/audit')))).total).toBe(0)
    expect((await fetch(api('evidence/corrections/batches/rollback-batch'), { headers: { authorization: 'Bearer synthetic-api-token' } })).status).toBe(404)
    expect((await post('evidence/corrections/commit', { request: req, planHash: plan.planHash })).status).toBe(200)
  })

  it('marks confirmed related correspondences stale and permits explicit revalidation', async () => {
    const target = seedEvidence(17)
    const query = db.insert(schema.platformQuery).values({ interface: 'business_list', queryKey: 'synthetic-101', rdjb: '2', titleCode: 'specialized_sme', queriedAt: '2026-10-19', status: 'partial' }).returning().get()
    const relation = db.insert(schema.platformRelation).values({ queryId: query.id, sequenceNo: 1, enterpriseId: enterprise.id, nameRaw: enterprise.name, verificationStatus: 'confirmed', matchBasis: 'uscc' }).returning().get()
    const decision = { idempotencyKey: 'edge-before-101', sourceIdentity: 'synthetic/manual-101', actor: { type: 'agent', id: 'test' }, basis: '明确核对公开来源', ruleId: 'manual', ruleVersion: '1', operations: [{ action: 'create', status: 'confirmed', edge: { type: 'event_process', eventId: event.id, relationId: relation.id, role: 'context_only' } }] }
    const edgePlan = await json(await post('correspondences/preflight', decision))
    const edgeReceipt = await json(await post('correspondences/commit', { request: decision, planHash: edgePlan.planHash }))
    const edgeId = edgeReceipt.correspondenceIds[0]
    const edgeRead = () => fetch(api('correspondences/' + edgeId)).then(json)
    expect(await edgeRead()).toMatchObject({ status: 'confirmed', requiresRevalidation: false })
    const req = request('edge-invalidating-correction', await read(target.id), 2)
    const plan = await json(await post('evidence/corrections/preflight', req))
    expect(plan.targets[0].relatedCorrespondences).toBe(1)
    expect((await post('evidence/corrections/commit', { request: req, planHash: plan.planHash })).status).toBe(200)
    const stale = await edgeRead()
    expect(stale).toMatchObject({ status: 'confirmed', requiresRevalidation: true })
    const reconfirm = { ...decision, idempotencyKey: 'edge-after-101', operations: [{ action: 'correct', correspondenceId: edgeId, expectedRevision: stale.revision, edge: decision.operations[0]!.edge }] }
    const replan = await json(await post('correspondences/preflight', reconfirm))
    expect((await post('correspondences/commit', { request: reconfirm, planHash: replan.planHash })).status).toBe(200)
    expect(await edgeRead()).toMatchObject({ status: 'confirmed', requiresRevalidation: false })
    expect((await post('evidence/pages', { entries: [{ sourceFile: 'notice.pdf', listNo: 17, page: 3, enterpriseId: enterprise.id, basis: '人工重核页图' }] })).status).toBe(200)
    expect(await edgeRead()).toMatchObject({ status: 'confirmed', requiresRevalidation: true })
  })
  it('publishes actionable OpenAPI coordinates and rejects unauthenticated or malformed requests', async () => {
    const spec = await json(await fetch(service.baseUrl + '/_openapi.json'))
    const operation = spec.paths['/api/roster/evidence/corrections/preflight'].post.requestBody.content['application/json'].schema.properties.operations.items
    expect(operation.properties.coordinate.required).toEqual(['sourceFile', 'attachment', 'listNo', 'page'])
    expect(operation.properties.expectedVersion.type).toBe('string')
    const row = await read(evidence.id)
    const denied = await post('evidence/corrections/preflight', request('auth-denied', row), false)
    expect(denied.status).toBe(401)
    expect(denied.headers.get('cache-control')).toBe('no-store')
    const malformed = await fetch(api('evidence/corrections/commit'), { method: 'POST', headers: { authorization: 'Bearer synthetic-api-token', 'content-type': 'application/json' }, body: '{invalid' })
    expect(malformed.status).toBe(400)
    expect(malformed.headers.get('cache-control')).toBe('no-store')
    expect(await json(malformed)).toMatchObject({ error: { code: 'invalid_request' } })
    expect((await fetch(api('evidence/' + evidence.id + '/audit?pageSize=201'))).status).toBe(400)
    expect((await post('evidence/corrections/preflight', { ...request('over-limit', row), operations: Array.from({ length: 101 }, () => request('x', row).operations[0]) })).status).toBe(400)
  })

  it('shares registered source validation between legacy dry run apply and exact correction', async () => {
    const target = seedEvidence(18)
    const legacy = { entries: [{ sourceFile: 'notice.pdf', listNo: 18, page: 2, enterpriseId: enterprise.id }] }
    db.$client.prepare('UPDATE stored_file SET sha256 = ? WHERE id = ?').run('0'.repeat(64), file.id)
    try {
      const row = await read(target.id)
      expect(await json(await post('evidence/corrections/preflight', request('source-validation-parity', row, 2)))).toMatchObject({ error: { code: 'file_changed' } })
      for (const dryRun of [true, false]) expect(await json(await post('evidence/pages', { ...legacy, dryRun }))).toMatchObject({ summary: { assigned: 0, written: 0, pending: 1 }, pending: [{ reason: 'ambiguous' }] })
      expect((await read(target.id)).coordinate.page).toBe(1)
    } finally { db.$client.prepare('UPDATE stored_file SET sha256 = ? WHERE id = ?').run(sha256, file.id) }
  })

})
