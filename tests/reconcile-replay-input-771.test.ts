import { chmodSync, copyFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'
import { getComparison } from '../lib/comparison'
import { eq } from 'drizzle-orm'
import { queryPlatformSlots } from '../lib/platform/client'
import { buildPlatformWritePayload } from '../lib/platform/payload'
import { StoredReplayOriginal } from '../lib/platform/reconcile-replay-input'
import { normalizePlatformRelation } from '../lib/platform/normalization'
import { ensurePlatformObservation, readPlatformObservationPlan } from '../server/utils/platform-business-record'
import type { RosterImportPlatformQuery, RosterImportRequest } from '../lib/roster-import-client'
import { runPlatformReconcile } from '../server/utils/platform-reconcile'
import { commitRosterImport, preflightRosterImport } from '../server/utils/roster-import'
import { platformQueriesInputSchema } from '../server/utils/roster-import-platform-schema'
import { whenIdle } from '../server/utils/job-runner'

const root = process.env.RECONCILE_771_ROOT
const cases = process.env.RECONCILE_771_CASES
const results = process.env.RECONCILE_771_RESULTS
if (!root || !cases || !results) throw new Error('Owned RECONCILE_771_ROOT/CASES/RESULTS required')
const uscc = '91330211000000771X'
const queriedAt = '2026-11-13T00:00:00.000Z'
const time = '2026-11-13T04:00:00.000Z'
const slots = [
  { interface: 'business_list', rdjb: '1' }, { interface: 'business_list', rdjb: '2' },
  { interface: 'business_list', rdjb: '3' }, { interface: 'apply_list', rdjb: '' },
] as const
let db: ReturnType<typeof drizzle<typeof schema>>
let serial = 0
let caseDir: string
let testName: string

beforeEach(context => {
  testName = context.task.name
  caseDir = join(cases, String(++serial))
  mkdirSync(caseDir)
  const source = join(root, 'input/schema0.sqlite')
  const path = join(caseDir, 'case.sqlite')
  copyFileSync(source, path)
  chmodSync(path, 0o600)
  expect(statSync(path).ino).not.toBe(statSync(source).ino)
  expect(statSync(path).nlink).toBe(1)
  expect(statSync(path).mode & 0o777).toBe(0o600)
  db = drizzle({ connection: { source: path, fileMustExist: true }, schema })
  db.$client.pragma('foreign_keys=ON')
  vi.stubEnv('MIIT_COOKIE', '')
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(time))
})
afterEach(async () => {
  await whenIdle()
  try {
    writeFileSync(join(results, `${serial}.json`), JSON.stringify({
      testName, caseDir, cells: protectedCells(),
      receipts: db.select().from(schema.importReceipt).all(),
      differences: db.select().from(schema.differenceReason).all(),
    }, null, 2))
    expect(db.$client.pragma('foreign_key_check')).toEqual([])
  } finally {
    db.$client.close()
    vi.useRealTimers()
    vi.unstubAllEnvs()
  }
})

/** Independent native-cell oracle, including SQL NULL and BLOB hex. */
function cells(table: string) {
  const columns = db.$client.pragma(`table_info("${table}")`) as { name: string }[]
  return db.$client.prepare(`SELECT ${columns.flatMap(({ name }) => [
    `typeof("${name}") AS "${name}:type"`, `hex(cast("${name}" AS blob)) AS "${name}:hex"`,
  ]).join(',')} FROM "${table}" ORDER BY 1,2,3,4`).all()
}
function protectedCells() {
  return Object.fromEntries([
    'platform_query', 'platform_relation', 'platform_business_record', 'platform_business_record_version',
    'platform_business_observation', 'enterprise_alias', 'record', 'record_event',
    'platform_apply_projection', 'platform_business_projection', 'platform_recognized_projection',
    'record_correspondence', 'record_correspondence_audit',
    'evidence_revision_113', 'evidence_semantic_head_113', 'evidence_impact_progress_113',
    'explanation_impact_113', 'evidence_impact_link_113', 'evidence_revision_event_113',
    'evidence_scope_version_113', 'evidence_review_receipt_114', 'evidence_rule_release_114',
  ].map(table => [table, cells(table)]))
}
function committed(request: RosterImportRequest) {
  expect(preflightRosterImport(db, request).preflight.conflicts).toEqual([])
  const result = commitRosterImport(db, request, [], { deferCandidateTasks: true })
  expect(result.status, JSON.stringify(result)).toBe('committed')
  return result
}
function command(queries: RosterImportPlatformQuery[], key: string): RosterImportRequest {
  return { sourceKind: 'alias_evidence', sourceIdentity: 'seed771', idempotencyKey: key, payload: { platformQueries: queries } }
}

