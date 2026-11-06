import LegacyDatabase391 from 'better-sqlite3'
import { drizzle as legacyDrizzle391 } from 'drizzle-orm/better-sqlite3'
import { migrate as legacyMigrate391 } from 'drizzle-orm/better-sqlite3/migrator'
import { resolve as legacyResolve391 } from 'node:path'
import { TITLE_SEED as LEGACY_TITLE_SEED391 } from '../db/titles'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDb, schema } from '../db/client'
import { handleRecordCorrespondenceRequest } from '../server/utils/record-correspondence-api'
import { dispatchRecordCorrespondenceMcp } from '../server/utils/mcp-record-correspondence'
import { startHttpFixture } from './helpers/http-fixture'
import * as receiptRedaction391 from '../server/utils/import-receipt-redaction'
import * as credentialState391 from '../server/utils/credential-state'
import { sourceReader, readSource, eventSource, relationSource, exportRowSource, detail, details } from '../server/utils/record-correspondence-read'
import { getRecordCorrespondence } from '../server/utils/record-correspondence'
import { discoverEventArchives } from '../server/utils/event-archive-discovery'
import * as official391 from '../server/utils/official-evidence'

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
      expect(summary.rows[0]).toMatchObject({ id: ids[0], type: 'event_process', role: 'context_only', status: 'candidate', revision: 1, relationId: f.relation.id, requiresRevalidation: true })
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
      expect(list).toMatchObject({ total: 120, page: 100, rows: [{ id: ids[99], status: 'candidate', revision: 1, requiresRevalidation: true, event: { id: events[99] } }] })
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

it('automatically discovers a deep candidate page without materializing other raw rows or archived response arrays', () => {
  const f = fixture(), event = f.addEvent(), raw = 'synthetic'.repeat(65536)
  f.db.$client.prepare('update platform_query set raw_response=?,collection_evidence=?').run(raw.repeat(8), JSON.stringify({ rows: [{ original: raw.repeat(4) }], completeness: 'partial' }))
  f.db.transaction(() => { for (let i = 2; i <= 80; i++) f.db.insert(schema.platformRelation).values({ queryId: f.query.id, sequenceNo: i, usccRaw: f.enterprise.usccNorm, enterpriseId: f.enterprise.id, rawFields: { original: raw }, declareKind: 'apply', year: 2022 }).run() })
  const meter = observeBytes(f.db)
  const body = { eventId: event.id, page: 70, pageSize: 1, queryPage: 1, queryPageSize: 1 }
  const result = handleRecordCorrespondenceRequest({ action: 'discover', method: 'POST', body }, { db: f.db })
  expect(result.status).toBe(200)
  expect(result.body).toMatchObject({ total: 80, page: 70, rows: [{ evidence: { source: { sequenceNo: 70 } }, conflicts: expect.arrayContaining(['multiple_candidate_rows']) }], coverage: { total: 1, rows: [{ candidateCount: 80, relationCount: 80 }] } })
  expect(meter.bytes).toBeLessThan(128 * 1024)
  expect(JSON.stringify(result.body)).not.toContain(raw)
  meter.reset()
  expect(dispatchRecordCorrespondenceMcp('discover', body, { db: f.db })).toEqual(result.body)
  expect(meter.bytes).toBeLessThan(128 * 1024)
})

