import Database from 'better-sqlite3'
import { closeSync, openSync, writeFileSync, writeSync } from 'node:fs'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { asc, gt } from 'drizzle-orm'
import * as schema from './legacy-schema'
import { withFrozenSource } from './collections'
import { observationManifest, upgradeObservations } from './observations'

const [source,target,evidence,runId,collectionRunId,batch] = process.argv.slice(2)
if(!source||!target||!evidence||!runId||!collectionRunId) throw new Error('Usage: node upgrade/run-observations.mjs FROZEN_SOURCE EXISTING_T04_TARGET NEW_EVIDENCE_DIRECTORY RUN_ID T04_RUN_ID [BATCH_SIZE=100]')
// T04 owns exclusive copying/migration. This command requires its completed isolated target.
withFrozenSource(source,frozen=>{
  const fd=openSync(`${evidence}/source-manifest.jsonl`,'wx')
  try{observationManifest(frozen.database,line=>writeSync(fd,line+'\n'))}finally{closeSync(fd)}
  const receipt=upgradeObservations({source,target,runId,collectionRunId,batchSize:Number(batch??100)},frozen)
  writeFileSync(`${evidence}/receipt.json`,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'})
  const t=new Database(target,{readonly:true,fileMustExist:true}),out=openSync(`${evidence}/mapping.jsonl`,'wx')
  try {
    const db=drizzle(t,{schema})
    let cursor=0
    while(true) {
      const o=schema.platformBusinessObservation
      const rows=db.select().from(o).where(gt(o.relationId,cursor)).orderBy(asc(o.relationId)).limit(100).all()
      if(!rows.length) break
      for(const row of rows) writeSync(out,JSON.stringify(row)+'\n')
      cursor=rows.at(-1)!.relationId
    }
  }finally{closeSync(out);t.close()}
  process.stdout.write(JSON.stringify(receipt)+'\n')
  if(receipt.state!=='complete') process.exitCode=2
})
