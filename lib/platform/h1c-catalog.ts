/** Fixed #744 A1 catalog proof. No runtime routing or migration executor. */
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { schemaHash } from './sqlite-row-cells'
import { processStoredInstalled, PROCESS_STORED_TRANSFORM } from './process-stored-catalog'

export const H1C_CATALOG_VERSION = 71611
export const H1C_CATALOG_TRANSFORM = 'h1c-correspondence-observation-v1'
/** Fixed accepted #744 predecessor, independently reproduced by the complete
 * migration fixture. Mutable DB receipts are not a trust root for other catalogs. */
const predecessorCatalogSha256 = 'a9af200fe3a21866bf65d9138b9b01be6738fb681f9e2bc512cd2bfa700d2776'
// Frozen physical grammar from accepted 71610 (0011 + 0016). Any other delta fails closed.
const predecessorTable = [
  "CREATE TABLE `record_correspondence` (",
  "\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,",
  "\t`edge_key` text NOT NULL,",
  "\t`type` text NOT NULL,",
  "\t`role` text NOT NULL,",
  "\t`event_id` integer,",
  "\t`predecessor_event_id` integer,",
  "\t`relation_id` integer,",
  "\t`export_row_id` integer,",
  "\t`enterprise_id` integer,",
  "\t`title_code` text NOT NULL,",
  "\t`status` text NOT NULL,",
  "\t`revision` integer NOT NULL,",
  "\t`target_identity` text NOT NULL,",
  "\t`provenance` text NOT NULL,",
  "\t`source_fingerprint` text NOT NULL,",
  "\t`rule_id` text NOT NULL,",
  "\t`rule_version` text NOT NULL,",
  "\t`created_at` text NOT NULL,",
  "\t`decided_at` text,",
  "\t`ended_at` text,",
  "\tFOREIGN KEY (`event_id`) REFERENCES `record_event`(`id`) ON UPDATE no action ON DELETE no action,",
  "\tFOREIGN KEY (`predecessor_event_id`) REFERENCES `record_event`(`id`) ON UPDATE no action ON DELETE no action,",
  "\tFOREIGN KEY (`relation_id`) REFERENCES `platform_relation`(`id`) ON UPDATE no action ON DELETE no action,",
  "\tFOREIGN KEY (`export_row_id`) REFERENCES `platform_export_row`(`id`) ON UPDATE no action ON DELETE no action,",
  "\tFOREIGN KEY (`enterprise_id`) REFERENCES `enterprise`(`id`) ON UPDATE no action ON DELETE no action,",
  "\tFOREIGN KEY (`title_code`) REFERENCES `title`(`code`) ON UPDATE no action ON DELETE no action",
  ")"
].join('\n')
const predecessorIndex = "CREATE INDEX `record_correspondence_relation_idx` ON `record_correspondence` (`relation_id`)"
const successorTable = predecessorTable.replaceAll('`relation_id`', '`observation_id`')
  .replace('REFERENCES `platform_relation`', 'REFERENCES `platform_business_observation`')
const successorIndex = predecessorIndex.replace('`relation_id`', '`observation_id`')
const catalogRow = z.object({type:z.string(), name:z.string(), tbl_name:z.string(), sql:z.string().nullable()})
const sha256 = z.string().regex(/^[0-9a-f]{64}$/)
const runSchema = z.object({
  run_id:z.string().min(1), source_snapshot_sha256:sha256, source_schema_hash:sha256,
  source_manifest_sha256:sha256, target_schema_version:sha256, transform_version:z.string(),
  state:z.literal('complete'),
})
const checkpointSchema = z.object({run_id:z.string(), phase:z.string(), source_table:z.string(),
  last_old_id:z.literal(0), copied_count:z.number().int().nonnegative().safe(), batch_digest:sha256})
function fail():never { throw new Error('h1c_catalog_binding') }
const quote = (name:string) => '"'+name.replaceAll('"','""')+'"'

/** Read-only, snapshot-scoped catalog authentication, NOT data-migration acceptance.
 * Reconstruct the entire predecessor in private memory rather than masking unrelated
 * schema changes or teaching accepted runtime consumers a new phase here. */
