import {afterEach,expect,it} from 'vitest'
import {listPlatformQueries,MAX_FULL_QUERY_BYTES} from '../../../layers/sme-roster/lib/platform/read'
import {readPlatformQueryEvidence} from '../../../layers/sme-roster/lib/platform/evidence-read'
import {submitNativePlatformQuery} from '../fixtures/native-query'
import {nativeImportDb,businessSource} from '../../roster/imports/fixtures/native-import'
const handles:ReturnType<typeof nativeImportDb>[]=[]
afterEach(()=>{for(const db of handles.splice(0))db.$client.close()})
function fixture(){const db=nativeImportDb();handles.push(db);return db}
function bytes(db:ReturnType<typeof fixture>,queryId:number,field:'rawResponse'|'collectionEvidence'|'relation',relationId?:number){
 const parts:Buffer[]=[];let offset=0
 for(;;){const part=readPlatformQueryEvidence(db,{queryId,field,relationId,offset,length:7});if(!('data' in part))throw Error('Expected byte evidence');const data=Buffer.from(part.data,'base64');expect(data.length).toBeLessThanOrEqual(7);parts.push(data);offset+=data.length;if(!part.hasMore){expect(offset).toBe(part.totalBytes);break}}
 return Buffer.concat(parts)
}
it('reassembles exact Unicode originals and pages every repeated relation by immutable public alias',()=>{
 const db=fixture(),raw='完整原文🙂\n\\"尾部',rows=[{sequenceNo:1,relationKey:'same-key',rawFields:{id:'same-key',original:'原行1🙂'},sourceText:'原文1'},{sequenceNo:2,relationKey:'same-key',rawFields:{id:'same-key',original:'原行2🙂'},sourceText:'原文2'}]
 const result=submitNativePlatformQuery(db,{...businessSource('exact',rows),rawResponse:raw})
 expect(bytes(db,result.queryId,'rawResponse')).toEqual(Buffer.from(raw))
 expect(JSON.parse(bytes(db,result.queryId,'relation',result.relationIds[1]).toString())).toMatchObject({id:result.relationIds[1],queryId:result.queryId,sequenceNo:2,relationKey:'same-key',rawFields:rows[1]!.rawFields,sourceText:'原文2'})
 expect(readPlatformQueryEvidence(db,{queryId:result.queryId,field:'relations',pageSize:1,page:2})).toMatchObject({total:2,rows:[{id:result.relationIds[1],sequenceNo:2}]})
 expect(readPlatformQueryEvidence(db,{queryId:result.queryId,field:'rawResponse',offset:Buffer.byteLength(raw),length:1})).toMatchObject({byteLength:0,hasMore:false})
})
it('distinguishes absent source identities from invalid byte ranges',()=>{
 const db=fixture(),q=submitNativePlatformQuery(db,businessSource('ranges'))
 expect(()=>readPlatformQueryEvidence(db,{queryId:9999,field:'rawResponse'})).toThrow(/not found/)
 expect(()=>readPlatformQueryEvidence(db,{queryId:q.queryId,field:'relation',relationId:9999})).toThrow(/not found/)
 for(const input of [{offset:-1},{offset:.5},{length:0},{length:65537},{pageSize:201}])expect(()=>readPlatformQueryEvidence(db,{queryId:q.queryId,field:'rawResponse',...input})).toThrow(/Invalid/)
 expect(readPlatformQueryEvidence(db,{queryId:q.queryId,field:'collectionEvidence'})).toMatchObject({isNull:true,totalBytes:0,data:'',hasMore:false})
})
it('enforces full-read budgets while keeping summary and bounded bytes available',()=>{
 const db=fixture(),exact=submitNativePlatformQuery(db,{...businessSource('exact-budget'),rawResponse:'x'.repeat(MAX_FULL_QUERY_BYTES)})
 expect(listPlatformQueries(db,{queryId:exact.queryId,includeRawResponse:true}).rows[0]!.query.rawResponse!.length).toBe(MAX_FULL_QUERY_BYTES)
 const huge=submitNativePlatformQuery(db,{...businessSource('oversize'),rawResponse:'x'.repeat(MAX_FULL_QUERY_BYTES+1)})
 expect(()=>listPlatformQueries(db,{queryId:huge.queryId,includeRawResponse:true})).toThrow(/summary/)
 expect(listPlatformQueries(db,{queryId:huge.queryId,view:'summary'}).total).toBe(1)
 expect(readPlatformQueryEvidence(db,{queryId:huge.queryId,field:'rawResponse',length:7})).toMatchObject({byteLength:7,hasMore:true})
})
