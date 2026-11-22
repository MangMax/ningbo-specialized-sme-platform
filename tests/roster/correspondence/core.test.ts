import { expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import * as schema from '../fixtures/postgres-tables'
import { nativeCorrespondenceFixture } from './fixtures/native-correspondence'
import { preflightPostgresCorrespondences, commitPostgresCorrespondences } from '../../../layers/sme-roster/server/utils/record-correspondence-write-postgres'
import { listPostgresCorrespondences } from '../../../layers/sme-roster/server/utils/record-correspondence-postgres'
import { readPostgresCorrespondenceRefs } from '../../../layers/sme-roster/server/utils/record-correspondence-postgres-refs'
import { readFixtureAudit } from './fixtures/postgres-audit'
import { useIsolatedPostgresCases, singlePostgresFixtureRow } from '../../support/isolated-postgres-cases'
const createDb = useIsolatedPostgresCases()
const fixture = () => nativeCorrespondenceFixture(createDb())

it('commits native endpoints with immutable audit and idempotent receipt', async () => {
 const f=await fixture(), row=await f.add(), request=f.request('confirmed',[{action:'create',status:'confirmed',edge:f.edge(row.id)}])
 const plan=await preflightPostgresCorrespondences(f.db,request), receipt=await commitPostgresCorrespondences(f.db,request,plan.planHash)
 const audit=await readFixtureAudit(f.db,receipt.correspondenceIds[0]!)
 expect(await listPostgresCorrespondences(f.db,{})).toMatchObject([{relationId:row.id,status:'confirmed',revision:2,requiresRevalidation:false}])
 expect(audit).toHaveLength(2)
 expect(await commitPostgresCorrespondences(f.db,request,plan.planHash)).toEqual(receipt)
 expect(await readFixtureAudit(f.db,receipt.correspondenceIds[0]!)).toEqual(audit)
})
it('keeps a new native content version independent of the old confirmed decision', async () => {
 const f=await fixture(), old=await f.add(), receipt=await f.save(f.request('old',[{action:'create',status:'confirmed',edge:f.edge(old.id)}]))
 const before=(await readPostgresCorrespondenceRefs(f.db,[receipt.correspondenceIds[0]!]))[0], audit=await readFixtureAudit(f.db,before!.id)
 const changed=await f.add({status:'终审不通过'})
 expect(changed.id).not.toBe(old.id)
 expect(await listPostgresCorrespondences(f.db,{relationId:changed.id})).toEqual([])
 expect((await readPostgresCorrespondenceRefs(f.db,[before!.id]))[0]).toEqual(before)
 await f.save(f.request('changed',[{action:'create',status:'rejected',edge:f.edge(changed.id)}]))
 expect((await listPostgresCorrespondences(f.db,{})).map(r=>[r.relationId,r.status])).toEqual([[old.id,'confirmed'],[changed.id,'rejected']])
 expect(await readFixtureAudit(f.db,before!.id)).toEqual(audit)
})
it('rejects cross-title native endpoints before recording a decision', async () => {
 const f=await fixture(), row=await f.add({rdjb:'1',titleCode:'innovative_sme'})
 await expect(f.save(f.request('wrong-title',[{action:'create',status:'confirmed',edge:f.edge(row.id)}]))).rejects.toThrowError(expect.objectContaining({code:'title_conflict'}))
 expect(await listPostgresCorrespondences(f.db,{})).toEqual([])
})
it('requires current revisions and preserves manual unlink audit', async () => {
 const f=await fixture(),row=await f.add(),id=(await f.save(f.request('create',[{action:'create',status:'confirmed',edge:f.edge(row.id)}]))).correspondenceIds[0]!
 await expect(f.save(f.request('stale',[{action:'decide',correspondenceId:id,expectedRevision:1,status:'unlinked'}]))).rejects.toThrowError(expect.objectContaining({code:'stale_revision'}))
 await f.save(f.request('unlink',[{action:'decide',correspondenceId:id,expectedRevision:2,status:'unlinked'}]))
 expect((await readPostgresCorrespondenceRefs(f.db,[id]))[0]).toMatchObject({status:'unlinked',revision:3})
 expect((await readFixtureAudit(f.db,id)).at(-1)).toMatchObject({fromStatus:'confirmed',toStatus:'unlinked',expectedRevision:2,resultingRevision:3})
})
it('invalidates a frozen preflight when official source facts change', async () => {
 const f=await fixture(),row=await f.add(),request=f.request('stale-source',[{action:'create',status:'confirmed',edge:f.edge(row.id)}]),plan=await preflightPostgresCorrespondences(f.db,request)
 await f.db.update(schema.recordEvent).set({batchSeq:2}).where(eq(schema.recordEvent.id,f.event.id))
 await expect(commitPostgresCorrespondences(f.db,request,plan.planHash)).rejects.toThrowError(expect.objectContaining({code:'plan_mismatch'}))
 expect(await listPostgresCorrespondences(f.db,{})).toEqual([])
})
it('rejects a native row explicitly assigned to another enterprise', async () => {
 const f=await fixture(),other=singlePostgresFixtureRow(await f.db.insert(schema.enterprise).values({name:'另一合成企业',nameNorm:'另一合成企业',usccNorm:'91330200987654321B'}).returning())
 const row=await f.add({enterpriseId:other.id})
 await expect(f.save(f.request('wrong-owner',[{action:'create',status:'confirmed',edge:f.edge(row.id)}]))).rejects.toThrowError(expect.objectContaining({code:'identity_conflict'}))
 expect(await listPostgresCorrespondences(f.db,{})).toEqual([])
})
