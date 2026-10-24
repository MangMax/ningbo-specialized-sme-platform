import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { useDb, schema } from '../db/client'
import { handleRecordCorrespondenceRequest } from '../server/utils/record-correspondence-api'
import { dispatchRecordCorrespondenceMcp } from '../server/utils/mcp-record-correspondence'
import { eq } from 'drizzle-orm'
import { startHttpFixture } from './helpers/http-fixture'

const dirs: string[] = []
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'archive-212-')); dirs.push(dir)
  const db = useDb({ dbPath: join(dir, 'isolated.db') })
  const enterprise = db.insert(schema.enterprise).values({ name: '合成新名称', nameNorm: '合成新名称', usccNorm: '91330211255994457P' }).returning().get()
  const record = db.insert(schema.record).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', source: 'jxj', usccRaw: enterprise.usccNorm }).returning().get()
  const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2022, batchSeq: 1 }).returning().get()
  db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: 'synthetic/notice.pdf', attachment: '附件一', listNo: 9, page: 3 }).run()
  const query = (source: 'business_list' | 'apply_list' | 'recognized_list', status: 'success' | 'failed' | 'no_record' | 'partial' | 'not_queried' = 'success', key = enterprise.usccNorm!) => db.insert(schema.platformQuery).values({ interface: source, queryKey: key, rdjb: '2', titleCode: 'specialized_sme', queriedAt: `2026-10-18T00:00:${String(db.select().from(schema.platformQuery).all().length).padStart(2, '0')}Z`, status, rawResponse: 'SECRET-BODY' }).returning().get()
  const relation = (queryId: number, values = {}) => db.insert(schema.platformRelation).values({ queryId, sequenceNo: 1, enterpriseId: enterprise.id, usccRaw: enterprise.usccNorm, nameRaw: '合成曾用名', year: 2022, batch: '2022-1', declareKind: 'apply', verificationStatus: 'confirmed', matchBasis: 'uscc', rawFields: { qymc: '合成曾用名', cookie: 'SECRET-COOKIE' }, ...values }).returning().get()
  const discover = (body = {}) => handleRecordCorrespondenceRequest({ action: 'discover' as any, method: 'POST', body: { eventId: event.id, ...body } }, { db })
  return { db, enterprise, event, query, relation, discover }
}
afterAll(() => dirs.forEach(dir => rmSync(dir, { recursive: true, force: true })))

it('discovers historical rows across three interfaces without archive IDs and preserves original facts', () => {
  const f = fixture()
  const old = f.relation(f.query('business_list').id)
  const later = f.relation(f.query('apply_list').id, { year: 2025, declareKind: 'review' })
  const recognized = f.relation(f.query('recognized_list').id)
  f.relation(f.query('business_list').id, { usccRaw: '91330211790043112T', enterpriseId: null })
  const before = dispatchRecordCorrespondenceMcp('source', { kind: 'event', id: f.event.id }, { db: f.db })
  const result = f.discover()
  expect(result.status).toBe(200)
  const body = result.body as any
  expect(body.rows.map((r: any) => r.edge.relationId)).toEqual([old.id, later.id, recognized.id])
  expect(body.rows[1].conflicts).toEqual(expect.arrayContaining(['year_mismatch', 'process_type_mismatch', 'multiple_candidate_rows']))
  expect(body.rows[0].evidence.source).toMatchObject({ queryId: old.queryId, sequenceNo: 1 })
  expect(body.event.evidence).toMatchObject([{ sourceFile: 'synthetic/notice.pdf', attachment: '附件一', page: 3, listNo: 9 }])
  expect(body.coverage.total).toBe(4)
  expect(JSON.stringify(body)).not.toContain('SECRET')
  expect(dispatchRecordCorrespondenceMcp('source', { kind: 'event', id: f.event.id }, { db: f.db })).toEqual(before)
  expect(dispatchRecordCorrespondenceMcp('list', {}, { db: f.db })).toMatchObject({ rows: [], total: 0 })
})

