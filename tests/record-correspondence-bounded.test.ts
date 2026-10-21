import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { useDb, schema } from '../db/client'
import { handleRecordCorrespondenceRequest } from '../server/utils/record-correspondence-api'
import { dispatchRecordCorrespondenceMcp } from '../server/utils/mcp-record-correspondence'
import { startHttpFixture } from './helpers/http-fixture'

const cleanup: Array<() => void> = []
function mcpErrorCode(result: unknown) {
  expect(result).toMatchObject({ isError: true, content: [{ type: 'text' }] })
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text).error.code
}
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'correspondence-85-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const dbPath = join(dir, 'roster.db'), db = useDb({ dbPath })
  cleanup.push(() => db.$client.close())
  const enterprise = db.insert(schema.enterprise).values({ name: '合成企业', nameNorm: '合成企业', usccNorm: '91330211255994457P' }).returning().get()
  const record = db.insert(schema.record).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', source: 'jxj', usccRaw: enterprise.usccNorm }).returning().get()
  const query = db.insert(schema.platformQuery).values({ interface: 'business_list', queryKey: enterprise.usccNorm!, rdjb: '2', titleCode: 'specialized_sme', queriedAt: '2026-10-19', status: 'partial', rawResponse: 'synthetic archived body' }).returning().get()
  const relation = db.insert(schema.platformRelation).values({ queryId: query.id, sequenceNo: 1, enterpriseId: enterprise.id, usccRaw: enterprise.usccNorm, relationKey: 'synthetic', declareKind: 'apply', year: 2022, matchBasis: 'uscc', verificationStatus: 'confirmed' }).returning().get()
  function addEvent() { return db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2022, batchSeq: 1 }).returning().get() }
  function addEdge(eventId: number, n: number, provenance: Record<string, unknown> = {}) {
    return db.insert(schema.recordCorrespondence).values({ edgeKey: `synthetic-${n}`, type: 'event_process', role: 'context_only', eventId, relationId: relation.id, enterpriseId: enterprise.id, titleCode: 'specialized_sme', status: 'candidate', revision: 1, targetIdentity: {}, provenance, sourceFingerprint: 'synthetic', ruleId: 'manual', ruleVersion: '1', createdAt: '2026-10-19' }).returning({ id: schema.recordCorrespondence.id }).get().id
  }
  return { db, dbPath, enterprise, record, query, relation, addEvent, addEdge }
}
/** Observe the real driver, including row materialization; no substituted database results. */
function observeBytes(db: ReturnType<typeof useDb>) {
  let bytes = 0, statements = 0
  const size = (v: unknown): number => typeof v === 'string' ? Buffer.byteLength(v) : typeof v === 'number' ? 8 : v && typeof v === 'object' ? Object.values(v).reduce<number>((n, x) => n + size(x), 0) : 0
  const prepare = db.$client.prepare.bind(db.$client)
  db.$client.prepare = ((...args: Parameters<typeof prepare>) => {
    const statement = prepare(...args)
    for (const method of ['all', 'get'] as const) {
      const run = statement[method].bind(statement)
      Object.assign(statement, { [method]: (...params: unknown[]) => { statements++; const result = run(...params); bytes += size(result); return result } })
    }
    return statement
  }) as typeof prepare
  return { reset() { bytes = 0; statements = 0 }, get bytes() { return bytes }, get statements() { return statements } }
}
async function server(db: ReturnType<typeof useDb>, pointId = 1) {
  return startHttpFixture({ routes: {
    '/api/roster/correspondences': r => handleRecordCorrespondenceRequest({ ...r, action: 'list' }, { db }),
    [`/api/roster/correspondences/${pointId}`]: r => handleRecordCorrespondenceRequest({ ...r, action: 'get', id: pointId }, { db }),
  } })
}