/** Pages come from the real original producer; only historical cells are explicitly seeded. */
async function seed(raw: 'null' | 'empty' | 'ordinary', extra: Record<string, unknown> = {}) {
  const enterprise = db.insert(schema.enterprise).values({ name: 'Replay771', nameNorm: 'Replay771', usccNorm: uscc }).returning().get()
  db.insert(schema.record).values({ enterpriseId: enterprise.id, source: 'miit', titleCode: 'specialized_sme' }).run()
  const row = {
    id: 'SOURCE771', qymc: 'Replay771', tyshxydm: uscc, szsfmc: 'P', cszt: 'done', whpc: 'B',
    sblx: 'apply', sqsj: 'D', personuuid: 'A', year: '2024', ...extra,
  }
  const outcomes = await queryPlatformSlots({
    uscc, cookie: 'local=771', retries: 0, now: () => queriedAt,
    fetchImpl: async url => ({
      ok: true, status: 200, text: async () => JSON.stringify({
        zrarData: { grid: { [url.includes('businessList') ? 'businessListGrid' : 'applyGrid']: {
          page: 1, pageSize: 50, maxCount: 1, pageSet: [row],
        } } },
      }),
    }),
  }, slots.map(slot => slot.interface === 'apply_list' ? { interface: slot.interface } : slot))
  expect(outcomes.map(o => [o.status, o.rows.length])).toEqual([['success', 1], ['success', 1], ['success', 1], ['success', 1]])
  const request = buildPlatformWritePayload({
    sourceIdentity: 'seed771', idempotencyKey: 'seed771', enterprises: [],
    queries: outcomes.map(outcome => ({ ...outcome, titleCode: null, outcome })),
  })
  for (const query of request.payload.platformQueries!) {
    query.relations![0]!.rawFields = raw === 'ordinary' ? row : raw === 'null' ? null : {}
  }
  committed(request)
  expect(getComparison(db, { title: ['specialized_sme'] }).rows.filter(r => r.uscc === uscc))
    .toEqual([{
      enterpriseId: enterprise.id, name: 'Replay771', uscc, district: null, titleCode: 'specialized_sme',
      direction: 'extra_in_miit', curated: false,
      evidence: { matchedBy: 'uscc', otherSideUscc: null, currentCity: null, regStatus: null },
    }])
  return { enterprise, request, row }
}
function service() {
  const fetchImpl = vi.fn(async () => { throw new Error('Stored four slots must not fetch') })
  const cookie = vi.fn(() => { throw new Error('Stored four slots must not read credentials') })
  return { fetchImpl, cookie, run: () => runPlatformReconcile({
    db, titles: ['specialized_sme'], usccs: [uscc], now: () => new Date(time), fetchImpl, cookie,
  }) }
}
function serviceReceipts() {
  return db.select().from(schema.importReceipt).all().filter(row => {
    const request: RosterImportRequest = JSON.parse(row.requestBody)
    return request.sourceIdentity === 'platform/reconcile:specialized_sme'
  })
}

it.each(['null', 'empty'] as const)('A01 four lawful %s originals commit real decisions and durable literal references with zero network', async raw => {
  const { enterprise } = await seed(raw)
  const ownIds = selectedRelations().map(row => row.id)
  expect(db.select().from(schema.platformBusinessObservation).all().filter(row => ownIds.includes(row.relationId)).map(row => row.versionId))
    .toEqual([null, null, null, null])
  const before = protectedCells()
  const svc = service()
  const report = await svc.run()
  expect(report.queries).toEqual({ network: 0, reused: 4, byInterface: { business_list: 0, apply_list: 0 } })
  expect(report.counts).toEqual({ confirmed: 0, byReason: {}, noRecord: 0, needsReview: 1, queryFailed: 0, notQueried: 0, reusedFresh: 0, total: 1 })
  expect(report.write).toEqual({ batchId: expect.any(Number), status: 'committed', written: 1, skipped: 4 })
  const receipts = serviceReceipts()
  expect(receipts.map(r => [r.operation, r.status])).toEqual([['preflight', 'preflight'], ['commit', 'committed']])
  const literalQueries = slots.map(slot => ({
    ...slot, queryKey: uscc, queriedAt, reuseExisting: true, relations: [{ sequenceNo: 1 }],
  }))
  for (const receipt of receipts) {
    const request: RosterImportRequest = JSON.parse(receipt.requestBody)
    expect(request.payload.platformQueries).toEqual(literalQueries)
    expect(request.payload.differences).toEqual([{
      enterpriseName: 'Replay771', uscc, titleCode: 'specialized_sme', direction: 'extra_in_miit',
      status: 'needs_review', reasonCode: null,
      reasonNote: '已取得4条原始关系（平台状态：done）；待代理核实原因与措施。',
      measureCode: 'manual_review',
      measureNote: '代理核对正式名单、导出时点、各平台来源及必要的公开证据后，显式提交原因与措施。',
      evidenceQueryRef: { interface: 'business_list', queryKey: uscc, rdjb: '1', queriedAt },
      evidenceRelationId: null, movedIn: null, verificationStatus: 'pending', recordedAt: time,
    }])
    expect(request).toEqual({
      idempotencyKey: 'platform_reconcile:e8e56c308be2adc139fd89254e7b8d32',
      sourceKind: 'alias_evidence', sourceIdentity: 'platform/reconcile:specialized_sme', sourceSha256: null,
      payload: { platformQueries: literalQueries, differences: request.payload.differences },
    })
  }
  const saved = db.select().from(schema.differenceReason).all().filter(r => r.enterpriseId === enterprise.id)
  expect(saved).toHaveLength(1)
  expect(saved[0]).toMatchObject({ status: 'needs_review', verificationStatus: 'pending', evidenceRelationId: null })
  expect(db.select().from(schema.platformQuery).all().find(q => q.id === saved[0]!.evidenceQueryId))
    .toMatchObject({ queryKey: uscc, rdjb: '1', queriedAt })
  expect(protectedCells()).toEqual(before)
  expect(svc.fetchImpl).not.toHaveBeenCalled()
  expect(svc.cookie).not.toHaveBeenCalled()
  const replay: RosterImportRequest = JSON.parse(receipts[1]!.requestBody)
  const batch = committed(replay)
  expect(batch.batchId).toBe(report.write!.batchId)
  expect(serviceReceipts()).toEqual(receipts)
  expect(protectedCells()).toEqual(before)
})