export type H1cCatalogBinding = {
  kind:'h1c-catalog-binding'; predecessorRunId:string; predecessorSchemaHash:string; targetSchemaHash:string
}
export function authenticateH1cCatalog(target:Database.Database): H1cCatalogBinding {
 return target.transaction(():H1cCatalogBinding => {
  if(target.pragma('user_version',{simple:true})!==H1C_CATALOG_VERSION)fail()
  const catalog=z.array(catalogRow).parse(target.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name").all())
  // Historical schemaHash omits LIKE sqlite_% matches. They are absent from the
  // fixed predecessor; reject user objects in that gap without rewriting receipts.
  if(catalog.some(row => /^sqlite[\s\S]/i.test(row.name)))fail()
  if(catalog.find(r=>r.type==='table'&&r.name==='record_correspondence')?.sql!==successorTable ||
     catalog.find(r=>r.type==='index'&&r.name==='record_correspondence_relation_idx')?.sql!==successorIndex)fail()
  const runs=target.prepare('SELECT * FROM platform_migration_run WHERE transform_version=?').all(H1C_CATALOG_TRANSFORM)
  if(runs.length!==1)fail()
  const run=runSchema.parse(runs[0]), targetSchemaHash=schemaHash(target)
  if(run.target_schema_version!==targetSchemaHash)fail()
  const checkpoints=target.prepare('SELECT * FROM platform_migration_checkpoint WHERE run_id=? ORDER BY phase,source_table').all(run.run_id)
  if(checkpoints.length!==1)fail()
  const checkpoint=checkpointSchema.parse(checkpoints[0])
  const allSuccessorCheckpoints=target.prepare("SELECT * FROM platform_migration_checkpoint WHERE phase='h1c-correspondence-fk'").all()
  if(allSuccessorCheckpoints.length!==1||checkpoint.phase!=='h1c-correspondence-fk'||checkpoint.source_table!=='record_correspondence')fail()
  const predecessors=target.prepare('SELECT * FROM platform_migration_run WHERE transform_version=?').all(PROCESS_STORED_TRANSFORM)
  if(predecessors.length!==1)fail()
  // Keep the original SQL row property order and all bytes in the digest, not a parsed/reserialized subset.
  const predecessorRun=predecessors[0], prior=runSchema.parse(predecessorRun)
  if(prior.run_id===run.run_id||prior.target_schema_version!==run.source_schema_hash)fail()
  const predecessorCheckpoints=target.prepare('SELECT * FROM platform_migration_checkpoint WHERE run_id=? ORDER BY phase,source_table').all(prior.run_id)
  if(predecessorCheckpoints.length!==1)fail()
  const priorCheckpoint=checkpointSchema.parse(predecessorCheckpoints[0])
  if(priorCheckpoint.phase!=='process-stored'||priorCheckpoint.source_table!=='platform_business_projection')fail()
  const binding={version:1,predecessorRun,predecessorCheckpoints,sourceSchemaHash:run.source_schema_hash,targetSchemaHash,copiedCount:checkpoint.copied_count}
  if(checkpoint.batch_digest!==createHash('sha256').update(JSON.stringify(binding)).digest('hex'))fail()
  const predecessor=new Database(':memory:')
  try {
   const restored=catalog.map(r=>r.name==='record_correspondence'&&r.type==='table'?{...r,sql:predecessorTable}:
     r.name==='record_correspondence_relation_idx'&&r.type==='index'?{...r,sql:predecessorIndex}:r)
   for(const type of ['table','view','index','trigger']) for(const row of restored) if(row.type===type&&row.sql!==null)predecessor.exec(row.sql)
   const predecessorSchemaHash=schemaHash(predecessor)
   if(predecessorSchemaHash!==predecessorCatalogSha256||predecessorSchemaHash!==run.source_schema_hash)fail()
   for(const table of ['platform_migration_run','platform_migration_checkpoint']) {
    const rows=target.prepare(`SELECT * FROM ${table} WHERE run_id<>?`).all(run.run_id)
    const columns=z.array(z.object({name:z.string()})).parse(predecessor.pragma(`table_info(${table})`)).map(r=>r.name)
    const insert=predecessor.prepare(`INSERT INTO ${table}(${columns.map(quote).join(',')}) VALUES(${columns.map(c=>'@'+c).join(',')})`)
    for(const row of rows)insert.run(z.record(z.string(),z.unknown()).parse(row))
   }
   predecessor.pragma('user_version=71610')
   if(!processStoredInstalled(predecessor))fail()
   return {kind:'h1c-catalog-binding',predecessorRunId:prior.run_id,predecessorSchemaHash,targetSchemaHash}
  } finally { predecessor.close() }
 }).deferred()
}
