import { expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { differenceReason } from '../../../db/postgresql/roster-selection-tables'
import { readPostgresQueryAssessments } from '../../../layers/sme-roster/lib/roster/query-assessment-postgres'
import { currentPostgresDecisions102, historyPostgresDecision102 } from '../../../layers/sme-roster/server/utils/decision-lifecycle/postgres-reads'
import { platformBusinessObservation } from '../../../db/postgresql/platform-tables'
import { prunePostgresPlatformCaptures } from '../../../layers/sme-roster/server/utils/platform-capture-retention-postgres'
import * as schema from '../fixtures/postgres-tables'
import { nativeCorrespondenceFixture } from './fixtures/native-correspondence'
import { readPostgresCorrespondenceRefs } from '../../../layers/sme-roster/server/utils/record-correspondence-postgres-refs'
import { readFixtureAudit } from './fixtures/postgres-audit'
import { useIsolatedPostgresCases } from '../../support/isolated-postgres-cases'
const createDb = useIsolatedPostgresCases()
const fixture = () => nativeCorrespondenceFixture(createDb())

it('native decision refs track official identity changes and recovery without rewriting audit', async () => {
 const f=await fixture(),row=await f.add(),id=(await f.save(f.request('identity',[{action:'create',status:'confirmed',edge:f.edge(row.id)}]))).correspondenceIds[0]!
 const audit=await readFixtureAudit(f.db,id)
 expect(await readPostgresCorrespondenceRefs(f.db,[id])).toMatchObject([{id,relationId:row.id,requiresRevalidation:false}])
 await f.db.update(schema.recordEvent).set({batchSeq:2}).where(eq(schema.recordEvent.id,f.event.id))
 expect(await readPostgresCorrespondenceRefs(f.db,[id])).toMatchObject([{requiresRevalidation:true}])
 expect((await readPostgresCorrespondenceRefs(f.db,[id]))[0]!.requiresRevalidation).toBe(true)
 await f.db.update(schema.recordEvent).set({batchSeq:null}).where(eq(schema.recordEvent.id,f.event.id))
 expect(await readPostgresCorrespondenceRefs(f.db,[id])).toMatchObject([{requiresRevalidation:false}])
 expect(await readFixtureAudit(f.db,id)).toEqual(audit)
})
it('marks a superseded decision stale and preserves its audit when the old capture is pruned', async () => {
 const f=await fixture(),old=await f.add(),id=(await f.save(f.request('old-ref',[{action:'create',status:'confirmed',edge:f.edge(old.id)}]))).correspondenceIds[0]!
 const audit=await readFixtureAudit(f.db,id)
 const changed=await f.add({status:'终审不通过'})
 expect(await readPostgresCorrespondenceRefs(f.db,[id])).toMatchObject([{relationId:old.id,requiresRevalidation:true}])
 expect(await readPostgresCorrespondenceRefs(f.db,{eventIds:[],relationIds:[changed.id],exportRowIds:[]})).toEqual([])
 const latest=await f.add({status:'终审通过'})
 const [record]=await f.db.select({id:platformBusinessObservation.recordId}).from(platformBusinessObservation)
   .where(eq(platformBusinessObservation.publicId,latest.id))
 expect(await prunePostgresPlatformCaptures(f.db,[record!.id!],true)).toBe(1)
 expect(await readPostgresCorrespondenceRefs(f.db,[id])).toMatchObject([{relationId:null,requiresRevalidation:true}])
 expect(await readFixtureAudit(f.db,id)).toEqual(audit)
})

it('rebinds human evidence to an identical current capture and invalidates it when business content changes', async () => {
 const f = await fixture()
 const first = await f.add()
 const receipt = await f.save(f.request('repeat-reviewed', [{ action: 'create', status: 'confirmed', edge: f.edge(first.id) }]))
 const id = receipt.correspondenceIds[0]!
 const originalAudit = await readFixtureAudit(f.db, id)
 const observation = platformBusinessObservation
 const [original] = await f.db.select().from(observation).where(eq(observation.publicId, first.id))
 const scope = { enterpriseId: f.enterprise.id, titleCode: 'specialized_sme' as const, direction: 'missing_in_miit' as const }
 const [decision] = await f.db.insert(differenceReason).values({
  ...scope, status: 'confirmed_reason', reasonCode: 'other', verificationStatus: 'confirmed',
  recordedAt: '2026-10-20T00:02:00Z', createdAt: '2026-10-20T00:02:00Z',
  evidenceRelationId: original!.id, evidenceQueryId: original!.collectionId,
  retiredEvidenceValidity: 'valid', retiredEvidenceReviewed: true,
 }).returning({ id: differenceReason.id })

 const repeat = await f.add({ queryRaw: 'New transmission of identical business content' })
 expect(await prunePostgresPlatformCaptures(f.db, [original!.recordId!], true)).toBe(1)
 expect(await readPostgresCorrespondenceRefs(f.db, { validityIds: [id] })).toMatchObject([
  { id, relationId: repeat.id, status: 'confirmed', requiresRevalidation: false },
 ])
 expect(await readFixtureAudit(f.db, id)).toEqual(originalAudit)
 expect(await currentPostgresDecisions102(f.db, [scope])).toMatchObject([{ current: { id: decision!.id, evidenceRelationId: repeat.id, evidenceQueryId: repeat.queryId } }])
 expect(await readPostgresQueryAssessments(f.db, [scope])).toMatchObject([{ explanationValidity: { status: 'valid' } }])
 const [rebound] = await f.db.select().from(differenceReason).where(eq(differenceReason.id, decision!.id))
 expect(rebound).toMatchObject({ retiredEvidenceReviewed: true, retiredEvidenceValidity: 'valid' })
 expect(await historyPostgresDecision102(f.db, { ...scope, page: 1, pageSize: 10 })).toMatchObject({
  rows: [{ id: decision!.id, evidenceRelationId: first.id, evidenceQueryId: first.queryId }],
 })

 const changed = await f.add({ status: '终审不通过' })
 expect(await prunePostgresPlatformCaptures(f.db, [original!.recordId!], true)).toBe(0)
 expect(await f.db.select({ id: observation.publicId }).from(observation).where(eq(observation.recordId, original!.recordId!)).orderBy(observation.publicId))
  .toEqual([{ id: repeat.id }, { id: changed.id }])
 expect(await readPostgresCorrespondenceRefs(f.db, { validityIds: [id] })).toMatchObject([
  { id, relationId: null, status: 'confirmed', requiresRevalidation: true },
 ])
 expect(await readPostgresQueryAssessments(f.db, [scope])).toMatchObject([{ explanationValidity: { status: 'evidence_changed' } }])
 const [invalidated] = await f.db.select().from(differenceReason).where(eq(differenceReason.id, decision!.id))
 expect(invalidated).toMatchObject({ evidenceRelationId: null, retiredEvidenceReviewed: false, retiredEvidenceValidity: 'evidence_changed' })
 expect(await readFixtureAudit(f.db, id)).toEqual(originalAudit)
})
