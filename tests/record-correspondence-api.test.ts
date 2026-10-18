import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { useDb, schema } from '../db/client'
import { handleRecordCorrespondenceRequest } from '../server/utils/record-correspondence-api'
import { dispatchRecordCorrespondenceMcp } from '../server/utils/mcp-record-correspondence'
import { getRecordCorrespondenceAudit, listRecordCorrespondences } from '../server/utils/record-correspondence'
import { startHttpFixture } from './helpers/http-fixture'

const dirs: string[] = []
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'spztx-api-66-')); dirs.push(dir)
  const db = useDb({ dbPath: join(dir, 'isolated.db') })
  const enterprise = db.insert(schema.enterprise).values({ name: '合成甲', nameNorm: '合成甲', usccNorm: '91330211255994457P' }).returning().get()
  const record = db.insert(schema.record).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', source: 'jxj', usccRaw: enterprise.usccNorm }).returning().get()
  const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2022, batchSeq: 1 }).returning().get()
  db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: 'synthetic/notice.pdf', attachment: '附件一', listNo: 9, page: 3 }).run()
  const query = db.insert(schema.platformQuery).values({ interface: 'business_list', queryKey: enterprise.usccNorm!, rdjb: '2', titleCode: 'specialized_sme', queriedAt: '2026-10-18T00:00:00.000Z', status: 'partial', rawResponse: 'SECRET-RAW' }).returning().get()
  const relation = db.insert(schema.platformRelation).values({ queryId: query.id, sequenceNo: 1, enterpriseId: enterprise.id, usccRaw: enterprise.usccNorm, nameRaw: '合成甲', relationKey: 'B-1', status: '待审核', rawFields: { original: '原值', cookie: 'SECRET-COOKIE' }, matchBasis: 'uscc', verificationStatus: 'confirmed' }).returning().get()
  const batch = db.insert(schema.platformExportBatch).values({ titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-18', originalFilename: 'synthetic.xlsx', sha256: 'synthetic-sha', importStatus: 'imported' }).returning().get()
  const exportRow = db.insert(schema.platformExportRow).values({ batchId: batch.id, sourceRowNo: 7, usccRaw: enterprise.usccNorm, rawFields: { source: '原值', password: 'SECRET-PASSWORD' } }).returning().get()
  return { db, enterprise, event, query, relation, batch, exportRow }
}
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })
async function server(db: ReturnType<typeof useDb>, apiToken: string | null = 'synthetic-token') {
  return startHttpFixture({ routes: { '/api/roster/correspondences': r => handleRecordCorrespondenceRequest({ ...r, action: 'list' }, { db, apiToken }), '/api/roster/correspondences/preflight': r => handleRecordCorrespondenceRequest({ ...r, action: 'preflight' }, { db, apiToken }), '/api/roster/correspondences/commit': r => handleRecordCorrespondenceRequest({ ...r, action: 'commit' }, { db, apiToken }), '/api/roster/correspondences/candidates': r => handleRecordCorrespondenceRequest({ ...r, action: 'candidates' }, { db, apiToken }) } })
}
function decision(eventId: number, relationId: number) { return { idempotencyKey: 'synthetic-1', sourceIdentity: 'synthetic/1', actor: { type: 'agent', id: 'test' }, basis: 'explicit row review', ruleId: 'manual', ruleVersion: '1', operations: [{ action: 'create', status: 'candidate', edge: { type: 'event_process', eventId, relationId, role: 'context_only' } }] } }
async function json(response: Response) { return response.json() as Promise<any> }

