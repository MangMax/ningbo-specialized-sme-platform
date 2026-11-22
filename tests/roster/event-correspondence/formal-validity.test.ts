import { expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import * as schema from '../fixtures/postgres-tables'
import { useIsolatedPostgresCases, singlePostgresFixtureRow } from '../../support/isolated-postgres-cases'
import { handlePostgresEventCorrectionWrite } from '../../../layers/sme-roster/server/utils/roster-event-correction-write-postgres'
import { handlePostgresOfficialEvidenceRead } from '../../../layers/sme-roster/server/utils/official-evidence-read-postgres'
import { versionedOfficialEvent } from '../../../layers/sme-roster/server/utils/roster-event-version-model'

const createDb = useIsolatedPostgresCases()

async function fixture() {
  const db = createDb()
  const enterprise = singlePostgresFixtureRow(await db.insert(schema.enterprise).values({ name: '合成原件企业', nameNorm: '合成原件企业' }).returning())
  const record = singlePostgresFixtureRow(await db.insert(schema.record).values({ enterpriseId: enterprise.id, titleCode: 'innovative_sme', source: 'jxj' }).returning())
  const event = singlePostgresFixtureRow(await db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2023, batchSeq: 2 }).returning())
  const sha = 'a'.repeat(64)
  await db.insert(schema.storedFile).values({ relPath: 'owned/notice.pdf', filename: 'notice.pdf', ext: 'pdf', bytes: 1n, sha256: sha, createdAt: '2026-10-17T00:00:00Z' })
  const evidence = singlePostgresFixtureRow(await db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: 'owned/notice.pdf', page: 27, listNo: 907 }).returning())
  const fact = { evidenceId: evidence.id, sourceSha256: sha, statementPages: [2], interval: { validFrom: '2023-11-01', validThrough: '2026-10-31' } }
  const request = (value: unknown) => ({ idempotencyKey: 'validity', sourceIdentity: 'owned:notice', actor: { type: 'agent', id: 'test' }, basis: 'Independent expected from 2024 notice page2; business year remains2023', operations: [{ eventId: event.id, recordId: record.id, enterpriseId: enterprise.id, expectedRevision: 1, patch: { formalValidity: value } as { formalValidity?: unknown; year?: number } }] })
  const call = (action: 'preflight' | 'commit' | 'get' | 'audit', body?: unknown) => {
    const headers = { authorization: 'Bearer synthetic' }
    return action === 'preflight' || action === 'commit'
      ? handlePostgresEventCorrectionWrite(action, { method: 'POST', body, headers, apiToken: 'synthetic' })
      : handlePostgresOfficialEvidenceRead({ kind: 'event', action, method: 'GET', id: event.id, headers }, { db, apiToken: 'synthetic' })
  }
  return { db, event: { ...event, formalValidity: null }, fact, request, call }
}

it('preserves source exact interval independently of business year through correction audit and replay', async () => {
  const f = await fixture(), request = f.request(f.fact)
  expect(f.event.formalValidity).toBeNull()
  const plan = await f.call('preflight', request)
  expect(plan.status).toBe(200)
  const commit = { request, planHash: (plan.body as any).planHash }
  expect((await f.call('commit', commit)).status).toBe(200)
  expect((await f.call('get')).body).toMatchObject({ event: { year: 2023, batchSeq: 2, decidedYear: null, revision: 2, formalValidity: f.fact } })
  expect((await f.call('audit')).body).toMatchObject({ rows: [{ before: { formalValidity: null }, after: { formalValidity: f.fact } }] })
  expect((await f.call('commit', commit)).status).toBe(200)
})

it.each([
  ['impossible date', { interval: { validFrom: '2023-02-29', validThrough: '2026-10-31' } }, 400],
  ['reversed interval', { interval: { validFrom: '2026-11-01', validThrough: '2026-10-31' } }, 400],
  ['unbound source', { sourceSha256: 'b'.repeat(64) }, 422],
  ['foreign evidence', { evidenceId: 999999 }, 422],
])('rejects %s without modifying the event', async (_, override, status) => {
  const f = await fixture()
  expect((await f.call('preflight', f.request({ ...f.fact, ...override }))).status).toBe(status)
  expect((await f.call('get')).body).toMatchObject({ event: { revision: 1, formalValidity: null } })
})

