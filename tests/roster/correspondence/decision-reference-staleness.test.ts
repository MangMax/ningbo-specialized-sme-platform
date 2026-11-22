import { expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
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
it('native refs remain tied to their decided observation after a new version arrives', async () => {
 const f=await fixture(),old=await f.add(),id=(await f.save(f.request('old-ref',[{action:'create',status:'confirmed',edge:f.edge(old.id)}]))).correspondenceIds[0]!
 const changed=await f.add({status:'终审不通过'})
 expect(await readPostgresCorrespondenceRefs(f.db,[id])).toMatchObject([{relationId:old.id,requiresRevalidation:false}])
 expect(await readPostgresCorrespondenceRefs(f.db,{eventIds:[],relationIds:[changed.id],exportRowIds:[]})).toEqual([])
})
