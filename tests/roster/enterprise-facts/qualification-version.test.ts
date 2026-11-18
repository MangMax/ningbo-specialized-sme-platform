import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { initializeDb, schema } from '../../../db/client'
import { createHash } from 'node:crypto'
import { createCurrentQualificationAssessmentReader, PREVIOUS_QUALIFICATION_ASSESSMENT_VERSION } from '../../../layers/sme-roster/lib/roster/current-qualification'

const dir = mkdtempSync(join(tmpdir(), 'facts-qualification-version-307-'))
const db = initializeDb({ create: true,  dbPath: join(dir, 'test.sqlite') })
db.insert(schema.enterprise).values({ id: 1, name: '版本兼容合成企业', nameNorm: '版本兼容合成企业', city: '宁波市' }).run()
db.insert(schema.differenceReason).values({
  id: 1, enterpriseId: 1, titleCode: 'specialized_sme', direction: 'missing_in_miit',
  status: 'needs_review', reasonCode: 'pending_review', verificationStatus: 'pending',
  recordedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z',
}).run()
const reader = createCurrentQualificationAssessmentReader(db.$client)
const read = () => reader.read(1, Date.parse('2026-11-04T15:17:33.693Z'), { assessmentVersion: PREVIOUS_QUALIFICATION_ASSESSMENT_VERSION }).snapshot
afterAll(() => { db.$client.close(); rmSync(dir, { recursive: true, force: true }) })

it('preserves pre-migration qualification snapshot and decision versions for null fact references', () => {
  // Captured using the actual 82acea2 reader and schema, with this synthetic
  // fixture and fixed asOf: its default was 407-v2/current-roster-116-v9.
  // Pin that published compatibility contract, retaining its original hashes.
  const snapshot = read()
  expect(snapshot.snapshotId).toBe('e5787b94ae0f6bdc788c08fe807de95b95dfa5d717157a068ff80a8b1b7b5037')
  expect(snapshot.titles.map(title => title.versions.decisions)).toEqual(Array(3).fill('128f464856851929398ec1e596eedab2a2093638705b921409c8f2915dc11abb'))
})

it('binds non-null pinned fact references into decision versions and restores the legacy version after rollback', () => {
  const before = read()
  db.$client.exec('BEGIN')
  try {
    db.$client.prepare('update difference_reason set fact_references=? where id=1').run(JSON.stringify([{ enterpriseId: 1, factId: 19, revision: 2, kind: 'moved_out' }]))
    const pinned = read()
    expect(pinned.snapshotId).not.toBe(before.snapshotId)
    for (const [index, title] of pinned.titles.entries()) {
      expect(title.versions.decisions).not.toBe(before.titles[index]!.versions.decisions)
      expect(title.versions.facts).toBe(before.titles[index]!.versions.facts)
      expect(title.group).toBe(before.titles[index]!.group)
    }
  } finally { db.$client.exec('ROLLBACK') }
  expect(read()).toEqual(before)
})

it('preserves pre-migration versions when confirmed legacy subject decisions hydrate nested assessments', () => {
  db.$client.exec('BEGIN')
  try {
    db.$client.prepare("update difference_reason set status='confirmed_reason',reason_code='moved_out',verification_status='confirmed' where id=1").run()
    const snapshot = read()
    expect(snapshot.snapshotId).toBe('3738aeed7ccc0ca8b5e80c96fb54a98fe2b0536e51c5fb51a086f3e040f92b11')
    expect(snapshot.titles.map(title => title.versions.decisions)).toEqual(Array(3).fill('e06d98ad5ad5616a58ee9a64c6651079afc88dbb74d896da371cf0fcfbbbd4d2'))
  } finally { db.$client.exec('ROLLBACK') }
})

it('default formal qualification versions exclude difference decisions and pinned references while legacy versions retain them', () => {
  const current = () => reader.read(1, Date.parse('2026-11-04T15:17:33.693Z')).snapshot
  const before = current(), legacy = read()
  // No formal event, correspondence, or subject fact is seeded. The default
  // v6 includes disposition inputs and downward giant/specialized dependencies.
  const hash = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex')
  const giant = hash([[], [], [], []])
  const specialized = hash([giant, giant])
  const innovative = hash([hash([giant, giant]), specialized])
  expect(before.assessmentVersion).toBe('enterprise-qualification-807-v7')
  expect(before.titles.map(title => [title.group, title.versions.decisions])).toEqual([giant, specialized, innovative].map(decisions => ['excluded', decisions]))
  db.$client.exec('BEGIN')
  try {
    db.$client.prepare("update difference_reason set status='confirmed_reason',reason_code='moved_out',verification_status='confirmed',fact_references=? where id=1")
      .run(JSON.stringify([{ enterpriseId: 1, factId: 19, revision: 2, kind: 'moved_out' }]))
    expect(current()).toEqual(before)
    expect(read().titles.map(title => title.versions.decisions)).not.toEqual(legacy.titles.map(title => title.versions.decisions))
  } finally { db.$client.exec('ROLLBACK') }
  expect(current()).toEqual(before)
})

it('isolates empty legacy serializers from the current namespace with independent bytes', () => {
 db.insert(schema.enterprise).values({id:2,name:'空依赖版本矩阵',nameNorm:'空依赖版本矩阵',city:'宁波市'}).run()
 const digest=(bytes:string)=>createHash('sha256').update(bytes).digest('hex')
 for(const assessmentVersion of ['enterprise-qualification-407-v1','enterprise-qualification-407-v2','enterprise-qualification-478-v3','enterprise-qualification-687-v4'] as const){
  const snapshot=reader.read(2,Date.parse('2026-11-04T15:17:33.693Z'),{assessmentVersion}).snapshot
  expect(snapshot.titles[0]!.versions.sources).toBe(digest('[[],[],[]]'))
  expect(snapshot.titles[0]!.versions.decisions).toBe(digest('[[],[],[]]'))
 }
 const current=reader.read(2,Date.parse('2026-11-04T15:17:33.693Z')).snapshot
 expect(current).toMatchObject({assessmentVersion:'enterprise-qualification-807-v7',ruleVersion:'current-roster-116-v14'})
 expect(current.titles[0]!.versions.sources).toBe(digest('[[],[],[],[]]'))
 expect(current.titles[0]!.versions.decisions).toBe(digest('[[],[],[],[]]'))
})
