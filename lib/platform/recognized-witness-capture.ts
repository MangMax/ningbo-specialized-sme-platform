import { serialize } from 'node:v8'
/** #733 A only: frozen mixed SQLite/JS witness grammar at ingest/offline/replay. */
import type Database from 'better-sqlite3'
import { z } from 'zod'
export const WITNESS_RULE = 'recognized-witness-input-v1'
export const witnessConditionNames = ['rddqrq','whpcyear','whpc'] as const
export type WitnessValue = { kind: 'absent'|'null'|'text'|'number'|'boolean'|'array'|'object'; value: string|number|Buffer|null }
const sqlNumber=z.custom<number>(value=>typeof value==='number')
const sqlRow = z.object({ gate:z.number().nullable(), pages:z.union([z.string(),sqlNumber,z.null()]),
 rddqrq_kind:z.string().nullable(),rddqrq:z.union([z.string(),sqlNumber,z.null()]),
 whpcyear_kind:z.string().nullable(),whpcyear:z.union([z.string(),sqlNumber,z.null()]),
 whpc_kind:z.string().nullable(),whpc:z.union([z.string(),sqlNumber,z.null()]) })
export function captureWitnessInputs(t: Database.Database, evidence: string|Buffer|null, storage: 'text'|'blob'|'null'=typeof evidence==='string'?'text':evidence===null?'null':'blob') {
 try {
  // SQL outputs intentionally precede JS parsing: first duplicate key and JSON5.
  const r=sqlRow.parse(t.prepare(`WITH original(e) AS (VALUES(CASE WHEN @storage='text' THEN CAST(@e AS TEXT) ELSE @e END)) SELECT
   (json_extract(e,'$.source')='queryBusList' AND json_extract(e,'$.status')='success' AND json_extract(e,'$.completeness')='complete' AND json_extract(e,'$.fullRange')=1 AND json_extract(e,'$.effectiveConditions.combination')='and') gate,
   json_extract(e,'$.pages') pages,
   json_type(e,'$.effectiveConditions.rddqrq') rddqrq_kind,json_extract(e,'$.effectiveConditions.rddqrq') rddqrq,
   json_type(e,'$.effectiveConditions.whpcyear') whpcyear_kind,json_extract(e,'$.effectiveConditions.whpcyear') whpcyear,
   json_type(e,'$.effectiveConditions.whpc') whpc_kind,json_extract(e,'$.effectiveConditions.whpc') whpc FROM original`).get({e:evidence,storage}))
  return {state:'captured' as const,gate:r.gate===1?1:0,pages:r.pages,conditions:{rddqrq:{kind:r.rddqrq_kind??'absent',value:r.rddqrq},whpcyear:{kind:r.whpcyear_kind??'absent',value:r.whpcyear},whpc:{kind:r.whpc_kind??'absent',value:r.whpc}},errorName:null,error:null}
 } catch(error) {
  if(!(error instanceof Error)||error.message!=='malformed JSON')throw error
  return {state:'error' as const,gate:null,pages:null,conditions:{rddqrq:{kind:'absent',value:null},whpcyear:{kind:'absent',value:null},whpc:{kind:'absent',value:null}},errorName:error.name,error:error.message}
 }
}
export function witnessValue(value:unknown):WitnessValue {
 if(value===undefined)return {kind:'absent',value:null}
 if(value===null)return {kind:'null',value:null}
 if(typeof value==='string')return {kind:'text',value:serialize(value)}
 if(typeof value==='number')return {kind:'number',value:serialize(value)}
 if(typeof value==='boolean')return {kind:'boolean',value:serialize(value)}
 if(typeof value==='object')return {kind:Array.isArray(value)?'array':'object',value:serialize(value)}
 throw new Error('Non-JSON witness value')
}
const prop=(value:unknown,key:string):unknown=>{
 if(value===null||value===undefined)throw new TypeError(`Cannot read properties of ${value} (reading '${key}')`)
 return Reflect.get(Object(value),key)
}
function primitive(value:unknown):string|number|boolean|null|undefined {
 if(value===null||value===undefined||typeof value==='number'||typeof value==='boolean'||typeof value==='string')return value
 return String(value)
}
export function captureWitnessPosition(input:ReturnType<typeof captureWitnessInputs>,sequence:number) {
 const empty={ordinal:null,rdjb:witnessValue(undefined),page:witnessValue(undefined),rdjbKey:null,errorName:null,error:null}
 if(input.state==='error')return {...empty,state:'error',errorName:input.errorName,error:input.error}
 if(input.gate!==1)return {...empty,state:'not_applicable'}
 let pages:unknown
 try {pages=input.pages?JSON.parse(String(input.pages)):null} catch {return {...empty,state:'rejected'}}
 if(!Array.isArray(pages))return {...empty,state:'unmatched'}
 let offset:string|number=0
 try {
  for(const [ordinal,p] of pages.entries()) {
   if(prop(p,'status')!=='success')continue
   const count=primitive(prop(p,'fetchedCount'))
   offset=typeof offset==='string'||typeof count==='string'?String(offset)+String(count):Number(offset)+Number(count)
   if(sequence>0&&sequence<=Number(offset)) {
    const rdjb=prop(p,'rdjb'),page=prop(p,'page')
    return {...empty,state:'matched',ordinal,rdjb:witnessValue(rdjb),page:witnessValue(page),rdjbKey:rdjb?String(rdjb):null}
   }
  }
  return {...empty,state:'unmatched'}
 }catch(error){if(!(error instanceof Error))throw error;return {...empty,state:'error',errorName:error.name,error:error.message}}
}