// Small process-local API/DAO controls. The existing real HTTP and worker cases
// above stay intact and require the parent's separate heavy grant.
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })
const token391 = 'cx391-only-A7mN5p9Q'
function contextFixture391(name = token391) {
  const f = fixture(), event = f.addEvent(), id = f.addEdge(event.id, 391)
  const batch = f.db.insert(schema.importBatch).values({ idempotencyKey: 'capture391', sourceKind: 'announcement', sourceIdentity: 'synthetic391', status: 'committed' }).returning().get()
  const evidence = f.db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: 'synthetic391.pdf', page: 1 }).returning().get()
  f.db.insert(schema.officialEvidenceRowRevision).values({ evidenceId: evidence.id, eventId: event.id, revision: 1, capturedRecordId: f.record.id, capturedEnterpriseId: f.enterprise.id, nameRaw: name,
    sourceBindingKnown: false, actor: { type: 'agent', id: 'synthetic391' }, basis: 'synthetic391', commandKind: 'import', importBatchId: batch.id, createdAt: 'synthetic391' }).run()
  const exportBatch = f.db.insert(schema.platformExportBatch).values({ titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-19', originalFilename: 'synthetic391.xlsx', sha256: 'synthetic391', importStatus: 'imported' }).returning().get()
  const exportRow = f.db.insert(schema.platformExportRow).values({ batchId: exportBatch.id, sourceRowNo: 1, usccRaw: f.enterprise.usccNorm }).returning().get()
  f.db.insert(schema.recordCorrespondence).values({ edgeKey: 'export391', type: 'event_export_context', role: 'current_snapshot_context', eventId: event.id, exportRowId: exportRow.id, enterpriseId: f.enterprise.id,
    titleCode: 'specialized_sme', status: 'candidate', revision: 1, targetIdentity: {}, provenance: {}, sourceFingerprint: 'synthetic391', ruleId: 'manual', ruleVersion: '1', createdAt: 'synthetic391' }).run()
  return { ...f, event, id, evidence, exportRow }
}
function instrumentRedactor391() {
  const original = receiptRedaction391.importReceiptRedactor, callbacks: ReturnType<typeof vi.fn>[] = []
  const factory = vi.spyOn(receiptRedaction391, 'importReceiptRedactor').mockImplementation((db, options) => {
    const real = original(db, options), callback = vi.fn((value: unknown, mode?: receiptRedaction391.ReceiptRedactionMode) => real(value, mode)); callbacks.push(callback)
    return Object.assign(callback, { knownRedactors: real.knownRedactors })
  })
  const credentials = vi.spyOn(credentialState391, 'resolveCredential')
  return { factory, callbacks, credentials }
}
function fact391(f: ReturnType<typeof contextFixture391>, nameRaw: string | null = '[REDACTED]') {
  return { evidenceId: f.evidence.id, eventId: f.event.id, revision: 1, availability: 'captured', nameRaw, sourceBindingKnown: false }
}

it.each(['list', 'get', 'source_event', 'source_relation', 'source_export', 'discover'] as const)('391 api_context propagates the first callback through %s', action => {
  const f = contextFixture391(), trace = instrumentRedactor391()
  const input = action === 'list' ? { action: 'list' as const, method: 'GET', query: { pageSize: 20 } }
    : action === 'get' ? { action: 'get' as const, method: 'GET', id: f.id }
      : action === 'discover' ? { action: 'discover' as const, method: 'POST', body: { eventId: f.event.id } }
        : { action: 'source' as const, method: 'GET', kind: action === 'source_event' ? 'event' : action === 'source_relation' ? 'relation' : 'export_row', id: action === 'source_event' ? f.event.id : action === 'source_relation' ? f.relation.id : f.exportRow.id }
  const result = handleRecordCorrespondenceRequest(input, { db: f.db, apiToken: token391 })
  expect(result.status).toBe(200)
  const body = result.body as any
  const events = action === 'list' ? body.rows.map((row: any) => row.event) : action === 'get' ? [body.event]
    : action === 'discover' ? [body.event] : [action === 'source_event' ? body.source : null, ...body.correspondences.map((row: any) => row.event)].filter(Boolean)
  expect(events.length).toBeGreaterThan(0)
  for (const event of events) {
    expect(event.publishedPresentation).toEqual({ availability: 'available', error: null, facts: [fact391(f)] })
    expect(event.evidence[0].publishedName).toEqual(fact391(f))
    expect(event.officialEvidence[0].publishedName).toEqual(fact391(f))
    expect(Object.keys(event.evidence[0].publishedName).sort()).toEqual(['availability', 'eventId', 'evidenceId', 'nameRaw', 'revision', 'sourceBindingKnown'])
  }
  expect(trace.factory).toHaveBeenCalledTimes(1)
  expect(trace.factory.mock.calls[0]?.[1]).toEqual({ additionalSecrets: [token391] })
  expect(trace.credentials.mock.calls.map(call => call[0])).toEqual(['miitCookie', 'ocrToken'])
  expect(trace.callbacks[0]).toHaveBeenCalledTimes(1)
  if (action === 'discover') {
    expect(body).toMatchObject({ ruleVersion: 'event-archive-212-v1', total: 1, page: 1, pageSize: 50, coverage: { total: 1, page: 1, pageSize: 25, rows: [{ id: f.query.id, relationCount: 1, candidateCount: 1, status: 'partial' }] } })
    expect(body.rows[0].edge).toEqual({ type: 'event_process', eventId: f.event.id, relationId: f.relation.id, role: 'context_only' })
  }
})

it('391 api_no_double_redaction attaches final DTO once at all three typed positions', () => {
  const f = contextFixture391('REDACTED'), trace = instrumentRedactor391()
  const result = handleRecordCorrespondenceRequest({ action: 'source', method: 'GET', kind: 'event', id: f.event.id }, { db: f.db, apiToken: 'REDACTED' })
  expect(result.status).toBe(200)
  const body = result.body as any
  for (const event of [body.source, ...body.correspondences.map((row: any) => row.event)]) {
    expect(event.publishedPresentation.facts).toEqual([fact391(f)])
    expect(event.evidence[0].publishedName).toEqual(fact391(f))
    expect(event.officialEvidence[0].publishedName).toEqual(fact391(f))
  }
  expect(trace.callbacks[0]).toHaveBeenCalledTimes(1)
})

it('391 api_raw_names_are_not_slots retains old sanitization for arbitrary same-name raw keys', () => {
  const f = contextFixture391('{"cx391-only-A7mN5p9Q":"cx391-only-A7mN5p9Q","nested":"{\\"name\\":\\"cx391-only-A7mN5p9Q\\"}","bearer":"Bearer unlisted"}')
  f.db.$client.prepare('UPDATE platform_relation SET raw_fields=? WHERE id=?').run(JSON.stringify({ publishedPresentation: { nameRaw: token391, token: 'private' }, publishedName: token391, nested: { publishedName: token391 }, text: 'Bearer cx391-only-A7mN5p9Q' }), f.relation.id)
  const result = handleRecordCorrespondenceRequest({ action: 'get', method: 'GET', id: f.id }, { db: f.db, apiToken: token391 })
  expect(result.status).toBe(200)
  const body = result.body as any
  expect(body.event.publishedPresentation.facts[0].nameRaw).toBe('{"[REDACTED]":"[REDACTED]","nested":"{\\"name\\":\\"[REDACTED]\\"}","bearer":"Bearer [REDACTED]"}')
  expect(body.relation.rawFields).toEqual({ publishedPresentation: { nameRaw: '[REDACTED]' }, publishedName: '[REDACTED]', nested: { publishedName: '[REDACTED]' }, text: 'Bearer [REDACTED]' })
})

it('391 direct_source_aliases reuse completed maps and pass callbacks across discovery transactions', () => {
  const f = contextFixture391(), real = receiptRedaction391.importReceiptRedactor(f.db, { additionalSecrets: [token391] })
  const callback = Object.assign(vi.fn((value: unknown, mode?: receiptRedaction391.ReceiptRedactionMode) => real(value, mode)), { knownRedactors: real.knownRedactors })
  const trace = instrumentRedactor391(), row = getRecordCorrespondence(f.db, f.id)!
  const assertEvent = (event: any) => expect(event.publishedPresentation.facts).toEqual([fact391(f)])
  assertEvent(readSource(f.db, 'event', f.event.id, callback))
  assertEvent(eventSource(f.db, f.event.id, callback))
  const reader = sourceReader(f.db, [row], { kind: 'event', id: f.event.id }, callback)
  assertEvent(reader.read('event', f.event.id)); assertEvent(reader.detail(row).event)
  expect(reader.read('event', f.event.id)).toBe(reader.detail(row).event)
  assertEvent(details(f.db, [row], callback)[0]!.event); assertEvent(detail(f.db, row, callback).event)
  const input = { eventId: f.event.id, page: 1, pageSize: 50, queryPage: 1, queryPageSize: 25 }
  assertEvent(discoverEventArchives(f.db, input, callback)!.event)
  expect(relationSource(f.db, f.relation.id, callback)).toMatchObject({ id: f.relation.id })
  expect(exportRowSource(f.db, f.exportRow.id, callback)).toMatchObject({ id: f.exportRow.id })
  expect(callback).toHaveBeenCalledTimes(6)
  expect(trace.factory).not.toHaveBeenCalled(); expect(trace.credentials).not.toHaveBeenCalled()
  expect(f.db.$client.inTransaction).toBe(false)
})

it('391 api_auth_method_order resolves no secret before the existing guards', () => {
  const f = contextFixture391(), trace = instrumentRedactor391()
  expect(handleRecordCorrespondenceRequest({ action: 'preflight', method: 'POST', body: {} }, { db: f.db, apiToken: token391 }).status).toBe(401)
  expect(handleRecordCorrespondenceRequest({ action: 'list', method: 'POST' }, { db: f.db, apiToken: token391 }).status).toBe(405)
  expect(trace.factory).not.toHaveBeenCalled(); expect(trace.credentials).not.toHaveBeenCalled()
})

it('391 api_credential_failure_before_write preserves the decision ledger on secret failure', () => {
  const f = contextFixture391(), before = f.db.select().from(schema.importBatch).all()
  vi.spyOn(credentialState391, 'resolveCredential').mockImplementation(() => { throw new Error('synthetic391 credential read failed') })
  expect(() => handleRecordCorrespondenceRequest({ action: 'preflight', method: 'POST', body: {}, headers: { authorization: 'Bearer ' + token391 } }, { db: f.db, apiToken: token391 })).toThrow('synthetic391 credential read failed')
  expect(f.db.select().from(schema.importBatch).all()).toEqual(before)
})

it('391 api_forty_driver_budget keeps complete IDs sources raw and reverse links below thirty statements', () => {
  const f = fixture(), expected: Array<{ id: number; eventId: number; relationId: number }> = []
  for (let i = 0; i < 40; i++) {
    const event = f.addEvent()
    f.db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: `synthetic/${i}.pdf`, page: i + 1 }).run()
    const relation = i === 0 ? f.relation : f.db.insert(schema.platformRelation).values({ queryId: f.query.id, sequenceNo: i + 1, enterpriseId: f.enterprise.id, usccRaw: f.enterprise.usccNorm, rawFields: { original: `row-${i}` } }).returning().get()
    const id = f.addEdge(event.id, i)
    f.db.$client.prepare('UPDATE record_correspondence SET relation_id=? WHERE id=?').run(relation.id, id)
    expected.push({ id, eventId: event.id, relationId: relation.id })
  }
  const meter = observeBytes(f.db), fingerprints: string[] = [], prepare = f.db.$client.prepare.bind(f.db.$client)
  vi.spyOn(f.db.$client, 'prepare').mockImplementation((query: string) => { fingerprints.push(query.replace(/\s+/g, ' ').slice(0, 180)); return prepare(query) })
  const all = f.db.all.bind(f.db), gateBytes: number[] = []
  vi.spyOn(f.db, 'all').mockImplementation(((query: Parameters<typeof f.db.all>[0]) => {
    const rows = all(query) as Array<{ gate_json?: string }>
    for (const row of rows) if (row.gate_json) gateBytes.push(Buffer.byteLength(row.gate_json))
    return rows
  }) as typeof f.db.all)
  const result = handleRecordCorrespondenceRequest({ action: 'list', method: 'GET', query: { pageSize: 40 } }, { db: f.db }).body as any
  expect(result.total).toBe(40)
  expect(result.rows.map((row: any) => ({ id: row.id, eventId: row.event.id, relationId: row.relation.id }))).toEqual(expected)
  expect(result.rows[39]).toMatchObject({ event: { evidence: [{ page: 40 }], correspondences: [{ id: expected[39]!.id }] }, relation: { rawFields: { original: 'row-39' }, correspondences: [{ id: expected[39]!.id }] } })
  expect(meter.statements).toBeLessThan(30)
  expect(fingerprints.filter(query => query.includes('service_credential'))).toHaveLength(2)
  expect(gateBytes).toHaveLength(40)
  expect(gateBytes.every(bytes => bytes <= 66560)).toBe(true)
  console.info('391 actual driver receipt', JSON.stringify({ statements: meter.statements, materializedBytes: meter.bytes, gateBytes, fingerprints }))
})