function selectedRelations() {
  const queries = db.select().from(schema.platformQuery).where(eq(schema.platformQuery.queryKey, uscc)).all()
  return queries.flatMap(query => db.select().from(schema.platformRelation).where(eq(schema.platformRelation.queryId, query.id)).all())
}
function lastRequest(): RosterImportRequest {
  return JSON.parse(serviceReceipts().at(-1)!.requestBody)
}

it('A07 ordinary builder keeps own fields and bytes and still bootstraps through the real service', async () => {
  const extra: Record<string, unknown> = JSON.parse('{"n":1,"b":true,"x":null,"o":{"z":1,"a":false},"arr":[1,false],"__proto__":{"own":true},"constructor":"own"}')
  const { request, enterprise } = await seed('ordinary', extra)
  // Remove only derived materialization on this private fixture: the ordinary replay must refill it.
  const ids = selectedRelations().map(row => row.id)
  db.$client.prepare(`DELETE FROM platform_business_observation WHERE relation_id IN (${ids.join(',')})`).run()
  const before = cells('platform_relation')
  const report = await service().run()
  expect(report.write?.status).toBe('committed')
  const actual = lastRequest()
  const literal = request.payload.platformQueries!.map(query => ({
    interface: query.interface, queryKey: uscc, rdjb: query.rdjb, titleCode: null, queriedAt,
    status: 'success', failureReason: null, rawResponse: null,
    relations: [{
      sequenceNo: 1, relationKey: 'SOURCE771', enterpriseId: enterprise.id, usccRaw: uscc, nameRaw: 'Replay771',
      aliasNameRaw: null, province: 'P', status: 'done', batch: 'B', declareKind: 'apply', appliedAt: 'D',
      awardBatchLabel: 'A', year: 2024, matchBasis: 'uscc', verificationStatus: 'confirmed',
      rawFields: {
        id: 'SOURCE771', qymc: 'Replay771', tyshxydm: uscc, szsfmc: 'P', cszt: 'done', whpc: 'B',
        sblx: 'apply', sqsj: 'D', personuuid: 'A', year: '2024', ...extra,
      },
    }],
  }))
  expect(JSON.stringify(actual.payload.platformQueries)).toBe(JSON.stringify(literal))
  expect(Object.keys(actual.payload.platformQueries![0]!)).toEqual(['interface', 'queryKey', 'rdjb', 'titleCode', 'queriedAt', 'status', 'failureReason', 'rawResponse', 'relations'])
  expect(Object.hasOwn(actual.payload.platformQueries![0]!.relations![0]!.rawFields!, '__proto__')).toBe(true)
  expect(actual.payload.platformQueries!.every(q => !Object.hasOwn(q, 'reuseExisting'))).toBe(true)
  expect(db.select().from(schema.platformBusinessObservation).all().filter(row => ids.includes(row.relationId))).toHaveLength(4)
  expect(cells('platform_relation')).toEqual(before)
  const stable = protectedCells()
  const receipts = serviceReceipts()
  expect(committed(actual).batchId).toBe(report.write!.batchId)
  expect(serviceReceipts()).toEqual(receipts)
  expect(protectedCells()).toEqual(stable)
})

it('A02 returns the identical compatible query object and an empty-object old-success query stays ordinary', async () => {
  await seed('empty')
  const query = db.select().from(schema.platformQuery).where(eq(schema.platformQuery.queryKey, uscc)).all()[0]!
  const original = db.transaction(tx => StoredReplayOriginal.read(tx, query.id))
  const input: RosterImportPlatformQuery = {
    interface: query.interface, queryKey: uscc, rdjb: query.rdjb, titleCode: null, queriedAt,
    status: 'success', failureReason: null, rawResponse: null,
    relations: [{ sequenceNo: 1, relationKey: 'SOURCE771', rawFields: {} }],
  }
  expect(original.encode(input)).toBe(input)
  committed(command([original.encode(input)], 'empty-ordinary'))
  const incomplete = { ...input, relations: [] }
  expect(original.encode(incomplete)).toEqual({
    interface: query.interface, queryKey: uscc, rdjb: query.rdjb, queriedAt,
    reuseExisting: true, relations: [{ sequenceNo: 1 }],
  })
})

