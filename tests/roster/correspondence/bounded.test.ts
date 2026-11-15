import { afterEach, expect, it } from 'vitest'


import { nativeCorrespondenceFixture } from './fixtures/native-correspondence'
import { listRecordCorrespondenceRefs } from '../../../server/utils/record-correspondence'
const fixtures: ReturnType<typeof nativeCorrespondenceFixture>[] = []
const fixture = () => { const f = nativeCorrespondenceFixture(); fixtures.push(f); return f }
afterEach(() => { for (const f of fixtures.splice(0)) f.close() })

import { handleRecordCorrespondenceRequest } from '../../../server/utils/record-correspondence-api'
it('bounded native list pagination preserves total and only returns selected decisions', () => {
 const f=fixture()
 for(let n=0;n<4;n++){const row=f.add({key:`B-${n}`});f.save(f.request(`decision-${n}`,[{action:'create',status:'confirmed',edge:f.edge(row.id)}]))}
 const result=handleRecordCorrespondenceRequest({action:'list',method:'GET',query:{eventId:String(f.event.id),page:2,pageSize:2}},{db:f.db})
 expect(result.status).toBe(200)
 expect(result.body).toMatchObject({total:4,page:2,pageSize:2})
 expect((result.body as {rows:unknown[]}).rows).toHaveLength(2)
 expect(JSON.stringify(result.body)).not.toContain('PRIVATE-COOKIE')
})
it('native refs do not hydrate archived megabytes', () => {
 const f=fixture(),marker='BOUNDED-NATIVE-RAW-',row=f.add({rawPadding:marker+'x'.repeat(1024*1024),queryRaw:marker+'y'.repeat(1024*1024)})
 const id=f.save(f.request('bounded',[{action:'create',status:'confirmed',edge:f.edge(row.id)}])).correspondenceIds[0]!
 let rawBytes=0
 const prepare=f.db.$client.prepare.bind(f.db.$client)
 f.db.$client.prepare=((query:string)=>{const statement=prepare(query);for(const method of ['get','all'] as const){const original=statement[method].bind(statement);Object.assign(statement,{[method]:(...args:unknown[])=>{const result=original(...args);const text=JSON.stringify(result);if(text?.includes(marker))rawBytes+=Buffer.byteLength(text);return result}})}return statement}) as typeof prepare
 try {expect(listRecordCorrespondenceRefs(f.db,{id})).toMatchObject([{requiresRevalidation:false}]);expect(rawBytes).toBe(0)}finally{f.db.$client.prepare=prepare}
})