const collisionSecrets391 = [
  { label: 'official', token: 'officialEvidence', evidenceKey: 'evidence', officialKey: '[REDACTED]', innerKey: 'evidence' },
  { label: 'evidence', token: 'evidence', evidenceKey: '[REDACTED]', officialKey: 'officialEvidence', innerKey: '[REDACTED]' },
  { label: 'normal', token: token391, evidenceKey: 'evidence', officialKey: 'officialEvidence', innerKey: 'evidence' },
  { label: 'dual', token: 'officialEvidence', evidenceKey: '[REDACTED]', officialKey: '[REDACTED]', innerKey: '[REDACTED]' },
] as const
const collisionCases391 = collisionSecrets391.flatMap(secret => (['empty', 'captured'] as const).flatMap(state =>
  (['list', 'get', 'source', 'discover'] as const).map(action => ({ ...secret, state, action }))))

it.each(collisionCases391)('391 key_collision $label $state $action', ({ label, token, evidenceKey, officialKey, innerKey, state, action }) => {
  const f = contextFixture391(token), trace = instrumentRedactor391()
  if (label === 'dual') vi.stubEnv('NUXT_MCP_TOKEN', 'evidence')
  if (state === 'empty') {
    f.db.delete(schema.officialEvidenceRowRevision).run()
    f.db.delete(schema.recordEvidence).run()
  }
  const input = action === 'list' ? { action, method: 'GET', query: { pageSize: 20 } }
    : action === 'get' ? { action, method: 'GET', id: f.id }
      : action === 'discover' ? { action, method: 'POST', body: { eventId: f.event.id } }
        : { action, method: 'GET', kind: 'event', id: f.event.id }
  const result = handleRecordCorrespondenceRequest(input, { db: f.db, apiToken: token })
  expect(result.status).toBe(200)
  const body = result.body as any
  const events = action === 'list' ? body.rows.map((row: any) => row.event)
    : action === 'source' ? [body.source, ...body.correspondences.map((row: any) => row.event)] : [body.event]
  expect(events).toHaveLength(action === 'list' ? 2 : action === 'source' ? 3 : 1)
  const fact = { evidenceId: f.evidence.id, eventId: f.event.id, revision: 1, availability: 'captured', nameRaw: '[REDACTED]', sourceBindingKnown: false }
  for (const event of events) {
    expect(event.id).toBe(f.event.id)
    expect(event.publishedPresentation).toEqual({ availability: 'available', error: null, facts: state === 'empty' ? [] : [fact] })
    if (evidenceKey !== 'evidence') expect(event).not.toHaveProperty('evidence')
    if (officialKey !== 'officialEvidence') expect(event).not.toHaveProperty('officialEvidence')
    expect(event[evidenceKey]).toHaveLength(state === 'empty' ? 0 : 1)
    expect(event[officialKey]).toHaveLength(state === 'empty' ? 0 : 1)
    if (state === 'captured') {
      expect(event[evidenceKey][0].publishedName).toEqual(fact)
      expect(event[officialKey][0].publishedName).toEqual(fact)
      const original = { id: f.evidence.id, recordEventId: f.event.id, sourceFile: 'synthetic391.pdf', page: 1 }
      // Both renamed keys may collide: the later officialEvidence entry must
      // retain the legacy sanitizer's last-entry-wins behavior.
      if (label !== 'dual') expect(event[evidenceKey][0]).toMatchObject(original)
      expect(event[officialKey][0][innerKey]).toMatchObject(original)
      expect(event[officialKey][0].storedFile).toBeNull()
      if (innerKey !== 'evidence') expect(event[officialKey][0]).not.toHaveProperty('evidence')
      expect(Object.keys(event[officialKey][0].publishedName).sort()).toEqual(['availability', 'eventId', 'evidenceId', 'nameRaw', 'revision', 'sourceBindingKnown'])
    }
  }
  expect(trace.factory).toHaveBeenCalledTimes(1)
  expect(trace.factory.mock.calls[0]?.[1]).toEqual({ additionalSecrets: [token] })
  expect(trace.credentials.mock.calls.map(call => call[0])).toEqual(['miitCookie', 'ocrToken'])
  expect(trace.callbacks[0]).toHaveBeenCalledTimes(state === 'empty' ? 0 : 1)
})

