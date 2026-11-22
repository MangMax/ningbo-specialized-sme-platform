import { expect, it, vi } from 'vitest'
import pg from 'pg'


import { nativeCorrespondenceFixture } from './fixtures/native-correspondence'
import { readPostgresCorrespondenceRefs } from '../../../layers/sme-roster/server/utils/record-correspondence-postgres-refs'
import { useIsolatedPostgresCases } from '../../support/isolated-postgres-cases'
const createDb = useIsolatedPostgresCases()
const fixture = () => nativeCorrespondenceFixture(createDb())

import { handlePostgresCorrespondenceRequest } from '../../../layers/sme-roster/server/utils/record-correspondence-runtime'
it('bounded native list pagination preserves total and only returns selected decisions', async () => {
 const f=await fixture()
 for(let n=0;n<4;n++){const row=await f.add({key:`B-${n}`});await f.save(f.request(`decision-${n}`,[{action:'create',status:'confirmed',edge:f.edge(row.id)}]))}
 const result=await handlePostgresCorrespondenceRequest({action:'list',method:'GET',query:{eventId:String(f.event.id),page:2,pageSize:2}})
 expect(result.status).toBe(200)
 expect(result.body).toMatchObject({total:4,page:2,pageSize:2})
 expect((result.body as {rows:unknown[]}).rows).toHaveLength(2)
 expect(JSON.stringify(result.body)).not.toContain('PRIVATE-COOKIE')
})
it('native refs do not hydrate archived megabytes', async () => {
 const f=await fixture(),marker='BOUNDED-NATIVE-RAW-',row=await f.add({rawPadding:marker+'x'.repeat(1024*1024),queryRaw:marker+'y'.repeat(1024*1024)})
 const id=(await f.save(f.request('bounded',[{action:'create',status:'confirmed',edge:f.edge(row.id)}]))).correspondenceIds[0]!
 let rawBytes=0
 const Client = pg.Client
 const query = Client.prototype.query
 const spy = vi.spyOn(Client.prototype, 'query').mockImplementation(function (this: pg.Client, ...args: unknown[]) {
  const callbackIndex = args.findIndex(value => typeof value === 'function')
  if (callbackIndex >= 0) {
   const callback = args[callbackIndex] as (error: unknown, result: { rows?: unknown[] }) => void
   args[callbackIndex] = (error: unknown, result: { rows?: unknown[] }) => {
    const text = JSON.stringify(result?.rows)
    if (text?.includes(marker)) rawBytes += Buffer.byteLength(text)
    callback(error, result)
   }
  }
  return Reflect.apply(query, this, args)
 } as typeof query)
 try {
  expect(await readPostgresCorrespondenceRefs(f.db, [id])).toMatchObject([{requiresRevalidation:false}])
  expect(rawBytes).toBe(0)
 } finally { spy.mockRestore() }
})