it('keeps unqueried failed partial complete empty and no-candidate coverage distinct on independent pages', () => {
  const f = fixture()
  f.query('business_list', 'not_queried')
  f.query('business_list', 'failed')
  const partial = f.query('apply_list', 'partial'); f.relation(partial.id, { year: null, batch: null, declareKind: null })
  f.query('recognized_list', 'no_record')
  const wrong = f.query('business_list'); f.relation(wrong.id, { usccRaw: '91330211790043112T', enterpriseId: null })
  const first = f.discover({ pageSize: 1, queryPageSize: 2 }).body as any
  expect(first).toMatchObject({ total: 1, page: 1, rows: [{ conflicts: expect.arrayContaining(['platform_year_missing', 'platform_batch_missing', 'process_type_unknown']) }], coverage: { total: 5, page: 1, rows: [{ outcome: 'not_queried' }, { outcome: 'failed' }] } })
  const next = f.discover({ page: 2, pageSize: 1, queryPage: 2, queryPageSize: 2 }).body as any
  expect(next.rows).toEqual([])
  expect(next.coverage.rows.map((q: any) => q.outcome)).toEqual(['partial', 'no_record'])
  const last = f.discover({ queryPage: 3, queryPageSize: 2 }).body as any
  expect(last.coverage.rows).toMatchObject([{ outcome: 'no_candidate', relationCount: 1, candidateCount: 0 }])
  expect(f.discover({ queryPage: 4, queryPageSize: 2 }).body).toMatchObject({ coverage: { total: 5, rows: [] } })
  const empty = fixture().discover().body as any
  expect(empty).toMatchObject({ total: 0, coverage: { total: 0 }, interfaces: [{ queried: false, states: [] }, { queried: false }, { queried: false }] })
})


it('isolates titles in mixed recognized archives and retains verified former-name identity across event years', () => {
  const f = fixture()
  const query = f.query('recognized_list', 'success', 'scope:synthetic')
  f.db.update(schema.platformQuery).set({ titleCode: null, rdjb: '1,2,3', collectionEvidence: { pages: [{ status: 'success', rdjb: '1', page: 1, fetchedCount: 1 }, { status: 'success', rdjb: '2', page: 2, fetchedCount: 2 }, { status: 'success', rdjb: '3', page: 1, fetchedCount: 1 }], rows: [{ token: 'SECRET-ROW' }] } as any }).where(eq(schema.platformQuery.id, query.id)).run()
  f.relation(query.id)
  const matching = f.relation(query.id, { sequenceNo: 2, batch: '2022-2' })
  const missing = f.relation(query.id, { sequenceNo: 3, year: null, batch: null, usccRaw: null, matchBasis: 'alias' })
  f.relation(query.id, { sequenceNo: 4 })
  f.relation(query.id, { sequenceNo: 5, usccRaw: null, verificationStatus: 'pending' })
  const result = f.discover({ pageSize: 1 }).body as any
  expect(result).toMatchObject({ total: 2, rows: [{ edge: { relationId: matching.id }, conflicts: expect.arrayContaining(['batch_mismatch', 'multiple_candidate_rows']) }] })
  const next = f.discover({ page: 2, pageSize: 1 }).body as any
  expect(next.rows).toMatchObject([{ edge: { relationId: missing.id }, evidence: { identity: { rowUsccRaw: null }, source: { interface: 'recognized_list', sourceRdjb: '2', sourcePage: 2 } }, conflicts: expect.arrayContaining(['platform_year_missing', 'platform_batch_missing', 'multiple_candidate_rows']) }])
  const source = dispatchRecordCorrespondenceMcp('source', { kind: 'relation', id: missing.id }, { db: f.db }) as any
  expect(source.source).toMatchObject({ sourceRdjb: '2', sourcePage: 2, nameRaw: '合成曾用名' })
  expect(JSON.stringify(source)).not.toContain('SECRET')
  const review = f.db.insert(schema.recordEvent).values({ recordId: result.event.recordId, eventType: 'review', year: 2025, batchSeq: 1 }).returning().get()
  const history = f.discover({ eventId: review.id }).body as any
  expect(history.total).toBe(2)
  expect(history.rows[0].evidence.process.eventType).toBe('review')
  expect(history.rows[0].conflicts).toContain('year_mismatch')
})