it.each(['officialEvidence', 'evidence'])('391 key_collision_raw %s keeps arbitrary raw dictionaries on the legacy sanitizer', token => {
  const f = contextFixture391(token)
  f.db.$client.prepare('UPDATE platform_relation SET raw_fields=? WHERE id=?').run(JSON.stringify({
    evidence: { publishedName: token, cookie: 'private', officialEvidence: token },
    officialEvidence: { publishedPresentation: token, token: 'private', evidence: token },
  }), f.relation.id)
  const result = handleRecordCorrespondenceRequest({ action: 'get', method: 'GET', id: f.id }, { db: f.db, apiToken: token })
  expect(result.status).toBe(200)
  expect((result.body as any).relation.rawFields).toEqual(token === 'officialEvidence'
    ? { evidence: { publishedName: '[REDACTED]', '[REDACTED]': '[REDACTED]' }, '[REDACTED]': { publishedPresentation: '[REDACTED]', evidence: '[REDACTED]' } }
    : { '[REDACTED]': { publishedName: '[REDACTED]', officialEvidence: '[REDACTED]' }, officialEvidence: { publishedPresentation: '[REDACTED]', '[REDACTED]': '[REDACTED]' } })
})

// R12: independent legacy-key/order controls; synthetic storage only.
type LegacyEdge391 = 'none' | 'process' | 'export' | 'later'
type LegacyAction391 = 'get' | 'list' | 'source_event' | 'source_relation' | 'source_export' | 'discover'
function legacyFixture391(edge: LegacyEdge391 = 'process', captured = false, nameRaw = 'Legacy391Name') {
  const sqlite = new LegacyDatabase391(':memory:'); sqlite.pragma('foreign_keys=ON')
  cleanup.push(() => { sqlite.close() })
  const db = legacyDrizzle391(sqlite, { schema })
  legacyMigrate391(db, { migrationsFolder: legacyResolve391('db/migrations') })
  for (const title of LEGACY_TITLE_SEED391) db.insert(schema.title).values(title).run()
  db.insert(schema.enterprise).values({ id: 1, name: '合成旧键391', nameNorm: '合成旧键391', usccNorm: '91330211255994457P' }).run()
  db.insert(schema.record).values({ id: 1, enterpriseId: 1, titleCode: 'specialized_sme', source: 'jxj', usccRaw: '91330211255994457P' }).run()
  db.insert(schema.recordEvent).values({ id: 1, recordId: 1, eventType: 'award', year: 2022, batchSeq: 1 }).run()
  db.insert(schema.platformQuery).values({ id: 1, interface: 'business_list', queryKey: '91330211255994457P', rdjb: '2', titleCode: 'specialized_sme', queriedAt: '2026-10-19', status: 'partial' }).run()
  db.insert(schema.platformRelation).values({ id: 1, queryId: 1, sequenceNo: 1, enterpriseId: 1, usccRaw: '91330211255994457P', relationKey: 'legacy391', declareKind: 'apply', year: 2022, matchBasis: 'uscc', verificationStatus: 'confirmed' }).run()
  db.insert(schema.platformExportBatch).values({ id: 1, titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-19', originalFilename: 'legacy391.xlsx', sha256: 'synthetic-legacy391', importStatus: 'imported' }).run()
  db.insert(schema.platformExportRow).values({ id: 1, batchId: 1, sourceRowNo: 1, usccRaw: '91330211255994457P' }).run()
  if (edge !== 'none') db.insert(schema.recordCorrespondence).values({ id: 7, edgeKey: 'legacy391',
    type: edge === 'process' ? 'event_process' : edge === 'export' ? 'event_export_context' : 'later_process',
    role: edge === 'process' ? 'context_only' : edge === 'export' ? 'current_snapshot_context' : 'followup_review',
    eventId: edge === 'later' ? null : 1, predecessorEventId: edge === 'later' ? 1 : null,
    relationId: edge === 'export' ? null : 1, exportRowId: edge === 'export' ? 1 : null,
    enterpriseId: 1, titleCode: 'specialized_sme', status: 'candidate', revision: 1, targetIdentity: {}, provenance: {},
    sourceFingerprint: 'synthetic-legacy391', ruleId: 'manual', ruleVersion: '1', createdAt: '2026-10-19' }).run()
  if (captured) {
    db.insert(schema.importBatch).values({ id: 1, idempotencyKey: 'legacy391', sourceKind: 'announcement', sourceIdentity: 'synthetic-legacy391', status: 'committed' }).run()
    db.insert(schema.recordEvidence).values({ id: 17, recordEventId: 1, sourceFile: 'legacy391.pdf', page: 1, listNo: 17 }).run()
    db.insert(schema.officialEvidenceRowRevision).values({ evidenceId: 17, eventId: 1, revision: 1, capturedRecordId: 1, capturedEnterpriseId: 1, nameRaw,
      sourceBindingKnown: false, actor: { type: 'agent', id: 'synthetic391' }, basis: 'synthetic391', commandKind: 'import', importBatchId: 1, createdAt: 'synthetic391' }).run()
  }
  return { db }
}
// Full reverse-link literals, not generated by a reader or sanitizer.
const legacyProcessRef391 = { id: 7, type: 'event_process', role: 'context_only', status: 'candidate', eventId: 1, predecessorEventId: null, relationId: 1, exportRowId: null, enterpriseId: 1, titleCode: 'specialized_sme', revision: 1, requiresRevalidation: false }
const legacyExportRef391 = { id: 7, type: 'event_export_context', role: 'current_snapshot_context', status: 'candidate', eventId: 1, predecessorEventId: null, relationId: null, exportRowId: 1, enterpriseId: 1, titleCode: 'specialized_sme', revision: 1, requiresRevalidation: false }
function legacyCall391(f: ReturnType<typeof legacyFixture391>, action: LegacyAction391, token = 'normal-legacy391') {
  const input = action === 'list' ? { action: 'list' as const, method: 'GET' }
    : action === 'get' ? { action: 'get' as const, method: 'GET', id: 7 }
      : action === 'discover' ? { action: 'discover' as const, method: 'POST', body: { eventId: 1 } }
        : { action: 'source' as const, method: 'GET', kind: action === 'source_event' ? 'event' : action === 'source_relation' ? 'relation' : 'export_row', id: 1 }
  const result = handleRecordCorrespondenceRequest(input, { db: f.db, apiToken: token })
  expect(result.status).toBe(200)
  return result.body as any
}
function legacyDetail391(body: any, action: Exclude<LegacyAction391, 'discover'>) {
  if (action === 'get') return body
  const rows = action === 'list' ? body.rows : body.correspondences
  expect(rows).toHaveLength(1)
  expect(rows[0].id).toBe(7)
  return rows[0]
}
const legacySourceCases391 = (['source', 'correspondences'] as const).flatMap(key =>
  (['event', 'relation', 'export_row'] as const).flatMap(kind => [false, true].map(nonempty => ({ key, kind, nonempty }))))
it.each(legacySourceCases391)('391 legacy_key_source $key $kind $nonempty', ({ key, kind, nonempty }) => {
  const f = legacyFixture391(nonempty ? kind === 'export_row' ? 'export' : 'process' : 'none', nonempty)
  const result = handleRecordCorrespondenceRequest({ action: 'source', method: 'GET', kind, id: 1 }, { db: f.db, apiToken: key })
  expect(result.status).toBe(200)
  const body = result.body as any
  expect(Object.keys(body)).toEqual(key === 'source' ? ['[REDACTED]', 'correspondences'] : ['source', '[REDACTED]'])
  expect(body).not.toHaveProperty(key)
  const source = body[key === 'source' ? '[REDACTED]' : 'source']
  expect(source.id).toBe(1)
  const rows = body[key === 'correspondences' ? '[REDACTED]' : 'correspondences']
  expect(rows.map((row: any) => row.id)).toEqual(nonempty ? [7] : [])
  expect(source[key === 'correspondences' ? '[REDACTED]' : 'correspondences']).toEqual(nonempty ? [kind === 'export_row' ? legacyExportRef391 : legacyProcessRef391] : [])
  if (kind === 'event') {
    expect(source.publishedPresentation).toEqual({ availability: 'available', error: null, facts: nonempty ? [{ evidenceId: 17, eventId: 1, revision: 1, availability: 'captured', nameRaw: 'Legacy391Name', sourceBindingKnown: false }] : [] })
    if (key === 'source') expect(source.record).toEqual({ id: 1, enterpriseId: 1, titleCode: 'specialized_sme', '[REDACTED]': 'jxj', usccRaw: '91330211255994457P' })
  }
})
const legacyRowsCases391 = (['full', 'summary'] as const).flatMap(view => [false, true].flatMap(nonempty => ['normal-legacy391', 'rows'].map(token => ({ view, nonempty, token }))))
it.each(legacyRowsCases391)('391 legacy_key_rows $view $nonempty $token', ({ view, nonempty, token }) => {
  const f = legacyFixture391(nonempty ? 'process' : 'none')
  const result = handleRecordCorrespondenceRequest({ action: 'list', method: 'GET', query: view === 'summary' ? { view } : {} }, { db: f.db, apiToken: token })
  expect(result.status).toBe(200)
  const body = result.body as any, rowKey = token === 'rows' ? '[REDACTED]' : 'rows'
  expect(Object.keys(body)).toEqual([rowKey, 'total', 'page', 'pageSize'])
  expect({ total: body.total, page: body.page, pageSize: body.pageSize }).toEqual({ total: nonempty ? 1 : 0, page: 1, pageSize: 50 })
  expect(body[rowKey].map((row: any) => ({ id: row.id, eventId: row.eventId, relationId: row.relationId }))).toEqual(nonempty ? [{ id: 7, eventId: 1, relationId: 1 }] : [])
  if (token === 'rows') expect(body).not.toHaveProperty('rows')
  if (nonempty && view === 'summary') expect(body[rowKey][0]).not.toHaveProperty('event')
  if (nonempty && view === 'full') expect(body[rowKey][0].event.id).toBe(1)
})
const legacyDetailCases391: Array<{ action: Exclude<LegacyAction391, 'discover'>; edge: Exclude<LegacyEdge391, 'none'>; key: 'event' | 'predecessorEvent' }> = [
  ...(['get', 'list', 'source_event', 'source_relation'] as const).flatMap(action =>
    (['process', 'later'] as const).flatMap(edge => (['event', 'predecessorEvent'] as const).map(key => ({ action, edge, key })))),
  ...(['event', 'predecessorEvent'] as const).map(key => ({ action: 'source_export' as const, edge: 'export' as const, key })),
]
it.each(legacyDetailCases391)('391 legacy_key_detail $action $edge $key', ({ action, edge, key }) => {
  const f = legacyFixture391(edge), row = legacyDetail391(legacyCall391(f, action, key), action)
  expect(row).not.toHaveProperty(key)
  expect(Object.hasOwn(row, '[REDACTED]')).toBe(true)
  if ((key === 'event') === (edge === 'later')) expect(row['[REDACTED]']).toBeNull()
  else expect(row['[REDACTED]']).toMatchObject({ id: 1, record: { id: 1, enterpriseId: 1, titleCode: 'specialized_sme', source: 'jxj', usccRaw: '91330211255994457P' }, evidence: [], officialEvidence: [] })
})
it.each(['event', 'rows'])('391 legacy_key_discover %s', key => {
  const f = legacyFixture391()
  const body = legacyCall391(f, 'discover', key)
  expect(Object.keys(body)).toEqual(key === 'event'
    ? ['[REDACTED]', 'ruleVersion', 'rows', 'total', 'page', 'pageSize', 'coverage', 'interfaces']
    : ['event', 'ruleVersion', '[REDACTED]', 'total', 'page', 'pageSize', 'coverage', 'interfaces'])
  expect(body).not.toHaveProperty(key)
  expect(body.ruleVersion).toBe(key === 'event' ? '[REDACTED]-archive-212-v1' : 'event-archive-212-v1')
  if (key === 'event') expect(body['[REDACTED]']).toMatchObject({ id: 1, evidence: [], officialEvidence: [] })
  else expect(body['[REDACTED]'].map((row: any) => row.edge)).toEqual([{ type: 'event_process', eventId: 1, relationId: 1, role: 'context_only' }])
})
it.each((['get', 'list', 'source_event', 'discover'] as const).flatMap(action => [false, true].map(captured => ({ action, captured }))))('391 legacy_order_reverse_wins $action $captured', ({ action, captured }) => {
  const f = legacyFixture391('process', captured, 'officialEvidence')
  vi.stubEnv('NUXT_MCP_TOKEN', 'correspondences')
  const body = legacyCall391(f, action, 'officialEvidence')
  const event = action === 'get' ? body.event : action === 'list' ? body.rows[0].event : action === 'source_event' ? body.source : body.event
  expect(event.id).toBe(1)
  expect(event['[REDACTED]']).toEqual([legacyProcessRef391])
  expect(event).not.toHaveProperty('correspondences')
  expect(event).not.toHaveProperty('officialEvidence')
  expect(event.publishedPresentation).toEqual({ availability: 'available', error: null, facts: captured ? [{ evidenceId: 17, eventId: 1, revision: 1, availability: 'captured', nameRaw: '[REDACTED]', sourceBindingKnown: false }] : [] })
})
it.each((['full', 'summary'] as const).flatMap(view => [false, true].map(nonempty => ({ view, nonempty }))))('391 legacy_order_total_wins $view $nonempty', ({ view, nonempty }) => {
  const f = legacyFixture391(nonempty ? 'process' : 'none')
  vi.stubEnv('NUXT_MCP_TOKEN', 'total')
  const result = handleRecordCorrespondenceRequest({ action: 'list', method: 'GET', query: view === 'summary' ? { view } : {} }, { db: f.db, apiToken: 'rows' })
  expect(result.status).toBe(200)
  expect(result.body).toEqual({ '[REDACTED]': nonempty ? 1 : 0, page: 1, pageSize: 50 })
})
it.each(['get', 'list', 'source_event', 'source_relation', 'source_export'] as const)('391 legacy_order_null_predecessor %s', action => {
  const f = legacyFixture391(action === 'source_export' ? 'export' : 'process')
  vi.stubEnv('NUXT_MCP_TOKEN', 'predecessorEvent')
  const row = legacyDetail391(legacyCall391(f, action, 'event'), action)
  expect(row).not.toHaveProperty('event')
  expect(row).not.toHaveProperty('predecessorEvent')
  expect(Object.hasOwn(row, '[REDACTED]')).toBe(true)
  expect(row['[REDACTED]']).toBeNull()
})
it('391 legacy_order_normal preserves the original full body and event sibling order', () => {
  const body = legacyCall391(legacyFixture391('process', true), 'list')
  expect(Object.keys(body)).toEqual(['rows', 'total', 'page', 'pageSize'])
  expect(Object.keys(body.rows[0]).slice(-4)).toEqual(['event', 'predecessorEvent', 'relation', 'exportRow'])
  expect(Object.keys(body.rows[0].event).slice(-5)).toEqual(['publishedPresentation', 'record', 'evidence', 'officialEvidence', 'correspondences'])
  expect(body.rows[0].event.correspondences).toEqual([legacyProcessRef391])
})
it('391 legacy_raw_shape never opts arbitrary same-name six-field dictionaries into typed mode', () => {
  const f = legacyFixture391('process', true, 'nameRaw')
  const raw = { evidenceId: 17, eventId: 1, revision: 1, availability: 'captured', nameRaw: 'nameRaw', sourceBindingKnown: false }
  f.db.$client.prepare('UPDATE platform_relation SET raw_fields=? WHERE id=1').run(JSON.stringify({ publishedName: raw, publishedPresentation: { facts: [raw], event: 'nameRaw', rows: ['nameRaw'], cookie: 'private' } }))
  const body = legacyCall391(f, 'get', 'nameRaw')
  expect(body.relation.rawFields).toEqual({
    publishedName: { evidenceId: 17, eventId: 1, revision: 1, availability: 'captured', '[REDACTED]': '[REDACTED]', sourceBindingKnown: false },
    publishedPresentation: { facts: [{ evidenceId: 17, eventId: 1, revision: 1, availability: 'captured', '[REDACTED]': '[REDACTED]', sourceBindingKnown: false }], event: '[REDACTED]', rows: ['[REDACTED]'] },
  })
  expect(body.event.evidence[0].publishedName).toEqual({ evidenceId: 17, eventId: 1, revision: 1, availability: 'captured', nameRaw: '[REDACTED]', sourceBindingKnown: false })
})
it('391 legacy_own_keys keeps prototype data generic and drops sensitive raw keys', () => {
  const f = legacyFixture391()
  const raw = Object.fromEntries([['__proto__', { constructor: 'constructor', cookie: 'private' }], ['constructor', 'constructor'], ['prototype', 'constructor'], ['password', 'private'], ['cookie', 'private'], ['token', 'private'], ['rawResponse', 'private'], ['kept', 'safe']])
  f.db.$client.prepare('UPDATE platform_relation SET raw_fields=? WHERE id=1').run(JSON.stringify(raw))
  const value = legacyCall391(f, 'get', 'constructor').relation.rawFields
  expect(value).toEqual({ ['__proto__']: { '[REDACTED]': '[REDACTED]' }, '[REDACTED]': '[REDACTED]', prototype: '[REDACTED]', kept: 'safe' })
  expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
  expect(Object.hasOwn(value, '__proto__')).toBe(true)
  expect(Object.hasOwn(value, 'constructor')).toBe(false)
  expect(Object.keys(value)).toEqual(['__proto__', '[REDACTED]', 'prototype', 'kept'])
})
