import { submitNativePlatformQuery } from '../../platform/fixtures/native-query'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, createRouter, defineEventHandler, toNodeListener } from 'h3'
import { afterAll, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { initializeDb, schema } from '../../../db/client'
import { readCurrentCandidate } from '../../../lib/roster/current-qualification'

const dirs: string[] = []
afterAll(() => { vi.unstubAllGlobals(); for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })
async function fixture(awardYear = 2021, titleCode = 'specialized_sme') {
  const dir = mkdtempSync(join(tmpdir(), 'event-correction-100-')); dirs.push(dir)
  const dbPath = join(dir, 'test.db'), db = initializeDb({ create: true,  dbPath })
  const enterprise = db.insert(schema.enterprise).values({ name: '合成事件企业', nameNorm: '合成事件企业' }).returning().get()
  const record = db.insert(schema.record).values({ enterpriseId: enterprise.id, titleCode, source: 'jxj', nameRaw: enterprise.name }).returning().get()
  const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: awardYear, decidedYear: awardYear, batchSeq: 1, sortKey: awardYear }).returning().get()
  db.insert(schema.storedFile).values({ relPath: 'synthetic/notice.pdf', filename: 'notice.pdf', ext: 'pdf', bytes: 123, sha256: 'synthetic-sha' }).run()
  const evidence = db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: 'synthetic/notice.pdf', attachment: '附件一', listNo: 7, page: 2 }).returning().get()
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  vi.stubGlobal('useRuntimeConfig', () => ({ apiToken: 'test-api' }))
  const oldPath = process.env.NUXT_DB_PATH; process.env.NUXT_DB_PATH = dbPath
  const { eventCorrectionRoute } = await import('../../../server/utils/roster-event-correction-route')
  const app = createApp(), router = createRouter()
  router.use('/api/roster/events/corrections/preflight', eventCorrectionRoute('preflight'))
  router.use('/api/roster/events/corrections/commit', eventCorrectionRoute('commit'))
  router.use('/api/roster/events/:id/audit', eventCorrectionRoute('audit'))
  router.use('/api/roster/events/:id', eventCorrectionRoute('get'))
  const { correspondenceRoute } = await import('../../../server/utils/record-correspondence-route')
  router.use('/api/roster/correspondences/preflight', correspondenceRoute('preflight'))
  router.use('/api/roster/correspondences/commit', correspondenceRoute('commit'))
  router.use('/api/roster/correspondences/:id', correspondenceRoute('get', { id: true }))
  app.use(router)
  const listener = createServer(toNodeListener(app))
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`
  const rawPost = async (path: string, body: unknown) => { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test-api' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() } }
  const request = (key = 'correct-1', patch: Record<string, unknown> = { year: 2022, decidedYear: 2022 }) => ({ idempotencyKey: key, sourceIdentity: 'synthetic:notice-review', actor: { type: 'agent', id: 'test' }, basis: 'Verified original announcement row', operations: [{ eventId: event.id, recordId: record.id, enterpriseId: enterprise.id, expectedRevision: 1, patch }] })
  const read = async (path = `/api/roster/events/${event.id}`) => { const r = await fetch(base + path); return { status: r.status, body: await r.json(), headers: r.headers } }
  const post = async (action: string, body: unknown, token: string | null = 'test-api') => { const r = await fetch(base + '/api/roster/events/corrections/' + action, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: typeof body === 'string' ? body : JSON.stringify(body) }); return { status: r.status, body: await r.json(), headers: r.headers } }
  return { db, dbPath, event, evidence, record, enterprise, request, read, post, rawPost, close: async () => { await new Promise<void>(resolve => listener.close(() => resolve())); if (oldPath == null) delete process.env.NUXT_DB_PATH; else process.env.NUXT_DB_PATH = oldPath } }
}

it('corrects the exact official event in place and replays the receipt with preserved evidence and audit', async () => {
  const f = await fixture()
  try {
    const before = await f.read()
    expect(before.status).toBe(200)
    expect(before.body).toMatchObject({ event: { id: f.event.id, revision: 1, year: 2021 }, evidence: [f.evidence], lifecycle: { firstRecognitionYear: 2021, dueYear: 2024 } })
    const request = f.request()
    const plan = await f.post('preflight', request)
    expect(plan.status).toBe(200)
    expect(plan.body).toMatchObject({ batchStatus: 'preflight', targets: [{ before: { year: 2021 }, after: { year: 2022 }, lifecycleBefore: { dueYear: 2024 }, lifecycleAfter: { dueYear: 2025 } }] })
    expect((await f.read()).body).toEqual(before.body)
    const receipt = await f.post('commit', { request, planHash: plan.body.planHash })
    expect(receipt.status).toBe(200)
    expect(receipt.body).toMatchObject({ eventIds: [f.event.id] })
    expect((await f.post('commit', { request, planHash: plan.body.planHash })).body).toEqual(receipt.body)
    expect((await f.read()).body).toMatchObject({ event: { id: f.event.id, recordId: f.record.id, revision: 2, year: 2022, decidedYear: 2022, sortKey: 2022 }, record: { id: f.record.id, enterpriseId: f.enterprise.id }, evidence: [f.evidence], lifecycle: { firstRecognitionYear: 2022, dueYear: 2025 } })
    expect((await f.read(`/api/roster/events/${f.event.id}/audit?pageSize=1`)).body).toMatchObject({ total: 1, rows: [{ before: { year: 2021 }, after: { year: 2022 }, actorId: 'test', basis: request.basis, sourceIdentity: request.sourceIdentity, evidence: [f.evidence] }] })
  } finally { await f.close() }
})

it('corrects review origin and conclusion independently without guessing its batch or changing another title', async () => {
  const f = await fixture(2022)
  try {
    // Synthetic legacy import: publication year was placed in the origin field.
    const review = f.db.insert(schema.recordEvent).values({ recordId: f.record.id, eventType: 'review', year: 2025 }).returning().get()
    f.db.insert(schema.recordEvidence).values({ recordEventId: review.id, sourceFile: 'synthetic/notice.pdf', attachment: '附件2', listNo: 9, page: 17 }).run()
    const other = f.db.insert(schema.record).values({ enterpriseId: f.enterprise.id, titleCode: 'innovative_sme', source: 'jxj', nameRaw: f.enterprise.name }).returning().get()
    const otherAward = f.db.insert(schema.recordEvent).values({ recordId: other.id, eventType: 'award', year: 2023, batchSeq: 1 }).returning().get()
    const otherReview = f.db.insert(schema.recordEvent).values({ recordId: other.id, eventType: 'review', year: 2023, decidedYear: 2026, batchSeq: 1, reviewOutcome: 'failed' }).returning().get()
    for (const event of [otherAward, otherReview]) f.db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: 'synthetic/notice.pdf', page: 2 }).run()
    const before = (await f.read(`/api/roster/events/${review.id}`)).body
    const otherBefore = (await f.read(`/api/roster/events/${otherReview.id}`)).body
    const candidate = () => readCurrentCandidate(f.db.$client, f.enterprise.id, 'specialized_sme', 2026)
    expect(candidate().group).toBe('excluded')
    const correct = async (key: string, expectedRevision: number, patch: Record<string, unknown>) => {
      const request = f.request(key)
      request.operations = [{ eventId: review.id, recordId: f.record.id, enterpriseId: f.enterprise.id, expectedRevision, patch }]
      const plan = await f.post('preflight', request)
      expect(plan.status).toBe(200)
      const receipt = await f.post('commit', { request, planHash: plan.body.planHash })
      expect(receipt.status).toBe(200)
      expect((await f.post('commit', { request, planHash: plan.body.planHash })).body).toEqual(receipt.body)
      return (await f.read(`/api/roster/events/${review.id}`)).body
    }
    const corrected = await correct('review-verified', 1, { year: 2022, decidedYear: 2025, reviewOutcome: 'passed', batchSeq: null })
    expect(corrected).toMatchObject({ event: { id: review.id, recordId: f.record.id, year: 2022, decidedYear: 2025, reviewOutcome: 'passed', batchSeq: null, revision: 2 }, lifecycle: { firstRecognitionYear: 2022, firstRecognitionEventId: f.event.id, state: 'none', needsReview: true, anchorYear: 2022, dueYear: null } })
    expect(corrected.evidence).toEqual(before.evidence)
    expect(corrected.files).toEqual(before.files)
    expect(candidate()).toMatchObject({ group: 'eligible', firstYear: 2022, basis: `event:${f.event.id}@1 award 2022/1 结论年:2022\nevent:${review.id}@2 review 2022/ 结论年:2025` })
    // Recording the original batch improves diagnostics; the recorded passed period already permits eligibility.
    const verified = await correct('review-batch-verified', 2, { batchSeq: 1 })
    expect(verified).toMatchObject({ event: { id: review.id, recordId: f.record.id, year: 2022, decidedYear: 2025, batchSeq: 1, reviewOutcome: 'passed', revision: 3 }, lifecycle: { firstRecognitionYear: 2022, firstRecognitionEventId: f.event.id, state: 'active', needsReview: false, anchorYear: 2025, dueYear: 2028 } })
    expect(verified.evidence).toEqual(before.evidence)
    expect(verified.files).toEqual(before.files)
    expect(candidate().group).toBe('eligible')
    const unknown = await correct('review-outcome-unknown', 3, { reviewOutcome: null })
    expect(unknown.lifecycle).toMatchObject({ firstRecognitionYear: 2022, state: 'none', needsReview: true, dueYear: null })
    expect(candidate().group).toBe('excluded')
    const failed = await correct('review-explicit-failure', 4, { reviewOutcome: 'failed' })
    expect(failed.lifecycle).toMatchObject({ firstRecognitionYear: 2022, state: 'terminated', needsReview: false, dueYear: null })
    expect(candidate().group).toBe('excluded')
    expect((await f.read(`/api/roster/events/${f.event.id}`)).body.event).toMatchObject({ id: f.event.id, year: 2022, revision: 1 })
    expect((await f.read(`/api/roster/events/${otherReview.id}`)).body).toEqual(otherBefore)
    const audit = (await f.read(`/api/roster/events/${review.id}/audit`)).body
    expect(audit.total).toBe(4)
    expect(audit.rows.map(({ after }: any) => [after.revision, after.year, after.decidedYear, after.batchSeq, after.reviewOutcome])).toEqual([
      [2, 2022, 2025, null, 'passed'], [3, 2022, 2025, 1, 'passed'], [4, 2022, 2025, 1, null], [5, 2022, 2025, 1, 'failed'],
    ])
    expect(audit.rows[0].before).toMatchObject({ year: 2025, decidedYear: null, reviewOutcome: null })
    expect(audit.rows.every((row: any) => JSON.stringify(row.evidence) === JSON.stringify(before.evidence))).toBe(true)
  } finally { await f.close() }
})

it('atomically corrects a confirmed award batch and its 2022-origin 2025 review while retaining year and outcome protections', async () => {
  const f = await fixture(2022, 'innovative_sme')
  try {
    // Synthetic legacy facts; batch 1 is an explicit source-scope decision,
    // never inferred by the API from the file name or platform maintenance tag.
    f.db.$client.prepare('update record_event set batch_seq = null where id = ?').run(f.event.id)
    const review = f.db.insert(schema.recordEvent).values({ recordId: f.record.id, eventType: 'review', year: 2025 }).returning().get()
    f.db.insert(schema.recordEvidence).values({ recordEventId: review.id, sourceFile: 'synthetic/notice.pdf', attachment: '附件2', listNo: 139, page: 17 }).run()
    const controlRecord = f.db.insert(schema.record).values({ enterpriseId: f.enterprise.id, titleCode: 'specialized_sme', source: 'jxj' }).returning().get()
    const control = f.db.insert(schema.recordEvent).values({ recordId: controlRecord.id, eventType: 'review', year: 2023, decidedYear: 2026, batchSeq: 1, reviewOutcome: 'failed' }).returning().get()
    const before = await Promise.all([f.read(), f.read(`/api/roster/events/${review.id}`), f.read(`/api/roster/events/${control.id}`)])
    const counts = () => ['enterprise', 'record', 'record_event', 'record_evidence'].map(table => f.db.$client.prepare(`select count(*) as n from ${table}`).get())
    const countsBefore = counts()
    const candidate = () => readCurrentCandidate(f.db.$client, f.enterprise.id, 'innovative_sme', 2026)
    expect(candidate().group).toBe('excluded')
    const request = f.request('confirmed-batch-pair')
    request.basis = 'Explicitly confirmed original award batch 1; attachment 2 page 17 proves review conclusion in 2025, passed, for the 2022 cycle'
    request.operations = [
      { eventId: f.event.id, recordId: f.record.id, enterpriseId: f.enterprise.id, expectedRevision: 1, patch: { batchSeq: 1 } },
      { eventId: review.id, recordId: f.record.id, enterpriseId: f.enterprise.id, expectedRevision: 1, patch: { year: 2022, batchSeq: 1, decidedYear: 2025, reviewOutcome: 'passed' } },
    ]
    const plan = await f.post('preflight', request)
    expect(plan.status).toBe(200)
    expect(plan.body.targets.map((target: any) => target.after)).toEqual([
      expect.objectContaining({ id: f.event.id, year: 2022, batchSeq: 1 }),
      expect.objectContaining({ id: review.id, year: 2022, batchSeq: 1, decidedYear: 2025, reviewOutcome: 'passed' }),
    ])
    expect((await f.read()).body).toEqual(before[0]!.body)
    expect((await f.read(`/api/roster/events/${review.id}`)).body).toEqual(before[1]!.body)
    // One stale member rejects the entire preflight; neither event nor audit changes.
    const stale = structuredClone(request); stale.idempotencyKey = 'stale-confirmed-batch-pair'; stale.operations[1]!.expectedRevision = 2
    expect((await f.post('preflight', stale)).body).toMatchObject({ error: { code: 'stale_revision' } })
    expect((await f.read()).body).toEqual(before[0]!.body)
    expect((await f.read(`/api/roster/events/${review.id}/audit`)).body.total).toBe(0)
    const receipt = await f.post('commit', { request, planHash: plan.body.planHash })
    expect(receipt.status).toBe(200)
    expect(receipt.body.eventIds).toEqual([f.event.id, review.id])
    expect((await f.post('commit', { request, planHash: plan.body.planHash })).body).toEqual(receipt.body)
    expect(candidate()).toMatchObject({ group: 'eligible', firstYear: 2022 })
    for (const [index, id] of [f.event.id, review.id].entries()) {
      const after = (await f.read(`/api/roster/events/${id}`)).body
      expect(after.event).toMatchObject({ id, recordId: f.record.id, revision: 2, year: 2022, batchSeq: 1 })
      expect(after.record).toEqual(before[index]!.body.record)
      expect(after.evidence).toEqual(before[index]!.body.evidence)
      expect(after.files).toEqual(before[index]!.body.files)
      const audit = (await f.read(`/api/roster/events/${id}/audit`)).body
      expect(audit).toMatchObject({ total: 1, rows: [{ before: before[index]!.body.event, after: after.event, basis: request.basis }] })
    }
    const changeReview = async (key: string, revision: number, patch: Record<string, unknown>) => {
      const next = f.request(key)
      next.operations = [{ eventId: review.id, recordId: f.record.id, enterpriseId: f.enterprise.id, expectedRevision: revision, patch }]
      const preflight = await f.post('preflight', next)
      expect(preflight.status).toBe(200)
      expect((await f.post('commit', { request: next, planHash: preflight.body.planHash })).status).toBe(200)
    }
    const wrongYear = f.request('origin-after-conclusion')
    wrongYear.operations = [{ eventId: review.id, recordId: f.record.id, enterpriseId: f.enterprise.id, expectedRevision: 2, patch: { year: 2026, decidedYear: 2025 } }]
    expect((await f.post('preflight', wrongYear)).body).toMatchObject({ error: { code: 'invalid_event_combination' } })
    expect((await f.read(`/api/roster/events/${review.id}`)).body.event).toMatchObject({ year: 2022, decidedYear: 2025, revision: 2 })
    expect(candidate().group).toBe('eligible')
    await changeReview('missing-outcome', 2, { reviewOutcome: null })
    expect(candidate().group).toBe('excluded')
    await changeReview('failed-outcome', 3, { reviewOutcome: 'failed' })
    expect(candidate().group).toBe('excluded')
    await changeReview('missing-conclusion-year', 4, { reviewOutcome: 'passed', decidedYear: null })
    expect(candidate().group).toBe('excluded')
    expect(counts()).toEqual(countsBefore)
    expect((await f.read(`/api/roster/events/${control.id}`)).body).toEqual(before[2]!.body)
  } finally { await f.close() }
})

it('rejects unauthorized, malformed, non-whitelist and inconsistent corrections without changing the event', async () => {
  const f = await fixture()
  try {
    const before = (await f.read()).body
    expect((await f.post('preflight', f.request(), null)).status).toBe(401)
    expect((await f.post('preflight', '{"basis":')).body).toEqual({ error: { code: 'invalid_request', message: 'Malformed JSON request body' } })
    for (const patch of [{ sourceFile: 'bad.pdf' }, { recordId: 44 }, { eventType: 'maintain' }, { year: '2022' }, {}, { year: 1899 }, { batchSeq: 0 }, { year: 2021 }]) {
      const result = await f.post('preflight', f.request('bad', patch))
      expect([400, 422]).toContain(result.status)
    }
    for (const patch of [{ reviewOutcome: 'failed' }, { year: 2024, decidedYear: 2023 }]) {
      expect((await f.post('preflight', f.request('combination', patch))).body).toMatchObject({ error: { code: 'invalid_event_combination' } })
    }
    const missingBasis = f.request(); missingBasis.basis = '  '
    expect((await f.post('preflight', missingBasis)).status).toBe(400)
    const ownership = f.request(); ownership.operations[0]!.enterpriseId += 99
    expect((await f.post('preflight', ownership)).body).toMatchObject({ error: { code: 'target_mismatch' } })
    const missing = f.request(); missing.operations[0]!.eventId += 999
    expect((await f.post('preflight', missing)).status).toBe(404)
    const duplicate = f.request(); duplicate.operations.push(duplicate.operations[0]!)
    expect((await f.post('preflight', duplicate)).body).toMatchObject({ error: { code: 'duplicate_target' } })
    expect((await f.read()).body).toEqual(before)
    expect((await f.read(`/api/roster/events/${f.event.id}/audit`)).body).toMatchObject({ total: 0, rows: [] })
  } finally { await f.close() }
})

it('allows review unknown/null transitions and recomputes termination without replacing official evidence', async () => {
  const f = await fixture()
  try {
    const request = f.request('review', { eventType: 'review', year: 2021, decidedYear: 2024, reviewOutcome: 'failed', batchSeq: null })
    const pre = await f.post('preflight', request)
    expect(pre.status).toBe(200)
    expect((await f.post('commit', { request, planHash: pre.body.planHash })).status).toBe(200)
    expect((await f.read()).body).toMatchObject({ event: { eventType: 'review', year: 2021, decidedYear: 2024, reviewOutcome: 'failed', batchSeq: null }, evidence: [f.evidence], lifecycle: { firstRecognitionYear: null, dueYear: null } })
    const next = f.request('unknown', { year: null, decidedYear: null, reviewOutcome: null }); next.operations[0]!.expectedRevision = 2
    const plan = await f.post('preflight', next)
    expect((await f.post('commit', { request: next, planHash: plan.body.planHash })).status).toBe(200)
    expect((await f.read()).body.event).toMatchObject({ revision: 3, year: null, decidedYear: null, reviewOutcome: null })
    expect((await f.read(`/api/roster/events/${f.event.id}/audit?page=2&pageSize=1`)).body).toMatchObject({ total: 2, rows: [{ before: { revision: 2 }, after: { revision: 3 } }] })
    expect((await f.read(`/api/roster/events/${f.event.id}/audit?page=3&pageSize=1`)).body.rows).toEqual([])
    expect((await f.read(`/api/roster/events/${f.event.id}/audit?pageSize=101`)).status).toBe(400)
  } finally { await f.close() }
})

it('rejects natural-key collisions including two targets converging in the same batch', async () => {
  const f = await fixture()
  try {
    const other = f.db.insert(schema.recordEvent).values({ recordId: f.record.id, eventType: 'award', year: 2023, decidedYear: 2023, batchSeq: 1 }).returning().get()
    f.db.insert(schema.recordEvidence).values({ recordEventId: other.id, sourceFile: 'synthetic/other.pdf' }).run()
    expect((await f.post('preflight', f.request('collision', { year: 2023, decidedYear: 2024 }))).body).toMatchObject({ error: { code: 'natural_key_conflict' } })
    const request = f.request('converging'); request.operations.push({ ...request.operations[0]!, eventId: other.id })
    expect((await f.post('preflight', request)).body).toMatchObject({ error: { code: 'natural_key_conflict' } })
    expect((await f.read()).body.event).toMatchObject({ year: 2021, revision: 1 })
  } finally { await f.close() }
})

it('binds source snapshots and rejects evidence drift, stale concurrent plans and changed idempotent requests', async () => {
  const f = await fixture(), external = new Database(f.dbPath)
  try {
    const request = f.request(), first = await f.post('preflight', request)
    external.prepare('UPDATE record_evidence SET page = 4 WHERE id = ?').run(f.evidence.id)
    expect((await f.post('commit', { request, planHash: first.body.planHash })).body).toMatchObject({ error: { code: 'plan_mismatch' } })
    external.prepare('UPDATE record_evidence SET page = 2 WHERE id = ?').run(f.evidence.id)
    external.prepare('UPDATE stored_file SET sha256 = ? WHERE rel_path = ?').run('changed-source-sha', 'synthetic/notice.pdf')
    expect((await f.post('commit', { request, planHash: first.body.planHash })).body).toMatchObject({ error: { code: 'plan_mismatch' } })
    external.prepare('UPDATE stored_file SET sha256 = ? WHERE rel_path = ?').run('synthetic-sha', 'synthetic/notice.pdf')
    const concurrent = f.request('other-writer', { year: 2023, decidedYear: 2023 }), second = await f.post('preflight', concurrent)
    expect((await f.post('commit', { request: concurrent, planHash: second.body.planHash })).status).toBe(200)
    expect((await f.post('commit', { request, planHash: first.body.planHash })).body).toMatchObject({ error: { code: 'stale_revision' } })
    const changed = structuredClone(concurrent); changed.basis = 'different request'
    expect((await f.post('preflight', changed)).body).toMatchObject({ error: { code: 'idempotency_conflict' } })
    expect((await f.read()).body.event).toMatchObject({ year: 2023, revision: 2 })
  } finally { external.close(); await f.close() }
})

it('rolls back the first update, revisions, audit and receipt if a later update fails, then recovers the same key', async () => {
  const f = await fixture(), external = new Database(f.dbPath)
  try {
    const other = f.db.insert(schema.recordEvent).values({ recordId: f.record.id, eventType: 'review', year: 2021, decidedYear: 2024, reviewOutcome: 'passed' }).returning().get()
    f.db.insert(schema.recordEvidence).values({ recordEventId: other.id, sourceFile: 'synthetic/review.pdf' }).run()
    const request = f.request(); request.operations.push({ ...request.operations[0]!, eventId: other.id, patch: { decidedYear: 2025 } })
    const plan = await f.post('preflight', request)
    external.exec(`CREATE TRIGGER fail_second_event BEFORE UPDATE ON record_event WHEN OLD.id = ${other.id} BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`)
    expect((await f.post('commit', { request, planHash: plan.body.planHash })).body).toMatchObject({ error: { code: 'transaction_failed' } })
    expect((await f.read()).body.event).toMatchObject({ year: 2021, revision: 1 })
    expect((await f.read(`/api/roster/events/${f.event.id}/audit`)).body.total).toBe(0)
    expect((await f.post('preflight', request)).body.batchStatus).toBe('preflight')
    external.exec('DROP TRIGGER fail_second_event')
    expect((await f.post('commit', { request, planHash: plan.body.planHash })).body).toMatchObject({ eventIds: [f.event.id, other.id] })
    expect((await f.read()).body.event.revision).toBe(2)
  } finally { external.close(); await f.close() }
})

it('marks direct and predecessor confirmations stale after correction and after restoring original values until explicit reconfirmation', async () => {
  const f = await fixture()
  try {
    const native = submitNativePlatformQuery(f.db, { interface: 'business_list', queryKey: 'synthetic', rdjb: '2', titleCode: 'specialized_sme', queriedAt: '2026-10-19', status: 'success', rawResponse: 'Explicit synthetic correspondence source', relations: [{ sequenceNo: 1, enterpriseId: f.enterprise.id, verificationStatus: 'confirmed', declareKind: 'apply', appliedAt: '2026-01-01' }] })
    const relation = { id: native.relationIds[0]! }
    const create = { idempotencyKey: 'correspondence', sourceIdentity: 'synthetic:relation', actor: { type: 'agent', id: 'test' }, basis: 'Explicit row context', ruleId: 'manual', ruleVersion: '1', operations: [
      { action: 'create', status: 'confirmed', edge: { type: 'event_process', eventId: f.event.id, relationId: relation.id, role: 'context_only' } },
      { action: 'create', status: 'confirmed', edge: { type: 'later_process', enterpriseId: f.enterprise.id, titleCode: 'specialized_sme', predecessorEventId: f.event.id, relationId: relation.id, role: 'followup_apply' } },
    ] }
    const pre = await f.rawPost('/api/roster/correspondences/preflight', create)
    expect(pre.status).toBe(200)
    const confirmed = await f.rawPost('/api/roster/correspondences/commit', { request: create, planHash: pre.body.planHash })
    const ids = confirmed.body.correspondenceIds as number[]
    // Seed exactly the pre-0016 fingerprint format (no event revision) as historical data.
    for (const id of ids) {
      const stored = f.db.$client.prepare('SELECT provenance FROM record_correspondence WHERE id = ?').get(id) as { provenance: string }
      const provenance = JSON.parse(stored.provenance)
      delete provenance.comparisonProofIds
      if (provenance.event) delete provenance.event.revision
      if (provenance.predecessor) delete provenance.predecessor.event.revision
      const legacyHash = createHash('sha256').update(JSON.stringify(provenance)).digest('hex')
      f.db.$client.prepare('UPDATE record_correspondence SET source_fingerprint = ? WHERE id = ?').run(legacyHash, id)
      expect((await f.read(`/api/roster/correspondences/${id}`)).body.requiresRevalidation).toBe(false)
    }
    const edit = f.request(), plan = await f.post('preflight', edit)
    expect(plan.body.impact.requiresRevalidation).toBe(2)
    expect((await f.post('commit', { request: edit, planHash: plan.body.planHash })).status).toBe(200)
    for (const id of ids) expect((await f.read(`/api/roster/correspondences/${id}`)).body).toMatchObject({ status: 'confirmed', requiresRevalidation: true })
    const undo = f.request('restore-values', { year: 2021, decidedYear: 2021 }); undo.operations[0]!.expectedRevision = 2
    const undoPlan = await f.post('preflight', undo)
    expect((await f.post('commit', { request: undo, planHash: undoPlan.body.planHash })).status).toBe(200)
    for (const id of ids) expect((await f.read(`/api/roster/correspondences/${id}`)).body.requiresRevalidation).toBe(true)
    const reconfirm = { ...create, idempotencyKey: 'reconfirm', operations: [{ action: 'correct', correspondenceId: ids[0], expectedRevision: 2, edge: create.operations[0]!.edge }] }
    const re = await f.rawPost('/api/roster/correspondences/preflight', reconfirm)
    expect(re.status).toBe(200)
    expect((await f.rawPost('/api/roster/correspondences/commit', { request: reconfirm, planHash: re.body.planHash })).status).toBe(200)
    expect((await f.read(`/api/roster/correspondences/${ids[0]}`)).body).toMatchObject({ requiresRevalidation: false, revision: 4 })
    expect((await f.read(`/api/roster/correspondences/${ids[1]}`)).body.requiresRevalidation).toBe(true)
  } finally { await f.close() }
})

it.each([
  { id: 'verified-batch', batchSeq: 1, initial: { state: 'active', needsReview: false, dueYear: 2027 }, failed: { state: 'terminated', needsReview: false, dueYear: null }, group: 'eligible', failedGroup: 'excluded' },
  { id: 'unknown-batch', batchSeq: null, initial: { state: 'none', needsReview: true, dueYear: null }, failed: { state: 'none', needsReview: true, dueYear: null }, group: 'eligible', failedGroup: 'excluded' },
])('corrects the same review passed to failed and back in place with $id', async ({ batchSeq, initial, failed, group, failedGroup }) => {
  const f = await fixture()
  try {
    // A source-scoped batch is explicit fixture evidence, never inferred from
    // the award. The null control preserves the original legacy review shape.
    const review = f.db.insert(schema.recordEvent).values({ recordId: f.record.id, eventType: 'review', year: 2021, decidedYear: 2024, batchSeq, reviewOutcome: 'passed' }).returning().get()
    f.db.insert(schema.recordEvidence).values({ recordEventId: review.id, sourceFile: 'synthetic/review.pdf' }).run()
    const before = (await f.read(`/api/roster/events/${review.id}`)).body
    const awardBefore = (await f.read()).body
    const candidate = () => readCurrentCandidate(f.db.$client, f.enterprise.id, 'specialized_sme', 2026)
    expect(before).toMatchObject({ event: { id: review.id, batchSeq, revision: 1, reviewOutcome: 'passed' }, lifecycle: { firstRecognitionYear: 2021, ...initial } })
    expect(candidate().group).toBe(group)
    const request = f.request('review-failed', { reviewOutcome: 'failed' }); request.operations[0]!.eventId = review.id
    const pre = await f.post('preflight', request)
    expect(pre.status).toBe(200)
    expect((await f.read(`/api/roster/events/${review.id}`)).body).toEqual(before)
    const receipt = await f.post('commit', { request, planHash: pre.body.planHash })
    expect(receipt.status).toBe(200)
    expect(receipt.body.eventIds).toEqual([review.id])
    expect((await f.post('commit', { request, planHash: pre.body.planHash })).body).toEqual(receipt.body)
    const afterFailure = (await f.read(`/api/roster/events/${review.id}`)).body
    expect(afterFailure).toMatchObject({ event: { id: review.id, recordId: f.record.id, year: 2021, decidedYear: 2024, batchSeq, reviewOutcome: 'failed', revision: 2 }, lifecycle: { firstRecognitionYear: 2021, ...failed } })
    expect(afterFailure.evidence).toEqual(before.evidence)
    expect(afterFailure.files).toEqual(before.files)
    expect(candidate().group).toBe(failedGroup)
    const recover = f.request('review-reconfirmed', { reviewOutcome: 'passed' }); recover.operations[0]!.eventId = review.id; recover.operations[0]!.expectedRevision = 2
    const next = await f.post('preflight', recover)
    expect(next.status).toBe(200)
    const restored = await f.post('commit', { request: recover, planHash: next.body.planHash })
    expect(restored.status).toBe(200)
    expect((await f.post('commit', { request: recover, planHash: next.body.planHash })).body).toEqual(restored.body)
    const after = (await f.read(`/api/roster/events/${review.id}`)).body
    expect(after).toMatchObject({ event: { id: review.id, recordId: f.record.id, year: 2021, decidedYear: 2024, batchSeq, reviewOutcome: 'passed', revision: 3 }, lifecycle: { firstRecognitionYear: 2021, ...initial } })
    expect(after.evidence).toEqual(before.evidence)
    expect(after.files).toEqual(before.files)
    expect(candidate().group).toBe(group)
    const awardAfter = (await f.read()).body
    expect(awardAfter.event).toEqual(awardBefore.event)
    expect(awardAfter.evidence).toEqual(awardBefore.evidence)
    expect((await f.read(`/api/roster/events/${review.id}/audit`)).body).toMatchObject({ total: 2, rows: [
      { before: { id: review.id, revision: 1, reviewOutcome: 'passed' }, after: { id: review.id, revision: 2, reviewOutcome: 'failed' }, evidence: before.evidence },
      { before: { id: review.id, revision: 2, reviewOutcome: 'failed' }, after: { id: review.id, revision: 3, reviewOutcome: 'passed' }, evidence: before.evidence },
    ] })
    expect(f.db.$client.prepare('SELECT id FROM record_event ORDER BY id').all()).toEqual([{ id: f.event.id }, { id: review.id }])
  } finally { await f.close() }
})

it('retains failed review history while a later passed review or new award supplies a current cycle', async () => {
  const f = await fixture(2020)
  try {
    const failed = f.db.insert(schema.recordEvent).values({ recordId: f.record.id, eventType: 'review', year: 2020, decidedYear: 2023, batchSeq: 1, reviewOutcome: 'failed' }).returning().get()
    f.db.insert(schema.recordEvidence).values({ recordEventId: failed.id, sourceFile: 'synthetic/failed-review.pdf', page: 1 }).run()
    const failureBefore = (await f.read(`/api/roster/events/${failed.id}`)).body
    const candidate = () => readCurrentCandidate(f.db.$client, f.enterprise.id, 'specialized_sme', 2026)
    expect(failureBefore.lifecycle).toMatchObject({ firstRecognitionYear: 2020, state: 'terminated', needsReview: false, dueYear: null })
    expect(candidate().group).toBe('excluded')
    const passed = f.db.insert(schema.recordEvent).values({ recordId: f.record.id, eventType: 'review', year: 2020, decidedYear: 2024, batchSeq: 1, reviewOutcome: 'passed' }).returning().get()
    f.db.insert(schema.recordEvidence).values({ recordEventId: passed.id, sourceFile: 'synthetic/later-passed-review.pdf', page: 1 }).run()
    expect((await f.read()).body.lifecycle).toMatchObject({ firstRecognitionYear: 2020, state: 'none', needsReview: true, dueYear: null })
    expect(candidate().group).toBe('eligible')
    const retainedFailure = (await f.read(`/api/roster/events/${failed.id}`)).body
    expect(retainedFailure.event).toEqual(failureBefore.event)
    expect(retainedFailure.evidence).toEqual(failureBefore.evidence)
    expect((await f.read(`/api/roster/events/${passed.id}`)).body.event).toMatchObject({ id: passed.id, year: 2020, decidedYear: 2024, reviewOutcome: 'passed', revision: 1 })
    const reaward = f.db.insert(schema.recordEvent).values({ recordId: f.record.id, eventType: 'award', year: 2025, decidedYear: 2025, batchSeq: 1 }).returning().get()
    f.db.insert(schema.recordEvidence).values({ recordEventId: reaward.id, sourceFile: 'synthetic/new-award.pdf', page: 1 }).run()
    expect((await f.read()).body.lifecycle).toMatchObject({ firstRecognitionYear: 2020, firstRecognitionEventId: f.event.id, state: 'active', needsReview: false, anchorYear: 2025, dueYear: 2028 })
    expect(candidate().group).toBe('eligible')
    const failureAfter = (await f.read(`/api/roster/events/${failed.id}`)).body
    expect(failureAfter.event).toEqual(failureBefore.event)
    expect(failureAfter.evidence).toEqual(failureBefore.evidence)
    expect(failureAfter.files).toEqual(failureBefore.files)
    expect((await f.read(`/api/roster/events/${failed.id}/audit`)).body).toMatchObject({ total: 0, rows: [] })
    expect(f.db.$client.prepare('SELECT id FROM record_event ORDER BY id').all()).toEqual([{ id: f.event.id }, { id: failed.id }, { id: passed.id }, { id: reaward.id }])
  } finally { await f.close() }
})

it('rejects missing official evidence and platform-maintenance targets without changing unrelated rows', async () => {
  const f = await fixture()
  try {
    const bare = f.db.insert(schema.recordEvent).values({ recordId: f.record.id, eventType: 'award', year: 2020 }).returning().get()
    const request = f.request(); request.operations[0]!.eventId = bare.id
    expect((await f.post('preflight', request)).body).toMatchObject({ error: { code: 'basis_required' } })
    const platform = f.db.insert(schema.record).values({ enterpriseId: f.enterprise.id, titleCode: 'specialized_sme', source: 'miit' }).returning().get()
    const event = f.db.insert(schema.recordEvent).values({ recordId: platform.id, eventType: 'maintain', year: 2026 }).returning().get()
    request.operations[0]!.eventId = event.id; request.operations[0]!.recordId = platform.id
    expect((await f.post('preflight', request)).status).toBe(404)
    expect((await f.read()).body).toMatchObject({ evidence: [f.evidence], event: { id: f.event.id, year: 2021, revision: 1 } })
  } finally { await f.close() }
})

it('keeps exact reads and audit pages fixed when unrelated raw evidence and event histories grow', async () => {
  const f = await fixture()
  try {
    const request = f.request(), pre = await f.post('preflight', request)
    await f.post('commit', { request, planHash: pre.body.planHash })
    const before = await f.read(), auditBefore = await f.read(`/api/roster/events/${f.event.id}/audit?pageSize=1`)
    const other = f.db.insert(schema.enterprise).values({ name: '无关合成企业', nameNorm: '无关合成企业' }).returning().get()
    const record = f.db.insert(schema.record).values({ enterpriseId: other.id, source: 'jxj', titleCode: 'specialized_sme' }).returning().get()
    f.db.transaction(tx => {
      for (let i = 0; i < 2000; i++) tx.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2000 + i % 25, batchSeq: i + 1 }).run()
      for (let i = 0; i < 100; i++) submitNativePlatformQuery(tx, { interface: 'business_list', queryKey: `unrelated-${i}`, rdjb: '2', queriedAt: '2026-10-19', status: 'success', rawResponse: 'UNRELATED-RAW'.repeat(5000) })
    })
    const samples: number[] = []
    for (let i = 0; i < 5; i++) {
      const start = performance.now(); const after = await f.read(); samples.push(performance.now() - start)
      expect(after.body).toEqual(before.body)
      expect((await f.read(`/api/roster/events/${f.event.id}/audit?pageSize=1`)).body).toEqual(auditBefore.body)
      expect(Buffer.byteLength(JSON.stringify(after.body))).toBeLessThan(4096)
    }
    console.log(JSON.stringify({ ticket: 100, sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), unrelatedEvents: 2000, unrelatedRawBytes: 100 * 13 * 5000, exactReadMs: samples, samples: 5, responseBytes: Buffer.byteLength(JSON.stringify(before.body)), limitation: 'boundedness fixture only; no tail/capacity claim' }))
  } finally { await f.close() }
})

it('accepts the 300-target bound and rejects an extra target before any event change', async () => {
  const f = await fixture()
  try {
    const request = f.request('bounded-300')
    f.db.transaction(tx => {
      for (let i = 1; i < 300; i++) {
        const event = tx.insert(schema.recordEvent).values({ recordId: f.record.id, eventType: 'award', year: 2021, decidedYear: 2021, batchSeq: i + 1 }).returning().get()
        tx.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: 'synthetic/notice.pdf', listNo: i + 1 }).run()
        request.operations.push({ ...request.operations[0]!, eventId: event.id })
      }
    })
    const accepted = await f.post('preflight', request)
    expect(accepted.status).toBe(200)
    expect(accepted.body).toMatchObject({ impact: { corrected: 300 } })
    expect(accepted.body.targets).toHaveLength(300)
    request.operations.push(request.operations[0]!)
    expect((await f.post('preflight', request)).status).toBe(400)
    expect((await f.read()).body.event).toMatchObject({ year: 2021, revision: 1 })
    expect((await f.read(`/api/roster/events/${f.event.id}/audit`)).body.total).toBe(0)
  } finally { await f.close() }
})
