import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { expect, it } from 'vitest'
import { enterprise } from '../../../db/postgresql/enterprise-tables'
import { differenceReason } from '../../../db/postgresql/roster-selection-tables'
import { readPostgresCurrentDetailBatch, readPostgresLegacyQualification } from '../../../layers/sme-roster/lib/roster/current-qualification-postgres'
import { useIsolatedPostgresCases, singlePostgresFixtureRow } from '../../support/isolated-postgres-cases'

const createDb = useIsolatedPostgresCases()
const asOf = Date.parse('2026-11-04T15:17:33.693Z')
const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex')
const readOptions = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const

it('isolates empty legacy serializers from the current namespace with independent bytes', async () => {
  const db = createDb()
  const owner = singlePostgresFixtureRow(await db.insert(enterprise).values({
    name: '空依赖版本矩阵', nameNorm: '空依赖版本矩阵', city: '宁波市',
  }).returning())
  const legacy = await db.transaction(tx => readPostgresLegacyQualification(tx, owner.id, asOf), readOptions)
  expect(legacy).toMatchObject({ assessmentVersion: 'enterprise-qualification-407-v1', ruleVersion: 'current-roster-116-v8' })
  expect(legacy.titles[0]!.versions.sources).toBe(digest('[[],[],[]]'))
  expect(legacy.titles[0]!.versions.decisions).toBe(digest('[[],[],[]]'))
  const current = await db.transaction(async tx => (await readPostgresCurrentDetailBatch(tx, [owner.id], 'specialized_sme', asOf)).get(owner.id)?.snapshot, readOptions)
  expect(current).toMatchObject({ assessmentVersion: 'enterprise-qualification-807-v7', ruleVersion: 'current-roster-116-v14' })
  expect(current!.titles[0]!.versions.sources).toBe(digest('[[],[],[],[]]'))
  expect(current!.titles[0]!.versions.decisions).toBe(digest('[[],[],[],[]]'))
})

it('current formal qualification ignores edits to historical difference facts while the retained reader pins those edits', async () => {
  const db = createDb()
  const owner = singlePostgresFixtureRow(await db.insert(enterprise).values({
    name: '版本兼容合成企业', nameNorm: '版本兼容合成企业', city: '宁波市',
  }).returning())
  const decision = singlePostgresFixtureRow(await db.insert(differenceReason).values({
    enterpriseId: owner.id, titleCode: 'specialized_sme', direction: 'missing_in_miit',
    status: 'needs_review', reasonCode: 'pending_review', verificationStatus: 'pending',
    recordedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z',
  }).returning())
  const current = () => db.transaction(async tx => (await readPostgresCurrentDetailBatch(tx, [owner.id], 'specialized_sme', asOf)).get(owner.id)?.snapshot, readOptions)
  const legacy = () => db.transaction(tx => readPostgresLegacyQualification(tx, owner.id, asOf), readOptions)
  const before = await current()
  const legacyBefore = await legacy()
  await db.transaction(async tx => {
    await tx.update(differenceReason).set({
      status: 'confirmed_reason', reasonCode: 'moved_out', verificationStatus: 'confirmed',
      factReferences: JSON.stringify([{ enterpriseId: owner.id, factId: 19, revision: 2, kind: 'moved_out' }]),
    }).where(eq(differenceReason.id, decision.id))
    const changed = await readPostgresLegacyQualification(tx, owner.id, asOf)
    expect(changed.titles.map(title => title.versions.decisions)).not.toEqual(legacyBefore.titles.map(title => title.versions.decisions))
    const current = await readPostgresCurrentDetailBatch(tx, [owner.id], 'specialized_sme', asOf)
    expect(current.get(owner.id)?.snapshot).toEqual(before)
    tx.rollback()
  }, { isolationLevel: 'repeatable read' }).catch(error => {
    if (error?.message !== 'Rollback') throw error
  })
  expect(await current()).toEqual(before)
  expect(await legacy()).toEqual(legacyBefore)
})
