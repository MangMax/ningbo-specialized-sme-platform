import { afterEach, expect, it } from 'vitest'
import { nativeCatalogFixture } from '../../helpers/native-catalog-fixture'
const fixtures:ReturnType<typeof nativeCatalogFixture>[]=[]
const fixture=()=>{const f=nativeCatalogFixture();fixtures.push(f);return f}
afterEach(()=>{for(const f of fixtures.splice(0))f.close()})

import { handleRecordCorrespondenceRequest } from '../../../server/utils/record-correspondence-api'
import { dispatchRecordCorrespondenceMcp } from '../../../server/utils/mcp-record-correspondence'
import { startHttpFixture } from '../../helpers/http-fixture'
it('native HTTP and MCP candidates expose identical scoped business provenance without private raw fields',async()=>{
 const f=fixture(),seed=f.seed('business_list',f.raw('WIRE',{sblx:'申请',year:2024,private:'PRIVATE-CANDIDATE'}))
 const input={eventId:f.event.id,queryIds:[seed.queryId],exportBatchIds:[],ruleVersion:'native'}
 const api=await startHttpFixture({routes:{'/candidates':request=>handleRecordCorrespondenceRequest({action:'candidates',method:request.method,body:request.body},{db:f.db})}})
 try{const response=await fetch(api.baseUrl+'/candidates',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});expect(response.status).toBe(200);const body=await response.json();expect(body).toEqual(dispatchRecordCorrespondenceMcp('candidates',input,{db:f.db}));expect(body).toMatchObject({total:1});expect(JSON.stringify(body)).not.toContain('PRIVATE-CANDIDATE')}finally{await api.close()}
})
