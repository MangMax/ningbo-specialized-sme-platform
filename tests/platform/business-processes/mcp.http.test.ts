import { afterEach, expect, it } from 'vitest'
import { nativeCatalogFixture } from '../fixtures/native-catalog'
const fixtures:ReturnType<typeof nativeCatalogFixture>[]=[]
const fixture=()=>{const f=nativeCatalogFixture();fixtures.push(f);return f}
afterEach(()=>{for(const f of fixtures.splice(0))f.close()})

import { readPlatformBusinessMetadata } from '../../../layers/sme-roster/server/utils/platform-business-record-read'
it('native canonical metadata preserves original observation IDs and excludes raw archives',async()=>{
 const f=fixture(),a=f.seed('business_list',f.raw('META',{private:'PRIVATE-METADATA'})),b=f.seed('apply_list',f.raw('META'))
 const metadata=readPlatformBusinessMetadata(f.db,[a.relationIds[0]!,b.relationIds[0]!])
 expect(metadata.get(a.relationIds[0]!)).toMatchObject({interface:'business_list',platformKey:'META',identityState:'resolved',contentState:'verified'})
 expect(metadata.get(b.relationIds[0]!)!.recordId).not.toBe(metadata.get(a.relationIds[0]!)!.recordId)
 expect(JSON.stringify([...metadata.values()])).not.toContain('PRIVATE-METADATA')
 const api=await f.http();try{expect((await fetch(api.baseUrl+'/catalog?source=business_list&platformKey=META')).status).toBe(200)}finally{await api.close()}
})
