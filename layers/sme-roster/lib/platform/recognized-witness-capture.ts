import { serialize } from 'node:v8'

export const WITNESS_RULE = 'recognized-witness-input-v1'
export const witnessConditionNames = ['rddqrq','whpcyear','whpc'] as const
export type WitnessValue = { kind: 'absent'|'null'|'text'|'number'|'boolean'|'array'|'object'; value: string|number|Buffer|null }
export interface WitnessCapture {
 state: 'captured' | 'error'
 gate: number | null
 pages: string | number | null
 conditions: Record<(typeof witnessConditionNames)[number], { kind: string; value: string | number | null }>
 errorName: string | null
 error: string | null
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
export function captureWitnessPosition(input:WitnessCapture,sequence:number) {
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
