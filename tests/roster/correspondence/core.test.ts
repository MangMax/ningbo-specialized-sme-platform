import { afterEach, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { schema } from '../../../db/client'
import { nativeCorrespondenceFixture } from '../../helpers/native-correspondence-fixture'
import { commitRecordCorrespondences, preflightRecordCorrespondences, getRecordCorrespondence, getRecordCorrespondenceAudit, listRecordCorrespondences } from '../../../server/utils/record-correspondence'
const fixtures: ReturnType<typeof nativeCorrespondenceFixture>[] = []
const fixture = () => { const f = nativeCorrespondenceFixture(); fixtures.push(f); return f }
afterEach(() => { for (const f of fixtures.splice(0)) f.close() })

it('commits native endpoints with immutable audit and idempotent receipt', () => {
 const f=fixture(), row=f.add(), request=f.request('confirmed',[{action:'create',status:'confirmed',edge:f.edge(row.id)}])
 const plan=preflightRecordCorrespondences(f.db,request), receipt=commitRecordCorrespondences(f.db,request,plan.planHash)
 const audit=getRecordCorrespondenceAudit(f.db,receipt.correspondenceIds[0]!)
 expect(listRecordCorrespondences(f.db)).toMatchObject([{relationId:row.id,status:'confirmed',revision:2,requiresRevalidation:false}])
 expect(audit).toHaveLength(2)
 expect(commitRecordCorrespondences(f.db,request,plan.planHash)).toEqual(receipt)
 expect(getRecordCorrespondenceAudit(f.db,receipt.correspondenceIds[0]!)).toEqual(audit)
})
it('keeps a new native content version independent of the old confirmed decision', () => {
 const f=fixture(), old=f.add(), receipt=f.save(f.request('old',[{action:'create',status:'confirmed',edge:f.edge(old.id)}]))
 const before=getRecordCorrespondence(f.db,receipt.correspondenceIds[0]!), audit=getRecordCorrespondenceAudit(f.db,before!.id)
 const changed=f.add({status:'终审不通过'})
 expect(changed.id).not.toBe(old.id)
 expect(listRecordCorrespondences(f.db,{relationId:changed.id})).toEqual([])
 expect(getRecordCorrespondence(f.db,before!.id)).toEqual(before)
 f.save(f.request('changed',[{action:'create',status:'rejected',edge:f.edge(changed.id)}]))
 expect(listRecordCorrespondences(f.db).map(r=>[r.relationId,r.status])).toEqual([[old.id,'confirmed'],[changed.id,'rejected']])
 expect(getRecordCorrespondenceAudit(f.db,before!.id)).toEqual(audit)
})
it('rejects cross-title native endpoints before recording a decision', () => {
 const f=fixture(), row=f.add({rdjb:'1',titleCode:'innovative_sme'})
 expect(()=>f.save(f.request('wrong-title',[{action:'create',status:'confirmed',edge:f.edge(row.id)}]))).toThrowError(expect.objectContaining({code:'title_conflict'}))
 expect(listRecordCorrespondences(f.db)).toEqual([])
})
it('requires current revisions and preserves manual unlink audit', () => {
 const f=fixture(),row=f.add(),id=f.save(f.request('create',[{action:'create',status:'confirmed',edge:f.edge(row.id)}])).correspondenceIds[0]!
 expect(()=>f.save(f.request('stale',[{action:'decide',correspondenceId:id,expectedRevision:1,status:'unlinked'}]))).toThrowError(expect.objectContaining({code:'stale_revision'}))
 f.save(f.request('unlink',[{action:'decide',correspondenceId:id,expectedRevision:2,status:'unlinked'}]))
 expect(getRecordCorrespondence(f.db,id)).toMatchObject({status:'unlinked',revision:3})
 expect(getRecordCorrespondenceAudit(f.db,id).at(-1)).toMatchObject({fromStatus:'confirmed',toStatus:'unlinked',expectedRevision:2,resultingRevision:3})
})
it('invalidates a frozen preflight when official source facts change', () => {
 const f=fixture(),row=f.add(),request=f.request('stale-source',[{action:'create',status:'confirmed',edge:f.edge(row.id)}]),plan=preflightRecordCorrespondences(f.db,request)
 f.db.update(schema.recordEvent).set({batchSeq:2}).where(eq(schema.recordEvent.id,f.event.id)).run()
 expect(()=>commitRecordCorrespondences(f.db,request,plan.planHash)).toThrowError(expect.objectContaining({code:'plan_mismatch'}))
 expect(listRecordCorrespondences(f.db)).toEqual([])
})
it('rejects a native row explicitly assigned to another enterprise', () => {
 const f=fixture(),other=f.db.insert(schema.enterprise).values({name:'另一合成企业',nameNorm:'另一合成企业',usccNorm:'91330200987654321B'}).returning().get()
 const row=f.add({enterpriseId:other.id})
 expect(()=>f.save(f.request('wrong-owner',[{action:'create',status:'confirmed',edge:f.edge(row.id)}]))).toThrowError(expect.objectContaining({code:'identity_conflict'}))
 expect(listRecordCorrespondences(f.db)).toEqual([])
})
