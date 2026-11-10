import Database from 'better-sqlite3'
import { openSync, closeSync, writeSync, writeFileSync } from 'node:fs'
import { withFrozenSource } from './collections'
import { projectionManifest, upgradeProjections } from './projections'

const [source,target,evidence,runId,observationRunId,collectionRunId,batch]=process.argv.slice(2)
if(!source||!target||!evidence||!runId||!observationRunId||!collectionRunId)throw new Error('Usage: node upgrade/run-projections.mjs FROZEN_SOURCE EXISTING_T05A_TARGET NEW_EVIDENCE_DIRECTORY RUN_ID T05A_RUN_ID T04_RUN_ID [BATCH_SIZE=100]')
withFrozenSource(source,frozen=>{
  const manifest=openSync(`${evidence}/source-manifest.jsonl`,'wx')
  try{projectionManifest(frozen.database,line=>writeSync(manifest,line+'\n'))}finally{closeSync(manifest)}
  const receipt=upgradeProjections({source,target,runId,observationRunId,collectionRunId,batchSize:Number(batch??100)},frozen)
  writeFileSync(`${evidence}/receipt.json`,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'})
  const t=new Database(target,{readonly:true,fileMustExist:true}),mapping=openSync(`${evidence}/target-manifest.jsonl`,'wx')
  try{projectionManifest(t,line=>writeSync(mapping,line+'\n'))}finally{closeSync(mapping);t.close()}
  process.stdout.write(JSON.stringify(receipt)+'\n')
})