it('A03 keeps original gapped sequences keys identity conflicts and all source columns on the normal path', async () => {
  await seed('ordinary')
  const rows = selectedRelations()
  for (const row of rows) db.$client.prepare(`UPDATE platform_relation
    SET sequence_no=7, relation_key='ORIGINAL771', name_raw='Original Name', uscc_raw='91330211000000999X',
      alias_name_raw='Explicit old alias', source_text='Independent source text'
    WHERE id=?`).run(row.id)
  // The old key is part of the immutable observation input. Reindex the explicitly seeded
  // historical fixture once, before selection; never repair a writer failure.
  for (const row of rows) {
    db.$client.prepare('DELETE FROM platform_business_observation WHERE relation_id=?').run(row.id)
    ensurePlatformObservation(db, row.id)
    expect(readPlatformObservationPlan(db, row.id).identityState).toBe('conflict')
  }
  const before = protectedCells()
  const report = await service().run()
  expect(report.write?.status).toBe('committed')
  expect(lastRequest().payload.platformQueries).toEqual(slots.map(slot => ({
    interface: slot.interface, queryKey: uscc, rdjb: slot.rdjb, queriedAt, reuseExisting: true, relations: [{ sequenceNo: 7 }],
  })))
  expect(protectedCells()).toEqual(before)
  const reference = lastRequest().payload.platformQueries![0]!
  for (const [suffix, relations] of [
    ['new-sequence', [{ sequenceNo: 8 }]],
    ['wrong-raw', [{ sequenceNo: 7, rawFields: { id: 'SOURCE771' } }]],
    ['wrong-alias', [{ sequenceNo: 7, aliasNameRaw: 'wrong' }]],
    ['wrong-source', [{ sequenceNo: 7, sourceText: 'wrong' }]],
  ] as const) {
    const result = preflightRosterImport(db, command([{ ...reference, relations: [...relations] }], suffix))
    expect(result.preflight.conflicts).toHaveLength(1)
    expect(result.preflight.conflicts[0]!.error!.code).toBe(suffix === 'new-sequence' ? 'query_relation_set_conflict' : suffix === 'wrong-raw' ? 'observation_payload_conflict' : 'relation_payload_conflict')
  }
  expect(protectedCells()).toEqual(before)
})

it.each(['null', 'empty'] as const)('A05 native business BLOB statuses and %s raw survive real service writer and receipt', async raw => {
  await seed(raw)
  const business = selectedRelations().slice(0, 3)
  const values = [Buffer.from([0, 255]), Buffer.alloc(0), Buffer.from('done')]
  for (const [index, row] of business.entries()) db.$client.prepare('UPDATE platform_relation SET status=? WHERE id=?').run(values[index], row.id)
  // The original page validator owns the string projection, including JSON.stringify(Buffer).
  for (const row of business) {
    const query = db.select().from(schema.platformQuery).where(eq(schema.platformQuery.id, row.queryId)).get()!
    const collection = JSON.parse(query.rawResponse!)
    const page = JSON.parse(collection.pages[0].raw)
    page.zrarData.grid.businessListGrid.pageSet[0].cszt = values[business.indexOf(row)]
    collection.pages[0].raw = JSON.stringify(page)
    db.$client.prepare('UPDATE platform_query SET raw_response=? WHERE id=?').run(JSON.stringify(collection), row.queryId)
  }
  const before = protectedCells()
  const report = await service().run()
  expect(report.queries).toMatchObject({ network: 0, reused: 4 })
  expect(report.write?.status).toBe('committed')
  expect(lastRequest().payload.platformQueries!.every(q => q.reuseExisting === true)).toBe(true)
  expect(protectedCells()).toEqual(before)
  expect(db.$client.prepare(`SELECT typeof(status) kind,hex(status) hex FROM platform_relation WHERE id IN (${business.map(r => r.id).join(',')}) ORDER BY id`).all())
    .toEqual([{ kind: 'blob', hex: '00FF' }, { kind: 'blob', hex: '' }, { kind: 'blob', hex: '646F6E65' }])
})

it('A04 same-version observations retain independent seven-field conflicts and source facts', async () => {
  const { request } = await seed('ordinary')
  const query = request.payload.platformQueries![1]!
  const rawFields = query.relations![0]!.rawFields
  const savedQuery = db.select().from(schema.platformQuery).where(eq(schema.platformQuery.queryKey, uscc)).all()[1]!
  const row = selectedRelations()[1]!
  // Same original query, second independent sequence, same raw/version but independent source cells.
  const second = db.insert(schema.platformRelation).values({
    queryId: savedQuery.id, sequenceNo: 9, relationKey: 'SOURCE771', rawFields,
    nameRaw: 'Second original', usccRaw: uscc, aliasNameRaw: 'Second alias', sourceText: 'Second source',
    province: 'OTHER', status: 'OTHER', batch: 'OTHER', declareKind: 'review',
    appliedAt: 'OTHER', awardBatchLabel: 'OTHER', year: 2025,
  }).returning().get()
  ensurePlatformObservation(db, second.id)
  const envelope = JSON.parse(savedQuery.rawResponse!)
  const page = JSON.parse(envelope.pages[0].raw)
  page.zrarData.grid.businessListGrid.pageSet.push(rawFields)
  page.zrarData.grid.businessListGrid.maxCount = 2
  envelope.declaredTotal = 2
  envelope.pages[0].fetchedCount = 2
  envelope.pages[0].declaredTotal = 2
  envelope.pages[0].raw = JSON.stringify(page)
  db.$client.prepare('UPDATE platform_query SET raw_response=? WHERE id=?').run(JSON.stringify(envelope), savedQuery.id)
  const observations = db.select().from(schema.platformBusinessObservation).all().filter(r => r.relationId === row.id || r.relationId === second.id)
  expect(observations).toHaveLength(2)
  expect(observations[0]!.versionId).toBe(observations[1]!.versionId)
  expect(normalizePlatformRelation('business_list', second).normalizationConflicts.map(c => c.field))
    .toEqual(['province', 'status', 'batch', 'declareKind', 'appliedAt', 'awardBatchLabel', 'year'])
  const before = protectedCells()
  expect((await service().run()).write?.status).toBe('committed')
  expect(lastRequest().payload.platformQueries![1]).toEqual({
    interface: 'business_list', queryKey: uscc, rdjb: '2', queriedAt, reuseExisting: true,
    relations: [{ sequenceNo: 1 }, { sequenceNo: 9 }],
  })
  expect(protectedCells()).toEqual(before)
})