describe('bounded correspondence public reads on real SQLite', () => {
  it('offers an opt-in summary list on REST and MCP while full evidence stays at default and point routes', async () => {
    const f = fixture(), original = 'synthetic-original-'.repeat(2048)
    f.db.$client.prepare('update platform_relation set raw_fields=? where id=?').run(JSON.stringify({ original }), f.relation.id)
    const ids: number[] = []
    f.db.transaction(() => { for (let i = 0; i < 20; i++) ids.push(f.addEdge(f.addEvent().id, i)) })
    const meter = observeBytes(f.db), app = await server(f.db, ids[0])
    try {
      const query = '?page=1&pageSize=20&status=candidate&view=summary'
      const response = await fetch(app.baseUrl + '/api/roster/correspondences' + query)
      const summary = await response.json() as any
      expect(response.status).toBe(200)
      expect(summary).toMatchObject({ total: 20, page: 1, pageSize: 20 })
      expect(summary.rows[0]).toMatchObject({ id: ids[0], type: 'event_process', role: 'context_only', status: 'candidate', revision: 1, relationId: f.relation.id, requiresRevalidation: false })
      expect(summary.rows.map((row: any) => row.id)).toEqual(ids)
      expect(summary.rows[0]).not.toHaveProperty('relation')
      expect(summary.rows[0]).not.toHaveProperty('event')
      expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThan(256 * 1024)
      expect(meter.bytes).toBeLessThan(64 * 1024)
      meter.reset()
      expect(dispatchRecordCorrespondenceMcp('list', { page: 1, pageSize: 20, status: 'candidate', view: 'summary' }, { db: f.db })).toEqual(summary)
      expect(meter.bytes).toBeLessThan(64 * 1024)

      const full = await (await fetch(app.baseUrl + '/api/roster/correspondences?page=1&pageSize=20&status=candidate')).json() as any
      expect(full.rows[0].relation.rawFields).toEqual({ original })
      expect(Buffer.byteLength(JSON.stringify(full))).toBeGreaterThan(256 * 1024)
      expect(dispatchRecordCorrespondenceMcp('list', { page: 1, pageSize: 20, status: 'candidate' }, { db: f.db })).toEqual(full)
      const point = await (await fetch(app.baseUrl + `/api/roster/correspondences/${ids[0]}`)).json()
      expect(point).toEqual(full.rows[0])
      expect(dispatchRecordCorrespondenceMcp('get', { id: ids[0] }, { db: f.db })).toEqual(point)

      const deep = await (await fetch(app.baseUrl + '/api/roster/correspondences?page=20&pageSize=1&view=summary')).json() as any
      expect(deep).toMatchObject({ total: 20, rows: [{ id: ids[19] }] })
      expect((await fetch(app.baseUrl + '/api/roster/correspondences?view=unknown')).status).toBe(400)
      expect(mcpErrorCode(dispatchRecordCorrespondenceMcp('list', { view: 'unknown' }, { db: f.db }))).toBe('invalid_request')
    } finally { await app.close() }
  }, 30000)

  it('keeps deep list and point results independent of unrelated correspondence provenance', async () => {
    const f = fixture()
    const large = { original: 'synthetic'.repeat(65536), cookie: 'synthetic-secret' }
    const ids: number[] = [], events: number[] = []
    f.db.transaction(() => { for (let i = 0; i < 120; i++) { const event = f.addEvent(); events.push(event.id); ids.push(f.addEdge(event.id, i, large)) } })
    const meter = observeBytes(f.db), app = await server(f.db, ids[99])
    try {
      const response = await fetch(app.baseUrl + '/api/roster/correspondences?page=100&pageSize=1&role=context_only&ruleVersion=1')
      const list = await response.json() as any
      expect(response.status).toBe(200)
      expect(list).toMatchObject({ total: 120, page: 100, rows: [{ id: ids[99], status: 'candidate', revision: 1, requiresRevalidation: false, event: { id: events[99] } }] })
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(meter.bytes).toBeLessThan(128 * 1024)
      meter.reset()
      expect(dispatchRecordCorrespondenceMcp('list', { page: 100, pageSize: 1, role: 'context_only', ruleVersion: '1' }, { db: f.db })).toEqual(list)
      expect(meter.bytes).toBeLessThan(128 * 1024)
      meter.reset()
      const point = await (await fetch(app.baseUrl + `/api/roster/correspondences/${ids[99]}`)).json()
      expect(point).toEqual(list.rows[0])
      expect(meter.bytes).toBeLessThan(2 * 1024 * 1024)
      expect(dispatchRecordCorrespondenceMcp('get', { id: ids[99] }, { db: f.db })).toEqual(point)
      expect(JSON.stringify(point)).not.toContain('synthetic-secret')
    } finally { await app.close() }
  }, 30000)
})

