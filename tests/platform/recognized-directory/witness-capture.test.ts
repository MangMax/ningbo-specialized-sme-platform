import { deserialize } from 'node:v8'
function decode(value:unknown):unknown {if(!Buffer.isBuffer(value))throw new Error('Expected opaque witness BLOB');return deserialize(value)}
import Database from 'better-sqlite3'
import { expect, it } from 'vitest'
import { captureWitnessInputs, captureWitnessPosition } from '../../../lib/platform/recognized-witness-capture'
it('captures SQLite first gates separately from boolean facts and JS last page values', () => {
  const t = new Database(':memory:')
  try {
    const input = captureWitnessInputs(t, '{"source":"queryBusList","status":"success","completeness":"complete","fullRange":1,"effectiveConditions":{"combination":"and","rddqrq":"2028","rddqrq":"2029"},"pages":[{"status":"success","fetchedCount":1,"rdjb":"2","rdjb":"1","page":"p"}],"pages":[]}')
    expect(input.gate).toBe(1)
    expect(input.conditions.rddqrq).toEqual({ kind: 'text', value: '2028' })
    const position=captureWitnessPosition(input,1)
    expect(position).toMatchObject({state:'matched',ordinal:0,rdjb:{kind:'text'},page:{kind:'text'},rdjbKey:'1'})
    expect(decode(position.rdjb.value!)).toBe('1')
    expect(decode(position.page.value!)).toBe('p')
  } finally { t.close() }
})
import { sourcePositionForSequence } from '../../../lib/platform/recognized-evidence'
function oldPosition(pages:unknown,sequence:number) {
 if(!Array.isArray(pages))throw new Error('Historical pages fixture must be an array')
 return sourcePositionForSequence({pages},sequence)
}

it.each([
 ['text','1','text'],['number',1,'number'],['false',false,'boolean'],['null',null,'null'],['absent',undefined,'absent'],
 ['array',['1'],'array'],['object',{code:'1'},'object'],['empty','','text'],['unpaired surrogate','\ud800','text'],
] as const)('preserves original rdjb/sourcePage type value and ordinal for %s without storing a title enum',(_name,value,kind)=>{
 const t=new Database(':memory:')
 try{
  const evidence={source:'queryBusList',status:'success',completeness:'complete',fullRange:true,effectiveConditions:{combination:'and'},pages:[{status:'failed',fetchedCount:99,rdjb:'3'},{status:'success',fetchedCount:1,rdjb:value,page:value}]}
  const actual=captureWitnessPosition(captureWitnessInputs(t,JSON.stringify(evidence)),1)
  const old=oldPosition(evidence.pages,1)
  expect(old).toEqual({sourceRdjb:value,sourcePage:value})
  expect(actual).toMatchObject({state:'matched',ordinal:1,rdjb:{kind},page:{kind},rdjbKey:value?String(value):null})
  for(const captured of [actual.rdjb,actual.page])if(value==null)expect(captured.value).toBeNull();else expect(decode(captured.value!)).toEqual(value)
 }finally{t.close()}
})
it.each([
 ['absent',undefined],['null',null],['text','1'],['real',0.5],['false',false],['true',true],['array',[1]],['object',{}],
] as const)('matches independent old JS prefix coercion for %s',(_name,count)=>{
 const t=new Database(':memory:')
 try{
  const pages=[{status:'success',fetchedCount:count,rdjb:'2',page:2},{status:'success',fetchedCount:1,rdjb:'1',page:1}]
  const e={source:'queryBusList',status:'success',completeness:'complete',fullRange:true,effectiveConditions:{combination:'and'},pages}
  const old=oldPosition(pages,1),actual=captureWitnessPosition(captureWitnessInputs(t,JSON.stringify(e)),1)
  if(old.sourceRdjb===null)expect(actual.state).toBe('unmatched')
  else {expect(actual.state).toBe('matched');expect(decode(actual.rdjb.value!)).toEqual(old.sourceRdjb);expect(decode(actual.page.value!)).toEqual(old.sourcePage)}
 }finally{t.close()}
})
it('captures original parse rejection traversal error and out-of-range separately and preserves SQL Infinity types',()=>{
 const t=new Database(':memory:')
 const text=(pages:string)=>`{"source":"queryBusList","status":"success","completeness":"complete","fullRange":1,"effectiveConditions":{"combination":"and","rddqrq":1e999},"pages":${pages}}`
 try{
  const input=captureWitnessInputs(t,text('null'))
  expect(input.conditions.rddqrq).toEqual({kind:'real',value:Infinity})
  expect(captureWitnessPosition(captureWitnessInputs(t,text('"oops"')),1).state).toBe('rejected')
  expect(captureWitnessPosition(captureWitnessInputs(t,text('[null]')),1)).toMatchObject({state:'error',errorName:'TypeError',error:"Cannot read properties of null (reading 'status')"})
  expect(captureWitnessPosition(captureWitnessInputs(t,text('[]')),1).state).toBe('unmatched')
 }finally{t.close()}
})
it.each([
 ['negative zero','-0',-0],
 ['nested numeric and Unicode values','[-0,1e999,"\\ud800"]',[-0,Infinity,'\ud800']],
] as const)('preserves %s from actual SQLite pages extraction rather than a regenerated fixture',(_name,raw,value)=>{
 const t=new Database(':memory:')
 try{
  const text=`{"source":"queryBusList","status":"success","completeness":"complete","fullRange":true,"effectiveConditions":{"combination":"and"},"pages":[{"status":"success","fetchedCount":1,"rdjb":${raw},"page":${raw}}]}`
  const extracted=t.prepare("SELECT json_extract(?,'$.pages') pages").get(text) as {pages:string}
  const old=oldPosition(JSON.parse(extracted.pages),1)
  expect(old).toEqual({sourceRdjb:value,sourcePage:value})
  const position=captureWitnessPosition(captureWitnessInputs(t,text),1)
  expect(decode(position.rdjb.value)).toEqual(value);expect(decode(position.page.value)).toEqual(value)
 }finally{t.close()}
})
