import Database from 'better-sqlite3'
import { openSync,closeSync,writeSync,writeFileSync } from 'node:fs'
import { withFrozenSource } from './collections'
import { projectionManifest } from './projections'
import { finalizeObservations,finalizeCollectionScopes,finalizationCatalog } from './finalize-observations'
const args=process.argv.slice(2),successor=args[0]==='--collection-scopes'
if(successor)args.shift()
const [source,target,evidence,runId,projectionRunId,observationRunId,collectionRunId,finalizationRunId]=args
if(successor&&!finalizationRunId)throw new Error('Collection scopes require predecessor T05C_RUN_ID as final argument')
if(!source||!target||!evidence||!runId||!projectionRunId||!observationRunId||!collectionRunId)throw new Error('Usage: node upgrade/run-finalize-observations.mjs [--collection-scopes] FROZEN_SOURCE EXISTING_T05B_TARGET NEW_EVIDENCE_DIRECTORY T05C_RUN_ID T05B_RUN_ID T05A_RUN_ID T04_RUN_ID')
withFrozenSource(source,frozen=>{
  const manifest=openSync(`${evidence}/source-manifest.jsonl`,'wx')
  try{projectionManifest(frozen.database,line=>writeSync(manifest,line+'\n'))}finally{closeSync(manifest)}
  const options={source,target,runId,projectionRunId,observationRunId,collectionRunId}
  const receipt=successor ? finalizeCollectionScopes({...options,finalizationRunId:finalizationRunId!},frozen) : finalizeObservations(options,frozen)
  const t=new Database(target,{readonly:true,fileMustExist:true}),output=openSync(`${evidence}/target-manifest.jsonl`,'wx')
  try{
    projectionManifest(t,line=>writeSync(output,line+'\n'))
    writeFileSync(`${evidence}/schema-manifest.json`,JSON.stringify({catalog:finalizationCatalog(t),foreignKeys:finalizationCatalog(t).filter(x=>x.type==='table').map(x=>({table:x.name,foreignKeys:t.pragma(`foreign_key_list("${x.name}")`)}))},null,2)+'\n',{flag:'wx'})
  }finally{closeSync(output);t.close()}
  writeFileSync(`${evidence}/receipt.json`,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'})
  process.stdout.write(JSON.stringify(receipt)+'\n')
})