describe('bounded audit and candidates', () => {
  it('pages long append audit without materializing earlier evidence or revalidating source bodies', async () => {
    const f = fixture(), event = f.addEvent(), id = f.addEdge(event.id, 1)
    const batch = f.db.insert(schema.importBatch).values({ idempotencyKey: 'synthetic-audit', sourceKind: 'correspondence_decision', sourceIdentity: 'synthetic/audit', status: 'committed' }).returning().get()
    f.db.transaction(() => { for (let i = 0; i < 160; i++) f.db.insert(schema.recordCorrespondenceAudit).values({ correspondenceId: id, batchId: batch.id, idempotencyKey: `audit-${i}`, fromStatus: i ? 'candidate' : null, toStatus: 'candidate', expectedRevision: i, resultingRevision: i + 1, actorType: 'agent', actorId: 'synthetic', basis: 'synthetic review', ruleId: 'manual', ruleVersion: '1', evidence: { original: 'synthetic'.repeat(65536), token: 'audit-secret' }, decidedAt: '2026-10-19' }).run() })
    const meter = observeBytes(f.db)
    const app = await startHttpFixture({ getRoutes: { [`/api/roster/correspondences/${id}/audit`]: r => handleRecordCorrespondenceRequest({ ...r, action: 'audit', id }, { db: f.db }) } })
    try {
      const response = await fetch(app.baseUrl + `/api/roster/correspondences/${id}/audit?page=80&pageSize=1`)
      const result = await response.json() as any
      expect(result).toMatchObject({ total: 160, page: 80, rows: [{ expectedRevision: 79, resultingRevision: 80, toStatus: 'candidate', evidence: { original: 'synthetic'.repeat(65536) } }] })
      expect(JSON.stringify(result)).not.toContain('audit-secret')
      expect(meter.bytes).toBeLessThan(1024 * 1024)
      meter.reset()
      expect(dispatchRecordCorrespondenceMcp('audit', { id, page: 80, pageSize: 1 }, { db: f.db })).toEqual(result)
      expect(meter.bytes).toBeLessThan(1024 * 1024)
      expect(dispatchRecordCorrespondenceMcp('audit', { id, page: 161, pageSize: 1 }, { db: f.db })).toMatchObject({ total: 160, rows: [] })
    } finally { await app.close() }
  }, 30000)

  it('keeps selected-source candidate ambiguity and normalized identity while excluding archived payloads', async () => {
    const f = fixture(), event = f.addEvent()
    const raw = 'synthetic'.repeat(65536)
    f.db.$client.prepare('update platform_query set raw_response=?').run(raw.repeat(8))
    f.db.transaction(() => { for (let i = 2; i <= 80; i++) f.db.insert(schema.platformRelation).values({ queryId: f.query.id, sequenceNo: i, usccRaw: i === 2 ? '\u200b91330211255994457p\u3000' : 'unrelated', enterpriseId: i === 2 ? f.enterprise.id : null, rawFields: { original: raw }, declareKind: 'review', year: 2022 }).run() })
    const excluded = f.db.insert(schema.platformQuery).values({ interface: 'business_list', queryKey: 'excluded', rdjb: '2', titleCode: 'specialized_sme', queriedAt: '2026-10-19', status: 'success', rawResponse: raw }).returning().get()
    f.db.insert(schema.platformRelation).values({ queryId: excluded.id, sequenceNo: 1, usccRaw: f.enterprise.usccNorm, rawFields: { original: raw } }).run()
    const body = { eventId: event.id, queryIds: [f.query.id, f.query.id], exportBatchIds: [], ruleVersion: 'frozen-85', page: 2, pageSize: 1 }
    const meter = observeBytes(f.db)
    const app = await startHttpFixture({ routes: { '/api/roster/correspondences/candidates': r => handleRecordCorrespondenceRequest({ ...r, action: 'candidates' }, { db: f.db }) } })
    try {
      const response = await fetch(app.baseUrl + '/api/roster/correspondences/candidates', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const result = await response.json() as any
      expect(result).toMatchObject({ total: 2, page: 2, rows: [{ status: 'candidate', edge: { relationId: 2 }, conflicts: ['platform_batch_missing', 'multiple_candidate_rows'] }], coverage: [{ id: f.query.id, status: 'partial' }] })
      expect(meter.bytes).toBeLessThan(256 * 1024)
      expect(JSON.stringify(result)).not.toContain(raw)
      meter.reset()
      expect(dispatchRecordCorrespondenceMcp('candidates', body, { db: f.db })).toEqual(result)
      expect(meter.bytes).toBeLessThan(256 * 1024)
      expect(dispatchRecordCorrespondenceMcp('list', {}, { db: f.db })).toMatchObject({ total: 0, rows: [] })
    } finally { await app.close() }
  }, 30000)
})

it('hydrates many events and relations in batches while retaining each original source and reverse link', async () => {
  const f = fixture(), expected: Array<{ id: number; eventId: number; relationId: number }> = []
  f.db.transaction(() => { for (let i = 0; i < 40; i++) {
    const event = f.addEvent()
    f.db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: `synthetic/${i}.pdf`, page: i + 1 }).run()
    const relation = i === 0 ? f.relation : f.db.insert(schema.platformRelation).values({ queryId: f.query.id, sequenceNo: i + 1, enterpriseId: f.enterprise.id, usccRaw: f.enterprise.usccNorm, rawFields: { original: `row-${i}` } }).returning().get()
    const id = f.addEdge(event.id, i)
    f.db.$client.prepare('update record_correspondence set relation_id=? where id=?').run(relation.id, id)
    expected.push({ id, eventId: event.id, relationId: relation.id })
  } })
  const meter = observeBytes(f.db), app = await server(f.db)
  try {
    const result = await (await fetch(app.baseUrl + '/api/roster/correspondences?pageSize=40')).json() as any
    expect(result.total).toBe(40)
    expect(result.rows.map((r: any) => ({ id: r.id, eventId: r.event.id, relationId: r.relation.id }))).toEqual(expected)
    expect(result.rows[39]).toMatchObject({ event: { evidence: [{ page: 40 }], correspondences: [{ id: expected[39]!.id }] }, relation: { rawFields: { original: 'row-39' }, correspondences: [{ id: expected[39]!.id }] } })
    expect(meter.statements).toBeLessThan(30)
    expect(dispatchRecordCorrespondenceMcp('list', { pageSize: 40 }, { db: f.db })).toEqual(result)
  } finally { await app.close() }
})

