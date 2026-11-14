import { upgradeIntegrityGate, upgradeForeignKeyFailures } from './integrity-policy'
/** #731 A explicit offline 71608 -> 71609 successor. Operator maintains no writers. */
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { existsSync, realpathSync, statSync, statfsSync } from 'node:fs'
import { dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { asc, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { z } from 'zod'
import { withFrozenSource, assertFrozenSource, fileHash, type FrozenSource } from '../lib/platform/frozen-source'
import { schemaHash } from '../lib/platform/sqlite-row-cells'
import { projectionManifest } from './projections'
import { candidateScopeObservation, candidateScopeColumns } from '../lib/platform/candidate-scope-schema'
import { candidateObservationValues, verifyCandidateObservation } from '../lib/platform/candidate-scope-write'
import { targetSchema as s } from '../lib/platform/target-schema'
import { installCandidateScopeSchema, installCandidateScopeBarriers } from './candidate-scope-schema'
import { CANDIDATE_SCOPE_VERSION } from '../db/schema-phase'
export const CANDIDATE_SCOPE_TRANSFORM = 'candidate-scope-offline-v1'
const hash = (v: string) => createHash('sha256').update(v).digest('hex')
function digest(t: Database.Database, runId: string, original=false) {
  const h = createHash('sha256')
  projectionManifest(t, line => {
    if (original) {
      const row = JSON.parse(line) as {table:string; fields:{name:string}[]}
      if (row.table === 'platform_business_observation') row.fields = row.fields.filter(c => !candidateScopeColumns.some(name => name === c.name))
      line = JSON.stringify(row)
    }
    h.update(line+'\n')
  })
  for (const table of ['platform_migration_run','platform_migration_checkpoint']) h.update(JSON.stringify(t.prepare(`SELECT * FROM ${table} WHERE run_id<>? ORDER BY run_id${table.endsWith('checkpoint')?',phase,source_table':''}`).all(runId)))
  h.update(JSON.stringify(t.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all()))
  return h.digest('hex')
}
export type CandidateScopeOptions = { source:string; target:string; runId:string; predecessorRunId:string; beforeCommit?:(stage:string)=>void }
export function finalizeCandidateScopes(options: CandidateScopeOptions, frozen?: FrozenSource): {state:'complete'; captured:number; uncaptured:number; errors:number} {
  if (!frozen) return withFrozenSource(options.source, source => finalizeCandidateScopes(options, source))
  assertFrozenSource(frozen, options.source)
  const source = realpathSync(options.source), target = realpathSync(options.target), ss=statSync(source), ts=statSync(target)
  if (ss.dev===ts.dev && ss.ino===ts.ino) throw new Error('Distinct isolated source and target required')
  if (!options.runId || !options.predecessorRunId || options.runId===options.predecessorRunId) throw new Error('Distinct run IDs required')
  for (const path of [source,target]) {
    for (const suffix of ['-wal','-journal']) if (existsSync(path+suffix) && statSync(path+suffix).size) throw new Error('Standalone fixed offline files required')
    const disk=statfsSync(dirname(path)); if (disk.bavail*disk.bsize<8*1024**3) throw new Error('Disk floor 8GiB')
  }
  const old=frozen.database, sourceHash=fileHash(frozen.fd), sourceSchema=schemaHash(old), sourceManifest=digest(old,options.runId)
  const prior=z.object({state:z.literal('complete'),transform_version:z.literal('apply-exact-stored-offline-v1'),target_schema_version:z.literal(sourceSchema)})
    .parse(old.prepare('SELECT * FROM platform_migration_run WHERE run_id=?').get(options.predecessorRunId))
  void prior
  if (old.pragma('user_version',{simple:true})!==71608) throw new Error('Completed 71608 predecessor required')
  const t=new Database(target,{fileMustExist:true})
  try {
    t.pragma('foreign_keys=ON')
    const db=drizzle(t,{schema:s})
    const checkpoint = () => ({run_id:options.runId,phase:'candidate-scope',source_table:'platform_business_observation',last_old_id:0,
      copied_count:db.select({id:s.platformBusinessObservation.id}).from(s.platformBusinessObservation).all().length,batch_digest:digest(t,options.runId)})
    const existing=t.prepare('SELECT * FROM platform_migration_run WHERE run_id=?').get(options.runId)
    if (existing) {
      z.object({state:z.literal('complete'),source_snapshot_sha256:z.literal(sourceHash),source_schema_hash:z.literal(sourceSchema),
        source_manifest_sha256:z.literal(sourceManifest),target_schema_version:z.literal(schemaHash(t)),transform_version:z.literal(CANDIDATE_SCOPE_TRANSFORM)}).parse(existing)
      if (t.pragma('user_version',{simple:true})!==CANDIDATE_SCOPE_VERSION || !isDeepStrictEqual(t.prepare('SELECT * FROM platform_migration_checkpoint WHERE run_id=?').all(options.runId),[checkpoint()])) throw new Error('Candidate successor replay/checkpoint drift')
    } else {
      if (t.pragma('user_version',{simple:true})!==71608 || schemaHash(t)!==sourceSchema || digest(t,options.runId)!==sourceManifest) throw new Error('Unproven candidate predecessor facts/catalog')
      t.transaction(() => {
        options.beforeCommit?.('authenticated')
        installCandidateScopeSchema(t)
        // The version is provisional until this transaction commits; it enables
        // only the explicit ingest-boundary helper, never ordinary runtime routing.
        t.pragma(`user_version=${CANDIDATE_SCOPE_VERSION}`)
        options.beforeCommit?.('schema')
        const observations=db.select().from(s.platformBusinessObservation).orderBy(asc(s.platformBusinessObservation.id)).all()
        for (const observation of observations) {
          const collection=db.select().from(s.platformCollection).where(eq(s.platformCollection.id,observation.collectionId)).get()
          if (!collection) throw new Error('Candidate collection owner missing')
          db.update(candidateScopeObservation).set(candidateObservationValues(db,collection,observation.sequenceNo)).where(eq(candidateScopeObservation.id,observation.id)).run()
        }
        options.beforeCommit?.('captured')
        installCandidateScopeBarriers(t)
        options.beforeCommit?.('barriers')
        if (digest(t,options.runId,true)!==sourceManifest) throw new Error('Original facts/hash/ID/bytes/receipt drift')
        if (!isDeepStrictEqual(upgradeForeignKeyFailures(t),[]) || !upgradeIntegrityGate(t)) throw new Error('Candidate successor integrity failure')
        t.prepare('INSERT INTO platform_migration_run(run_id,state,source_snapshot_sha256,source_schema_hash,source_manifest_sha256,target_schema_version,transform_version) VALUES(?,?,?,?,?,?,?)')
          .run(options.runId,'complete',sourceHash,sourceSchema,sourceManifest,schemaHash(t),CANDIDATE_SCOPE_TRANSFORM)
        t.prepare('INSERT INTO platform_migration_checkpoint(run_id,phase,source_table,last_old_id,copied_count,batch_digest) VALUES(@run_id,@phase,@source_table,@last_old_id,@copied_count,@batch_digest)').run(checkpoint())
        options.beforeCommit?.('receipt')
        assertFrozenSource(frozen,options.source)
        if (sourceHash!==fileHash(frozen.fd)) throw new Error('Frozen candidate source drift')
      }).immediate()
    }
    for (const observation of db.select({id:s.platformBusinessObservation.id}).from(s.platformBusinessObservation).all()) verifyCandidateObservation(db,observation.id)
    const rows=db.select({state:candidateScopeObservation.candidateScopeState}).from(candidateScopeObservation).all()
    assertFrozenSource(frozen,options.source)
    if (sourceHash!==fileHash(frozen.fd)) throw new Error('Frozen candidate source drift')
    return {state:'complete',captured:rows.filter(r=>r.state==='captured').length,uncaptured:rows.filter(r=>r.state==='uncaptured').length,errors:rows.filter(r=>r.state==='error').length}
  } finally { t.close() }
}