it('A08 same-key failed attempts recover without changing the historical request and receipt', async () => {
  await seed('null')
  const svc = service()
  db.$client.exec(`CREATE TRIGGER fault771 BEFORE INSERT ON difference_reason
    WHEN NEW.enterprise_id=(SELECT id FROM enterprise WHERE uscc_norm='${uscc}')
    BEGIN SELECT RAISE(ABORT,'owned decision fault771'); END`)
  const before = protectedCells()
  await expect(svc.run()).rejects.toThrow('owned decision fault771')
  const failed = serviceReceipts()
  expect(failed.map(r => r.status)).toEqual(['preflight', 'failed'])
  expect(db.select().from(schema.differenceReason).all().filter(r => r.enterpriseId === selectedRelations()[0]!.enterpriseId)).toEqual([])
  expect(protectedCells()).toEqual(before)
  db.$client.exec('DROP TRIGGER fault771')
  expect((await svc.run()).write?.status).toBe('committed')
  expect(serviceReceipts().slice(0, failed.length)).toEqual(failed)
  expect(serviceReceipts().map(r => r.status)).toEqual(['preflight', 'failed', 'preflight', 'committed'])
  const good = lastRequest()
  const changed = { ...good, payload: { ...good.payload, platformQueries: [{ ...good.payload.platformQueries![0]!, status: 'failed' as const }] } }
  expect(() => preflightRosterImport(db, changed)).toThrow('Idempotency key belongs to a different request')
  expect(() => preflightRosterImport(db, { ...good, sourceIdentity: 'wrong-owner' })).toThrow()
  expect(protectedCells()).toEqual(before)
})

it('A06 fresh primitive array and Buffer transport remain rejected', () => {
  for (const rawFields of [1, true, 'text', [], Buffer.from([0, 255])]) {
    expect(platformQueriesInputSchema.safeParse([{ interface: 'business_list', queryKey: uscc, rdjb: '2', queriedAt,
      relations: [{ sequenceNo: 1, rawFields }] }]).success).toBe(false)
  }
})

it.each([
  ['TEXT-null', 'null', null],
  ['number', '7', null],
  ['false', 'false', null],
  ['string', '"old"', { 0: 'o', 1: 'l', 2: 'd' }],
  ['array', '[1,{"nested":true},null]', { 0: 1, 1: { nested: true }, 2: null }],
  ['empty-array', '[]', null],
  ['valid-JSON-BLOB', '{}', null],
] as const)('A06 historical %s retains original decoder projection and succeeds through service reference', async (name, rawText, pageRow) => {
  await seed('null')
  const row = selectedRelations()[0]!
  db.$client.prepare('DELETE FROM platform_business_observation WHERE relation_id=?').run(row.id)
  db.$client.prepare('UPDATE platform_relation SET raw_fields=? WHERE id=?').run(name === 'valid-JSON-BLOB' ? Buffer.from(rawText) : rawText, row.id)
  ensurePlatformObservation(db, row.id)
  if (pageRow) {
    const query = db.select().from(schema.platformQuery).where(eq(schema.platformQuery.id, row.queryId)).get()!
    const envelope = JSON.parse(query.rawResponse!)
    const page = JSON.parse(envelope.pages[0].raw)
    page.zrarData.grid.businessListGrid.pageSet = [pageRow]
    envelope.pages[0].raw = JSON.stringify(page)
    db.$client.prepare('UPDATE platform_query SET raw_response=? WHERE id=?').run(JSON.stringify(envelope), row.queryId)
  }
  const before = protectedCells()
  const report = await service().run()
  expect(report.queries).toMatchObject({ network: 0, reused: 4 })
  expect(report.write?.status).toBe('committed')
  expect(lastRequest().payload.platformQueries![0]).toEqual({
    interface: 'business_list', queryKey: uscc, rdjb: '1', queriedAt, reuseExisting: true, relations: [{ sequenceNo: 1 }],
  })
  expect(protectedCells()).toEqual(before)
  expect(db.$client.prepare('SELECT typeof(raw_fields) kind,hex(raw_fields) hex FROM platform_relation WHERE id=?').get(row.id))
    .toEqual({ kind: name === 'valid-JSON-BLOB' ? 'blob' : 'text', hex: Buffer.from(rawText).toString('hex').toUpperCase() })
})