it('records an explicit continuation clause without manufacturing interval dates and rejects source drift', async () => {
  const f = await fixture(), { interval, ...binding } = f.fact
  const request = f.request({ ...binding, continuation: 'until_next_review_results' })
  const plan = await f.call('preflight', request)
  expect(plan.status).toBe(200)
  await f.db.update(schema.storedFile).set({ sha256: 'b'.repeat(64) })
  expect((await f.call('commit', { request, planHash: (plan.body as any).planHash })).status).toBe(422)
  expect((await f.call('get')).body).toMatchObject({ event: { revision: 1, formalValidity: null } })
  await f.db.update(schema.storedFile).set({ sha256: f.fact.sourceSha256 })
  expect((await f.call('commit', { request, planHash: (plan.body as any).planHash })).status).toBe(200)
  expect((await f.call('get')).body).toMatchObject({ event: { formalValidity: { ...binding, continuation: 'until_next_review_results' } } })
  expect(((await f.call('get')).body as any).event.formalValidity).not.toHaveProperty('interval')
})

it('binds an explicit original award while preserving unknown batch and rejects foreign origins', async () => {
  const f = await fixture()
  const review = singlePostgresFixtureRow(await f.db.insert(schema.recordEvent).values({ recordId: f.event.recordId, eventType: 'review', year: 2023, decidedYear: 2026, reviewOutcome: 'passed' }).returning())
  const evidence = singlePostgresFixtureRow(await f.db.insert(schema.recordEvidence).values({ recordEventId: review.id, sourceFile: 'owned/notice.pdf', page: 12 }).returning())
  const request = f.request({ ...f.fact, evidenceId: evidence.id, originAwardEventId: f.event.id, continuation: 'until_next_review_results' })
  request.operations[0]!.eventId = review.id
  const plan = await f.call('preflight', request)
  expect(plan.status).toBe(200)
  expect((await f.call('commit', { request, planHash: (plan.body as any).planHash })).status).toBe(200)
  const read = singlePostgresFixtureRow(await f.db.select().from(schema.recordEvent).where(eq(schema.recordEvent.id, review.id)))
  expect(read).toMatchObject({ year: 2023, batchSeq: null, decidedYear: 2026, reviewOutcome: 'passed' })
  expect(JSON.parse(read.formalValidity!)).toMatchObject({ originAwardEventId: f.event.id })
  const invalid = f.request({ ...f.fact, originAwardEventId: review.id })
  invalid.idempotencyKey = 'foreign-origin'
  expect((await f.call('preflight', invalid)).status).toBe(422)
})

it('withdraws formal facts explicitly with audit rather than inventing replacement dates', async () => {
  const f = await fixture(), request = f.request(f.fact)
  const plan = await f.call('preflight', request)
  expect((await f.call('commit', { request, planHash: (plan.body as any).planHash })).status).toBe(200)
  const clear = f.request(null)
  clear.idempotencyKey = 'withdraw'
  clear.operations[0]!.expectedRevision = 2
  const clearPlan = await f.call('preflight', clear)
  expect(clearPlan.status).toBe(200)
  expect((await f.call('commit', { request: clear, planHash: (clearPlan.body as any).planHash })).status).toBe(200)
  expect((await f.call('get')).body).toMatchObject({ event: { revision: 3, year: 2023, formalValidity: null } })
  expect((await f.call('audit')).body).toMatchObject({ total: 2, rows: [{ after: { formalValidity: f.fact } }, { before: { formalValidity: f.fact }, after: { formalValidity: null } }] })
})