describe('record correspondence HTTP adapter with isolated SQLite', () => {
  it('lists empty state and rejects unauthenticated preflight when token is unconfigured', async () => {
    const { db, event, relation } = fixture(); const app = await server(db, null)
    try {
      const read = await fetch(app.baseUrl + '/api/roster/correspondences')
      expect(await json(read)).toMatchObject({ rows: [], total: 0, page: 1 })
      expect(read.headers.get('cache-control')).toBe('no-store')
      const write = await fetch(app.baseUrl + '/api/roster/correspondences/preflight', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(decision(event.id, relation.id)) })
      expect(write.status).toBe(401)
      expect((await json(write)).error.code).toBe('unauthorized')
    } finally { await app.close() }
  })

  it('preflights, commits, replays and reads original row provenance without credentials', async () => {
    const { db, event, relation } = fixture(); const app = await server(db)
    const request = decision(event.id, relation.id); const post = (path: string, body: unknown) => fetch(app.baseUrl + '/api/roster/correspondences/' + path, { method: 'POST', headers: { authorization: 'Bearer synthetic-token', 'content-type': 'application/json' }, body: JSON.stringify(body) })
    try {
      const preflight = await json(await post('preflight', request))
      expect(preflight).toMatchObject({ batchStatus: 'preflight', impact: { created: 1, audit: 1 } })
      const receipt = await json(await post('commit', { request, planHash: preflight.planHash }))
      expect(receipt.correspondenceIds).toHaveLength(1)
      expect(await json(await post('commit', { request, planHash: preflight.planHash }))).toEqual(receipt)
      const response = await fetch(app.baseUrl + `/api/roster/correspondences?eventId=${event.id}`)
      const result = await json(response)
      expect(result).toMatchObject({ total: 1, rows: [{ event: { id: event.id, evidence: [{ page: 3, listNo: 9 }] }, relation: { id: relation.id, status: '待审核', query: { status: 'partial' } } }] })
      expect(JSON.stringify(result)).not.toMatch(/SECRET-RAW|SECRET-COOKIE|SECRET-PASSWORD/)
    } finally { await app.close() }
  })
})


