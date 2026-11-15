import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { candidateFixture } from './candidate-scope-upgrade'
import { finalizeCandidateScopes } from '../../../upgrade/candidate-scope'
import { finalizeRecognizedStored } from '../../../upgrade/recognized-stored'
import { finalizeRecognizedWitness } from '../../../upgrade/recognized-witness'
import { targetSchema } from '../../../upgrade/target-schema'
export async function witnessReaderFixture(seed:(old:Database.Database)=>void) {
 const f=await candidateFixture(seed);finalizeCandidateScopes(f)
 const r3=join(f.root,'r3-source.sqlite');copyFileSync(f.target,r3)
 finalizeRecognizedStored({source:r3,target:f.target,runId:'recognized',predecessorRunId:'candidate'})
 const a=join(f.root,'a-source.sqlite');copyFileSync(f.target,a)
 finalizeRecognizedWitness({source:a,target:f.target,runId:'witness',predecessorRunId:'recognized'})
 const trace:string[]=[],t=new Database(f.target,{verbose:q=>trace.push(String(q))});t.pragma('foreign_keys=ON')
 const old=new Database(f.legacySource,{readonly:true})
 return {...f,t,old,db:drizzle(t,{schema:targetSchema}),trace,close(){old.close();t.close()}}
}