it('keeps legacy provenance bytes unchanged when nullable formal validity is added', async () => {
  const f = await fixture()
  const { formalValidity: _, revision, ...legacy } = f.event
  expect(JSON.stringify(versionedOfficialEvent(f.event))).toBe(JSON.stringify(legacy))
  const revised = { ...f.event, revision: 2 }
  expect(JSON.stringify(versionedOfficialEvent(revised))).toBe(JSON.stringify({ ...legacy, revision: 2 }))
  expect(versionedOfficialEvent({ ...revised, formalValidity: f.fact })).toEqual({ ...legacy, revision: 2, formalValidity: f.fact })
})

async function linkedReview(f: Awaited<ReturnType<typeof fixture>>) {
  const review = singlePostgresFixtureRow(await f.db.insert(schema.recordEvent).values({ recordId: f.event.recordId, eventType: 'review', year: 2023, decidedYear: 2026, reviewOutcome: 'passed' }).returning())
  const evidence = singlePostgresFixtureRow(await f.db.insert(schema.recordEvidence).values({ recordEventId: review.id, sourceFile: 'owned/notice.pdf', page: 12 }).returning())
  return { review, fact: { ...f.fact, evidenceId: evidence.id, originAwardEventId: f.event.id } }
}

it('validates simultaneous origin and review corrections against their final values', async () => {
  const f = await fixture(), { review, fact } = await linkedReview(f)
  const request = f.request(null)
  request.operations[0]!.patch = { year: 2022 }
  request.operations.push({ eventId: review.id, recordId: review.recordId, enterpriseId: request.operations[0]!.enterpriseId, expectedRevision: 1, patch: { year: 2022, formalValidity: fact } })
  const plan = await f.call('preflight', request)
  expect(plan.status).toBe(200)
  expect((await f.call('commit', { request, planHash: (plan.body as any).planHash })).status).toBe(200)
  expect((await f.db.select().from(schema.recordEvent).orderBy(schema.recordEvent.id)).filter(e => [review.id, f.event.id].includes(e.id)).map(e => e.year)).toEqual([2022, 2022])
})

it('rejects a same-batch final origin mismatch without committing either event', async () => {
  const f = await fixture(), { review, fact } = await linkedReview(f)
  const request = f.request(null)
  request.operations[0]!.patch = { year: 2022 }
  request.operations.push({ eventId: review.id, recordId: review.recordId, enterpriseId: request.operations[0]!.enterpriseId, expectedRevision: 1, patch: { formalValidity: fact } })
  expect(await f.call('preflight', request)).toMatchObject({ status: 422, body: { error: { code: 'invalid_validity_origin' } } })
  expect((await f.db.select().from(schema.recordEvent).orderBy(schema.recordEvent.id)).map(e => e.revision)).toEqual([1, 1])
})

it('protects existing reverse origin references and permits explicit withdrawal in the same batch', async () => {
  const f = await fixture(), { review, fact } = await linkedReview(f)
  const attach = f.request(null)
  attach.operations[0] = { eventId: review.id, recordId: review.recordId, enterpriseId: attach.operations[0]!.enterpriseId, expectedRevision: 1, patch: { formalValidity: fact } }
  const attachPlan = await f.call('preflight', attach)
  expect(attachPlan.status).toBe(200)
  expect((await f.call('commit', { request: attach, planHash: (attachPlan.body as any).planHash })).status).toBe(200)
  const change = f.request(null)
  change.idempotencyKey = 'origin-change'
  change.operations[0]!.patch = { year: 2022 }
  expect(await f.call('preflight', change)).toMatchObject({ status: 422, body: { error: { code: 'invalid_validity_origin' } } })
  change.operations.push({ eventId: review.id, recordId: review.recordId, enterpriseId: change.operations[0]!.enterpriseId, expectedRevision: 2, patch: { formalValidity: null } })
  const plan = await f.call('preflight', change)
  expect(plan.status).toBe(200)
  expect((await f.call('commit', { request: change, planHash: (plan.body as any).planHash })).status).toBe(200)
  expect((await f.call('get')).body).toMatchObject({ event: { year: 2022, revision: 2 } })
})
