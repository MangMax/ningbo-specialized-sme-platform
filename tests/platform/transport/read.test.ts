import {afterEach,expect,it} from 'vitest'
import * as schema from '../../../db/schema'
import {listPlatformQueries} from '../../../lib/platform/read'
import {nativeImportDb,businessSource,commitNativeSource} from '../../helpers/native-import'
const handles:ReturnType<typeof nativeImportDb>[]=[]
afterEach(()=>{for(const db of handles.splice(0))db.$client.close()})
function fixture(){const db=nativeImportDb();handles.push(db);return db}
it('retains repeated business observations in original sequence and keeps every collection separate',()=>{
 const db=fixture(),query=businessSource('native-read',[{sequenceNo:1,relationKey:'same',rawFields:{id:'same',qymc:'原名1'}},{sequenceNo:2,relationKey:'same',rawFields:{id:'same',qymc:'原名2'}}])
 expect(commitNativeSource(db,query,'read-first').status).toBe('committed')
 expect(commitNativeSource(db,{...query,queriedAt:'2026-06-01T00:00:00Z'},'read-later').status).toBe('committed')
 const read=listPlatformQueries(db,{queryKey:'native-read'})
 expect(read.total).toBe(2);expect(read.rows.map(row=>row.relations.map(r=>r.sequenceNo))).toEqual([[1,2],[1,2]])
 expect(read.rows[0]!.relations.map(r=>r.rawFields)).toEqual([{id:'same',qymc:'原名1'},{id:'same',qymc:'原名2'}])
 expect(read.rows[0]!.query.queriedAt).toBe('2026-06-01T00:00:00Z')
})
it.each(['failed','no_record','not_queried','partial'] as const)('keeps %s distinct with scoped counts and explicitly omitted summary relations',status=>{
 const db=fixture(),query={...businessSource(status),status,failureReason:status==='failed'?'original failure':null}
 expect(commitNativeSource(db,query,status).status).toBe('committed')
 const result=listPlatformQueries(db,{status,view:'summary'})
 expect(result).toMatchObject({total:1,counts:{[status]:1},rows:[{relationsIncluded:false,query:{status,relationCount:0},relations:[]}]})
 const id=result.rows[0]!.query.id
 expect(listPlatformQueries(db,{queryId:id,includeRawResponse:true}).rows[0]!.query.rawResponse).toBe(query.rawResponse)
 if(status==='failed')expect(result.rows[0]!.query.failureReason).toBe('original failure')
})
it('filters current assignment through public enterprise identity without changing archived raw fields',()=>{
 const db=fixture(),e=db.insert(schema.enterprise).values({name:'Current name',nameNorm:'current name',usccNorm:'91330211255994457P'}).returning().get()
 expect(commitNativeSource(db,businessSource(e.usccNorm!,[{sequenceNo:1,relationKey:'B',enterpriseId:e.id,matchBasis:'uscc',verificationStatus:'confirmed',nameRaw:'Original name',usccRaw:e.usccNorm,rawFields:{id:'B',qymc:'Original name',tyshxydm:e.usccNorm}}]),'identity').status).toBe('committed')
 const rows=listPlatformQueries(db,{enterpriseId:e.id}).rows
 expect(rows).toHaveLength(1);expect(rows[0]!.relations[0]).toMatchObject({enterpriseId:e.id,nameRaw:'Original name',matchedName:'Current name'})
 expect(listPlatformQueries(db,{enterpriseId:999}).total).toBe(0)
})