describe('record correspondence source, candidate and MCP contracts', () => {
  it('generates read-only candidates from named archived rows and keeps missing year and batch ambiguity', async () => {
    const { db, event, relation, query, batch } = fixture(); const app = await server(db)
    try {
      const body = { eventId: event.id, queryIds: [query.id], exportBatchIds: [batch.id], ruleVersion: '2026.10', page: 1, pageSize: 1 }
      const response = await fetch(app.baseUrl + '/api/roster/correspondences/candidates', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const result = await json(response)
      expect(result).toMatchObject({ total: 2, page: 1, pageSize: 1, coverage: [{ id: query.id, status: 'partial' }], rows: [{ status: 'candidate', ruleVersion: '2026.10' }] })
      expect(result.rows[0].conflicts).toContain('platform_year_missing')
      expect(result.rows[0].edge.relationId).toBe(relation.id)
      expect(JSON.stringify(result)).not.toContain('SECRET-RAW')
      expect(listRecordCorrespondences(db)).toEqual([])
      const mcp = dispatchRecordCorrespondenceMcp('candidates', body, { db }) as any
      expect(mcp).toEqual(result)
    } finally { await app.close() }
  })

  it('reads unlinked sources with original row, batch version, and empty reverse links', () => {
    const { db, event, relation, exportRow } = fixture()
    for (const [kind, id] of [['event', event.id], ['relation', relation.id], ['export_row', exportRow.id]] as const) {
      const rest = handleRecordCorrespondenceRequest({ action: 'source', method: 'GET', kind, id }, { db })
      const mcp = dispatchRecordCorrespondenceMcp('source', { kind, id }, { db })
      expect(rest.body).toEqual(mcp)
      expect(rest.body).toMatchObject({ correspondences: [], source: { id } })
    }
    const eventRead = handleRecordCorrespondenceRequest({ action: 'source', method: 'GET', kind: 'event', id: event.id }, { db }).body as any
    expect(eventRead.source.evidence).toMatchObject([{ sourceFile: 'synthetic/notice.pdf', page: 3 }])
    const exportRead = handleRecordCorrespondenceRequest({ action: 'source', method: 'GET', kind: 'export_row', id: exportRow.id }, { db }).body as any
    expect(exportRead.source).toMatchObject({ sourceRowNo: 7, batch: { sha256: 'synthetic-sha', year: 2026 } })
    expect(JSON.stringify(exportRead)).not.toContain('SECRET-PASSWORD')
  })

  it('rejects invalid roles and discriminators before preflight, then preserves stale-plan atomicity', () => {
    const { db, event, relation } = fixture()
    const run = (action: 'preflight' | 'commit', body: unknown) => handleRecordCorrespondenceRequest({ action, method: 'POST', body, headers: { authorization: 'Bearer synthetic-token' } }, { db, apiToken: 'synthetic-token' })
    const invalid = decision(event.id, relation.id) as any
    invalid.operations[0].edge.role = 'same_current_row'
    expect(run('preflight', invalid)).toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } })
    invalid.operations[0].edge.role = 'context_only'
    invalid.operations[0].edge.type = 'wrong_type'
    expect(run('preflight', invalid).status).toBe(400)
    const valid = decision(event.id, relation.id)
    const plan = run('preflight', valid).body as any
    expect(plan.planHash).toMatch(/^[0-9a-f]{64}$/)
    db.update(schema.platformRelation).set({ status: '已退回' }).where(eq(schema.platformRelation.id, relation.id)).run()
    expect(run('commit', { request: valid, planHash: plan.planHash })).toMatchObject({ status: 409, body: { error: { code: 'plan_mismatch' } } })
    expect(listRecordCorrespondences(db)).toEqual([])
  })

  it('pages filtered reads and audit, and requires token for receipt recovery on both surfaces', () => {
    const { db, event, relation } = fixture()
    const req = decision(event.id, relation.id)
    const pre = dispatchRecordCorrespondenceMcp('preflight', req, { db, authorized: true }) as any
    const receipt = dispatchRecordCorrespondenceMcp('commit', { request: req, planHash: pre.planHash }, { db, authorized: true }) as any
    expect(() => dispatchRecordCorrespondenceMcp('batch', { idempotencyKey: req.idempotencyKey }, { db })).toThrowError(expect.objectContaining({ code: 'unauthorized' }))
    expect(dispatchRecordCorrespondenceMcp('batch', { idempotencyKey: req.idempotencyKey }, { db, authorized: true })).toEqual(receipt)
    const id = receipt.correspondenceIds[0]
    const list = dispatchRecordCorrespondenceMcp('list', { eventId: event.id, role: 'context_only', page: 1, pageSize: 1 }, { db }) as any
    expect(list).toMatchObject({ total: 1, rows: [{ id, status: 'candidate' }] })
    expect((dispatchRecordCorrespondenceMcp('list', { eventId: event.id, page: 2, pageSize: 1 }, { db }) as any).rows).toEqual([])
    const audit = dispatchRecordCorrespondenceMcp('audit', { id, page: 1, pageSize: 1 }, { db }) as any
    expect(audit).toMatchObject({ total: 1, rows: [{ correspondenceId: id, toStatus: 'candidate' }] })
    expect(getRecordCorrespondenceAudit(db, id)).toHaveLength(1)
  })
})

