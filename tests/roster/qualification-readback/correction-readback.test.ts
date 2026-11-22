import { eq } from 'drizzle-orm'
import { afterEach, expect, it, vi } from 'vitest'
import { enterprise } from '../../../db/postgresql/enterprise-tables'
import { record, recordEvent, recordEvidence } from '../../../db/postgresql/ledger-tables'
import { eventCorrectionAudit } from '../../../db/postgresql/official-evidence-tables'
import { readPostgresLegacyQualification } from '../../../layers/sme-roster/lib/roster/current-qualification-postgres'
import { handlePostgresEventCorrectionWrite } from '../../../layers/sme-roster/server/utils/roster-event-correction-write-postgres'
import type { EventCorrectionRequest } from '../../../layers/sme-roster/server/utils/roster-event-correction-model'
import { singlePostgresFixtureRow, useIsolatedPostgresCases } from '../../support/isolated-postgres-cases'

const openCase = useIsolatedPostgresCases()
const token = 'synthetic-correction-token'
const beforeDate = Date.parse('2026-01-15T00:00:00Z')
afterEach(() => vi.useRealTimers())

async function fixture() {
  const db = openCase()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(beforeDate)
  const owner = singlePostgresFixtureRow(await db.insert(enterprise).values({ name: '合成更正甲', nameNorm: '合成更正甲' }).returning())
  const ledger = singlePostgresFixtureRow(await db.insert(record).values({ enterpriseId: owner.id, titleCode: 'innovative_sme', source: 'jxj' }).returning())
  const event = singlePostgresFixtureRow(await db.insert(recordEvent).values({ recordId: ledger.id, eventType: 'review', year: 2025 }).returning())
  await db.insert(recordEvidence).values({ recordEventId: event.id, sourceFile: 'notice.txt', attachment: '附件2', listNo: 1 })
  const command: EventCorrectionRequest = {
    idempotencyKey: 'synthetic-review-correction', sourceIdentity: 'synthetic/attachment2',
    actor: { type: 'agent', id: 'synthetic-reviewer' }, basis: '附件2明确复核2022年原认定企业',
    operations: [{ eventId: event.id, recordId: ledger.id, enterpriseId: owner.id, expectedRevision: 1,
      patch: { year: 2022, decidedYear: 2025, reviewOutcome: 'passed', batchSeq: null } }],
  }
  const post = (action: 'preflight' | 'commit', body: unknown, authorized = true) =>
    handlePostgresEventCorrectionWrite(action, { method: 'POST', apiToken: token, body,
      headers: authorized ? { authorization: 'Bearer ' + token } : {} })
  const state = async () => ({
    events: await db.select().from(recordEvent).orderBy(recordEvent.id),
    evidence: await db.select().from(recordEvidence).orderBy(recordEvidence.id),
    audit: await db.select().from(eventCorrectionAudit).orderBy(eventCorrectionAudit.id),
  })
  const preview = async () => {
    const { status, body } = await post('preflight', command)
    expect(status, JSON.stringify(body)).toBe(200)
    expect(body).toHaveProperty('planHash', expect.stringMatching(/^[a-f\d]{64}$/))
    return body as { planHash: string; qualificationReadback: unknown }
  }
  return { db, owner, ledger, event, command, post, preview, state }
}

it('captures the actual post-correction assessment with unchanged evidence and event identity', async () => {
  const f = await fixture()
  const before = await f.state()
  const plan = await f.preview()
  expect(plan.qualificationReadback).toMatchObject({
    stage: 'before', status: 'captured', target: { enterpriseId: f.owner.id },
    assessment: { titles: expect.arrayContaining([expect.objectContaining({
      titleCode: 'innovative_sme', evidence: [expect.objectContaining({ eventId: f.event.id, year: 2025, revision: 1 })],
    })]) },
  })
  expect(await f.state()).toEqual(before)
  const result = await f.post('commit', { request: f.command, planHash: plan.planHash })
  expect(result.status, JSON.stringify(result.body)).toBe(200)
  const snapshot = await f.db.transaction(tx => readPostgresLegacyQualification(tx, f.owner.id, beforeDate), { isolationLevel: 'repeatable read', accessMode: 'read only' })
  expect(result.body).toMatchObject({
    eventIds: [f.event.id],
    qualificationReadback: { stage: 'after', status: 'captured', target: { enterpriseId: f.owner.id }, assessment: snapshot },
  })
  expect(snapshot.titles.find(title => title.titleCode === 'innovative_sme')).toMatchObject({
    group: 'pending', evidence: [{ eventId: f.event.id, year: 2022, decidedYear: 2025, batchSeq: null, reviewOutcome: 'passed', revision: 2 }],
  })
  const after = await f.state()
  expect(after.evidence).toEqual(before.evidence)
  expect(after.audit).toHaveLength(1)
  expect(JSON.parse(after.audit[0]!.before)).toMatchObject({ id: f.event.id, year: 2025, revision: 1 })
  expect(JSON.parse(after.audit[0]!.after)).toMatchObject({ id: f.event.id, year: 2022, revision: 2 })
})

