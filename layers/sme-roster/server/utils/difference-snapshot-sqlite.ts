import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { useApplicationDb } from '../../../../db/client'
import * as s from '../../../../db/schema'
import { newJobId } from '../../../core/lib/job'
import { resolvePlatformCookie } from './platform-credential'
import { createJob, getJob, setJobResult } from '../../../core/server/utils/job-store'
import { enqueuePersistedJob, ensureJobRunnerReady, requeueFinishedJob, type JobSpec } from '../../../core/server/utils/job-runner'
import { getJobSpec, registerJob } from '../../../core/server/utils/job-spec-registry'
import { preflightRosterImport, commitRosterImport } from './roster-import'
type Db = ReturnType<typeof useApplicationDb>
import { mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { and, eq, sql } from 'drizzle-orm'
import { reuseCollectedPlatformResult } from './platform-collection-reuse-sqlite'
import { differenceSnapshotSpec, fail, initialSnapshot, runSnapshot, snapshotInput, SNAPSHOT_KIND, type Receipt, type Scope } from './difference-snapshot'

const sqliteSnapshotSpec: JobSpec = { ...differenceSnapshotSpec,
  async run(ctx) {
    const row = getJob(ctx.db,ctx.jobId)!
    const cookie = resolvePlatformCookie(undefined, { db: ctx.db })
    const checkpoint = (result:Receipt) => { setJobResult(ctx.db,ctx.jobId,result) }
    return runSnapshot({ ...ctx,checkpoint,admit(stored,owner,request,result) {
      ctx.db.transaction(() => {
        if (request && !reuseCollectedPlatformResult(ctx.db,stored,owner)) {
          const preflight = preflightRosterImport(ctx.db,request)
          if (preflight.status !== 'preflight') fail(409,'Business collection preflight failed')
          const committed = commitRosterImport(ctx.db,request,[],{ deferCandidateTasks:true })
          if (committed.status !== 'committed') fail(409,'Business collection commit failed')
        }
        checkpoint(result)
      })
    } },row.result as Receipt,cookie)
  },
}

// Serialize backup + freeze + create inside this process, including duplicate concurrent requests.
let submission: Promise<unknown> = Promise.resolve()
export async function snapshotOperation(db: Db, filesDir: string, raw: unknown) {
  const parsed = snapshotInput.safeParse(raw)
  if (!parsed.success) return fail(400, 'Invalid snapshot action or parameters')
  const input = parsed.data
  if (!getJobSpec(SNAPSHOT_KIND)?.run) registerJob(sqliteSnapshotSpec)
  if (input.action !== 'create') {
    const row = getJob(db, input.jobId)
    if (!row || row.kind !== SNAPSHOT_KIND) return fail(404, 'Snapshot not found')
    if (input.action === 'retry') {
      const receipt = row.params.backup as { path: string; sha256: string }
      if (createHash('sha256').update(readFileSync(receipt.path)).digest('hex') !== receipt.sha256) return fail(409, 'Backup checksum mismatch')
      ensureJobRunnerReady(db)
      if (!requeueFinishedJob(db, { id: row.id, kind: row.kind, params: row.params, filesDir })) fail(409, 'Snapshot is active')
    }
    return getJob(db, row.id)!
  }
  const operation = submission.catch(() => {}).then(async () => {
    const existing = db.select().from(s.job).where(and(eq(s.job.kind, SNAPSHOT_KIND), sql`json_extract(${s.job.params}, '$.clientRequestId') = ${input.clientRequestId}`)).get()
    if (existing) {
      if (JSON.stringify((existing.params as Record<string, unknown>).enterpriseIds ?? null) !== JSON.stringify(input.enterpriseIds ?? null)) fail(409, 'clientRequestId already belongs to a different enterprise scope')
      return getJob(db, existing.id)!
    }
    if (!db.$client.name || db.$client.name === ':memory:') fail(400, 'File-backed isolated SQLite required')
    const id = newJobId(), startedAt = new Date().toISOString()
    const folder = resolve(`${db.$client.name}.snapshot-backups`)
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    const path = join(folder, `${id}.sqlite`)
    await db.$client.backup(path)
    const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex')
    const Connection = db.$client.constructor as typeof Database
    const backup = new Connection(path, { readonly: true })
    let scope: Scope[]
    try {
      if (backup.pragma('integrity_check', { simple: true }) !== 'ok') fail(500, 'Backup integrity check failed')
      scope = backup.prepare(`select e.id enterpriseId, e.name, e.uscc_norm uscc, json_group_array(r.id) recordIds from record r join enterprise e on e.id=r.enterprise_id where r.source='jxj' group by e.id order by e.id`).all().map(v => { const row = v as Scope & { recordIds: string }; return { ...row, uscc: /^[0-9A-Z]{18}$/.test(row.uscc ?? '') ? row.uscc : null, recordIds: JSON.parse(row.recordIds) as number[] } })
      if (input.enterpriseIds) {
        if (input.enterpriseIds.some(id => !scope.some(e => e.enterpriseId === id))) fail(400, 'Selected enterprise IDs must identify published enterprises')
        scope = scope.filter(e => input.enterpriseIds!.includes(e.enterpriseId))
      }
    } finally { backup.close() }
    const result = initialSnapshot(id,scope)
    const { items } = result
    ensureJobRunnerReady(db)
    db.$client.transaction(() => {
      createJob(db, { id, kind: SNAPSHOT_KIND, params: { clientRequestId: input.clientRequestId, ...(input.enterpriseIds ? { enterpriseIds: input.enterpriseIds } : {}), snapshotAt: startedAt, backup: { path, sha256, verifiedAt: new Date().toISOString() } }, progress: { done: 0, total: items.length } })
      setJobResult(db, id, result)
    })()
    enqueuePersistedJob(db, id, filesDir)
    return getJob(db, id)!
  })
  submission = operation
  return operation
}