describe('core guards remain authoritative through both adapters', () => {
  it('rejects candidate confirmation with a mismatched original process role via REST and MCP', () => {
    const { db, event, relation } = fixture()
    db.update(schema.platformRelation).set({ declareKind: 'update' }).where(eq(schema.platformRelation.id, relation.id)).run()
    const auth = { authorization: 'Bearer synthetic-token' }
    const call = (action: 'preflight' | 'commit', body: unknown) => handleRecordCorrespondenceRequest({ action, method: 'POST', body, headers: auth }, { db, apiToken: 'synthetic-token' })
    const first = decision(event.id, relation.id) as any
    first.operations[0].edge.role = 'supports_award'
    const plan = call('preflight', first).body as any
    expect(plan.batchStatus).toBe('preflight')
    const receipt = call('commit', { request: first, planHash: plan.planHash }).body as any
    const second = { ...first, idempotencyKey: 'confirm-mismatch', sourceIdentity: 'synthetic/confirm-mismatch', operations: [{ action: 'decide', correspondenceId: receipt.correspondenceIds[0], expectedRevision: 1, status: 'confirmed' }] }
    expect(call('preflight', second)).toMatchObject({ status: 422, body: { error: { code: 'invalid_endpoint_type' } } })
    expect(() => dispatchRecordCorrespondenceMcp('preflight', second, { db, authorized: true })).toThrowError(expect.objectContaining({ code: 'invalid_endpoint_type' }))
    expect(listRecordCorrespondences(db)[0]).toMatchObject({ status: 'candidate', revision: 1 })
    const auditRead = handleRecordCorrespondenceRequest({ action: 'audit', method: 'GET', id: receipt.correspondenceIds[0] }, { db }).body as any
    expect(JSON.stringify(auditRead)).not.toContain('SECRET-RAW')
    expect(auditRead.rows[0].evidence.officialEvidence).toMatchObject([{ evidence: { page: 3, listNo: 9 } }])
  })

  it('includes a predecessor event as a reverse link with formal evidence', () => {
    const { db, enterprise, event, relation } = fixture()
    db.update(schema.platformRelation).set({ declareKind: 'update', appliedAt: '2025-01-01' }).where(eq(schema.platformRelation.id, relation.id)).run()
    const req = { ...decision(event.id, relation.id), operations: [{ action: 'create', status: 'candidate', edge: { type: 'later_process', enterpriseId: enterprise.id, titleCode: 'specialized_sme', predecessorEventId: event.id, relationId: relation.id, role: 'followup_update' } }] }
    const pre = dispatchRecordCorrespondenceMcp('preflight', req, { db, authorized: true }) as any
    const receipt = dispatchRecordCorrespondenceMcp('commit', { request: req, planHash: pre.planHash }, { db, authorized: true }) as any
    const source = dispatchRecordCorrespondenceMcp('source', { kind: 'event', id: event.id }, { db }) as any
    expect(source).toMatchObject({ source: { officialEvidence: [{ evidence: { page: 3 }, storedFile: null }], correspondences: [{ id: receipt.correspondenceIds[0], type: 'later_process' }] }, correspondences: [{ predecessorEvent: { id: event.id } }] })
    expect(JSON.stringify(source)).not.toContain('SECRET-RAW')
  })
})

describe('candidate coverage boundaries', () => {
  it('keeps every ambiguous row, shows zero and partial coverage, and omits archived response arrays', () => {
    const { db, enterprise, event, query, relation } = fixture()
    db.update(schema.platformQuery).set({ collectionEvidence: { effectiveConditions: { uscc: enterprise.usccNorm, combination: 'and' }, queriedAt: '2026-10-18T00:00:00.000Z', completedAt: '2026-10-18T00:01:00.000Z', rows: [{ token: 'SECRET-ROW-TOKEN' }], completeness: 'partial', fullRange: false } as any }).where(eq(schema.platformQuery.id, query.id)).run()
    const second = db.insert(schema.platformRelation).values({ queryId: query.id, sequenceNo: 2, enterpriseId: enterprise.id, usccRaw: enterprise.usccNorm, nameRaw: '合成甲', relationKey: 'B-2', matchBasis: 'uscc', verificationStatus: 'confirmed' }).returning().get()
    const zero = db.insert(schema.platformQuery).values({ interface: 'recognized_list', queryKey: enterprise.usccNorm!, rdjb: '2', titleCode: 'specialized_sme', queriedAt: '2026-10-18T02:00:00.000Z', status: 'no_record' }).returning().get()
    const result = dispatchRecordCorrespondenceMcp('candidates', { eventId: event.id, queryIds: [query.id, zero.id], ruleVersion: '2' }, { db }) as any
    expect(result.total).toBe(2)
    expect(result.rows.map((row: any) => row.edge.relationId)).toEqual([relation.id, second.id])
    expect(result.rows.every((row: any) => row.conflicts.includes('multiple_candidate_rows'))).toBe(true)
    expect(result.coverage.map((item: any) => item.status)).toEqual(['partial', 'no_record'])
    expect(JSON.stringify(result)).not.toContain('SECRET-ROW-TOKEN')
    expect(listRecordCorrespondences(db)).toEqual([])
  })
})