it.each(['missing-raw-id', 'NULL-original-key'] as const)('A03 %s uses original identity coordinates without rebuilding the stored key', async variant => {
  await seed('ordinary')
  const row = selectedRelations()[0]!
  db.$client.prepare('DELETE FROM platform_business_observation WHERE relation_id=?').run(row.id)
  if (variant === 'missing-raw-id') {
    const raw = { ...row.rawFields }
    delete raw.id
    db.$client.prepare('UPDATE platform_relation SET raw_fields=? WHERE id=?').run(JSON.stringify(raw), row.id)
    const query = db.select().from(schema.platformQuery).where(eq(schema.platformQuery.id, row.queryId)).get()!
    const envelope = JSON.parse(query.rawResponse!)
    const page = JSON.parse(envelope.pages[0].raw)
    delete page.zrarData.grid.businessListGrid.pageSet[0].id
    envelope.pages[0].raw = JSON.stringify(page)
    db.$client.prepare('UPDATE platform_query SET raw_response=? WHERE id=?').run(JSON.stringify(envelope), row.queryId)
  } else db.$client.prepare('UPDATE platform_relation SET relation_key=NULL WHERE id=?').run(row.id)
  ensurePlatformObservation(db, row.id)
  expect(readPlatformObservationPlan(db, row.id)).toMatchObject({
    identityState: 'resolved', keySource: variant === 'missing-raw-id' ? 'relation_key' : 'raw_id',
  })
  const before = protectedCells()
  expect((await service().run()).write?.status).toBe('committed')
  expect(lastRequest().payload.platformQueries![0]).toEqual({
    interface: 'business_list', queryKey: uscc, rdjb: '1', queriedAt, reuseExisting: true, relations: [{ sequenceNo: 1 }],
  })
  expect(protectedCells()).toEqual(before)
})

it.each(['whitespace', 'empty'] as const)('NOTREADY %s original key keeps the original normalized-key authentication refusal', async variant => {
  await seed('ordinary')
  const row = selectedRelations()[0]!
  db.$client.prepare('DELETE FROM platform_business_observation WHERE relation_id=?').run(row.id)
  db.$client.prepare('UPDATE platform_relation SET relation_key=? WHERE id=?').run(variant === 'empty' ? '' : ' SOURCE771 ', row.id)
  ensurePlatformObservation(db, row.id)
  const before = protectedCells()
  const svc = service()
  await expect(svc.run()).rejects.toThrow('observation_payload_conflict')
  expect(svc.fetchImpl).not.toHaveBeenCalled()
  expect(svc.cookie).not.toHaveBeenCalled()
  const literalReference: RosterImportPlatformQuery = {
    interface: 'business_list', queryKey: uscc, rdjb: '1', queriedAt, reuseExisting: true, relations: [{ sequenceNo: 1 }],
  }
  if (variant === 'empty') expect(lastRequest().payload.platformQueries![0]).toEqual(literalReference)
  else expect(lastRequest().payload.platformQueries![0]!.relations![0]!.relationKey).toBe('SOURCE771')
  expect(preflightRosterImport(db, command([literalReference], `literal-${variant}`)).preflight.conflicts.map(r => r.error!.code))
    .toEqual(['observation_payload_conflict'])
  expect(serviceReceipts().map(r => r.status)).toEqual(['preflight', 'failed'])
  expect(protectedCells()).toEqual(before)
})

it('A11 final durable receipt failure rolls back the actual decision and retries the same command', async () => {
  const { enterprise } = await seed('null')
  const historicalReceipts = db.select().from(schema.importReceipt).all()
  db.$client.exec(`CREATE TRIGGER receipt_fault771 BEFORE UPDATE OF status ON import_receipt
    WHEN NEW.status='committed' AND NEW.request_body LIKE '%platform/reconcile:specialized_sme%'
    BEGIN SELECT RAISE(ABORT,'owned receipt fault771'); END`)
  const before = protectedCells()
  const svc = service()
  await expect(svc.run()).rejects.toThrow('owned receipt fault771')
  expect(db.select().from(schema.differenceReason).all().filter(row => row.enterpriseId === enterprise.id)).toEqual([])
  expect(protectedCells()).toEqual(before)
  const failed = serviceReceipts()
  expect(failed.map(r => r.status)).toEqual(['preflight', 'failed'])
  db.$client.exec('DROP TRIGGER receipt_fault771')
  const report = await svc.run()
  expect(report.write?.status).toBe('committed')
  expect(serviceReceipts().slice(0, failed.length)).toEqual(failed)
  expect(db.select().from(schema.importReceipt).all().slice(0, historicalReceipts.length)).toEqual(historicalReceipts)
  expect(db.select().from(schema.differenceReason).all().filter(row => row.enterpriseId === enterprise.id)).toHaveLength(1)
  expect(protectedCells()).toEqual(before)
})

it.each(['raw-drift', 'fingerprint-drift', 'bad-JSON-bytes'] as const)('A06 %s remains an error instead of reference recovery', async variant => {
  await seed('ordinary')
  const row = selectedRelations()[0]!
  if (variant === 'fingerprint-drift') {
    db.$client.prepare(`UPDATE platform_business_observation SET input_fingerprint='bad' WHERE relation_id=?`).run(row.id)
  } else if (variant === 'bad-JSON-bytes') {
    db.$client.prepare("UPDATE platform_relation SET raw_fields='{' WHERE id=?").run(row.id)
  } else {
    const raw = { ...row.rawFields, extraDrift: true }
    db.$client.prepare('UPDATE platform_relation SET raw_fields=? WHERE id=?').run(JSON.stringify(raw), row.id)
    const query = db.select().from(schema.platformQuery).where(eq(schema.platformQuery.id, row.queryId)).get()!
    const envelope = JSON.parse(query.rawResponse!)
    const page = JSON.parse(envelope.pages[0].raw)
    page.zrarData.grid.businessListGrid.pageSet[0].extraDrift = true
    envelope.pages[0].raw = JSON.stringify(page)
    db.$client.prepare('UPDATE platform_query SET raw_response=? WHERE id=?').run(JSON.stringify(envelope), row.queryId)
  }
  const before = protectedCells()
  await expect(service().run()).rejects.toThrow(variant === 'bad-JSON-bytes' ? /JSON/ : 'projection_source_drift')
  expect(protectedCells()).toEqual(before)
})

