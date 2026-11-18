import { BUSINESS_STATUS_V1, BUSINESS_STATUS_V2 } from '../db/business-status'
import { businessStatusRule } from './business-status-catalog'
import { RECONCILE_SLOT_T04 } from './frozen/reconcile-slot-capture'
/** Source-only recovery from operator-owned fixed artifacts. Tokens prove source binding,
 * not writer exclusion; plain cells or caller assertions cannot mint this binding. */
import type Database from 'better-sqlite3'
import {statSync} from 'node:fs'
import {z} from 'zod'
import {withFrozenSource,assertFrozenSource,fileHash,type FrozenSource} from './frozen-source'
import {rowSnapshot,observationManifest,schemaHash} from '../layers/sme-roster/lib/platform/sqlite-row-cells'
const active=new WeakMap<object,{legacy:FrozenSource,predecessor:FrozenSource,hash:string}>()
export type LegacyFingerprintCustody=object
const receipt=z.object({state:z.literal('complete'),source_snapshot_sha256:z.string(),source_schema_hash:z.string(),source_manifest_sha256:z.string()})
export function withLegacyFingerprintCustody<T>(predecessor:FrozenSource,path:string,action:(custody:LegacyFingerprintCustody,legacy:FrozenSource)=>T):T {
 assertFrozenSource(predecessor,predecessor.path)
 const a=statSync(predecessor.path),b=statSync(path)
 if(a.dev===b.dev&&a.ino===b.ino)throw new Error('Distinct legacy source required')
 return withFrozenSource(path,legacy=>{
  const t=legacy.database,hash=fileHash(legacy.fd),schema=schemaHash(t)
  // A copied finalized target retains phase/receipts; a renamed or marker-downgraded
  // file still cannot match the original source hash bound by the receipt chain.
  if(t.pragma('user_version',{simple:true})!==0||t.prepare('SELECT 1 FROM platform_migration_run LIMIT 1').get())throw new Error('Finalized target is not a legacy source')
  const businessRuns=predecessor.database.prepare("SELECT * FROM platform_migration_run WHERE transform_version LIKE 't05b-%'").all()
  const selected=z.array(receipt.extend({transform_version:z.enum([BUSINESS_STATUS_V1,BUSINESS_STATUS_V2])})).length(1).parse(businessRuns)[0]!
  if(selected.transform_version!==businessStatusRule(predecessor.database))throw new Error('Legacy predecessor business catalog/transform conflict')
  const collections=predecessor.database.prepare("SELECT transform_version FROM platform_migration_run WHERE transform_version IN ('t04-collection-v1',?)").all(RECONCILE_SLOT_T04) as {transform_version:string}[]
  if(collections.length!==1)throw new Error('Unique legacy collection transform required')
  for(const transform of [collections[0]!.transform_version,'t05a-observation-v3',selected.transform_version,'t05c-independent-observation-v1','w4a-pre-collection-scopes-v1']) {
   const rows=predecessor.database.prepare('SELECT * FROM platform_migration_run WHERE transform_version=?').all(transform)
   if(rows.length!==1)throw new Error('Legacy predecessor receipt chain missing '+transform)
   const r=receipt.parse(rows[0])
   if(r.source_snapshot_sha256!==hash||r.source_schema_hash!==schema||(transform==='t05a-observation-v3'&&r.source_manifest_sha256!==observationManifest(t).digest))throw new Error('Legacy source provenance binding conflict '+transform)
  }
  const token=Object.freeze({});active.set(token,{legacy,predecessor,hash})
  try{return action(token,legacy)}finally{active.delete(token)}
 })
}
export function legacyCustodyCells(custody:LegacyFingerprintCustody,t:Database.Database,oldId:number){
 const proof=active.get(custody)
 if(!proof||proof.predecessor.database!==t)throw new Error('Inactive or foreign legacy fingerprint custody')
 assertFrozenSource(proof.predecessor,proof.predecessor.path)
 assertFrozenSource(proof.legacy,proof.legacy.path)
 if(fileHash(proof.legacy.fd)!==proof.hash)throw new Error('Legacy custody source drift')
 return rowSnapshot(proof.legacy.database,'platform_relation','id',oldId)
}

export function assertLegacyFingerprintCustody(custody:LegacyFingerprintCustody|undefined,predecessor:FrozenSource,legacy:FrozenSource){
 const proof=custody?active.get(custody):undefined
 if(!proof||proof.predecessor!==predecessor||proof.legacy!==legacy)throw new Error('Inactive or foreign legacy fingerprint custody')
 assertFrozenSource(predecessor,predecessor.path);assertFrozenSource(legacy,legacy.path)
 if(fileHash(legacy.fd)!==proof.hash)throw new Error('Legacy custody source drift')
}
