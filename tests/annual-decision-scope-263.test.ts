import { afterEach, expect, it } from 'vitest'


import { nativeCorrespondenceFixture } from './helpers/native-correspondence-fixture'
import { getRecordCorrespondenceAudit, listRecordCorrespondences } from '../server/utils/record-correspondence'
const fixtures: ReturnType<typeof nativeCorrespondenceFixture>[] = []
const fixture = () => { const f = nativeCorrespondenceFixture(); fixtures.push(f); return f }
afterEach(() => { for (const f of fixtures.splice(0)) f.close() })

import { readAnnualWriteScope } from '../server/utils/annual-correspondence-read'
import { qualifyAnnualFinal, reconcileAnnualStep } from '../server/utils/annual-correspondence'
it('native annual decision scope keeps same-version old observation confirmation', () => {
 const f=fixture(),old=f.add();f.save(f.request('old-confirmation',[{action:'create',status:'confirmed',edge:f.edge(old.id)}]));const current=f.add()
 const scope=readAnnualWriteScope(f.db,f.event.id)!
 expect(scope.steps[0]!.currentRelationIds).toEqual([old.id,current.id])
 expect(qualifyAnnualFinal(f.db,scope)).toMatchObject({status:'confirmed',decisionRefs:[{relationId:old.id}]})
 expect(reconcileAnnualStep(f.db,readAnnualWriteScope,{eventId:f.event.id,generation:scope.generation,stepId:scope.steps[0]!.stepId})).toMatchObject({status:'existing',relationId:old.id})
 expect(listRecordCorrespondences(f.db)).toHaveLength(1)
})
it('native annual scope protects an explicit manual rejection across new observations', () => {
 const f=fixture(),old=f.add();const id=f.save(f.request('reject',[{action:'create',status:'rejected',edge:f.edge(old.id)}])).correspondenceIds[0]!
 f.add({status:'终审不通过'});const scope=readAnnualWriteScope(f.db,f.event.id)!,audit=getRecordCorrespondenceAudit(f.db,id)
 expect(reconcileAnnualStep(f.db,readAnnualWriteScope,{eventId:f.event.id,generation:scope.generation,stepId:scope.steps[0]!.stepId})).toMatchObject({status:'protected'})
 expect(getRecordCorrespondenceAudit(f.db,id)).toEqual(audit)
})