it.each(['latest-failed', 'stale', 'no-envelope'] as const)('A09 %s masks old success and requires fresh collection without credentials', async variant => {
  await seed('ordinary')
  const query = db.select().from(schema.platformQuery).where(eq(schema.platformQuery.queryKey, uscc)).all()[0]!
  if (variant === 'latest-failed') {
    db.insert(schema.platformQuery).values({
      interface: query.interface, queryKey: uscc, rdjb: query.rdjb,
      queriedAt: '2026-11-13T01:00:00.000Z', status: 'failed', failureReason: 'original failure',
    }).run()
  } else db.$client.prepare(`UPDATE platform_query SET ${variant === 'stale' ? "queried_at='2026-11-11T00:00:00.000Z'" : "raw_response=NULL"} WHERE id=?`).run(query.id)
  const before = protectedCells()
  const svc = service()
  await expect(runPlatformReconcile({
    db, usccs: [uscc], titles: ['specialized_sme'], now: () => new Date(time),
    cookie: null, fetchImpl: svc.fetchImpl,
  })).rejects.toThrow('未配置平台会话凭据')
  expect(serviceReceipts()).toEqual([])
  expect(svc.fetchImpl).not.toHaveBeenCalled()
  expect(protectedCells()).toEqual(before)
})

it('A09 exact cutoff is inclusive and reuses all four original slots', async () => {
  await seed('ordinary')
  const report = await runPlatformReconcile({
    db, usccs: [uscc], titles: ['specialized_sme'], now: () => new Date(time),
    freshnessMs: 4 * 60 * 60 * 1000, cookie: null,
    fetchImpl: async () => { throw new Error('Inclusive cutoff must reuse') },
  })
  expect(report.queries).toMatchObject({ reused: 4, network: 0 })
  expect(report.write?.status).toBe('committed')
})

it.each(['parsed-text', 'parsed-NULL'] as const)('A05 ordinary JSON with native BLOB and %s keeps the schema0 comparison and encoding', async variant => {
  await seed('ordinary', variant === 'parsed-NULL' ? { cszt: '' } : {})
  const row = selectedRelations()[0]!
  const status = Buffer.from('done')
  db.$client.prepare('UPDATE platform_relation SET status=? WHERE id=?').run(status, row.id)
  const original = db.select().from(schema.platformRelation).where(eq(schema.platformRelation.id, row.id)).get()!
  const comparison = normalizePlatformRelation('business_list', original)
  if (variant === 'parsed-text') {
    expect(comparison.status).toBeNull()
    expect(comparison.normalizationConflicts).toEqual([{ field: 'status', storedValue: status, rawValue: 'done' }])
  } else {
    expect(comparison.status).toEqual(status)
    expect(comparison.normalizationConflicts).toEqual([])
  }
  const before = protectedCells()
  const report = await service().run()
  expect(report.write?.status).toBe('committed')
  expect(lastRequest().payload.platformQueries![0]!.reuseExisting).toBe(variant === 'parsed-text' ? true : undefined)
  expect(report.counts.needsReview).toBe(1)
  expect(protectedCells()).toEqual(before)
})

it.each(['申请', 'constructor', '未知原类型'] as const)('A04 original declareKind %s follows the existing dictionary without rewriting source columns', async declareKind => {
  await seed('ordinary', { sblx: declareKind })
  const row = selectedRelations()[0]!
  db.$client.prepare('UPDATE platform_relation SET declare_kind=? WHERE id=?').run(declareKind, row.id)
  const before = protectedCells()
  expect((await service().run()).write?.status).toBe('committed')
  expect(protectedCells()).toEqual(before)
})

it('A02 snapshot owner requires a real query and rejects changed coordinates before encoding', async () => {
  await seed('null')
  const query = db.select().from(schema.platformQuery).where(eq(schema.platformQuery.queryKey, uscc)).all()[0]!
  expect(() => db.transaction(tx => StoredReplayOriginal.read(tx, -1))).toThrow('Missing original reconcile query')
  const original = db.transaction(tx => StoredReplayOriginal.read(tx, query.id))
  expect(() => original.encode({ interface: query.interface, rdjb: query.rdjb, queryKey: 'wrong-owner', queriedAt, relations: [] }))
    .toThrow('Invalid original reconcile query binding')
})