it('replays the original before and after captures after an independent fact changes', async () => {
  const f = await fixture()
  const plan = await f.preview()
  const command = { request: f.command, planHash: plan.planHash }
  const first = await f.post('commit', command)
  expect(first.status, JSON.stringify(first.body)).toBe(200)
  vi.setSystemTime(Date.parse('2027-01-15T00:00:00Z'))
  await f.db.insert(recordEvent).values({ recordId: f.ledger.id, eventType: 'award', year: 2026, batchSeq: 1 })
  const before = await f.state()
  expect(await f.preview()).toMatchObject({ qualificationReadback: plan.qualificationReadback })
  expect(await f.post('commit', command)).toEqual(first)
  expect(await f.state()).toEqual(before)
})

it('keeps the competing revision and emits no successful capture for a stale correction', async () => {
  const f = await fixture()
  const plan = await f.preview()
  await f.db.update(recordEvent).set({ year: 2024, revision: 2 }).where(eq(recordEvent.id, f.event.id))
  const before = await f.state()
  const result = await f.post('commit', { request: f.command, planHash: plan.planHash })
  expect(result.status).toBe(409)
  expect(result.body).not.toHaveProperty('qualificationReadback')
  expect(await f.state()).toEqual(before)
})

it('rejects unauthorized correction and invalid patches before changing the ledger', async () => {
  const f = await fixture()
  const before = await f.state()
  expect((await f.post('preflight', f.command, false)).status).toBe(401)
  const invalid = structuredClone(f.command)
  Object.assign(invalid.operations[0]!.patch, { year: 2022.5 })
  expect((await f.post('preflight', invalid)).status).toBe(400)
  expect(await f.state()).toEqual(before)
})

it('does not select one enterprise for the capture when both enterprises are corrected', async () => {
  const f = await fixture()
  const secondOwner = singlePostgresFixtureRow(await f.db.insert(enterprise).values({ name: '合成更正乙', nameNorm: '合成更正乙' }).returning())
  const secondRecord = singlePostgresFixtureRow(await f.db.insert(record).values({ enterpriseId: secondOwner.id, titleCode: 'innovative_sme', source: 'jxj' }).returning())
  const secondEvent = singlePostgresFixtureRow(await f.db.insert(recordEvent).values({ recordId: secondRecord.id, eventType: 'review', year: 2025 }).returning())
  await f.db.insert(recordEvidence).values({ recordEventId: secondEvent.id, sourceFile: 'notice.txt', attachment: '附件2', listNo: 2 })
  f.command.operations.push({ ...f.command.operations[0]!, eventId: secondEvent.id, enterpriseId: secondOwner.id, recordId: secondRecord.id })
  const plan = await f.preview()
  const result = await f.post('commit', { request: f.command, planHash: plan.planHash })
  expect(result.status, JSON.stringify(result.body)).toBe(200)
  expect(result.body).toMatchObject({
    eventIds: [f.event.id, secondEvent.id],
    qualificationReadback: { stage: 'after', status: 'not_retained', reason: 'multiple_targets', target: null,
      enterpriseIds: [f.owner.id, secondOwner.id] },
  })
  expect((await f.state()).events.map(event => [event.id, event.year, event.revision])).toEqual([
    [f.event.id, 2022, 2], [secondEvent.id, 2022, 2],
  ])
})
