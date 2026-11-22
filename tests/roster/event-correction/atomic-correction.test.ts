import { commitPostgresCorrespondences, preflightPostgresCorrespondences } from '../../../layers/sme-roster/server/utils/record-correspondence-write-postgres'
import { listPostgresCorrespondences } from '../../../layers/sme-roster/server/utils/record-correspondence-postgres'
import type { CorrespondenceRequest } from '../../../layers/sme-roster/server/utils/record-correspondence-model'
import { singlePostgresFixtureRow, useIsolatedPostgresCases } from '../../support/isolated-postgres-cases'
import { seedPostgresPlatformQuery } from '../../platform/fixtures/postgres-query'
import { failEventUpdate } from './fixtures/postgres'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, createRouter, defineEventHandler, toNodeListener } from 'h3'
import { expect, it, vi } from 'vitest'
import { enterprise as enterprises } from '../../../db/postgresql/enterprise-tables'
import { record, recordEvent, recordEvidence } from '../../../db/postgresql/ledger-tables'
import { storedFile } from '../../../db/postgresql/file-tables'
import { readPostgresCurrentDetailBatch } from '../../../layers/sme-roster/lib/roster/current-qualification-postgres'
import type { CurrentTitle } from '../../../layers/sme-roster/lib/roster/current-qualification'

const schema = { enterprise: enterprises, record, recordEvent, recordEvidence, storedFile }
const createDatabase = useIsolatedPostgresCases()
const asOf = Date.parse('2026-10-19T04:00:00Z')

async function currentCandidate(f: Awaited<ReturnType<typeof fixture>>, title: CurrentTitle) {
  const id = f.enterprise.id
  const rows = (await f.db.transaction(tx => readPostgresCurrentDetailBatch(tx, [id], title, asOf), { isolationLevel: 'repeatable read' })).get(id)!.rows
  return rows.find(row => row.assessment?.titleCode === title)!
}