const baseCommittedPath = process.env.RECONCILE_771_BASE_COMMITTED
const baseCommittedTest = baseCommittedPath ? it : it.skip
baseCommittedTest('A07 candidate replays an actual exact-base committed B1 request on the same ledger without adding rows', () => {
  if (!baseCommittedPath) throw new Error('Exact-base committed B1 authority required')
  db.$client.close()
  const path = join(caseDir, 'base-committed.sqlite')
  copyFileSync(baseCommittedPath, path)
  chmodSync(path, 0o600)
  expect(statSync(path).ino).not.toBe(statSync(baseCommittedPath).ino)
  expect(statSync(path).nlink).toBe(1)
  db = drizzle({ connection: { source: path, fileMustExist: true }, schema })
  db.$client.pragma('foreign_keys=ON')
  const oldReceipt = db.select().from(schema.importReceipt).all().find(receipt =>
    receipt.status === 'committed' && JSON.parse(receipt.requestBody).sourceIdentity === 'platform/reconcile:specialized_sme')!
  expect(oldReceipt).toBeDefined()
  const request: RosterImportRequest = JSON.parse(oldReceipt.requestBody)
  const oldBytes = JSON.stringify(request)
  for (const query of request.payload.platformQueries!) {
    const originalQuery = db.select().from(schema.platformQuery).all().find(row =>
      row.interface === query.interface && row.queryKey === query.queryKey && row.rdjb === query.rdjb && row.queriedAt === query.queriedAt)!
    const original = db.transaction(tx => StoredReplayOriginal.read(tx, originalQuery.id))
    expect(original.encode(query)).toBe(query)
  }
  expect(JSON.stringify(request)).toBe(oldBytes)
  const before = protectedCells()
  const ledger = db.select().from(schema.importReceipt).all()
  const differences = cells('difference_reason')
  expect(committed(request).batchId).toBe(oldReceipt.batchId)
  expect(db.select().from(schema.importReceipt).all()).toEqual(ledger)
  expect(cells('difference_reason')).toEqual(differences)
  expect(protectedCells()).toEqual(before)
})

const baseFailedPath = process.env.RECONCILE_771_BASE_FAILED
const baseFailedTest = baseFailedPath ? it : it.skip
baseFailedTest('A08 actual exact-base NULL failure recovers on the same source key while retaining both old receipts', async () => {
  if (!baseFailedPath) throw new Error('Exact-base first FAIL authority required')
  db.$client.close()
  const path = join(caseDir, 'base-failed.sqlite')
  copyFileSync(baseFailedPath, path)
  chmodSync(path, 0o600)
  expect(statSync(path).ino).not.toBe(statSync(baseFailedPath).ino)
  expect(statSync(path).nlink).toBe(1)
  db = drizzle({ connection: { source: path, fileMustExist: true }, schema })
  db.$client.pragma('foreign_keys=ON')
  const old = serviceReceipts()
  expect(old.map(row => row.status)).toEqual(['preflight', 'failed'])
  const oldRequest: RosterImportRequest = JSON.parse(old[1]!.requestBody)
  expect(oldRequest.payload.platformQueries![0]!.relations![0]!.rawFields).toEqual({
    id: 'SOURCE771', qymc: 'Replay771', tyshxydm: uscc, szsfmc: 'P', cszt: 'done', whpc: 'B',
    sblx: 'apply', sqsj: 'D', personuuid: 'A', year: '2024',
  })
  const before = protectedCells()
  const report = await service().run()
  expect(report.write?.status).toBe('committed')
  expect(serviceReceipts().slice(0, old.length)).toEqual(old)
  expect(lastRequest().idempotencyKey).toBe(oldRequest.idempotencyKey)
  expect(lastRequest().payload.platformQueries![0]).toEqual({
    interface: 'business_list', queryKey: uscc, rdjb: '1', queriedAt, reuseExisting: true, relations: [{ sequenceNo: 1 }],
  })
  expect(serviceReceipts().map(row => row.status)).toEqual(['preflight', 'failed', 'preflight', 'committed'])
  expect(protectedCells()).toEqual(before)
})

it('A08 processing receipt fixture still binds the original request hash and source identity', async () => {
  await seed('null')
  const request = command(slots.map(slot => ({
    ...slot, queryKey: uscc, queriedAt, reuseExisting: true, relations: [{ sequenceNo: 1 }],
  })), 'processing771')
  preflightRosterImport(db, request)
  const previous = db.select().from(schema.importReceipt).all().at(-1)!
  // Exact persisted crash interval after normal reservation and before execution.
  db.insert(schema.importReceipt).values({
    batchId: previous.batchId, operation: 'commit', requestHash: previous.requestHash,
    requestBody: previous.requestBody, status: 'processing', createdAt: time,
  }).run()
  const before = cells('import_receipt')
  const changed = { ...request, payload: { platformQueries: [{ ...request.payload.platformQueries![0]!, relations: [] }] } }
  expect(() => preflightRosterImport(db, changed)).toThrow('Idempotency key belongs to a different request')
  expect(() => preflightRosterImport(db, { ...request, sourceIdentity: 'wrong-source' })).toThrow('Idempotency key belongs to a different source')
  expect(cells('import_receipt')).toEqual(before)
})

it.each(['JSON-null', 'invalid-JSON'] as const)('A06 historical raw BLOB %s retains the original decoder or serializer refusal', async variant => {
  await seed('null')
  const row = selectedRelations()[0]!
  db.$client.prepare('DELETE FROM platform_business_observation WHERE relation_id=?').run(row.id)
  db.$client.prepare('UPDATE platform_relation SET raw_fields=? WHERE id=?').run(Buffer.from(variant === 'JSON-null' ? 'null' : '{'), row.id)
  const before = protectedCells()
  await expect(service().run()).rejects.toThrow(variant === 'JSON-null' ? 'platform_raw_not_json' : /JSON/)
  expect(protectedCells()).toEqual(before)
})
