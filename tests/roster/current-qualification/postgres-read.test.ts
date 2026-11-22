import { eq } from 'drizzle-orm'
import { expect, it } from 'vitest'
import { enterprise } from '../../../db/postgresql/enterprise-tables'
import { record, recordEvent, recordEvidence } from '../../../db/postgresql/ledger-tables'
import { readPostgresEffectiveQualifications, readPostgresCurrentDetailBatch } from '../../../layers/sme-roster/lib/roster/current-qualification-postgres'
import { listPostgresCurrentQualified } from '../../../layers/sme-roster/lib/roster/current-qualified-query-postgres'
import { commitPostgresCorrespondences, preflightPostgresCorrespondences } from '../../../layers/sme-roster/server/utils/record-correspondence-write-postgres'
import { singlePostgresFixtureRow as single, useIsolatedPostgresCases } from '../../support/isolated-postgres-cases'
import { submitSyntheticRecognizedCollection } from '../fixtures/recognized-source'

const createDb = useIsolatedPostgresCases()
const asOf = Date.parse('2026-06-01T00:00:00.000Z')

it('keeps current qualification and filters independent of legacy correspondence revisions', async () => {
  const db = createDb()
  const titleCode = 'innovative_sme' as const
  const name = '合成认定见证企业'
  const uscc = '913302125705899102'
  const owner = single(await db.insert(enterprise).values({ name, nameNorm: name, usccNorm: uscc }).returning())
  const ledger = single(await db.insert(record).values({ enterpriseId: owner.id, titleCode, source: 'jxj', nameRaw: name }).returning())
  const award = single(await db.insert(recordEvent).values({ recordId: ledger.id, eventType: 'award', year: 2025, batchSeq: 1 }).returning())
  await db.insert(recordEvidence).values({ recordEventId: award.id, sourceFile: 'synthetic/award.pdf', page: 1 })
  const { relationIds } = await submitSyntheticRecognizedCollection(db, {
    rdjb: '1', queriedAt: '2026-05-01T00:00:00Z',
    rows: [{ enterpriseId: owner.id, raw: { id: 'recognized-witness', qymc: name, tyshxydm: uscc, rdjb: '1', rddqrq: '2028-11-20', whpc: '2023-2' } }],
  })
  const edge = { type: 'event_recognized' as const, eventId: award.id, relationId: relationIds[0]! }
  const request = {
    idempotencyKey: 'confirm-recognized-witness', sourceIdentity: 'synthetic/recognized-witness',
    actor: { type: 'agent' as const, id: 'test' }, basis: 'Synthetic corroboration', ruleId: 'manual', ruleVersion: '1',
    operations: [{ action: 'create' as const, status: 'confirmed' as const, edge: { ...edge, role: 'recognized_corrob' as const } }],
  }
  const filter = { titleCode, validYear: 2028, maintenanceYear: 2023 }
  const before = await listPostgresCurrentQualified(db, { titleCode }, asOf)
  expect(before).toMatchObject({
    total: 1, rows: [{ enterpriseId: owner.id, qualificationWitnesses: [{
      awardEventId: award.id, matchedValidYear: null, matchedMaintenance: null,
    }] }],
  })
  const plan = await preflightPostgresCorrespondences(db, request)
  const receipt = await commitPostgresCorrespondences(db, request, plan.planHash)
  expect(await listPostgresCurrentQualified(db, { titleCode }, asOf)).toEqual(before)
  expect(await listPostgresCurrentQualified(db, filter, asOf)).toMatchObject({ total: 0, rows: [] })

  const correction = {
    ...request, idempotencyKey: 'correct-recognized-witness-to-context',
    operations: [{
      action: 'correct' as const, correspondenceId: receipt.correspondenceIds[0]!, expectedRevision: 2,
      edge: { ...edge, role: 'current_context' as const },
    }],
  }
  const revised = await preflightPostgresCorrespondences(db, correction)
  await commitPostgresCorrespondences(db, correction, revised.planHash)
  expect(await listPostgresCurrentQualified(db, { titleCode }, asOf)).toEqual(before)
  expect(await listPostgresCurrentQualified(db, filter, asOf)).toMatchObject({ total: 0, rows: [] })
})

it('pins three-title qualification to the same PostgreSQL snapshot while another connection edits an award', async () => {
  const db = createDb()
  const owner = single(await db.insert(enterprise).values({ name: '合成快照企业', nameNorm: '合成快照企业' }).returning())
  const ledger = single(await db.insert(record).values({
    enterpriseId: owner.id, titleCode: 'specialized_sme', source: 'jxj',
  }).returning())
  const award = single(await db.insert(recordEvent).values({
    recordId: ledger.id, eventType: 'award', year: 2025, batchSeq: 1,
  }).returning())
  await db.insert(recordEvidence).values({ recordEventId: award.id, sourceFile: 'synthetic/snapshot.pdf', page: 1 })

  const read = (tx: Parameters<typeof readPostgresCurrentDetailBatch>[0]) =>
    readPostgresCurrentDetailBatch(tx, [owner.id], 'specialized_sme', asOf)

  await db.transaction(async tx => {
    const before = (await read(tx)).get(owner.id)!.snapshot
    expect(before.titles.map(title => [title.titleCode, title.effectiveQualification?.status])).toEqual([
      ['little_giant', 'unrecognized'], ['specialized_sme', 'effective'], ['innovative_sme', 'effective'],
    ])
    await db.update(recordEvent).set({ year: 2021 }).where(eq(recordEvent.id, award.id))
    expect((await read(tx)).get(owner.id)!.snapshot).toEqual(before)
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })

  await db.transaction(async tx => {
    const after = (await read(tx)).get(owner.id)!.snapshot
    expect(after.titles.map(title => [title.titleCode, title.effectiveQualification?.status])).toEqual([
      ['little_giant', 'unrecognized'], ['specialized_sme', 'expired'], ['innovative_sme', 'unrecognized'],
    ])
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
})

it('requires a repeatable snapshot and distinguishes an absent owner from an empty qualification', async () => {
  const db = createDb()
  const owner = single(await db.insert(enterprise).values({ name: '未认定合成企业', nameNorm: '未认定合成企业' }).returning())

  await expect(db.transaction(tx => readPostgresEffectiveQualifications(tx, owner.id, asOf)))
    .rejects.toThrow('PostgreSQL qualification requires a repeatable-read or serializable transaction')
  await db.transaction(async tx => {
    expect(await readPostgresEffectiveQualifications(tx, owner.id, asOf)).toEqual([])
    expect(await readPostgresEffectiveQualifications(tx, owner.id + 1, asOf)).toBeNull()
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
})