it('batch revalidates confirmations without changing fingerprints and detects fresh source drift', async () => {
  const f = fixture(), operations: unknown[] = []
  for (let i = 0; i < 20; i++) {
    const event = f.addEvent()
    f.db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: `synthetic/${i}.pdf`, page: i + 1 }).run()
    operations.push({ action: 'create', status: 'confirmed', edge: { type: 'event_process', role: 'context_only', eventId: event.id, relationId: f.relation.id } })
  }
  const request = { idempotencyKey: 'confirmed-batch', sourceIdentity: 'synthetic/confirmed-batch', actor: { type: 'agent', id: 'synthetic' }, basis: 'synthetic original review', ruleId: 'manual', ruleVersion: '1', operations }
  const pre = dispatchRecordCorrespondenceMcp('preflight', request, { db: f.db, authorized: true }) as any
  const receipt = dispatchRecordCorrespondenceMcp('commit', { request, planHash: pre.planHash }, { db: f.db, authorized: true }) as any
  const meter = observeBytes(f.db), app = await server(f.db)
  try {
    const result = await (await fetch(app.baseUrl + '/api/roster/correspondences?pageSize=20&status=confirmed')).json() as any
    expect(result.rows.map((r: any) => r.id)).toEqual(receipt.correspondenceIds)
    expect(result.rows.every((r: any) => r.revision === 2 && r.requiresRevalidation === false)).toBe(true)
    expect(meter.statements).toBeLessThan(50)
    f.db.$client.prepare("update record_evidence set page=99 where record_event_id=1").run()
    const changed = dispatchRecordCorrespondenceMcp('list', { pageSize: 20, status: 'confirmed' }, { db: f.db }) as any
    expect(changed.rows.map((r: any) => r.requiresRevalidation)).toEqual([true, ...Array(19).fill(false)])
    const changedSummary = dispatchRecordCorrespondenceMcp('list', { pageSize: 20, status: 'confirmed', view: 'summary' }, { db: f.db }) as any
    expect(changedSummary.rows.map((r: any) => ({ id: r.id, status: r.status, revision: r.revision, requiresRevalidation: r.requiresRevalidation })))
      .toEqual(changed.rows.map((r: any) => ({ id: r.id, status: r.status, revision: r.revision, requiresRevalidation: r.requiresRevalidation })))
    const audit = dispatchRecordCorrespondenceMcp('audit', { id: receipt.correspondenceIds[0] }, { db: f.db }) as any
    expect(audit.rows.map((r: any) => r.toStatus)).toEqual(['candidate', 'confirmed'])
    expect(audit.rows[1].evidence.officialEvidence[0].evidence.page).toBe(1)
  } finally { await app.close() }
})

