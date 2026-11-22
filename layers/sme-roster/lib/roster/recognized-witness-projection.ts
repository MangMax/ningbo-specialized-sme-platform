import { normalizeUscc } from '../domain'
import type { RecognizedWitnessReader, RecognizedWitnessResult } from './recognized-witness-reader'
import type { RecognizedWitnessRow } from './recognized-witness-target'

const SUPPORTED_RULE='recognized-witness-input-v1'

export class TargetRecognizedWitnessGap extends Error {
 constructor(readonly relationId:number|null,readonly reason:string){super(`Recognized witness gap ${relationId??'catalog'}: ${reason}`)}
}
/** Fixed UTF16LE code-unit decoder: does not perform Unicode replacement or v8/JSON decoding. */
export function witnessPropertyKey(hex:string):string {
 if(hex.length%4!==0||/[^0-9a-f]/.test(hex))throw new TargetRecognizedWitnessGap(null,'invalid_property_key')
 const units:string[]=[]
 for(let i=0;i<hex.length;i+=4)units.push(String.fromCharCode(Number.parseInt(hex.slice(i+2,i+4)+hex.slice(i,i+2),16)))
 return units.join('')
}
function sourceError(name:string|null,message:string|null):Error {
 const text=message??'Witness source error'
 if(name==='TypeError')return new TypeError(text)
 if(name==='RangeError')return new RangeError(text)
 if(name==='SqliteError')return Object.assign(new Error(text), { name, code: 'SQLITE_ERROR' })
 const error=new Error(text);error.name=name??'Error';return error
}
function condition(id:number,kind:string|null,value:unknown):unknown {
 const ok=kind==='absent'||kind==='null'?value===null
  :kind==='text'||kind==='array'||kind==='object'?typeof value==='string'
  :kind==='integer'||kind==='real'?typeof value==='number'
  :kind==='true'?value===1:kind==='false'?value===0:false
 if(!ok)throw new TargetRecognizedWitnessGap(id,'condition_capture')
 return value
}
type WitnessInput = Parameters<RecognizedWitnessReader['readMany']>[0]

const unavailable=(reason:Extract<RecognizedWitnessResult,{kind:'unavailable'}>['reason']):RecognizedWitnessResult=>({kind:'unavailable',reason})

export function projectRecognizedWitnesses(input: WitnessInput, rows: RecognizedWitnessRow[]) {
  const ids = [...new Set(input.relationIds)]
  const found = new Map<number, RecognizedWitnessResult | Error>()
  for(const row of rows) {
   try {
   const id=row.relationId
   let result:RecognizedWitnessResult
   if(row.assignmentId===null)throw new TargetRecognizedWitnessGap(id,'assignment_missing')
   if(row.enterpriseId!==input.enterpriseId&&!(row.enterpriseId===null&&input.uscc!==null&&(normalizeUscc(row.uscc)||null)===input.uscc))result=unavailable('owner')
   else if(row.verification!=='confirmed')result=unavailable('unconfirmed')
   else if(row.interface!=='recognized_list'||row.status!=='success')result=unavailable('not_applicable')
   else if(row.rule!==SUPPORTED_RULE)throw new TargetRecognizedWitnessGap(id,'unsupported_capture_rule')
   else if(row.state==='uncaptured')result=unavailable('evidence_uncaptured')
   else {
    if(row.archiveId===null||row.refId!==row.archiveId||row.sealed!==1||row.archiveOwner!==row.archiveId||row.sha!==row.archiveSha)throw new TargetRecognizedWitnessGap(id,'collection_binding')
    if(row.state==='error')throw sourceError(row.errorName,row.error)
    if(row.state!=='captured'||(row.gate!==0&&row.gate!==1))throw new TargetRecognizedWitnessGap(id,'collection_state')
    if(row.gate!==1)result=unavailable('not_applicable')
    else if(row.identity!=='resolved'||row.content!=='verified'||row.recordInterface!=='recognized_list'||row.projectionId===null)result=unavailable('unverified')
    else if(row.yearAbsent===null)result=unavailable('fidelity_uncaptured')
    else {
     if(row.positionRule!==SUPPORTED_RULE||row.positionCollection!==row.collectionId||row.positionSequence!==row.sequenceNo||row.positionArchive!==row.archiveId||row.positionSha!==row.sha)throw new TargetRecognizedWitnessGap(id,'position_binding')
     if(row.positionState==='error')throw sourceError(row.positionErrorName,row.positionError)
     if(row.positionState==='rejected')result=unavailable('position_rejected')
     else {
      if(row.queryId===null)throw new TargetRecognizedWitnessGap(id,'query_alias_missing')
      if(row.positionState!=='matched'&&row.positionState!=='unmatched')throw new TargetRecognizedWitnessGap(id,'position_state')
      if(row.positionState==='matched'&&(row.ordinal===null||row.pageKind===null))throw new TargetRecognizedWitnessGap(id,'position_metadata')
      result={kind:'available',source:{queryId:row.queryId,titleCode:row.titleCode,rdjb:row.rdjb,sequenceNo:row.sequenceNo,
       conditionValidYear:condition(id,row.validKind,row.valid),conditionMaintenanceYear:condition(id,row.yearKind,row.year),conditionMaintenanceBatch:condition(id,row.batchKind,row.batch),
       rawValid:row.rawValid,rawMaintenanceYear:row.yearAbsent?null:0,rawMaintenanceBatch:row.rawMaintenanceBatch,
       position:row.positionState==='unmatched'?{state:'unmatched'}:{state:'matched',ordinal:row.ordinal!,pageKind:row.pageKind!,rdjbKey:row.key===null?null:witnessPropertyKey(row.key)}}}
     }
    }
   }
   found.set(id,result)
   }catch(error){if(!(error instanceof Error))throw error;found.set(row.relationId,error)}
  }
  const ordered=new Map<number,RecognizedWitnessResult>()
  for(const id of ids){const result=found.get(id);if(result instanceof Error)throw result;ordered.set(id,result??unavailable('missing'))}
  return ordered
}
