import { eq } from 'drizzle-orm'
import { expect, it } from 'vitest'
import { enterprise } from '../../../db/postgresql/enterprise-tables'
import { record, recordEvent, recordEvidence } from '../../../db/postgresql/ledger-tables'
import { readPostgresEffectiveQualifications, readPostgresCurrentDetailBatch } from '../../../layers/sme-roster/lib/roster/current-qualification-postgres'
import { singlePostgresFixtureRow as single, useIsolatedPostgresCases } from '../../support/isolated-postgres-cases'

const createDb = useIsolatedPostgresCases()
const asOf = Date.parse('2026-06-01T00:00:00.000Z')

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
