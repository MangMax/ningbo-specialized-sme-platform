import { afterEach, expect, it } from 'vitest'

import { schema } from '../db/client'
import { nativeCorrespondenceFixture } from './helpers/native-correspondence-fixture'
import { listRecordCorrespondences } from '../server/utils/record-correspondence'
const fixtures: ReturnType<typeof nativeCorrespondenceFixture>[] = []
const fixture = () => { const f = nativeCorrespondenceFixture(); fixtures.push(f); return f }
afterEach(() => { for (const f of fixtures.splice(0)) f.close() })

import { readAnnualWriteScope } from '../server/utils/annual-correspondence-read'
import { qualifyAnnualFinal, reconcileAnnualStep } from '../server/utils/annual-correspondence'
it('native annual reconciliation confirms the actual endpoint and replays without duplicate audit', () => {
 const f=fixture(),row=f.add(),scope=readAnnualWriteScope(f.db,f.event.id)!
 const reconcile=()=>reconcileAnnualStep(f.db,readAnnualWriteScope,{eventId:f.event.id,generation:scope.generation,stepId:scope.finalCandidateStepId!})
 expect(reconcile()).toMatchObject({status:'created',relationId:row.id})
 const audit=f.db.select().from(schema.recordCorrespondenceAudit).all()
 expect(reconcile()).toMatchObject({status:'existing',relationId:row.id})
 expect(qualifyAnnualFinal(f.db,readAnnualWriteScope(f.db,f.event.id)!)).toMatchObject({status:'confirmed',decisionRefs:[{relationId:row.id}]})
 expect(f.db.select().from(schema.recordCorrespondenceAudit).all()).toEqual(audit)
})
it('native annual reconciliation rejects an admitted stale generation', () => {
 const f=fixture();f.add();const old=readAnnualWriteScope(f.db,f.event.id)!;f.add({key:'NEW'})
 expect(()=>reconcileAnnualStep(f.db,readAnnualWriteScope,{eventId:f.event.id,generation:old.generation,stepId:old.steps[0]!.stepId})).toThrowError(expect.objectContaining({code:'source_generation_changed'}))
 expect(listRecordCorrespondences(f.db)).toEqual([])
})