async function fixture(awardYear = 2021, titleCode = 'specialized_sme') {
  const db = createDatabase()
  const enterprise = singlePostgresFixtureRow(await db.insert(schema.enterprise).values({ name: '合成事件企业', nameNorm: '合成事件企业' }).returning())
  const record = singlePostgresFixtureRow(await db.insert(schema.record).values({ enterpriseId: enterprise.id, titleCode, source: 'jxj', nameRaw: enterprise.name }).returning())
  const event = singlePostgresFixtureRow(await db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: awardYear, decidedYear: awardYear, batchSeq: 1, sortKey: awardYear }).returning())
  await db.insert(schema.storedFile).values({ relPath: 'synthetic/notice.pdf', filename: 'notice.pdf', ext: 'pdf', bytes: 123n, sha256: 'synthetic-sha', createdAt: '2026-10-19' })
  const evidence = singlePostgresFixtureRow(await db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: 'synthetic/notice.pdf', attachment: '附件一', listNo: 7, page: 2 }).returning())
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  vi.stubGlobal('useRuntimeConfig', () => ({ apiToken: 'test-api' }))
  const { eventCorrectionRoute } = await import('../../../layers/sme-roster/server/utils/roster-event-correction-route')
  const app = createApp(), router = createRouter()
  router.use('/api/roster/events/corrections/preflight', eventCorrectionRoute('preflight'))
  router.use('/api/roster/events/corrections/commit', eventCorrectionRoute('commit'))
  router.use('/api/roster/events/:id/audit', eventCorrectionRoute('audit'))
  router.use('/api/roster/events/:id', eventCorrectionRoute('get'))
  app.use(router)
  const listener = createServer(toNodeListener(app))
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`
  const rawPost = async (path: string, body: unknown) => { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test-api' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() } }
  const request = (key = 'correct-1', patch: Record<string, unknown> = { year: 2022, decidedYear: 2022 }) => ({ idempotencyKey: key, sourceIdentity: 'synthetic:notice-review', actor: { type: 'agent', id: 'test' }, basis: 'Verified original announcement row', operations: [{ eventId: event.id, recordId: record.id, enterpriseId: enterprise.id, expectedRevision: 1, patch }] })
  const read = async (path = `/api/roster/events/${event.id}`) => { const r = await fetch(base + path); return { status: r.status, body: await r.json(), headers: r.headers } }
  const post = async (action: string, body: unknown, token: string | null = 'test-api') => { const r = await fetch(base + '/api/roster/events/corrections/' + action, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: typeof body === 'string' ? body : JSON.stringify(body) }); return { status: r.status, body: await r.json(), headers: r.headers } }
  return { db, event, evidence, record, enterprise, request, read, post, rawPost, close: async () => { await new Promise<void>(resolve => listener.close(() => resolve())) } }
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
    const { rows: [stored] } = await f.db.$client.query<{ summary: string }>(
      'SELECT summary FROM import_batch WHERE id = $1', [receipt.body.batchId],
    )
    const legacyReceipt = JSON.parse(stored!.summary)
    legacyReceipt.impact.requiresRevalidation = 2
    await f.db.$client.query('UPDATE import_batch SET summary = $1 WHERE id = $2',
      [JSON.stringify(legacyReceipt), receipt.body.batchId])
    expect((await f.post('commit', { request, planHash: plan.body.planHash })).body).toEqual({
      ...receipt.body, impact: { corrected: 1, requiresRevalidation: 2 },
    })
    expect((await f.read()).body).toMatchObject({ event: { id: f.event.id, recordId: f.record.id, revision: 2, year: 2022, decidedYear: 2022, sortKey: 2022 }, record: { id: f.record.id, enterpriseId: f.enterprise.id }, evidence: [f.evidence], lifecycle: { firstRecognitionYear: 2022, dueYear: 2025 } })
    expect((await f.read(`/api/roster/events/${f.event.id}/audit?pageSize=1`)).body).toMatchObject({ total: 1, rows: [{ before: { year: 2021 }, after: { year: 2022 }, actorId: 'test', basis: request.basis, sourceIdentity: request.sourceIdentity, evidence: [f.evidence] }] })
  } finally { await f.close() }
})

it('corrects review origin and conclusion independently without guessing its batch or changing another title', async () => {
  const f = await fixture(2022)
  try {
    // Synthetic legacy import: publication year was placed in the origin field.
    const review = singlePostgresFixtureRow(await f.db.insert(schema.recordEvent).values({ recordId: f.record.id, eventType: 'review', year: 2025 }).returning())
    await f.db.insert(schema.recordEvidence).values({ recordEventId: review.id, sourceFile: 'synthetic/notice.pdf', attachment: '附件2', listNo: 9, page: 17 })
    const other = singlePostgresFixtureRow(await f.db.insert(schema.record).values({ enterpriseId: f.enterprise.id, titleCode: 'innovative_sme', source: 'jxj', nameRaw: f.enterprise.name }).returning())
    const otherAward = singlePostgresFixtureRow(await f.db.insert(schema.recordEvent).values({ recordId: other.id, eventType: 'award', year: 2023, batchSeq: 1 }).returning())
    const otherReview = singlePostgresFixtureRow(await f.db.insert(schema.recordEvent).values({ recordId: other.id, eventType: 'review', year: 2023, decidedYear: 2026, batchSeq: 1, reviewOutcome: 'failed' }).returning())
    for (const event of [otherAward, otherReview]) await f.db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: 'synthetic/notice.pdf', page: 2 })
    const before = (await f.read(`/api/roster/events/${review.id}`)).body
    const otherBefore = (await f.read(`/api/roster/events/${otherReview.id}`)).body
    const candidate = () => currentCandidate(f, 'specialized_sme')
    expect((await candidate()).group).toBe('excluded')
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
    expect(await candidate()).toMatchObject({ group: 'eligible', firstYear: 2022, basis: `event:${f.event.id}@1 award 2022/1 结论年:2022\nevent:${review.id}@2 review 2022/ 结论年:2025` })
    // Recording the original batch improves diagnostics; the recorded passed period already permits eligibility.
    const verified = await correct('review-batch-verified', 2, { batchSeq: 1 })
    expect(verified).toMatchObject({ event: { id: review.id, recordId: f.record.id, year: 2022, decidedYear: 2025, batchSeq: 1, reviewOutcome: 'passed', revision: 3 }, lifecycle: { firstRecognitionYear: 2022, firstRecognitionEventId: f.event.id, state: 'active', needsReview: false, anchorYear: 2025, dueYear: 2028 } })
    expect(verified.evidence).toEqual(before.evidence)
    expect(verified.files).toEqual(before.files)
    expect((await candidate()).group).toBe('eligible')
    const unknown = await correct('review-outcome-unknown', 3, { reviewOutcome: null })
    expect(unknown.lifecycle).toMatchObject({ firstRecognitionYear: 2022, state: 'none', needsReview: true, dueYear: null })
    expect((await candidate()).group).toBe('excluded')
    const failed = await correct('review-explicit-failure', 4, { reviewOutcome: 'failed' })
    expect(failed.lifecycle).toMatchObject({ firstRecognitionYear: 2022, state: 'terminated', needsReview: false, dueYear: null })
    expect((await candidate()).group).toBe('excluded')
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
    await f.db.$client.query('UPDATE record_event SET batch_seq = null WHERE id = $1', [f.event.id])
    const review = singlePostgresFixtureRow(await f.db.insert(schema.recordEvent).values({ recordId: f.record.id, eventType: 'review', year: 2025 }).returning())
    await f.db.insert(schema.recordEvidence).values({ recordEventId: review.id, sourceFile: 'synthetic/notice.pdf', attachment: '附件2', listNo: 139, page: 17 })
    const controlRecord = singlePostgresFixtureRow(await f.db.insert(schema.record).values({ enterpriseId: f.enterprise.id, titleCode: 'specialized_sme', source: 'jxj' }).returning())
    const control = singlePostgresFixtureRow(await f.db.insert(schema.recordEvent).values({ recordId: controlRecord.id, eventType: 'review', year: 2023, decidedYear: 2026, batchSeq: 1, reviewOutcome: 'failed' }).returning())
    const before = await Promise.all([f.read(), f.read(`/api/roster/events/${review.id}`), f.read(`/api/roster/events/${control.id}`)])
    const counts = () => Promise.all(['enterprise', 'record', 'record_event', 'record_evidence'].map(async table => (await f.db.$client.query(`SELECT count(*) AS n FROM ${table}`)).rows[0]))
    const countsBefore = await counts()
    const candidate = () => currentCandidate(f, 'innovative_sme')
    expect((await candidate()).group).toBe('excluded')
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
    expect(await candidate()).toMatchObject({ group: 'eligible', firstYear: 2022 })
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
    expect((await candidate()).group).toBe('eligible')
    await changeReview('missing-outcome', 2, { reviewOutcome: null })
    expect((await candidate()).group).toBe('excluded')
    await changeReview('failed-outcome', 3, { reviewOutcome: 'failed' })
    expect((await candidate()).group).toBe('excluded')
    await changeReview('missing-conclusion-year', 4, { reviewOutcome: 'passed', decidedYear: null })
    expect((await candidate()).group).toBe('excluded')
    expect(await counts()).toEqual(countsBefore)
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
    const other = singlePostgresFixtureRow(await f.db.insert(schema.recordEvent).values({ recordId: f.record.id, eventType: 'award', year: 2023, decidedYear: 2023, batchSeq: 1 }).returning())
    await f.db.insert(schema.recordEvidence).values({ recordEventId: other.id, sourceFile: 'synthetic/other.pdf' })
    expect((await f.post('preflight', f.request('collision', { year: 2023, decidedYear: 2024 }))).body).toMatchObject({ error: { code: 'natural_key_conflict' } })
    const request = f.request('converging'); request.operations.push({ ...request.operations[0]!, eventId: other.id })
    expect((await f.post('preflight', request)).body).toMatchObject({ error: { code: 'natural_key_conflict' } })
    expect((await f.read()).body.event).toMatchObject({ year: 2021, revision: 1 })
  } finally { await f.close() }
})

it('binds source snapshots and rejects evidence drift, stale concurrent plans and changed idempotent requests', async () => {
  const f = await fixture(), external = f.db.$client
  try {
    const request = f.request(), first = await f.post('preflight', request)
    await external.query('UPDATE record_evidence SET page = 4 WHERE id = $1', [f.evidence.id])
    expect((await f.post('commit', { request, planHash: first.body.planHash })).body).toMatchObject({ error: { code: 'plan_mismatch' } })
    await external.query('UPDATE record_evidence SET page = 2 WHERE id = $1', [f.evidence.id])
    await external.query('UPDATE stored_file SET sha256 = $1 WHERE rel_path = $2', ['changed-source-sha', 'synthetic/notice.pdf'])
    expect((await f.post('commit', { request, planHash: first.body.planHash })).body).toMatchObject({ error: { code: 'plan_mismatch' } })
    await external.query('UPDATE stored_file SET sha256 = $1 WHERE rel_path = $2', ['synthetic-sha', 'synthetic/notice.pdf'])
    const concurrent = f.request('other-writer', { year: 2023, decidedYear: 2023 }), second = await f.post('preflight', concurrent)
    expect((await f.post('commit', { request: concurrent, planHash: second.body.planHash })).status).toBe(200)
    expect((await f.post('commit', { request, planHash: first.body.planHash })).body).toMatchObject({ error: { code: 'stale_revision' } })
    const changed = structuredClone(concurrent); changed.basis = 'different request'
    expect((await f.post('preflight', changed)).body).toMatchObject({ error: { code: 'idempotency_conflict' } })
    expect((await f.read()).body.event).toMatchObject({ year: 2023, revision: 2 })
  } finally { await f.close() }
})

it('rolls back the first update, revisions, audit and receipt if a later update fails, then recovers the same key', async () => {
  const f = await fixture()
  try {
    const other = singlePostgresFixtureRow(await f.db.insert(schema.recordEvent).values({ recordId: f.record.id, eventType: 'review', year: 2021, decidedYear: 2024, reviewOutcome: 'passed' }).returning())
    await f.db.insert(schema.recordEvidence).values({ recordEventId: other.id, sourceFile: 'synthetic/review.pdf' })
    const request = f.request(); request.operations.push({ ...request.operations[0]!, eventId: other.id, patch: { decidedYear: 2025 } })
    const plan = await f.post('preflight', request)
    const restore = await failEventUpdate(f.db, other.id)
    expect((await f.post('commit', { request, planHash: plan.body.planHash })).body).toMatchObject({ error: { code: 'transaction_failed' } })
    expect((await f.read()).body.event).toMatchObject({ year: 2021, revision: 1 })
    expect((await f.read(`/api/roster/events/${f.event.id}/audit`)).body.total).toBe(0)
    expect((await f.post('preflight', request)).body.batchStatus).toBe('preflight')
    await restore()
    expect((await f.post('commit', { request, planHash: plan.body.planHash })).body).toMatchObject({ eventIds: [f.event.id, other.id] })
    expect((await f.read()).body.event.revision).toBe(2)
  } finally { await f.close() }
})

it('marks direct and predecessor confirmations stale after correction and after restoring original values until explicit reconfirmation', async () => {
  const f = await fixture()
  try {
    const { relationIds } = await seedPostgresPlatformQuery(f.db, { interface: 'business_list', queryKey: 'synthetic', rdjb: '2', titleCode: 'specialized_sme', queriedAt: '2026-10-19', status: 'success', rawResponse: 'Explicit synthetic correspondence source', relations: [{ sequenceNo: 1, enterpriseId: f.enterprise.id, verificationStatus: 'confirmed', declareKind: 'apply', appliedAt: '2026-01-01' }] })
    const relation = { id: relationIds[0]! }
    const eventEdge = { type: 'event_process', eventId: f.event.id, relationId: relation.id, role: 'context_only' } as const
    const create: CorrespondenceRequest = { idempotencyKey: 'correspondence', sourceIdentity: 'synthetic:relation', actor: { type: 'agent', id: 'test' }, basis: 'Explicit row context', ruleId: 'manual', ruleVersion: '1', operations: [
      { action: 'create', status: 'confirmed', edge: eventEdge },
      { action: 'create', status: 'confirmed', edge: { type: 'later_process', enterpriseId: f.enterprise.id, titleCode: 'specialized_sme', predecessorEventId: f.event.id, relationId: relation.id, role: 'followup_apply' } },
    ] }
    const pre = await preflightPostgresCorrespondences(f.db, create)
    const confirmed = await commitPostgresCorrespondences(f.db, create, pre.planHash)
    const ids = confirmed.correspondenceIds
    const readEdge = async (id: number) => (await listPostgresCorrespondences(f.db, { id }))[0]
    const readAudit = async (id: number) => (await f.db.$client.query(
      'SELECT to_status AS "toStatus", evidence::json FROM record_correspondence_audit WHERE correspondence_id = $1 ORDER BY id', [id],
    )).rows
    const originalAudit = await readAudit(ids[0]!)
    expect(originalAudit).toMatchObject([
      { toStatus: 'candidate', evidence: { event: { id: f.event.id, year: 2021 } } },
      { toStatus: 'confirmed', evidence: { event: { id: f.event.id, year: 2021 } } },
    ])
    // Seed exactly the pre-0016 fingerprint format (no event revision) as historical data.
    for (const id of ids) {
      const snapshot = (await f.db.$client.query<{ evidence: string }>(
        'SELECT evidence FROM record_correspondence_audit WHERE correspondence_id = $1 AND to_status = $2', [id, 'confirmed'],
      )).rows[0]!
      const provenance = JSON.parse(snapshot.evidence)
      delete provenance.comparisonProofIds
      const { rawResponseSha256, collectionEvidence, createdAt, ...query } = provenance.query
      expect(rawResponseSha256).toBe(createHash('sha256').update('Explicit synthetic correspondence source').digest('hex'))
      provenance.query = { ...query, rawResponse: 'Explicit synthetic correspondence source', collectionEvidence, createdAt }
      if (provenance.event) delete provenance.event.revision
      if (provenance.predecessor) delete provenance.predecessor.event.revision
      const legacyHash = createHash('sha256').update(JSON.stringify(provenance)).digest('hex')
      await f.db.$client.query('UPDATE record_correspondence SET source_fingerprint = $1 WHERE id = $2', [legacyHash, id])
      expect(await readEdge(id)).toMatchObject({ requiresRevalidation: false })
    }
    const edit = f.request(), plan = await f.post('preflight', edit)
    expect(plan.body.impact).toEqual({ corrected: 1 })
    expect(plan.body.targets[0]).not.toHaveProperty('correspondences')
    await f.db.$client.query('UPDATE record_correspondence SET revision = revision + 1 WHERE id = $1', [ids[1]])
    expect((await f.post('commit', { request: edit, planHash: plan.body.planHash })).status).toBe(200)
    for (const id of ids) expect(await readEdge(id)).toMatchObject({ status: 'confirmed', requiresRevalidation: true })
    expect(await readAudit(ids[0]!)).toEqual(originalAudit)
    expect(await commitPostgresCorrespondences(f.db, create, pre.planHash)).toEqual(confirmed)
    const undo = f.request('restore-values', { year: 2021, decidedYear: 2021 }); undo.operations[0]!.expectedRevision = 2
    const undoPlan = await f.post('preflight', undo)
    expect((await f.post('commit', { request: undo, planHash: undoPlan.body.planHash })).status).toBe(200)
    for (const id of ids) expect(await readEdge(id)).toMatchObject({ requiresRevalidation: true })
    const reconfirm: CorrespondenceRequest = { ...create, idempotencyKey: 'reconfirm', operations: [{ action: 'correct', correspondenceId: ids[0]!, expectedRevision: 2, edge: eventEdge }] }
    const re = await preflightPostgresCorrespondences(f.db, reconfirm)
    await commitPostgresCorrespondences(f.db, reconfirm, re.planHash)
    expect(await readEdge(ids[0]!)).toMatchObject({ requiresRevalidation: false, revision: 4 })
    expect(await readEdge(ids[1]!)).toMatchObject({ requiresRevalidation: true })
    const reconfirmed = await readAudit(ids[0]!)
    expect(reconfirmed.slice(0, 2)).toEqual(originalAudit)
    expect(reconfirmed.slice(2)).toMatchObject([
      { toStatus: 'unlinked', evidence: { event: originalAudit[1].evidence.event } },
      { toStatus: 'confirmed', evidence: { event: { revision: 3 } } },
    ])
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
    const review = singlePostgresFixtureRow(await f.db.insert(schema.recordEvent).values({ recordId: f.record.id, eventType: 'review', year: 2021, decidedYear: 2024, batchSeq, reviewOutcome: 'passed' }).returning())
    await f.db.insert(schema.recordEvidence).values({ recordEventId: review.id, sourceFile: 'synthetic/review.pdf' })
    const before = (await f.read(`/api/roster/events/${review.id}`)).body
    const awardBefore = (await f.read()).body
    const candidate = () => currentCandidate(f, 'specialized_sme')
    expect(before).toMatchObject({ event: { id: review.id, batchSeq, revision: 1, reviewOutcome: 'passed' }, lifecycle: { firstRecognitionYear: 2021, ...initial } })
    expect((await candidate()).group).toBe(group)
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
    expect((await candidate()).group).toBe(failedGroup)
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
    expect((await candidate()).group).toBe(group)
    const awardAfter = (await f.read()).body
    expect(awardAfter.event).toEqual(awardBefore.event)
    expect(awardAfter.evidence).toEqual(awardBefore.evidence)
    expect((await f.read(`/api/roster/events/${review.id}/audit`)).body).toMatchObject({ total: 2, rows: [
      { before: { id: review.id, revision: 1, reviewOutcome: 'passed' }, after: { id: review.id, revision: 2, reviewOutcome: 'failed' }, evidence: before.evidence },
      { before: { id: review.id, revision: 2, reviewOutcome: 'failed' }, after: { id: review.id, revision: 3, reviewOutcome: 'passed' }, evidence: before.evidence },
    ] })
    expect((await f.db.select({ id: schema.recordEvent.id }).from(schema.recordEvent).orderBy(schema.recordEvent.id))).toEqual([{ id: f.event.id }, { id: review.id }])
  } finally { await f.close() }
})

it('retains failed review history while a later passed review or new award supplies a current cycle', async () => {
  const f = await fixture(2020)
  try {
    const failed = singlePostgresFixtureRow(await f.db.insert(schema.recordEvent).values({ recordId: f.record.id, eventType: 'review', year: 2020, decidedYear: 2023, batchSeq: 1, reviewOutcome: 'failed' }).returning())
    await f.db.insert(schema.recordEvidence).values({ recordEventId: failed.id, sourceFile: 'synthetic/failed-review.pdf', page: 1 })
    const failureBefore = (await f.read(`/api/roster/events/${failed.id}`)).body
    const candidate = () => currentCandidate(f, 'specialized_sme')
    expect(failureBefore.lifecycle).toMatchObject({ firstRecognitionYear: 2020, state: 'terminated', needsReview: false, dueYear: null })
    expect((await candidate()).group).toBe('excluded')
    const passed = singlePostgresFixtureRow(await f.db.insert(schema.recordEvent).values({ recordId: f.record.id, eventType: 'review', year: 2020, decidedYear: 2024, batchSeq: 1, reviewOutcome: 'passed' }).returning())
    await f.db.insert(schema.recordEvidence).values({ recordEventId: passed.id, sourceFile: 'synthetic/later-passed-review.pdf', page: 1 })
    expect((await f.read()).body.lifecycle).toMatchObject({ firstRecognitionYear: 2020, state: 'none', needsReview: true, dueYear: null })
    expect((await candidate()).group).toBe('eligible')
    const retainedFailure = (await f.read(`/api/roster/events/${failed.id}`)).body
    expect(retainedFailure.event).toEqual(failureBefore.event)
    expect(retainedFailure.evidence).toEqual(failureBefore.evidence)
    expect((await f.read(`/api/roster/events/${passed.id}`)).body.event).toMatchObject({ id: passed.id, year: 2020, decidedYear: 2024, reviewOutcome: 'passed', revision: 1 })
    const reaward = singlePostgresFixtureRow(await f.db.insert(schema.recordEvent).values({ recordId: f.record.id, eventType: 'award', year: 2025, decidedYear: 2025, batchSeq: 1 }).returning())
    await f.db.insert(schema.recordEvidence).values({ recordEventId: reaward.id, sourceFile: 'synthetic/new-award.pdf', page: 1 })
    expect((await f.read()).body.lifecycle).toMatchObject({ firstRecognitionYear: 2020, firstRecognitionEventId: f.event.id, state: 'active', needsReview: false, anchorYear: 2025, dueYear: 2028 })
    expect((await candidate()).group).toBe('eligible')
    const failureAfter = (await f.read(`/api/roster/events/${failed.id}`)).body
    expect(failureAfter.event).toEqual(failureBefore.event)
    expect(failureAfter.evidence).toEqual(failureBefore.evidence)
    expect(failureAfter.files).toEqual(failureBefore.files)
    expect((await f.read(`/api/roster/events/${failed.id}/audit`)).body).toMatchObject({ total: 0, rows: [] })
    expect((await f.db.select({ id: schema.recordEvent.id }).from(schema.recordEvent).orderBy(schema.recordEvent.id))).toEqual([{ id: f.event.id }, { id: failed.id }, { id: passed.id }, { id: reaward.id }])
  } finally { await f.close() }
})

it('rejects missing official evidence and platform-maintenance targets without changing unrelated rows', async () => {
  const f = await fixture()
  try {
    const bare = singlePostgresFixtureRow(await f.db.insert(schema.recordEvent).values({ recordId: f.record.id, eventType: 'award', year: 2020 }).returning())
    const request = f.request(); request.operations[0]!.eventId = bare.id
    expect((await f.post('preflight', request)).body).toMatchObject({ error: { code: 'basis_required' } })
    const platform = singlePostgresFixtureRow(await f.db.insert(schema.record).values({ enterpriseId: f.enterprise.id, titleCode: 'specialized_sme', source: 'miit' }).returning())
    const event = singlePostgresFixtureRow(await f.db.insert(schema.recordEvent).values({ recordId: platform.id, eventType: 'maintain', year: 2026 }).returning())
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
    const other = singlePostgresFixtureRow(await f.db.insert(schema.enterprise).values({ name: '无关合成企业', nameNorm: '无关合成企业' }).returning())
    const record = singlePostgresFixtureRow(await f.db.insert(schema.record).values({ enterpriseId: other.id, source: 'jxj', titleCode: 'specialized_sme' }).returning())
    await f.db.insert(schema.recordEvent).values(Array.from({ length: 2_000 }, (_, i) => ({
      recordId: record.id, eventType: 'award' as const, year: 2000 + i % 25, batchSeq: i + 1,
    })))
    for (let i = 0; i < 100; i++) {
      await seedPostgresPlatformQuery(f.db, { interface: 'business_list', queryKey: `unrelated-${i}`, rdjb: '2', queriedAt: '2026-10-19', status: 'success', rawResponse: 'UNRELATED-RAW'.repeat(5000) })
    }
    const after = await f.read()
    expect(after.body).toEqual(before.body)
    expect((await f.read(`/api/roster/events/${f.event.id}/audit?pageSize=1`)).body).toEqual(auditBefore.body)
    expect(Buffer.byteLength(JSON.stringify(after.body))).toBeLessThan(4096)
  } finally { await f.close() }
})

it('accepts the 300-target bound and rejects an extra target before any event change', async () => {
  const f = await fixture()
  try {
    const request = f.request('bounded-300')
    await f.db.transaction(async tx => {
      const events = await tx.insert(schema.recordEvent).values(Array.from({ length: 299 }, (_, i) => ({
        recordId: f.record.id, eventType: 'award' as const, year: 2021, decidedYear: 2021, batchSeq: i + 2,
      }))).returning({ id: schema.recordEvent.id, batchSeq: schema.recordEvent.batchSeq })
      await tx.insert(schema.recordEvidence).values(events.map(event => ({
        recordEventId: event.id, sourceFile: 'synthetic/notice.pdf', listNo: event.batchSeq,
      })))
      for (const event of events) request.operations.push({ ...request.operations[0]!, eventId: event.id })
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