it('finds failed and empty queries under confirmed aliases without accepting pending names', () => {
  const f = fixture()
  for (const [name, status] of [['合成曾用名', 'confirmed'], ['待核名称', 'pending']] as const) f.db.insert(schema.enterpriseAlias).values({ enterpriseId: f.enterprise.id, name, nameNorm: name, verificationStatus: status, sourceKind: 'manual' }).run()
  const old = f.query('apply_list', 'failed', 'name:合成曾用名')
  f.query('apply_list', 'no_record', 'name:待核名称')
  expect(f.discover().body).toMatchObject({ coverage: { total: 1, rows: [{ id: old.id, outcome: 'failed' }] } })
})

it('preserves every existing manual decision and audit when discovery is repeated', () => {
  const f = fixture()
  for (const [sequenceNo, status] of [[1, 'confirmed'], [2, 'rejected'], [3, 'unlinked'], [4, 'candidate']] as const) {
    const row = f.relation(f.query('business_list').id)
    const request = { idempotencyKey: `synthetic-${sequenceNo}`, sourceIdentity: 'synthetic', actor: { type: 'agent', id: 'fixture' }, basis: 'synthetic review', ruleId: 'manual', ruleVersion: '1', operations: [{ action: 'create', status: status === 'unlinked' ? 'confirmed' : 'candidate', edge: { type: 'event_process', eventId: f.event.id, relationId: row.id, role: 'context_only' } }] }
    const plan = dispatchRecordCorrespondenceMcp('preflight', request, { db: f.db, authorized: true }) as any
    const receipt = dispatchRecordCorrespondenceMcp('commit', { request, planHash: plan.planHash }, { db: f.db, authorized: true }) as any
    if (status !== 'candidate') {
      const decision = { ...request, idempotencyKey: `decide-${sequenceNo}`, operations: [{ action: 'decide', correspondenceId: receipt.correspondenceIds[0], expectedRevision: status === 'unlinked' ? 2 : 1, status }] }
      const dp = dispatchRecordCorrespondenceMcp('preflight', decision, { db: f.db, authorized: true }) as any
      dispatchRecordCorrespondenceMcp('commit', { request: decision, planHash: dp.planHash }, { db: f.db, authorized: true })
    }
  }
  const before = dispatchRecordCorrespondenceMcp('list', {}, { db: f.db }) as any
  const audits = before.rows.map((r: any) => dispatchRecordCorrespondenceMcp('audit', { id: r.id }, { db: f.db }))
  for (let i = 0; i < 2; i++) expect((f.discover().body as any).rows.map((r: any) => [r.existingStatus, r.recommendation])).toEqual([['confirmed', 'existing_decision'], ['rejected', 'existing_decision'], ['unlinked', 'existing_decision'], ['candidate', 'existing_decision']])
  expect(dispatchRecordCorrespondenceMcp('list', {}, { db: f.db })).toEqual(before)
  expect(before.rows.map((r: any) => dispatchRecordCorrespondenceMcp('audit', { id: r.id }, { db: f.db }))).toEqual(audits)
})

