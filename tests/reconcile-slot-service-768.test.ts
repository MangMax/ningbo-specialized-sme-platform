import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import { chmodSync, copyFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'
import { targetSchema as s } from '../lib/platform/target-schema'
import { queryPlatformSlots, type LegacySlotCollection } from '../lib/platform/client'
import { buildPlatformWritePayload } from '../lib/platform/payload'
import { normalizePlatformRelation } from '../lib/platform/normalization'
import { slotLegacyRow, slotPayloadRow } from '../lib/platform/reconcile-slot-capture'
import { RDJB_TITLE } from '../lib/platform/reconcile'
import { reserveLegacyIds } from '../lib/platform/target-archive'
import { assertExpandRuntime } from '../db/schema-phase'
import { normalizeName } from '../lib/domain'
import { commitRosterImport, preflightRosterImport } from '../server/utils/roster-import'
import { collectReconcileTargets, inProcessReconcileWriter, runPlatformReconcile, type ReconcileRunOptions } from '../server/utils/platform-reconcile'
import { compareReconcileSlotCollections, createReconcileTargetSlotReader } from '../server/utils/platform-reconcile-target-slots'
import { whenIdle } from '../server/utils/job-runner'
import { platformQueriesInputSchema } from '../server/utils/roster-import-platform-schema'
import type { RosterImportPlatformQuery, RosterImportRequest } from '../lib/roster-import-client'

const inputs = process.env.RECONCILE_768_INPUT, cases = process.env.RECONCILE_768_CASES, evidence = process.env.RECONCILE_768_EVIDENCE
if (!inputs || !cases || !evidence) throw new Error('Owned RECONCILE_768_INPUT/CASES/EVIDENCE required')
const time = '2026-11-13T04:00:00.000Z', uscc = '91330211000000088X'
let t: Database.Database, old: Database.Database, serial = 0, path: string
let db: ReturnType<typeof drizzle<typeof schema>>, oldDb: typeof db
const trace: string[] = []
let onSql: ((sql: string) => void) | undefined
const slots = [['business_list','1'], ['business_list','2'], ['business_list','3'], ['apply_list','']] as const
function copy(name: string, suffix: string) {
  const from = join(inputs!, name + '.sqlite'), to = join(cases!, `${++serial}-${suffix}.sqlite`)
  copyFileSync(from, to); chmodSync(to, 0o600)
  expect(statSync(to).ino).not.toBe(statSync(from).ino); expect(statSync(to).nlink).toBe(1)
  return to
}
beforeEach(context => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(time))
  path = copy('retired', 'target')
  onSql = undefined
  t = new Database(path, { verbose: sql => { trace.push(String(sql)); onSql?.(String(sql)) } }); t.pragma('foreign_keys=ON')
  old = new Database(copy('schema0', 'old')); old.pragma('foreign_keys=ON')
  db = drizzle(t, { schema }); oldDb = drizzle(old, { schema }); trace.length = 0
  writeFileSync(join(evidence!, `test-${serial}.json`), JSON.stringify({ name: context.task.name, path }))
})
afterEach(async () => {
  try {
    await whenIdle()
    expect(t.pragma('foreign_key_check')).toEqual([])
    expect(t.prepare("SELECT name FROM sqlite_schema WHERE name IN ('platform_query','platform_relation')").all()).toEqual([])
    expect(trace.filter(q => /\b(?:from|join|into|update)\s+["`]?platform_(?:query|relation)["`]?(?=\s|$|\()/i.test(q))).toEqual([])
    writeFileSync(join(evidence!, `trace-${serial}.json`), JSON.stringify(trace))
  } finally { onSql = undefined; t.close(); old.close(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks() }
})
function targets() {
  expect(collectReconcileTargets(db, { titles: ['specialized_sme'], usccs: [uscc] }).targets.length).toBeGreaterThan(0)
  expect(collectReconcileTargets(db, { titles: ['specialized_sme'], usccs: [uscc] })).toEqual(collectReconcileTargets(oldDb, { titles: ['specialized_sme'], usccs: [uscc] }))
}
function request(queries: RosterImportPlatformQuery[], key: string): RosterImportRequest {
  return { sourceKind: 'platform_archive', sourceIdentity: 'seed768', idempotencyKey: key, payload: { platformQueries: queries } }
}
function commit(q: RosterImportPlatformQuery[], key: string) {
  for (const database of [oldDb, db]) {
    const r = request(q, key)
    expect(preflightRosterImport(database, r).preflight.conflicts).toEqual([])
    const result = commitRosterImport(database, r, [], { deferCandidateTasks: true })
    expect(result.status, JSON.stringify(result)).toBe('committed')
  }
}
function reply(source: string, rows: Record<string, unknown>[]) {
  return JSON.stringify({ zrarData: { grid: { [source === 'business_list' ? 'businessListGrid' : 'applyGrid']: { page: 1, pageSize: 50, maxCount: rows.length, pageSet: rows } } } })
}
async function query(source: 'business_list'|'apply_list', rdjb: ''|'1'|'2'|'3', rows: Record<string, unknown>[], queriedAt = time) {
  const [outcome] = await queryPlatformSlots({
    uscc, cookie: 'offline768=1', retries: 0, now: () => queriedAt,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => reply(source, rows) }),
  }, source === 'apply_list' ? [{ interface: source }] : rdjb === '' ? [] : [{ interface: source, rdjb }])
  if (!outcome) throw new Error('Missing producer outcome')
  const built = buildPlatformWritePayload({
    sourceIdentity: 'seed768', idempotencyKey: 'seed768',
    queries: [{ interface: source, queryKey: uscc, rdjb, queriedAt, titleCode: source === 'business_list' ? RDJB_TITLE[rdjb] : null, outcome: { ...outcome, rawRows: rows } }],
    enterprises: collectReconcileTargets(db).enterprises,
  })
  return built.payload.platformQueries![0]!
}
async function seed(rows: Record<string, unknown>[] = [{ id: 'NORMAL768', qymc: 'Capture', tyshxydm: uscc, cszt: 'done', year: 2024, sblx: '申请' }], queriedAt = time) {
  const queries = await Promise.all(slots.map(([source, rdjb]) => query(source, rdjb, rows, queriedAt)))
  commit(queries, 'seed-' + queriedAt)
  return queries
}
function reader() { return createReconcileTargetSlotReader(t) }
function options(database = db): ReconcileRunOptions {
  return { db: database, titles: ['specialized_sme'], usccs: [uscc], now: () => new Date(time), cookie: null,
    fetchImpl: async () => { throw new Error('Unexpected fetch') }, ...(database === db ? { targetSlots: reader() } : {}) }
}
function sourceRows() {
  return Object.fromEntries(['platform_collection','platform_business_record','platform_business_record_version','platform_business_observation','platform_observation_assignment','platform_legacy_query_alias','platform_legacy_relation_alias','platform_archive_value','platform_collection_archive_ref','platform_observation_archive_ref','platform_version_archive_ref','platform_observation_fingerprint_basis','enterprise_alias']
    .map(name => [name, t.prepare(`SELECT * FROM ${name} ORDER BY 1`).raw().all()]))
}
function decisionRequest(connection: Database.Database) {
  const r = connection.prepare("SELECT request_body body FROM import_receipt r JOIN import_batch b ON b.id=r.batch_id WHERE b.source_identity='platform/reconcile:specialized_sme' AND r.operation='commit' AND r.status='committed' ORDER BY r.id DESC LIMIT 1").get() as { body: string } | undefined
  expect(r).toBeDefined()
  return JSON.parse(r!.body) as RosterImportRequest
}

/** Independent literals from the unchanged B1 source, never a production mapper. */
function originalTypedRow(): Record<string, unknown> {
  return JSON.parse('{"id":"SHARED","qymc":"Capture","tyshxydm":"91330211000000088X","rdjb":"2","szsfmc":"P","cszt":"done","whpc":"B","sblx":"申请","sqsj":"D","personuuid":"A","year":2024,"n":1,"b":true,"x":null,"o":{"z":1,"a":false},"arr":[1,false],"__proto__":{"own":true},"constructor":"own"}')
}
function originalB1Request(): RosterImportRequest {
  return {
    idempotencyKey: 'platform_reconcile:31378cd80d723adb2c4cd4f7f6d581d1',
    sourceKind: 'alias_evidence', sourceIdentity: 'platform/reconcile:specialized_sme', sourceSha256: null,
    payload: {
      platformQueries: [
        { interface: 'business_list', queryKey: uscc, rdjb: '1', titleCode: null, queriedAt: '2026-11-13T00:00:00.000Z', status: 'no_record', failureReason: null, rawResponse: null, relations: [] },
        { interface: 'business_list', queryKey: uscc, rdjb: '2', titleCode: null, queriedAt: '2026-11-13T00:00:00.000Z', status: 'success', failureReason: null, rawResponse: null, relations: [
          { sequenceNo: 1, relationKey: 'SHARED', enterpriseId: 1, usccRaw: uscc, nameRaw: 'Capture', aliasNameRaw: null,
            province: 'P', status: 'done', batch: 'B', declareKind: 'apply', appliedAt: 'D', awardBatchLabel: 'A', year: 2024,
            matchBasis: 'uscc', verificationStatus: 'confirmed', rawFields: originalTypedRow() },
        ] },
        { interface: 'business_list', queryKey: uscc, rdjb: '3', titleCode: null, queriedAt: '2026-11-13T00:00:00.000Z', status: 'no_record', failureReason: null, rawResponse: null, relations: [] },
        { interface: 'apply_list', queryKey: uscc, rdjb: '', titleCode: null, queriedAt: '2026-11-13T00:00:00.000Z', status: 'no_record', failureReason: null, rawResponse: null, relations: [] },
      ],
      differences: [{
        enterpriseName: 'Capture', uscc, titleCode: 'specialized_sme', direction: 'extra_in_miit', status: 'needs_review', reasonCode: null,
        reasonNote: '已取得1条原始关系（平台状态：done）；待代理核实原因与措施。',
        measureCode: 'manual_review',
        measureNote: '代理核对正式名单、导出时点、各平台来源及必要的公开证据后，显式提交原因与措施。',
        evidenceQueryRef: { interface: 'business_list', queryKey: uscc, rdjb: '2', queriedAt: '2026-11-13T00:00:00.000Z' },
        evidenceRelationId: null, movedIn: null, verificationStatus: 'pending', recordedAt: time,
      }],
    },
  }
}
function originalB1Report() {
  return {
    startedAt: time, finishedAt: time, sourceIdentity: 'platform/reconcile:specialized_sme',
    filters: { titles: ['specialized_sme'], directions: null, usccs: [uscc], limit: null, offset: null, freshnessMs: 86400000 },
    targetCount: 1, usccCount: 1, queries: { network: 0, reused: 4, byInterface: { business_list: 0, apply_list: 0 } },
    relations: 1,
    collection: { complete: 4, partial: 0, failed: 0, unknown: 0, positions: slots.map(([source, rdjb]) => ({
      interface: source, rdjb, queryKey: uscc, queriedAt: '2026-11-13T00:00:00.000Z', completedAt: '2026-11-13T00:00:00.000Z',
      completeness: 'complete', declaredTotal: rdjb === '2' ? 1 : 0, unfinished: [], requestCount: 1, failureReason: null,
      pages: [{ source: source === 'business_list' ? 'businessList' : 'queryList', rdjb: rdjb || null, page: 1,
        queriedAt: '2026-11-13T00:00:00.000Z', status: 'success', fetchedCount: rdjb === '2' ? 1 : 0, declaredTotal: rdjb === '2' ? 1 : 0, error: null }],
    })) },
    counts: { confirmed: 0, byReason: {}, noRecord: 0, needsReview: 1, queryFailed: 0, notQueried: 0, reusedFresh: 0, total: 1 },
    unqueryable: [], mergeCandidates: [], aliases: 0,
    write: { batchId: 46, status: 'committed', written: 1, skipped: 1 }, cancelled: false,
  }
}
function nativeCells(connection: Database.Database, table: string) {
  const columns = connection.pragma(`table_info("${table}")`) as { name: string }[]
  return connection.prepare(`SELECT ${columns.flatMap(({ name }) => [
    `typeof("${name}")`, `hex(cast("${name}" AS blob))`,
  ]).join(',')} FROM "${table}" ORDER BY 1,2`).raw().all()
}

it('runs original target collection and default writer with four fresh slots no credentials and exact schema0 payload decisions and receipts', async () => {
  targets()
  const typed = JSON.parse(`{"id":"NORMAL768","qymc":"Capture","tyshxydm":"${uscc}","cszt":"done","year":2024,"sblx":"申请","n":1,"b":false,"x":null,"o":{"z":1,"a":2},"a":[false,1],"__proto__":{"own":true},"constructor":"own"}`)
  await seed([typed])
  for (const name of Object.keys(process.env).filter(k => /COOKIE|TOKEN|PASSWORD|CREDENTIAL|SECRET/i.test(k))) vi.stubEnv(name, '')
  const fetch = vi.fn(async () => { throw new Error('No fetch allowed') })
  const before = sourceRows()
  const expected = await runPlatformReconcile({ ...options(oldDb), fetchImpl: fetch })
  const actual = await runPlatformReconcile({ ...options(), fetchImpl: fetch })
  expect(fetch).not.toHaveBeenCalled()
  expect(actual.queries).toEqual({ network: 0, reused: 4, byInterface: { business_list: 0, apply_list: 0 } })
  expect(actual.counts).toMatchObject({ needsReview: 1, confirmed: 0, noRecord: 0, queryFailed: 0, notQueried: 0, total: 1 })
  expect(actual.write?.status).toBe('committed')
  expect({ ...actual, write: null }).toEqual({ ...expected, write: null })
  const payload = decisionRequest(t), oracle = decisionRequest(old)
  expect(payload).toEqual(oracle)
  expect(payload.payload.platformQueries).toHaveLength(4)
  for (const q of payload.payload.platformQueries!) {
    expect(q.rawResponse).toBeNull()
    expect(q.relations?.[0]?.rawFields).toEqual(typed)
    expect(Object.keys(q.relations![0]!.rawFields!)).toEqual(Object.keys(typed))
  }
  const decisions = db.select().from(schema.differenceReason).where(eq(schema.differenceReason.recordedAt, time)).all()
  expect(decisions).toHaveLength(1)
  expect(decisions[0]).toMatchObject({ status: 'needs_review', reasonCode: null, verificationStatus: 'pending' })
  const qid = t.prepare("SELECT a.old_id id FROM platform_legacy_query_alias a JOIN platform_collection c ON c.id=a.collection_id WHERE c.queried_at=? AND c.interface='business_list' AND c.rdjb='1'").get(time)
  expect(decisions[0]!.evidenceQueryId).toBe((qid as {id:number}).id)
  expect(sourceRows()).toEqual(before)
  const replayWriter = inProcessReconcileWriter(db)
  await replayWriter.preflight(payload)
  const replayed = await replayWriter.commit(payload)
  expect(replayed.batchId).toBe(actual.write!.batchId)
  expect(sourceRows()).toEqual(before)
  const again = await runPlatformReconcile({ ...options(), fetchImpl: fetch })
  expect(again.write).toBeNull(); expect(again.counts.reusedFresh).toBe(1)
  writeFileSync(join(evidence!, 'normal-service.json'), JSON.stringify({ actual, expected, payload, decisions }, null, 2))
})

it('reuses complete empty no_record through the real service and writes the literal no_record decision', async () => {
  await seed([])
  const oldReport = await runPlatformReconcile(options(oldDb))
  const report = await runPlatformReconcile(options())
  expect(report.queries).toMatchObject({ reused: 4, network: 0 })
  expect(report.counts.noRecord).toBe(1); expect(report.relations).toBe(0)
  expect(report.write?.status).toBe('committed')
  expect(decisionRequest(t)).toEqual(decisionRequest(old))
  expect({ ...report, write: null }).toEqual({ ...oldReport, write: null })
})

it('binds the explicit reader to the actual service connection and preserves ordinary closed guards', async () => {
  reserveLegacyIds(drizzle(t, { schema: s }), { query: 9000, relation: 10000 })
  await seed()
  const publicId = t.prepare('SELECT a.old_id alias,c.id physical FROM platform_legacy_query_alias a JOIN platform_collection c ON c.id=a.collection_id WHERE c.queried_at=? LIMIT 1').get(time) as { alias: number; physical: number }
  expect(publicId.alias).toBeGreaterThan(9000); expect(publicId.physical).toBeLessThan(publicId.alias)
  await expect(runPlatformReconcile({ ...options(oldDb), targetSlots: reader() })).rejects.toThrow('connection mismatch')
  expect(() => assertExpandRuntime(t)).toThrow('W/R cutover required')
  expect(() => assertExpandRuntime(old)).not.toThrow()
})

it.each([
  ['failed', false], ['partial', false], ['unknown', false], ['not-queried', false], ['bare', false], ['success-empty', false],
  ['no-record-rows', false], ['missing-page-raw', false], ['empty', true],
] as const)('selects latest %s before capture admission and only fetches the missing slot', async (variant, reusable) => {
  await seed()
  const later = '2026-11-13T04:00:00.001Z'
  const q = await query('business_list', '2', variant === 'empty' || variant === 'success-empty' ? [] : [{ id: 'SHADOW768' }], later)
  if (variant === 'failed' || variant === 'partial') q.status = variant
  if (variant === 'not-queried') q.status = 'not_queried'
  if (variant === 'unknown') {
    const envelope = JSON.parse(q.rawResponse!)
    envelope.completeness = 'unknown'; q.rawResponse = JSON.stringify(envelope)
  }
  if (variant === 'bare') q.rawResponse = '{}'
  if (variant === 'success-empty') q.status = 'success'
  if (variant === 'no-record-rows') q.status = 'no_record'
  if (variant === 'missing-page-raw') {
    const envelope: LegacySlotCollection = JSON.parse(q.rawResponse!)
    envelope.pages[0]!.raw = ''; q.rawResponse = JSON.stringify(envelope)
  }
  commit([q], 'shadow')
  const before = sourceRows()
  const calls: string[] = [], oldCalls: string[] = []
  const fetch = (calls: string[]): NonNullable<ReconcileRunOptions['fetchImpl']> => async (_url, init) => {
    const form = new URLSearchParams(init.body)
    calls.push(form.get('rdjb') ?? '')
    return { ok: true, status: 200, text: async () => reply('business_list', []) }
  }
  const now = () => new Date('2026-11-13T05:00:00.000Z')
  const oldReport = await runPlatformReconcile({ ...options(oldDb), now, cookie: 'fake768=local', fetchImpl: fetch(oldCalls) })
  const report = await runPlatformReconcile({ ...options(), now, cookie: 'fake768=local', fetchImpl: fetch(calls) })
  expect(calls).toEqual(reusable ? [] : ['2']); expect(calls).toEqual(oldCalls)
  expect(report.queries).toMatchObject({ reused: reusable ? 4 : 3, network: reusable ? 0 : 1 })
  expect({ ...report, write: null }).toEqual({ ...oldReport, write: null })
  expect(decisionRequest(t)).toEqual(decisionRequest(old))
  if (reusable) expect(sourceRows()).toEqual(before)
})

it('lets locale-latest stale shadow a fresh complete slot in both normal services and fetches only that slot', async () => {
  await seed([], time)
  const stale = '2026-11-13T04:00:00+00:00'
  expect(stale.localeCompare(time)).toBeGreaterThan(0)
  expect(stale < time).toBe(true)
  const q = await query('business_list', '2', [{ id: 'STALE768' }], stale)
  commit([q], 'stale-shadow')
  const originalTimes = t.prepare('SELECT id,queried_at FROM platform_collection ORDER BY id').all()
  t.prepare('UPDATE platform_collection SET last_collected_at=?').run('2099-01-01')
  const runTime = '2026-11-14T04:00:00.000Z'
  const reports = [], calls: string[][] = []
  for (const database of [oldDb, db]) {
    const fetched: string[] = []
    const report = await runPlatformReconcile({ ...options(database), now: () => new Date(runTime), cookie: 'offline=768', retries: 0,
      fetchImpl: async (_url, init) => {
        fetched.push(new URLSearchParams(init.body).get('rdjb') ?? '')
        return { ok: true, status: 200, text: async () => reply('business_list', []) }
      } })
    expect(fetched).toEqual(['2'])
    expect(report.queries).toEqual({ network: 1, reused: 3, byInterface: { business_list: 1, apply_list: 0 } })
    expect(report.write?.status).toBe('committed')
    expect(report.counts.noRecord).toBe(1)
    reports.push(report); calls.push(fetched)
  }
  expect({ ...reports[0], write: null }).toEqual({ ...reports[1], write: null })
  expect(decisionRequest(t)).toEqual(decisionRequest(old))
  expect(decisionRequest(t).payload.platformQueries!.map(q => [q.rdjb, q.queriedAt])).toEqual([
    ['1', time], ['2', runTime], ['3', time], ['', time],
  ])
  expect(t.prepare('SELECT id,queried_at FROM platform_collection WHERE id<=? ORDER BY id').all(originalTimes.length)).toEqual(originalTimes)
  writeFileSync(join(evidence!, 'stale-shadow-normal.json'), JSON.stringify({ reports, calls, originalTimes }, null, 2))
})

it('preserves selected NULL and mismatched nonNULL titles in target normal reuse and keeps wrong-title replay closed', async () => {
  const queries = await Promise.all(slots.map(([source, rdjb]) => query(source, rdjb, [])))
  const titles = ['little_giant', null, 'specialized_sme', 'little_giant'] as const
  queries.forEach((q, i) => { q.titleCode = titles[i]! })
  commit(queries, 'original-mismatched-titles')
  const before = sourceRows()
  const fetch = vi.fn(async () => { throw new Error('Must reuse mismatched original metadata') })
  const oldReport = await runPlatformReconcile({ ...options(oldDb), fetchImpl: fetch })
  const report = await runPlatformReconcile({ ...options(), fetchImpl: fetch })
  expect(report.write?.status).toBe('committed')
  expect({ ...report, write: null }).toEqual({ ...oldReport, write: null })
  expect(decisionRequest(t)).toEqual(decisionRequest(old))
  expect(decisionRequest(t).payload.platformQueries!.map(q => [q.rdjb, q.titleCode]))
    .toEqual([['1', 'little_giant'], ['2', null], ['3', 'specialized_sme'], ['', 'little_giant']])
  expect(sourceRows()).toEqual(before)
  const wrong = request([{ ...queries[0]!, titleCode: 'innovative_sme', rawResponse: null }], 'wrong-original-title')
  for (const database of [oldDb, db]) expect(preflightRosterImport(database, wrong).preflight.conflicts.map(c => c.error?.field)).toEqual(['titleCode'])
  expect(fetch).not.toHaveBeenCalled()
})

it('mixes selected original titles with fresh business and apply mappings through both default services', async () => {
  const one = await query('business_list', '1', [])
  one.titleCode = 'little_giant'
  const two = await query('business_list', '2', [])
  two.titleCode = null
  commit([one, two], 'mixed-metadata')
  // Baseline business3/apply are stale at this cutoff; the two new slots are fresh.
  const reports = [], calls: string[][] = []
  for (const database of [oldDb, db]) {
    const fetched: string[] = []
    reports.push(await runPlatformReconcile({ ...options(database), now: () => new Date('2026-11-14T04:00:00.000Z'), cookie: 'offline=768', retries: 0,
      fetchImpl: async (_url, init) => {
        const rdjb = new URLSearchParams(init.body).get('rdjb') ?? ''
        fetched.push(rdjb)
        return { ok: true, status: 200, text: async () => reply(rdjb ? 'business_list' : 'apply_list', []) }
      } }))
    calls.push(fetched)
  }
  expect(calls).toEqual([['3', ''], ['3', '']])
  expect(reports[1]!.queries).toEqual({ network: 2, reused: 2, byInterface: { business_list: 1, apply_list: 1 } })
  expect(reports[1]!.write?.status).toBe('committed')
  expect({ ...reports[0], write: null }).toEqual({ ...reports[1], write: null })
  expect(decisionRequest(t)).toEqual(decisionRequest(old))
  expect(decisionRequest(t).payload.platformQueries!.map(q => [q.rdjb, q.titleCode])).toEqual([
    ['1', 'little_giant'], ['2', null], ['3', 'little_giant'], ['', null],
  ])
})

it.each([
  ['number', 3], ['boolean', false], ['string', 'raw'], ['array', [1, false]], ['native-status', Buffer.from([0,255])],
] as const)('keeps the existing fresh input boundary for %s without expanding the transport contract', (name, value) => {
  const row = name === 'native-status' ? { sequenceNo: 1, status: value, rawFields: {} } : { sequenceNo: 1, rawFields: value }
  const parsed = platformQueriesInputSchema.safeParse([{ interface: 'business_list', queryKey: uscc, rdjb: '2', queriedAt: time, relations: [row] }])
  expect(parsed.success).toBe(false)
  if (parsed.success) throw new Error('Fresh input unexpectedly accepted')
  expect(parsed.error.issues.map(issue => issue.path)).toContainEqual([0, 'relations', 0, name === 'native-status' ? 'status' : 'rawFields'])
})

it.each(['null', 'empty'] as const)('commits original %s raw fallback through both normal services without changing source rows', async variant => {
  const fallback = { id: 'FALLBACK768', qymc: 'Capture', tyshxydm: uscc, szsfmc: 'P', cszt: 'done', whpc: 'B', sblx: 'apply', sqsj: 'D', personuuid: 'A', year: '2024' }
  const queries = await Promise.all(slots.map(([source, rdjb]) => query(source, rdjb, [fallback])))
  for (const q of queries) q.relations![0]!.rawFields = variant === 'null' ? null : {}
  commit(queries, 'fallback-' + variant)
  reader().read(db, uscc, '2026-11-12').forEach(slot => expect(slot.payloadRows).toEqual([fallback]))
  const before = sourceRows()
  const fetch = vi.fn(async () => { throw new Error('Fallback slots must never fetch') })
  const attempts = []
  for (const database of [oldDb, db]) {
    const preview = await runPlatformReconcile({ ...options(database), fetchImpl: fetch, write: false })
    expect(preview.queries).toEqual({ reused: 4, network: 0, byInterface: { business_list: 0, apply_list: 0 } })
    const result = await runPlatformReconcile({ ...options(database), targetSlots: undefined, fetchImpl: fetch })
    expect(result.write?.status).toBe('committed')
    const connection = database === db ? t : old
    const receipt = connection.prepare("SELECT request_body,item_results,status FROM import_receipt WHERE operation='commit' ORDER BY id DESC LIMIT 1").get() as { request_body: string; item_results: string; status: string }
    expect(receipt.status).toBe('committed')
    const request: RosterImportRequest = JSON.parse(receipt.request_body)
    expect(request.payload.platformQueries!.map(q => ({
      reuseExisting: q.reuseExisting, relations: q.relations,
    }))).toEqual(Array.from({ length: 4 }, () => ({
      reuseExisting: true, relations: [{ sequenceNo: 1 }],
    })))
    expect(JSON.parse(receipt.item_results).filter((item: { ok: boolean }) => !item.ok)).toEqual([])
    attempts.push({ preview, receipt })
  }
  expect(sourceRows()).toEqual(before)
  expect(fetch).not.toHaveBeenCalled()
  writeFileSync(join(evidence!, 'fallback-normal-' + variant + '.json'), JSON.stringify({
    variant, attempts, fallback, fetchCalls: fetch.mock.calls.length,
    result: 'Both real default services committed immutable original references with no source row changes.',
  }, null, 2))
})

it.each([
  ['equal', '2026-11-12T04:00:00.000Z', 4],
  ['before', '2026-11-12T03:59:59.999Z', 0],
  ['after', '2026-11-12T04:00:00.001Z', 4],
  ['string-not-date', '2026-11-12T04:00:00+00:00', 0],
] as const)('preserves JS string freshness at the %s boundary independently of recency', async (_name, queriedAt, count) => {
  const qs = await Promise.all(slots.map(([source, rdjb]) => query(source, rdjb, [], queriedAt)))
  const cutoff = '2026-11-12T04:00:00.000Z'
  // A separate lawful key isolates these times from inherited baseline queries.
  const key = 'freshness768'
  for (const q of qs) {
    const envelope: LegacySlotCollection = JSON.parse(q.rawResponse!)
    envelope.queryKey = key
    q.queryKey = key; q.rawResponse = JSON.stringify(envelope)
  }
  commit(qs, 'fresh-key')
  expect(reader().read(db, key, cutoff).size).toBe(count)
  const originalTimes = t.prepare('SELECT queried_at t FROM platform_collection WHERE query_key=?').all(key)
  t.prepare('UPDATE platform_collection SET last_collected_at=?').run(time)
  expect(reader().read(db, key, cutoff).size).toBe(count)
  expect(t.prepare('SELECT queried_at t FROM platform_collection WHERE query_key=?').all(key)).toEqual(originalTimes)
})

it.each([
  ['equal', '2026-11-14T04:00:00.000Z', 4],
  ['before', '2026-11-14T04:00:00.001Z', 0],
  ['after', '2026-11-14T03:59:59.999Z', 4],
] as const)('uses the %s cutoff boundary through both actual normal services without refreshing original queriedAt', async (_name, now, reused) => {
  await seed([])
  const originalTimes = t.prepare('SELECT id,queried_at FROM platform_collection ORDER BY id').all()
  t.prepare('UPDATE platform_collection SET last_collected_at=?').run('2099-01-01')
  old.prepare('UPDATE platform_query SET last_collected_at=?').run('2099-01-01')
  const reports = [], counts = []
  for (const database of [oldDb, db]) {
    let calls = 0
    reports.push(await runPlatformReconcile({ ...options(database), now: () => new Date(now), cookie: 'offline=768', retries: 0,
      fetchImpl: async (_url, init) => {
        calls++
        const rdjb = new URLSearchParams(init.body).get('rdjb') ?? ''
        return { ok: true, status: 200, text: async () => reply(rdjb ? 'business_list' : 'apply_list', []) }
      } }))
    counts.push(calls)
  }
  expect(counts).toEqual([4 - reused, 4 - reused])
  expect(reports[1]!.queries).toEqual({ network: 4 - reused, reused, byInterface: { business_list: reused ? 0 : 3, apply_list: reused ? 0 : 1 } })
  expect(reports[1]!.counts.noRecord).toBe(1)
  expect(reports[1]!.write?.status).toBe('committed')
  expect({ ...reports[0], write: null }).toEqual({ ...reports[1], write: null })
  expect(decisionRequest(t)).toEqual(decisionRequest(old))
  expect(decisionRequest(t).payload.platformQueries!.map(q => q.queriedAt)).toEqual(Array.from({ length: 4 }, () => reused ? time : now))
  expect(t.prepare('SELECT id,queried_at FROM platform_collection WHERE id<=? ORDER BY id').all(originalTimes.length)).toEqual(originalTimes)
})

it('fetches four genuinely absent target slots through the real normal service with unchanged fresh title mappings', async () => {
  const key = '91330211000000768X'
  for (const database of [oldDb, db]) {
    const enterprise = database.insert(schema.enterprise).values({ name: key, nameNorm: key, usccNorm: key }).returning().get()
    database.insert(schema.record).values({ enterpriseId: enterprise.id, source: 'miit', titleCode: 'specialized_sme' }).run()
  }
  expect(reader().read(db, key, '2026-11-12').size).toBe(0)
  const reports = [], fetched: string[][] = []
  for (const database of [oldDb, db]) {
    const calls: string[] = []
    reports.push(await runPlatformReconcile({ ...options(database), usccs: [key], cookie: 'offline=768', retries: 0,
      fetchImpl: async (_url, init) => {
        const form = new URLSearchParams(init.body), rdjb = form.get('rdjb') ?? ''
        calls.push(rdjb)
        return { ok: true, status: 200, text: async () => reply(rdjb ? 'business_list' : 'apply_list', []) }
      } }))
    fetched.push(calls)
  }
  expect(fetched).toEqual([['1', '2', '3', ''], ['1', '2', '3', '']])
  expect(reports[1]!.queries).toEqual({ network: 4, reused: 0, byInterface: { business_list: 3, apply_list: 1 } })
  expect(reports[1]!.write?.status).toBe('committed')
  expect({ ...reports[0], write: null }).toEqual({ ...reports[1], write: null })
  expect(decisionRequest(t)).toEqual(decisionRequest(old))
  expect(decisionRequest(t).payload.platformQueries!.map(q => [q.rdjb, q.titleCode])).toEqual([
    ['1', 'innovative_sme'], ['2', 'specialized_sme'], ['3', 'little_giant'], ['', null],
  ])
  expect(reader().read(db, key, '2026-11-12').size).toBe(4)
})

it.each([
  ['shared-text', 1], ['shared-blob', 1], ['shared-empty-blob', 1],
  ['unindexed', 1], ['null-raw', 1], ['empty-raw', 1],
] as const)('reads original per-observation facts and selected typed inputs for %s', (key, count) => {
  const found = reader().read(db, key, '2026-11-12T00:00:00.000Z').get('business_list|2')!
  expect(found.evidence.relations).toHaveLength(count)
  const q = oldDb.select().from(schema.platformQuery).where(eq(schema.platformQuery.queryKey, key)).get()!
  const rows = oldDb.select().from(schema.platformRelation).where(eq(schema.platformRelation.queryId, q.id)).all().sort((a,b) => a.sequenceNo-b.sequenceNo)
  expect(found.payloadRows).toEqual(rows.map(slotPayloadRow))
  expect(found.rawRows).toEqual(rows.map(slotLegacyRow))
  const expected = rows.map(row => {
    const normalized = normalizePlatformRelation(q.interface, row)
    return { interface: q.interface, rdjb: q.rdjb, sequenceNo: row.sequenceNo, relationKey: row.relationKey,
      nameRaw: row.nameRaw, usccRaw: row.usccRaw, province: normalized.province, status: normalized.status,
      batch: normalized.batch, declareKind: normalized.declareKind, appliedAt: normalized.appliedAt,
      awardBatchLabel: normalized.awardBatchLabel, year: normalized.year, normalizationConflicts: normalized.normalizationConflicts,
      sourceKind: 'platform_business', rawFields: slotPayloadRow(row) }
  })
  expect(found.evidence.relations).toEqual(expected)
  const fallback = { id: 'FB', qymc: 'Fallback', tyshxydm: uscc, szsfmc: 'P', cszt: 'done', whpc: 'B', sblx: 'apply', sqsj: 'D', personuuid: 'A', year: '2024' }
  const isShared = key.startsWith('shared-')
  const literalRaw = isShared ? originalTypedRow() : key === 'unindexed' ? { qymc: 'No key', cszt: 'raw' } : fallback
  const conflicts = isShared ? [
    { field: 'province', storedValue: 'other', rawValue: 'P' },
    ...(key === 'shared-text' ? [] : [{ field: 'status', storedValue: key === 'shared-blob' ? Buffer.from([0,255]) : Buffer.alloc(0), rawValue: 'done' }]),
    { field: 'batch', storedValue: 'other', rawValue: 'B' },
    { field: 'declareKind', storedValue: 'review', rawValue: 'apply' },
    { field: 'appliedAt', storedValue: 'other', rawValue: 'D' },
    { field: 'awardBatchLabel', storedValue: 'other', rawValue: 'A' },
    { field: 'year', storedValue: 2020, rawValue: 2024 },
  ] : []
  expect(found.payloadRows).toEqual([literalRaw])
  expect(Object.keys(found.payloadRows[0]!)).toEqual(Object.keys(literalRaw))
  expect(found.evidence.relations).toEqual([{
    interface: 'business_list', rdjb: '2', sequenceNo: 1, relationKey: isShared ? 'SHARED' : key === 'unindexed' ? null : 'FB',
    nameRaw: isShared ? 'Capture' : key === 'unindexed' ? 'No key' : 'Fallback', usccRaw: key === 'unindexed' ? null : uscc,
    province: isShared || key === 'unindexed' ? null : 'P',
    status: key === 'shared-text' || key === 'null-raw' || key === 'empty-raw' ? 'done' : key === 'unindexed' ? 'raw' : null,
    batch: isShared || key === 'unindexed' ? null : 'B',
    declareKind: isShared || key === 'unindexed' ? null : 'apply',
    appliedAt: isShared || key === 'unindexed' ? null : 'D',
    awardBatchLabel: isShared || key === 'unindexed' ? null : 'A',
    year: isShared || key === 'unindexed' ? null : 2024,
    normalizationConflicts: conflicts, sourceKind: 'platform_business', rawFields: literalRaw,
  }])
  expect(rows.map(row => row.rawFields)).toEqual([key === 'null-raw' ? null : key === 'empty-raw' ? {} : literalRaw])
  if (key === 'shared-blob') expect(found.evidence.relations[0]!.normalizationConflicts).toContainEqual({ field: 'status', storedValue: Buffer.from([0,255]), rawValue: 'done' })
  if (key === 'shared-empty-blob') expect(found.evidence.relations[0]!.normalizationConflicts!.some(c => c.field === 'status' && Buffer.isBuffer(c.storedValue) && c.storedValue.length === 0)).toBe(true)
})

it('retains original decode errors while missing and rejected captures never hydrate archive bytes', () => {
  trace.length = 0
  expect(reader().read(db, 'no-such-key', time).size).toBe(0)
  expect(reader().read(db, 'bare-success', '2026-11-12').size).toBe(0)
  expect(reader().read(db, 'null-response', '2026-11-12').size).toBe(0)
  expect(() => reader().read(db, 'invalid-json', '2026-11-12')).toThrow(SyntaxError)
  expect(() => oldDb.select().from(schema.platformRelation).where(eq(schema.platformRelation.queryId, 41)).all()).toThrow(SyntaxError)
  expect(trace.some(sql => /[".]bytes[" ,]/.test(sql))).toBe(false)
})

it.each(['completion', 'variant', 'phase', 'uncaptured'] as const)('fails closed for %s without archive fallback or service writes', async variant => {
  await seed()
  if (variant === 'completion') t.exec("UPDATE platform_migration_run SET state='running' WHERE transform_version='reconcile-slot-capture-v1'")
  if (variant === 'variant') t.exec('DROP TRIGGER reconcile_slot_binding')
  if (variant === 'phase') t.pragma('user_version=71612')
  if (variant === 'uncaptured') {
    // Controlled missing-capture historical state; no production repair is attempted.
    t.exec('DROP TRIGGER reconcile_slot_immutable')
    t.prepare("UPDATE platform_collection SET reconcile_slot_state='uncaptured',reconcile_slot_rule=NULL,reconcile_slot_raw_archive_id=NULL,reconcile_slot_row_count=NULL,reconcile_slot_input_sha256=NULL,reconcile_slot_reason='missing_raw_ref' WHERE queried_at=? AND rdjb='2'").run(time)
  }
  const before = sourceRows()
  await expect(runPlatformReconcile(options())).rejects.toThrow(/NOTREADY|Unsupported/)
  expect(sourceRows()).toEqual(before)
})

it('keeps capture selection observation facts and typed payload in one real two-connection snapshot', async () => {
  await seed()
  t.pragma('journal_mode=WAL')
  const second = new Database(path); second.pragma('foreign_keys=ON')
  const secondDb = drizzle(second, { schema })
  const q = await query('business_list', '2', [{ id: 'NORMAL768', qymc: 'Next', tyshxydm: uscc, cszt: 'next', n: 2 }], '2026-11-13T04:00:00.001Z')
  let committed = false
  onSql = sql => {
    if (!committed && /from "platform_business_observation"/.test(sql)) {
      committed = true
      const result = commitRosterImport(secondDb, request([q], 'snapshot'), [], { deferCandidateTasks: true })
      expect(result.status).toBe('committed')
    }
  }
  try {
    const first = reader().read(db, uscc, '2026-11-12')
    expect(committed).toBe(true)
    expect(first.get('business_list|2')!.evidence.queriedAt).toBe(time)
    expect(first.get('business_list|2')!.evidence.relations[0]!.status).toBe('done')
    expect(first.get('business_list|2')!.payloadRows[0]!.qymc).toBe('Capture')
    onSql = undefined
    const next = reader().read(db, uscc, '2026-11-12')
    expect(next.get('business_list|2')!.evidence.queriedAt).toBe(q.queriedAt)
    expect(next.get('business_list|2')!.evidence.relations[0]!.status).toBe('next')
    expect(next.get('business_list|2')!.payloadRows[0]!.n).toBe(2)
  } finally { onSql = undefined; second.close() }
})

it('uses one selected snapshot in the real normal service while another connection commits newer content and assignment', async () => {
  await seed()
  t.pragma('journal_mode=WAL')
  const second = new Database(path); second.pragma('foreign_keys=ON')
  const nextQuery = await query('business_list', '2', [{ id: 'NORMAL768', qymc: 'New content', tyshxydm: uscc, cszt: 'next', n: 2 }], '2026-11-13T04:00:00.001Z')
  const original = drizzle(t).select().from(s.platformObservationAssignment).all().find(a => a.nameRaw === 'Capture' && a.origin === 'command')!
  let committed = false
  onSql = sql => {
    if (!committed && /from "platform_business_observation"/.test(sql)) {
      committed = true
      drizzle(second).insert(s.platformObservationAssignment).values({ ...original, revision: 2, nameRaw: 'Later identity', usccRaw: 'later', basis: 'controlled snapshot isolation' }).run()
      expect(commitRosterImport(drizzle(second, { schema }), request([nextQuery], 'normal-snapshot'), [], { deferCandidateTasks: true }).status).toBe('committed')
    }
  }
  try {
    const report = await runPlatformReconcile(options())
    expect(committed).toBe(true)
    expect(report.write?.status).toBe('committed')
    const selected = decisionRequest(t).payload.platformQueries!.find(q => q.interface === 'business_list' && q.rdjb === '2')!
    expect(selected.queriedAt).toBe(time)
    expect(selected.relations![0]).toMatchObject({ nameRaw: 'Capture', status: 'done', rawFields: { qymc: 'Capture', cszt: 'done' } })
    onSql = undefined
    const next = await runPlatformReconcile({ ...options(), write: false })
    expect(next.collection.positions.find(q => q.interface === 'business_list' && q.rdjb === '2')!.queriedAt).toBe(nextQuery.queriedAt)
    const nextSlot = reader().read(db, uscc, '2026-11-12').get('business_list|2')!
    expect(nextSlot.evidence.relations[0]!.status).toBe('next')
    expect(nextSlot.payloadRows[0]!.n).toBe(2)
    writeFileSync(join(evidence!, 'normal-snapshot.json'), JSON.stringify({ report, selected, next, nextSlot }, null, 2))
  } finally { onSql = undefined; second.close() }
})

it.each(['decision', 'receipt'] as const)('rolls back actual normal service %s failure and recovers the same request', async fault => {
  targets()
  const before = sourceRows()
  const trigger = fault === 'decision' ? 'BEFORE INSERT ON difference_reason' : "BEFORE UPDATE ON import_receipt WHEN NEW.operation='commit' AND NEW.status='committed'"
  t.exec(`CREATE TRIGGER fault768 ${trigger} BEGIN SELECT RAISE(ABORT,'768 injected ${fault}'); END`)
  await expect(runPlatformReconcile(options())).rejects.toThrow(/768 injected|未提交/)
  expect(sourceRows()).toEqual(before)
  expect(t.prepare('SELECT count(*) n FROM difference_reason WHERE recorded_at=?').get(time)).toEqual({ n: 0 })
  expect(t.prepare("SELECT count(*) n FROM import_receipt r JOIN import_batch b ON b.id=r.batch_id WHERE b.source_identity LIKE 'platform/reconcile%' AND r.operation='commit' AND r.status='committed'").get()).toEqual({ n: 0 })
  const failed = t.prepare('SELECT * FROM import_receipt WHERE batch_id=46 ORDER BY id').raw().all()
  t.exec('DROP TRIGGER fault768')
  const report = await runPlatformReconcile(options())
  expect(report).toEqual(originalB1Report())
  expect(t.prepare('SELECT count(*) n FROM difference_reason WHERE recorded_at=?').get(time)).toEqual({ n: 1 })
  expect(decisionRequest(t)).toEqual(originalB1Request())
  expect(t.prepare('SELECT * FROM import_receipt WHERE batch_id=46 ORDER BY id').raw().all().slice(0, failed.length)).toEqual(failed)
  expect(sourceRows()).toEqual(before)
})

it('selects metadata before original bytes and never hydrates unrelated large archives', async () => {
  await seed()
  const q = await query('business_list', '2', [], time)
  q.queryKey = 'unrelated-large768'; q.rawResponse = ' '.repeat(2 * 1024 * 1024)
  commit([q], 'large')
  const unrelated = t.prepare('SELECT id FROM platform_collection WHERE query_key=?').get(q.queryKey) as { id: number }
  trace.length = 0
  const selected = reader().read(db, uscc, '2026-11-12')
  expect(selected.size).toBe(4)
  const selection = trace.findIndex(q => q.startsWith('select') && q.includes('"slot_capture"'))
  const archives = trace.map((sql, index) => ({ sql, index })).filter(q => q.sql.startsWith('select') && q.sql.includes('"platform_archive_value"."bytes"'))
  expect(selection).toBeGreaterThanOrEqual(0); expect(archives.length).toBeGreaterThan(0)
  expect(archives.every(q => q.index > selection)).toBe(true)
  expect(archives.some(q => q.sql.includes(`"platform_collection_archive_ref"."owner_id" = ${unrelated.id}`))).toBe(false)
})

it('reports selected archive corruption before writing any receipt and never returns an empty reusable slot', async () => {
  await seed()
  const a = t.prepare("SELECT a.id FROM platform_archive_value a JOIN platform_collection_archive_ref r ON r.archive_id=a.id JOIN platform_collection c ON c.id=r.owner_id WHERE c.queried_at=? AND c.rdjb='2' AND r.field='rawResponse'").get(time) as { id: number }
  const triggers = t.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name='platform_archive_value'").all() as { name: string }[]
  for (const { name } of triggers) t.exec(`DROP TRIGGER "${name.replace(/"/g,'""')}"`)
  t.prepare('UPDATE platform_archive_value SET bytes=zeroblob(byte_length) WHERE id=?').run(a.id)
  const before = sourceRows(), receipts = t.prepare('SELECT * FROM import_receipt ORDER BY id').raw().all()
  await expect(runPlatformReconcile(options())).rejects.toThrow('Reconcile original archive drift')
  expect(sourceRows()).toEqual(before)
  expect(t.prepare('SELECT * FROM import_receipt ORDER BY id').raw().all()).toEqual(receipts)
})

it.each(['rawFields', 'legacyRowSnapshot'] as const)('rejects missing selected %s without canonical or display fallback and without service writes', async field => {
  const owner = t.prepare("SELECT o.id FROM platform_business_observation o JOIN platform_collection c ON c.id=o.collection_id WHERE c.query_key=? AND c.rdjb='2'").get(uscc) as { id: number }
  const triggers = t.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name='platform_observation_archive_ref'").all() as { name: string }[]
  for (const { name } of triggers) t.exec(`DROP TRIGGER "${name.replace(/"/g, '""')}"`)
  t.prepare('DELETE FROM platform_observation_archive_ref WHERE owner_id=? AND field=?').run(owner.id, field)
  const before = sourceRows(), receipts = nativeCells(t, 'import_receipt')
  await expect(runPlatformReconcile(options())).rejects.toThrow('Missing sealed reconcile original input')
  expect(sourceRows()).toEqual(before)
  expect(nativeCells(t, 'import_receipt')).toEqual(receipts)
})

it('keeps same-version observations independent of later assignments and later content versions', async () => {
  const original = reader().read(db, 'shared-blob', '2026-11-12').get('business_list|2')!
  const versions = t.prepare("SELECT o.id,o.version_id version FROM platform_business_observation o JOIN platform_collection c ON c.id=o.collection_id WHERE c.query_key IN ('shared-text','shared-blob','shared-empty-blob') ORDER BY o.id").all() as { id: number; version: number }[]
  expect(versions).toHaveLength(3)
  expect(new Set(versions.map(v => v.version)).size).toBe(1)
  const assignment = drizzle(t).select().from(s.platformObservationAssignment).where(eq(s.platformObservationAssignment.observationId, versions[1]!.id)).get()!
  drizzle(t).insert(s.platformObservationAssignment).values({ ...assignment, origin: 'command', revision: 2, nameRaw: 'Later assignment', usccRaw: 'later', basis: 'controlled assignment isolation' }).run()
  const q = await query('business_list', '2', [{ id: 'SHARED', qymc: 'Current version', tyshxydm: uscc, cszt: 'current' }])
  commit([q], 'new-current-version')
  expect(reader().read(db, 'shared-blob', '2026-11-12').get('business_list|2')).toEqual(original)
  const now = t.prepare("SELECT v.id FROM platform_business_record_version v JOIN platform_business_record r ON r.id=v.record_id WHERE r.interface='business_list' AND r.platform_key='SHARED' ORDER BY v.id DESC LIMIT 1").get() as { id: number }
  expect(now.id).not.toBe(versions[0]!.version)
  expect(original.evidence.relations[0]!.nameRaw).toBe('Capture')
  expect(original.evidence.relations[0]!.normalizationConflicts!.map(c => c.field)).toEqual(['province','status','batch','declareKind','appliedAt','awardBatchLabel','year'])
})

it('preserves accepted invalid-date queriedAt using literal string freshness and never parses it as a date', () => {
  const result = reader().read(db, 'unparseable-query-time', '2026-11-12').get('business_list|2')!
  expect(result.evidence.queriedAt).toBe('not-date')
  expect(result.evidence.relations).toHaveLength(1)
  expect(Date.parse(result.evidence.queriedAt)).toBeNaN()
})

it('keeps original confirmed decisions and collects filtered paginated targets through real getComparison', async () => {
  const queries = await seed([])
  const target = collectReconcileTargets(db, { titles: ['specialized_sme'], usccs: [uscc] }).targets[0]!
  const decision: RosterImportRequest = { sourceKind: 'platform_archive', sourceIdentity: 'confirmed768', idempotencyKey: 'confirmed768', payload: { platformQueries: queries.map(q => ({ ...q, rawResponse: null })), differences: [{
    enterpriseName: target.enterpriseName, uscc, titleCode: target.titleCode, direction: target.direction,
    status: 'confirmed_no_diff', verificationStatus: 'confirmed', measureCode: 'none', reasonNote: 'explicit confirmation',
    recordedAt: '2020-01-01T00:00:00.000Z',
  }] } }
  const saved = commitRosterImport(db, decision, [], { deferCandidateTasks: true })
  expect(saved.status, JSON.stringify(saved)).toBe('committed')
  const report = await runPlatformReconcile(options())
  expect(report.counts.reusedFresh).toBe(1); expect(report.write).toBeNull()
  const paged = await runPlatformReconcile({ ...options(), offset: 1, limit: 1 })
  expect(paged.targetCount).toBe(0); expect(paged.queries.reused).toBe(0)
})

it('keeps four slot membership independent of row title identity key version and assignment', async () => {
  const queries = await seed([{ qymc: 'Other original', tyshxydm: 'unmatched', rdjb: '3', year: false, extra: [null, true] }])
  const selected = reader().read(db, uscc, '2026-11-12')
  expect([...selected.keys()]).toEqual(expect.arrayContaining(['business_list|1','business_list|2','business_list|3','apply_list|']))
  for (const slot of selected.values()) {
    expect(slot.evidence.relations).toHaveLength(1)
    expect(slot.evidence.relations[0]).toMatchObject({ relationKey: null, nameRaw: 'Other original', usccRaw: 'unmatched', year: null })
    expect(slot.payloadRows[0]).toEqual(queries[0]!.relations![0]!.rawFields)
  }
  expect(t.prepare('SELECT count(*) n FROM platform_business_observation o JOIN platform_collection c ON c.id=o.collection_id WHERE c.queried_at=? AND o.version_id IS NULL').get(time)).toEqual({ n: 4 })
  expect(reader().read(db, 'recognized', '0').size).toBe(0)
})

it('writes literal not_queried through both real default services for unqueryable-only targets', async () => {
  for (const database of [oldDb, db]) {
    const enterprise = database.insert(schema.enterprise).values({ name: 'Unqueryable768', nameNorm: normalizeName('Unqueryable768'), usccNorm: null }).returning().get()
    database.insert(schema.record).values({ enterpriseId: enterprise.id, titleCode: 'little_giant', source: 'miit' }).run()
  }
  const reports = []
  for (const database of [oldDb, db]) {
    const run = { ...options(database), titles: ['little_giant'], usccs: undefined }
    const preview = await runPlatformReconcile({ ...run, write: false })
    expect(preview.counts).toMatchObject({ notQueried: 1, total: 1 })
    expect(preview.queries).toMatchObject({ reused: 0, network: 0 })
    reports.push(preview)
  }
  expect(reports[0]).toEqual(reports[1])
  const run = { titles: ['little_giant'], usccs: undefined }
  const oldCommitted = await runPlatformReconcile({ ...options(oldDb), ...run })
  expect(oldCommitted.write?.status).toBe('committed')
  const targetCommitted = await runPlatformReconcile({ ...options(), ...run })
  expect(targetCommitted.write?.status).toBe('committed')
  expect({ ...targetCommitted, write: null }).toEqual({ ...oldCommitted, write: null })
  expect(db.select().from(schema.differenceReason).where(eq(schema.differenceReason.recordedAt, time)).all()[0]).toMatchObject({ status: 'not_queried', verificationStatus: 'pending', evidenceQueryId: null })
  const attempts = t.prepare("SELECT r.request_body,r.item_results,r.status FROM import_receipt r JOIN import_batch b ON b.id=r.batch_id WHERE b.source_identity='platform/reconcile:little_giant' ORDER BY r.id").all()
  writeFileSync(join(evidence!, 'unqueryable-normal-service.json'), JSON.stringify({ reports, oldCommitted, targetCommitted, targetAttempts: attempts }, null, 2))
})

it('closes unchanged original B1 through both real default services with full literal request report native cells source refs and replay', async () => {
  targets()
  for (const name of Object.keys(process.env).filter(k => /COOKIE|TOKEN|PASSWORD|CREDENTIAL|SECRET/i.test(k))) vi.stubEnv(name, '')
  const fetch = vi.fn(async () => { throw new Error('Original B1 must never fetch') })
  const before = sourceRows()
  const oldBefore = Object.fromEntries(['platform_query','platform_relation','enterprise_alias','platform_business_record','platform_business_record_version','platform_business_observation'].map(table => [table, nativeCells(old, table)]))
  const targetBefore = Object.fromEntries(Object.keys(before).map(table => [table, nativeCells(t, table)]))
  const oracle = await runPlatformReconcile({ ...options(oldDb), fetchImpl: fetch })
  const report = await runPlatformReconcile({ ...options(), fetchImpl: fetch })
  await whenIdle()
  expect(oracle).toEqual(originalB1Report())
  expect(report).toEqual(originalB1Report())
  expect(decisionRequest(old)).toEqual(originalB1Request())
  const payload = decisionRequest(t)
  expect(payload).toEqual(originalB1Request())
  expect(Object.keys(payload.payload.platformQueries![1]!.relations![0]!.rawFields!)).toEqual(Object.keys(originalTypedRow()))
  const literalDecision = [{ enterprise_id: 1, title_code: 'specialized_sme', direction: 'extra_in_miit', status: 'needs_review', evidence_query_id: 1, evidence_relation_id: null, verification_status: 'pending' }]
  for (const connection of [old, t]) {
    expect(connection.prepare('SELECT enterprise_id,title_code,direction,status,evidence_query_id,evidence_relation_id,verification_status FROM difference_reason ORDER BY id').all()).toEqual(literalDecision)
    const receipts = connection.prepare('SELECT operation,status,request_body FROM import_receipt WHERE batch_id=46 ORDER BY id').all() as { operation: string; status: string; request_body: string }[]
    expect(receipts.map(r => [r.operation, r.status])).toEqual([['preflight','preflight'],['commit','committed']])
    for (const receipt of receipts) expect(JSON.parse(receipt.request_body)).toEqual(originalB1Request())
  }
  expect(sourceRows()).toEqual(before)
  for (const [table, cells] of Object.entries(oldBefore)) expect(nativeCells(old, table), table).toEqual(cells)
  for (const [table, cells] of Object.entries(targetBefore)) expect(nativeCells(t, table), table).toEqual(cells)
  const ledgerBeforeReplay = nativeCells(t, 'import_receipt')
  const decisionsBeforeReplay = nativeCells(t, 'difference_reason')
  const writer = inProcessReconcileWriter(db)
  await writer.preflight(payload)
  const replayed = await writer.commit(payload)
  expect(replayed.batchId).toBe(46)
  const again = await runPlatformReconcile({ ...options(), fetchImpl: fetch })
  expect(again.write).toBeNull(); expect(again.counts.reusedFresh).toBe(1)
  expect(nativeCells(t, 'import_receipt')).toEqual(ledgerBeforeReplay)
  expect(nativeCells(t, 'difference_reason')).toEqual(decisionsBeforeReplay)
  expect(sourceRows()).toEqual(before)
  const changed = originalB1Request()
  changed.payload.platformQueries![0]!.titleCode = 'innovative_sme'
  await expect(writer.preflight(changed)).rejects.toThrow('Idempotency key belongs to a different request')
  expect(nativeCells(t, 'import_receipt')).toEqual(ledgerBeforeReplay)
  expect(fetch).not.toHaveBeenCalled()
  writeFileSync(join(evidence!, 'B1-NORMAL-SERVICE-SUCCESS.json'), JSON.stringify({ report, oracle, payload, literalReport: originalB1Report(), literalRequest: originalB1Request(), literalDecision, targetBefore, oldBefore, replayed, again, fetchCalls: fetch.mock.calls.length }, null, 2))
})

it('preserves public alias tie ordering when physical IDs are reversed', () => {
  // Unit evidence for the actual production comparator. Identical natural keys
  // cannot coexist through normal import, which retains its unique index.
  const lowAlias = { collection: { id: 900, queriedAt: time }, id: 10 }
  const highAlias = { collection: { id: 100, queriedAt: time }, id: 20 }
  expect([lowAlias, highAlias].sort(compareReconcileSlotCollections)).toEqual([highAlias, lowAlias])
  expect([highAlias, lowAlias].sort(compareReconcileSlotCollections)).toEqual([highAlias, lowAlias])
})

it('uses JS localeCompare rather than binary or parsed-date ordering in both normal services', async () => {
  await seed([])
  for (const queriedAt of ['a', 'Z']) {
    const q = await query('business_list', '2', [{ id: 'LOCALE768', qymc: queriedAt, tyshxydm: uscc }], queriedAt)
    const envelope: LegacySlotCollection = JSON.parse(q.rawResponse!)
    envelope.completedAt = time
    envelope.pages.forEach(page => { page.queriedAt = time })
    q.rawResponse = JSON.stringify(envelope)
    commit([q], 'locale-' + queriedAt)
  }
  expect('Z'.localeCompare('a')).toBeGreaterThan(0); expect('Z' < 'a').toBe(true)
  const oracle = await runPlatformReconcile(options(oldDb)), actual = await runPlatformReconcile(options())
  expect(actual.queries.reused).toBe(4)
  expect(decisionRequest(t)).toEqual(decisionRequest(old))
  expect({ ...actual, write: null }).toEqual({ ...oracle, write: null })
  expect(decisionRequest(t).payload.platformQueries!.find(q => q.rdjb === '2')!.queriedAt).toBe('Z')
})