it('reads atomic pages and append audit during public commits on a separate SQLite connection', async () => {
  const { Worker } = await import('node:worker_threads')
  const { createRequire } = await import('node:module')
  const f = fixture(), events = Array.from({ length: 25 }, () => f.addEvent().id)
  const jitiPath = createRequire(import.meta.resolve('nuxt/package.json')).resolve('jiti')
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { createJiti } = require(workerData.jitiPath);
      const jiti = createJiti(workerData.root + '/worker.cjs');
      const { useDb } = await jiti.import(workerData.root + '/db/client.ts');
      const { dispatchRecordCorrespondenceMcp: call } = await jiti.import(workerData.root + '/server/utils/mcp-record-correspondence.ts');
      const db = useDb({ dbPath: workerData.dbPath });
      parentPort.postMessage({ ready: true });
      await new Promise(resolve => parentPort.once('message', resolve));
      for (const eventId of workerData.events) {
        const request = { idempotencyKey: 'concurrent-' + eventId, sourceIdentity: 'synthetic/concurrent-' + eventId, actor: { type: 'agent', id: 'synthetic' }, basis: 'synthetic concurrent review', ruleId: 'manual', ruleVersion: '1', operations: [{ action: 'create', status: 'candidate', edge: { type: 'event_process', eventId, relationId: workerData.relationId, role: 'context_only' } }] };
        const plan = call('preflight', request, { db, authorized: true });
        call('commit', { request, planHash: plan.planHash }, { db, authorized: true });
        if (eventId === workerData.events[0]) { parentPort.postMessage({ firstCommitted: true }); await new Promise(resolve => parentPort.once('message', resolve)); }
        await new Promise(resolve => setTimeout(resolve, 3));
      }
      db.$client.close(); parentPort.postMessage({ done: true });
    })().catch(error => { throw error });
  `, { eval: true, workerData: { jitiPath, root: process.cwd(), dbPath: f.dbPath, events, relationId: f.relation.id } })
  const workerFailure = new Promise<never>((_, reject) => worker.once('error', reject))
  void workerFailure.catch(() => {})
  const waitMessage = () => {
    const message = Promise.race([new Promise<any>(resolve => worker.once('message', resolve)), workerFailure])
    // Retain a failure if startup has not reached this await yet.
    void message.catch(() => {})
    return message
  }
  const ready = waitMessage()
  // Force the real worker to win startup, rather than relying on scheduler luck.
  const readyDelivered = new Promise<void>(resolve => worker.once('message', () => resolve()))
  let app: Awaited<ReturnType<typeof server>> | undefined
  try {
    app = await (async () => { await Promise.race([readyDelivered, ready]); return server(f.db) })()
    expect(await ready).toEqual({ ready: true })
    const first = waitMessage()
    worker.postMessage('start')
    expect(await first).toEqual({ firstCommitted: true })
    const done = waitMessage()
    const observed: number[] = []
    for (let round = 0; round < 30; round++) {
      const response = await fetch(app.baseUrl + '/api/roster/correspondences?pageSize=50')
      const result = await response.json() as any
      expect(response.status).toBe(200)
      expect(result.total).toBe(result.rows.length)
      expect(result.rows.map((r: any) => r.id)).toEqual(Array.from({ length: result.total }, (_, i) => i + 1))
      expect(result.rows.every((r: any) => r.status === 'candidate' && r.revision === 1 && r.event.correspondences.some((ref: any) => ref.id === r.id))).toBe(true)
      observed.push(result.total)
      if (round === 0) worker.postMessage('continue')
    }
    expect(await done).toEqual({ done: true })
    expect(observed.some(n => n > 0 && n < 25)).toBe(true)
    expect(observed).toEqual([...observed].sort((a, b) => a - b))
    const final = dispatchRecordCorrespondenceMcp('list', { pageSize: 50 }, { db: f.db }) as any
    expect(final.total).toBe(25)
    for (const row of final.rows) expect(dispatchRecordCorrespondenceMcp('audit', { id: row.id }, { db: f.db })).toMatchObject({ total: 1, rows: [{ fromStatus: null, toStatus: 'candidate', resultingRevision: 1 }] })
  } finally {
    try { await worker.terminate() } finally { await app?.close() }
  }
}, 30000)

it('preserves all typed roles, four statuses, conjunctive filters and public errors on REST and MCP', async () => {
  const f = fixture(), event = f.addEvent()
  const reviewEvent = f.db.insert(schema.recordEvent).values({ recordId: f.record.id, eventType: 'review', year: 2022, decidedYear: 2025, batchSeq: 1 }).returning().get()
  const recognizedQuery = f.db.insert(schema.platformQuery).values({ interface: 'recognized_list', queryKey: f.enterprise.usccNorm!, rdjb: '2', titleCode: 'specialized_sme', queriedAt: '2026-10-19', status: 'success' }).returning().get()
  const recognized = f.db.insert(schema.platformRelation).values({ queryId: recognizedQuery.id, sequenceNo: 1, enterpriseId: f.enterprise.id, usccRaw: f.enterprise.usccNorm, verificationStatus: 'confirmed', matchBasis: 'uscc' }).returning().get()
  const batch = f.db.insert(schema.platformExportBatch).values({ titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-19', originalFilename: 'synthetic.xlsx', sha256: 'synthetic', importStatus: 'imported' }).returning().get()
  const exportRow = f.db.insert(schema.platformExportRow).values({ batchId: batch.id, sourceRowNo: 1, usccRaw: f.enterprise.usccNorm, rawFields: { original: 'synthetic-original' } }).returning().get()
  const edges = [
    ...['supports_award', 'supports_review', 'context_only'].map(role => ({ type: 'event_process', role, eventId: role === 'supports_review' ? reviewEvent.id : event.id, relationId: f.relation.id })),
    ...['recognized_corrob', 'current_context'].map(role => ({ type: 'event_recognized', role, eventId: event.id, relationId: recognized.id })),
    ...['followup_apply', 'followup_update', 'followup_review'].map(role => ({ type: 'later_process', role, predecessorEventId: event.id, enterpriseId: f.enterprise.id, titleCode: 'specialized_sme', relationId: f.relation.id })),
    { type: 'event_export_context', role: 'current_snapshot_context', eventId: event.id, exportRowId: exportRow.id },
    { type: 'process_export_context', role: 'current_snapshot_context', relationId: f.relation.id, exportRowId: exportRow.id },
    ...['same_current_row', 'candidate_same_current_row'].map(role => ({ type: 'recognized_export', role, relationId: recognized.id, exportRowId: exportRow.id })),
  ]
  const call = (action: 'preflight' | 'commit', body: Record<string, unknown>) => dispatchRecordCorrespondenceMcp(action, body, { db: f.db, authorized: true }) as any
  const request = { idempotencyKey: 'all-types', sourceIdentity: 'synthetic/all-types', actor: { type: 'agent', id: 'synthetic' }, basis: 'synthetic typed review', ruleId: 'manual', ruleVersion: 'typed-85', operations: edges.map(edge => ({ action: 'create', status: 'candidate', edge })) }
  const receipt = call('commit', { request, planHash: call('preflight', request).planHash })
  for (const [id, status] of [[receipt.correspondenceIds[0], 'confirmed'], [receipt.correspondenceIds[1], 'rejected'], [receipt.correspondenceIds[2], 'confirmed']] as const) {
    const decide = { ...request, idempotencyKey: `decide-${id}`, sourceIdentity: `synthetic/decide-${id}`, operations: [{ action: 'decide', correspondenceId: id, expectedRevision: 1, status }] }
    call('commit', { request: decide, planHash: call('preflight', decide).planHash })
  }
  const unlink = { ...request, idempotencyKey: 'unlink', sourceIdentity: 'synthetic/unlink', operations: [{ action: 'decide', correspondenceId: receipt.correspondenceIds[2], expectedRevision: 2, status: 'unlinked' }] }
  call('commit', { request: unlink, planHash: call('preflight', unlink).planHash })
  const app = await startHttpFixture({ routes: {
    '/api/roster/correspondences': r => handleRecordCorrespondenceRequest({ ...r, action: 'list' }, { db: f.db }),
    '/api/roster/correspondences/999999': r => handleRecordCorrespondenceRequest({ ...r, action: 'get', id: 999999 }, { db: f.db }),
    '/api/roster/correspondences/candidates': r => handleRecordCorrespondenceRequest({ ...r, action: 'candidates' }, { db: f.db }),
    ...Object.fromEntries((['event', 'relation', 'export_row'] as const).map(kind => [`/api/roster/correspondences/${kind === 'event' ? 'events' : kind === 'relation' ? 'relations' : 'export-rows'}/999999`, (r: Parameters<typeof handleRecordCorrespondenceRequest>[0]) => handleRecordCorrespondenceRequest({ ...r, action: 'source', kind, id: 999999 }, { db: f.db })])),
  } })
  try {
    const all = await (await fetch(app.baseUrl + '/api/roster/correspondences')).json() as any
    expect(all.rows.map((r: any) => ({ type: r.type, role: r.role }))).toEqual(edges.map(({ type, role }) => ({ type, role })))
    expect(all.rows.map((r: any) => r.status)).toEqual(['confirmed', 'rejected', 'unlinked', ...Array(9).fill('candidate')])
    expect(all.rows.slice(0, 3).map((r: any) => r.revision)).toEqual([2, 2, 3])
    const candidates = dispatchRecordCorrespondenceMcp('candidates', { eventId: event.id, queryIds: [f.query.id, recognizedQuery.id], exportBatchIds: [batch.id], ruleVersion: 'typed-85' }, { db: f.db }) as any
    expect(candidates.rows.map((r: any) => [r.status, r.existingCorrespondenceId, r.revision])).toEqual([['candidate', receipt.correspondenceIds[2], 3], ['candidate', receipt.correspondenceIds[3], 1], ['candidate', receipt.correspondenceIds[8], 1]])
    for (const row of all.rows) {
      const filter = { enterpriseId: f.enterprise.id, titleCode: 'specialized_sme', type: row.type, role: row.role, status: row.status, ruleVersion: 'typed-85', ...(row.eventId ? { eventId: row.eventId } : {}), ...(row.relationId ? { relationId: row.relationId } : {}), ...(row.exportRowId ? { exportRowId: row.exportRowId } : {}) }
      const response = await fetch(app.baseUrl + '/api/roster/correspondences?' + new URLSearchParams(filter as any))
      const result = await response.json()
      expect(result).toMatchObject({ total: 1, rows: [{ id: row.id, type: row.type, role: row.role, status: row.status, revision: row.revision }] })
      expect(dispatchRecordCorrespondenceMcp('list', filter, { db: f.db })).toEqual(result)
    }
    expect(await (await fetch(app.baseUrl + '/api/roster/correspondences?ruleVersion=unknown')).json()).toMatchObject({ total: 0, rows: [] })
    for (const query of [{ page: 0 }, { pageSize: 201 }, { eventId: -1 }, { status: 'wrong' }, { type: 'wrong' }, { extra: 'wrong' }]) {
      const response = await fetch(app.baseUrl + '/api/roster/correspondences?' + new URLSearchParams(query as any))
      expect(response.status).toBe(400)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } })
      expect(mcpErrorCode(dispatchRecordCorrespondenceMcp('list', query, { db: f.db }))).toBe('invalid_request')
    }
    expect((await fetch(app.baseUrl + '/api/roster/correspondences/999999')).status).toBe(404)
    expect(mcpErrorCode(dispatchRecordCorrespondenceMcp('get', { id: 999999 }, { db: f.db }))).toBe('not_found')
    for (const [kind, path] of [['event', 'events'], ['relation', 'relations'], ['export_row', 'export-rows']] as const) {
      const response = await fetch(app.baseUrl + `/api/roster/correspondences/${path}/999999`)
      expect(response.status).toBe(404)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toMatchObject({ error: { code: 'not_found' } })
      expect(mcpErrorCode(dispatchRecordCorrespondenceMcp('source', { kind, id: 999999 }, { db: f.db }))).toBe('not_found')
    }
    for (const [body, status, code] of [[{ eventId: 999999, queryIds: [f.query.id], ruleVersion: 'missing' }, 404, 'not_found'], [{ eventId: event.id, queryIds: [-1], ruleVersion: 'invalid' }, 400, 'invalid_request']] as const) {
      const response = await fetch(app.baseUrl + '/api/roster/correspondences/candidates', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      expect(response.status).toBe(status)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toMatchObject({ error: { code } })
      expect(mcpErrorCode(dispatchRecordCorrespondenceMcp('candidates', body, { db: f.db }))).toBe(code)
    }
  } finally { await app.close() }
})

it('keeps original relation sequence and export source-row order when archive insertion order differs', () => {
  const f = fixture(), event = f.addEvent()
  const third = f.db.insert(schema.platformRelation).values({ queryId: f.query.id, sequenceNo: 30, usccRaw: f.enterprise.usccNorm }).returning().get()
  const second = f.db.insert(schema.platformRelation).values({ queryId: f.query.id, sequenceNo: 20, usccRaw: f.enterprise.usccNorm }).returning().get()
  const batch = f.db.insert(schema.platformExportBatch).values({ titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-19', originalFilename: 'synthetic.xlsx', sha256: 'order-synthetic', importStatus: 'imported' }).returning().get()
  const x3 = f.db.insert(schema.platformExportRow).values({ batchId: batch.id, sourceRowNo: 30, usccRaw: f.enterprise.usccNorm }).returning().get()
  const x2 = f.db.insert(schema.platformExportRow).values({ batchId: batch.id, sourceRowNo: 20, usccRaw: f.enterprise.usccNorm }).returning().get()
  const result = dispatchRecordCorrespondenceMcp('candidates', { eventId: event.id, queryIds: [f.query.id], exportBatchIds: [batch.id], ruleVersion: 'ordering' }, { db: f.db }) as any
  expect(result.rows.map((r: any) => r.edge.relationId ?? `export:${r.edge.exportRowId}`)).toEqual([f.relation.id, second.id, third.id, `export:${x2.id}`, `export:${x3.id}`])
})
