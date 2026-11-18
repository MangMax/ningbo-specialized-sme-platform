import { nativeCorrespondenceFixture } from '../../roster/correspondence/fixtures/native-correspondence'
import { submitNativePlatformQuery } from './native-query'
import type { RosterImportPlatformQuery } from '../../../lib/roster-import-client'
import { listTargetDeclarations, getTargetDeclaration } from '../../../layers/sme-roster/server/utils/platform-declarations-target'
import { listTargetBusinessProcesses, getTargetBusinessProcess } from '../../../layers/sme-roster/server/utils/platform-business-processes-target'
import { listTargetRecognizedDirectory, getTargetRecognizedRecord } from '../../../layers/sme-roster/server/utils/platform-recognized-target'
import { startHttpFixture } from '../../support/http'
import { declarationFilterFromQuery } from '../../../layers/sme-roster/lib/platform/declarations'
import { businessProcessFilterFromQuery } from '../../../layers/sme-roster/lib/platform/business-processes'
import { recognizedDirectoryFilterFromQuery } from '../../../layers/sme-roster/lib/platform/recognized-directory'

export type NativeSource = 'apply_list' | 'business_list' | 'recognized_list'
export function nativeCatalogFixture() {
 const f=nativeCorrespondenceFixture();let sequence=0
 const query=(source:NativeSource,raw:Record<string,unknown>,scope:'1'|'2'|'3'='2'):RosterImportPlatformQuery=>{
  const n=++sequence,at=`2026-10-21T00:${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}Z`
  const row={sequenceNo:1,relationKey:typeof raw.id==='string'?raw.id:null,enterpriseId:f.enterprise.id,nameRaw:typeof raw.qymc==='string'?raw.qymc:null,usccRaw:typeof raw.tyshxydm==='string'?raw.tyshxydm:null,rawFields:raw,matchBasis:'uscc' as const,verificationStatus:'confirmed' as const}
  return {interface:source,queryKey:f.enterprise.usccNorm!,queriedAt:at,rdjb:scope,titleCode:scope==='1'?'innovative_sme':scope==='3'?'little_giant':'specialized_sme',status:'success',rawResponse:'Explicit synthetic source response',relations:[row],...(source==='recognized_list'?{collectionEvidence:{source:'queryBusList' as const,status:'success' as const,effectiveConditions:{uscc:f.enterprise.usccNorm!,combination:'and' as const},titleScope:{mode:'selected' as const,rdjb:[scope]},queriedAt:at,completedAt:at,rows:[Object.fromEntries(Object.entries(raw).map(([key,value])=>[key,value==null?'':typeof value==='string'?value:JSON.stringify(value)]))],pages:[{source:'queryBusList' as const,rdjb:scope,page:1,maxPage:1,status:'success' as const,fetchedCount:1,declaredTotal:1,error:null}],fetchedCount:1,declaredTotal:1,completeness:'complete' as const,fullRange:true,unfinished:[],error:null,limits:{maxRequests:1,maxRows:50,maxDurationMs:1000,pageSize:50}}}:{} )}
 }
 const raw=(key='CATALOG-1',fields:Record<string,unknown>={})=>({id:key,qymc:f.enterprise.name,tyshxydm:f.enterprise.usccNorm,rdjb:'2',...fields})
 const seed=(source:NativeSource,fields:Record<string,unknown>,scope:'1'|'2'|'3'='2')=>submitNativePlatformQuery(f.db,query(source,fields,scope))
 const list=(source:NativeSource,filter:unknown={})=>source==='apply_list'?listTargetDeclarations(filter,f.db):source==='business_list'?listTargetBusinessProcesses(filter,f.db):listTargetRecognizedDirectory(filter,f.db)
 const detail=(source:NativeSource,id:number)=>source==='apply_list'?getTargetDeclaration(f.db,id):source==='business_list'?getTargetBusinessProcess(f.db,id):getTargetRecognizedRecord(f.db,id)
 const http=()=>startHttpFixture({getRoutes:{'/catalog':request=>{const source=request.query.source;const {source:_,...query}=request.query
  const body=source==='apply_list'?listTargetDeclarations(declarationFilterFromQuery(query),f.db):source==='business_list'?listTargetBusinessProcesses(businessProcessFilterFromQuery(query),f.db):listTargetRecognizedDirectory(recognizedDirectoryFilterFromQuery(query),f.db)
  return {status:200,headers:{'cache-control':'no-store'},body}
 }}})
 return {...f,query,raw,seed,list,detail,http}
}
