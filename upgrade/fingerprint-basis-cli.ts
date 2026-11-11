/** Evidence directory is exclusive: never replace an earlier failure or receipt. */
import Database from 'better-sqlite3'
import { mkdirSync, writeFileSync } from 'node:fs'
import { finalizeFingerprintBasis, fingerprintArchiveInventory } from './fingerprint-basis'
import { projectionManifest } from './projections'
import { withFrozenSource } from './collections'
import { finalizationCatalog } from './finalize-observations'
const [source,target,evidence,runId,predecessorRunId,legacySource]=process.argv.slice(2)
if(!source||!target||!evidence||!runId||!predecessorRunId)throw new Error('Usage: SOURCE_71606 TARGET EVIDENCE RUN_ID PREDECESSOR_RUN_ID [FROZEN_LEGACY_SOURCE]')
mkdirSync(evidence)
const emit=(file:string,value:unknown)=>writeFileSync(`${evidence}/${file}`,JSON.stringify(value,null,2)+'\n',{flag:'wx'})
function capture(path:string,prefix:string,connection?:Database.Database) {
  const t=connection??new Database(path,{readonly:true,fileMustExist:true})
  try {
    const lines:string[]=[];projectionManifest(t,line=>lines.push(line))
    writeFileSync(`${evidence}/${prefix}-manifest.jsonl`,lines.join('\n')+'\n',{flag:'wx'})
    emit(`${prefix}-catalog.json`,{catalog:finalizationCatalog(t),foreignKeys:finalizationCatalog(t).filter(x=>x.type==='table').map(x=>({table:x.name,foreignKeys:t.pragma(`foreign_key_list("${x.name}")`)}))})
  } finally {if(!connection)t.close()}
}
withFrozenSource(source,frozen=>{
 capture(source,'source',frozen.database);capture(target,'before-target')
 try {
  const receipt=finalizeFingerprintBasis({source,target,runId,predecessorRunId,legacySource},frozen)
  capture(target,'target')
  const t=new Database(target,{readonly:true,fileMustExist:true})
  try {emit('archive-inventory.json',fingerprintArchiveInventory(t))}finally{t.close()}
  emit('receipt.json',receipt);process.stdout.write(JSON.stringify(receipt)+'\n')
} catch(error) {
  capture(target,'failed-target');emit('failure.json',{message:error instanceof Error?error.message:String(error)})
  throw error
}
})
