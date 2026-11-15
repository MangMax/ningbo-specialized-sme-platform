import Database from 'better-sqlite3'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'
import { preRetirementFixture } from '../runtime-boundary/fixtures/pre-retirement'
import { completeReconcileSlotCapture, readSlotCapture, verifyReconcileHistory } from '../../../upgrade/reconcile-slot-capture'

it('captures complete original pages misses and non-slot sources without rewriting the frozen source', () => {
 const f=preRetirementFixture(false),before=readFileSync(f.source)
 const options={source:f.source,target:f.target,runId:'capture',collectionRunId:'c'}
 expect(completeReconcileSlotCapture(options).state).toBe('complete')
 const t=new Database(f.target),s=new Database(f.source,{readonly:true})
 try {
  expect(readSlotCapture(t,1)).toMatchObject({state:'verified',rowCount:1,reason:null})
  expect(readSlotCapture(t,2)).toMatchObject({state:'miss',rowCount:1,reason:'legacy_slot_not_complete'})
  expect(readSlotCapture(t,3)).toMatchObject({state:'uncaptured',rowCount:null,reason:'not_legacy_slot'})
  verifyReconcileHistory(s,t,true)
  expect(t.pragma('foreign_key_check')).toEqual([])
 } finally {s.close();t.close()}
 expect(readFileSync(f.source).equals(before)).toBe(true)
 const completed=readFileSync(f.target)
 completeReconcileSlotCapture(options)
 expect(readFileSync(f.target).equals(completed)).toBe(true)
},120000)

it('rolls back failed completion then resumes the same frozen source and run', () => {
 const f=preRetirementFixture(false),before=readFileSync(f.target)
 const options={source:f.source,target:f.target,runId:'capture',collectionRunId:'c'}
 expect(()=>completeReconcileSlotCapture({...options,beforeCommit:()=>{throw new Error('publication failure')}})).toThrow('publication failure')
 expect(readFileSync(f.target).equals(before)).toBe(true)
 expect(completeReconcileSlotCapture(options).state).toBe('complete')
})

it('completed replay preserves subsequent business writes and refuses a changed source', () => {
 const f=preRetirementFixture(),options={source:f.source,target:f.target,runId:'capture',collectionRunId:'c'}
 const t=new Database(f.target)
 t.exec("INSERT INTO enterprise(id,name,name_norm) VALUES(99,'Later','later')");t.close()
 const before=readFileSync(f.target)
 completeReconcileSlotCapture(options)
 expect(readFileSync(f.target).equals(before)).toBe(true)
 const s=new Database(f.source);s.exec("UPDATE platform_relation SET raw_fields='{}' WHERE id=1");s.close()
 expect(()=>completeReconcileSlotCapture(options)).toThrow()
 expect(readFileSync(f.target).equals(before)).toBe(true)
})

it('independent offline CLI completes and replays with the same source binding', () => {
 const f=preRetirementFixture(false),evidence=join(f.root,'cli');mkdirSync(evidence)
 const args=['upgrade/run.mjs','complete-reconcile-slot',f.source,f.target,evidence,'capture','c']
 execFileSync(process.execPath,args,{stdio:'pipe'})
 const before=readFileSync(f.target)
 const receipt=JSON.parse(readFileSync(join(evidence,'receipt.json'),'utf8'))
 expect(receipt.transform_version).toBe('reconcile-slot-capture-v1')
 expect(completeReconcileSlotCapture({source:f.source,target:f.target,runId:'capture',collectionRunId:'c'})).toEqual(receipt)
 expect(readFileSync(f.target).equals(before)).toBe(true)
})