it('serves real HTTP with isolated SQLite and the same MCP semantics plus bounded validation', async () => {
  const f = fixture(); f.relation(f.query('apply_list').id)
  const app = await startHttpFixture({ routes: { '/api/roster/correspondences/discover': r => handleRecordCorrespondenceRequest({ ...r, action: 'discover' }, { db: f.db }) } })
  try {
    const body = { eventId: f.event.id, pageSize: 1, queryPageSize: 1 }
    const response = await fetch(app.baseUrl + '/api/roster/correspondences/discover', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual(dispatchRecordCorrespondenceMcp('discover', body, { db: f.db }))
    expect(f.discover({ page: 0 }).status).toBe(400)
    expect(f.discover({ pageSize: 201 }).status).toBe(400)
    expect(f.discover({ queryPageSize: 201 }).status).toBe(400)
    expect(f.discover({ eventId: 99999 }).status).toBe(404)
    expect(f.discover({ queryIds: [1] }).status).toBe(400)
    expect(handleRecordCorrespondenceRequest({ action: 'discover', method: 'GET', body }, { db: f.db }).status).toBe(405)
    const maintenance = f.db.insert(schema.recordEvent).values({ recordId: (f.discover().body as any).event.recordId, eventType: 'maintain', year: 2026 }).returning().get()
    expect(f.discover({ eventId: maintenance.id }).status).toBe(404)
  } finally { await app.close() }
})

it('normalizes archived identity and recognizes existing support roles instead of recommending them again', () => {
  const f = fixture()
  const row = f.relation(f.query('business_list').id, { usccRaw: ' 91330211\u200b255994457p ' })
  const request = { idempotencyKey: 'support-role', sourceIdentity: 'synthetic', actor: { type: 'agent', id: 'fixture' }, basis: 'explicit synthetic review', ruleId: 'manual', ruleVersion: '1', operations: [{ action: 'create', status: 'confirmed', edge: { type: 'event_process', eventId: f.event.id, relationId: row.id, role: 'supports_award' } }] }
  const plan = dispatchRecordCorrespondenceMcp('preflight', request, { db: f.db, authorized: true }) as any
  const receipt = dispatchRecordCorrespondenceMcp('commit', { request, planHash: plan.planHash }, { db: f.db, authorized: true }) as any
  expect(receipt.correspondenceIds).toHaveLength(1)
  expect(f.discover().body).toMatchObject({ total: 1, rows: [{ edge: { relationId: row.id }, existingStatus: 'confirmed', recommendation: 'existing_decision', existingCorrespondenceId: receipt.correspondenceIds[0] }] })
})

it('enforces bounded pagination at the shared service used by jobs as well as adapters', async () => {
  const { discoverEventArchives } = await import('../server/utils/event-archive-discovery')
  const f = fixture()
  const input = { eventId: f.event.id, page: 1, pageSize: 50, queryPage: 1, queryPageSize: 25 }
  for (const invalid of [{ pageSize: 201 }, { queryPageSize: 201 }, { page: 0 }, { page: 1.5 }]) expect(() => discoverEventArchives(f.db, { ...input, ...invalid })).toThrow('Invalid discovery pagination')
})

it('resolves coverage through indexed query lookups without scanning unrelated archived queries', () => {
  const f = fixture()
  const wanted = f.relation(f.query('apply_list').id)
  f.db.transaction(() => {
    for (let i = 0; i < 40; i++) f.query('business_list', 'failed', `unrelated:${i}`)
  })
  const prepare = f.db.$client.prepare.bind(f.db.$client)
  const plans: string[] = []
  f.db.$client.prepare = ((...args: Parameters<typeof prepare>) => {
    const statement = prepare(...args)
    if (/^select .*platform_query/.test(args[0])) {
      for (const method of ['get', 'all'] as const) {
        const run = statement[method].bind(statement)
        Object.assign(statement, { [method]: (...params: unknown[]) => {
          const result = run(...params)
          plans.push(...(prepare(`EXPLAIN QUERY PLAN ${args[0]}`).all(...params) as Array<{ detail: string }>).map(row => row.detail))
          return result
        } })
      }
    }
    return statement
  }) as typeof prepare
  expect(f.discover().body).toMatchObject({ total: 1, rows: [{ edge: { relationId: wanted.id } }], coverage: { total: 1 } })
  expect(plans.some(detail => detail.startsWith('SEARCH platform_query'))).toBe(true)
  expect(plans.filter(detail => /^SCAN platform_query\b/.test(detail))).toEqual([])
})

it('deduplicates identity name alias and relation coverage while retaining all statuses and owner conflicts', () => {
  const f = fixture()
  f.db.insert(schema.enterpriseAlias).values({ enterpriseId: f.enterprise.id, name: f.enterprise.name, nameNorm: f.enterprise.nameNorm, verificationStatus: 'confirmed', sourceKind: 'manual' }).run()
  const other = f.db.insert(schema.enterprise).values({ name: '另一企业', nameNorm: '另一企业' }).returning().get()
  const direct = f.query('business_list'); const accepted = f.relation(direct.id)
  f.relation(direct.id, { sequenceNo: 2, enterpriseId: other.id })
  const named = f.query('apply_list', 'failed', `name:${f.enterprise.nameNorm}`)
  const normalized = f.query('recognized_list', 'partial', 'scope:normalized')
  const unowned = f.relation(normalized.id, { enterpriseId: null, usccRaw: '\u300091330211\u200b255994457p\t' })
  const blank = f.query('business_list', 'not_queried', 'scope:verified-blank')
  f.relation(blank.id, { usccRaw: '\ufeff\u200b ', verificationStatus: 'confirmed' })
  const foreign = f.query('apply_list', 'no_record', 'scope:foreign-owner')
  f.relation(foreign.id, { enterpriseId: other.id })
  const first = f.discover({ pageSize: 1, queryPageSize: 2 }).body as any
  expect(first).toMatchObject({ total: 2, rows: [{ edge: { relationId: accepted.id } }], coverage: { total: 4, rows: [{ id: direct.id, candidateCount: 1, relationCount: 2 }, { id: named.id, outcome: 'failed' }] } })
  const next = f.discover({ page: 2, pageSize: 1, queryPage: 2, queryPageSize: 2 }).body as any
  expect(next).toMatchObject({ total: 2, rows: [{ edge: { relationId: unowned.id } }], coverage: { total: 4, rows: [{ id: normalized.id, outcome: 'partial' }, { id: blank.id, outcome: 'not_queried' }] } })
  expect(next.interfaces).toEqual([
    { interface: 'business_list', states: [{ status: 'not_queried', count: 1 }, { status: 'success', count: 1 }], queried: true },
    { interface: 'apply_list', states: [{ status: 'failed', count: 1 }], queried: true },
    { interface: 'recognized_list', states: [{ status: 'partial', count: 1 }], queried: true },
  ])
})

it('uses only confirmed blank rows of the explicit owner when the event identity is missing', () => {
  const f = fixture()
  f.db.update(schema.record).set({ usccRaw: '' }).run()
  const query = f.query('apply_list', 'success', 'scope:no-identity')
  const accepted = f.relation(query.id, { usccRaw: null })
  f.relation(query.id, { sequenceNo: 2, usccRaw: null, enterpriseId: null })
  f.relation(query.id, { sequenceNo: 3, usccRaw: null, verificationStatus: 'pending' })
  f.relation(query.id, { sequenceNo: 4 })
  expect(f.discover().body).toMatchObject({ total: 1, rows: [{ edge: { relationId: accepted.id } }], coverage: { total: 1, rows: [{ id: query.id, relationCount: 4, candidateCount: 1 }] } })
})

it('retains every query status under confirmed aliases with independent coverage pages', () => {
  const f = fixture()
  f.db.insert(schema.enterpriseAlias).values({ enterpriseId: f.enterprise.id, name: '已确认旧名', nameNorm: '已确认旧名', verificationStatus: 'confirmed', sourceKind: 'manual' }).run()
  const statuses = ['failed', 'partial', 'success', 'no_record', 'not_queried'] as const
  const queries = statuses.map(status => f.query('apply_list', status, 'name:已确认旧名'))
  for (let i = 0; i < statuses.length; i++) {
    expect(f.discover({ queryPage: i + 1, queryPageSize: 1 }).body).toMatchObject({
      total: 0, rows: [], coverage: { total: 5, rows: [{ id: queries[i]!.id, status: statuses[i], outcome: statuses[i] === 'success' ? 'empty_unproven' : statuses[i] }] },
    })
  }
})
