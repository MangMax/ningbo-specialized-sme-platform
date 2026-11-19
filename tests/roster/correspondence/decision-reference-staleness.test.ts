import { afterEach, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { schema } from '../../../db/client'
import { nativeCorrespondenceFixture } from './fixtures/native-correspondence'
import { getRecordCorrespondence, getRecordCorrespondenceAudit, listRecordCorrespondenceRefs } from '../../../layers/sme-roster/server/utils/record-correspondence'
const fixtures: ReturnType<typeof nativeCorrespondenceFixture>[] = []
const fixture = () => { const f = nativeCorrespondenceFixture(); fixtures.push(f); return f }
afterEach(() => { for (const f of fixtures.splice(0)) f.close() })

it('native decision refs track official identity changes and recovery without rewriting audit', () => {
 const f=fixture(),row=f.add(),id=f.save(f.request('identity',[{action:'create',status:'confirmed',edge:f.edge(row.id)}])).correspondenceIds[0]!
 const audit=getRecordCorrespondenceAudit(f.db,id)
 expect(listRecordCorrespondenceRefs(f.db,{id})).toMatchObject([{id,relationId:row.id,requiresRevalidation:false}])
 f.db.update(schema.recordEvent).set({batchSeq:2}).where(eq(schema.recordEvent.id,f.event.id)).run()
 expect(listRecordCorrespondenceRefs(f.db,{id})).toMatchObject([{requiresRevalidation:true}])
 expect(getRecordCorrespondence(f.db,id)!.requiresRevalidation).toBe(true)
 f.db.update(schema.recordEvent).set({batchSeq:null}).where(eq(schema.recordEvent.id,f.event.id)).run()
 expect(listRecordCorrespondenceRefs(f.db,{id})).toMatchObject([{requiresRevalidation:false}])
 expect(getRecordCorrespondenceAudit(f.db,id)).toEqual(audit)
})
it('native refs remain tied to their decided observation after a new version arrives', () => {
 const f=fixture(),old=f.add(),id=f.save(f.request('old-ref',[{action:'create',status:'confirmed',edge:f.edge(old.id)}])).correspondenceIds[0]!
 const changed=f.add({status:'终审不通过'})
 expect(listRecordCorrespondenceRefs(f.db,{id})).toMatchObject([{relationId:old.id,requiresRevalidation:false}])
 expect(listRecordCorrespondenceRefs(f.db,{relationId:changed.id})).toEqual([])
})
