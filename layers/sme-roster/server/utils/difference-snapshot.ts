import { createHash } from 'node:crypto'
import { createReadStream, mkdirSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { eq, and, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { useApplicationDb } from '../../../../db/client'
import * as s from '../../../../db/schema'
import { enterprise } from '../../../../db/postgresql/enterprise-tables'
import { record } from '../../../../db/postgresql/ledger-tables'
import { newJobId } from '../../../core/lib/job'
import type { PlatformLiveQueryResult } from '../../lib/platform/live-query'
import { runPlatformLiveQuery } from './platform-live-query'
import { resolvePlatformCookie } from './platform-credential'
import { createJob, getJob, setJobResult } from '../../../core/server/utils/job-store'
import { enqueuePersistedJob, ensureJobRunnerReady, getJobSpec, registerJob, requeueFinishedJob, type JobContext, type JobSpec } from '../../../core/server/utils/job-runner'

import { reuseCollectedPlatformResult, reusePostgresCollectedPlatformResult } from './platform-collection-reuse'
import { platformResultToImport } from '../../lib/platform/recognized-evidence'
import { preflightRosterImport, commitRosterImport } from './roster-import'

import { commitPostgresPlatformCollection } from './collection-import-postgres'
import { resolvePostgresCredential } from '../../../core/server/utils/credential-state-postgres'
import { requirePostgresJobsWritable, startPostgresJobs, usePostgresJobsDb } from '../../../core/server/utils/postgres-jobs'
import { createPostgresJob, findPostgresJobRequest, getPostgresJob, lockPostgresJobAdmission, reopenPostgresJob, setPostgresJobResult } from '../../../core/server/utils/job-store-postgres'
import { summarizePostgresSnapshots } from './jobs/snapshot-summary'

type Db = ReturnType<typeof useApplicationDb>
export const SNAPSHOT_KIND = 'difference-snapshot'
export const snapshotInput = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('create'), clientRequestId: z.string().trim().min(1).max(120), enterpriseIds: z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).min(1).max(200).transform(ids => [...new Set(ids)].sort((a,b)=>a-b)).optional() }),
  z.strictObject({ action: z.enum(['read', 'retry']), jobId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/) }),
])
type Scope = { enterpriseId: number; name: string; uscc: string | null; recordIds: number[] }
type CoverageSegment = Omit<PlatformLiveQueryResult, 'rows' | 'rawData' | 'dataRows'>
type Item = { itemId: string; batchId: string; enterpriseId: number; source: string; rdjb: string | null; complete: boolean; rows: number | null; segments: CoverageSegment[]; reason: string | null }
type Receipt = { scope: Scope[]; items: Item[]; attempt: number; completeness: string; counts: { enterprises: number; requests: number; rows: number; unfinished: number; bySource?: Record<string, { requests: number; rows: number; failed: number; unfinished: number }> }; collectionPolicy: string }
const fail = (statusCode: number, message: string): never => { throw Object.assign(new Error(message), { statusCode }) }
function provenPages(pages: PlatformLiveQueryResult['pages'], size: number) {
  const sorted = [...pages].sort((a,b)=>a.page-b.page)
  const last = sorted.at(-1)
  if (!last || sorted.some((p,i)=>p.page !== i+1 || p.status !== 'success')) return false
  const count = sorted.reduce((n,p)=>n+p.fetchedCount,0)
  const totals = new Set(sorted.flatMap(p=>p.declaredTotal === null ? [] : [p.declaredTotal]))
  if (totals.size > 1 || [...totals].some(total=>total !== count)) return false
  const maxPages = new Set(sorted.flatMap(p=>p.maxPage == null ? [] : [p.maxPage]))
  if (maxPages.size > 1 || [...maxPages].some(max=>max !== last.page)) return false
  if (maxPages.size) return true
  if (totals.size) return last.page === Math.max(1,Math.ceil([...totals][0]!/size))
  // The provider's unknown-total protocol ends at a valid empty page;
  // a short preceding tail does not invalidate that proof.
  return last.fetchedCount === 0
}
function refresh(result: Receipt) {
  const bySource: NonNullable<Receipt['counts']['bySource']> = {}
  for (const source of ['queryList','businessList','queryBusList']) {
    const items=result.items.filter(i=>i.source===source)
    const observations=new Map<string, PlatformLiveQueryResult['pages'][number]>()
    for (const item of items) {
      const entries = item.segments.map((segment,index) => ({ key: `collection:${item.itemId}:${index}`, result: segment }))
      for (const entry of entries) for (const page of entry.result.pages.filter(p=>p.rdjb===item.rdjb)) observations.set(JSON.stringify([item.enterpriseId,entry.key,page.rdjb,page.page]),page)
    }
    bySource[source]={requests:observations.size,rows:[...observations.values()].reduce((n,p)=>n+p.fetchedCount,0),failed:[...observations.values()].filter(p=>p.status!=='success').length,unfinished:items.filter(i=>!i.complete).length}
  }
  result.counts.bySource=bySource
  result.counts.requests=Object.values(bySource).reduce((n,s)=>n+s.requests,0)
  result.counts.rows=result.items.reduce((n,i)=>n+(i.rows??0),0)
  result.counts.unfinished=result.items.filter(i=>!i.complete).length
}
type SnapshotContext = Pick<JobContext, 'jobId' | 'logContext'> & {
  cancelled(): boolean | Promise<boolean>
  progress(done:number,total:number): void | Promise<void>
  checkpoint(result:Receipt): void | Promise<void>
  admit(stored:PlatformLiveQueryResult,owner:number,request:Parameters<typeof commitRosterImport>[1] | null,result:Receipt): void | Promise<void>
}

async function runSnapshot(ctx: SnapshotContext, base: Receipt, cookie: string) {
  const result = structuredClone(base)
  result.attempt++
  for (const item of result.items) {
    if (await ctx.cancelled()) return { result, cancelled: true }
    if (item.complete) continue
    const scope = result.scope.find(e => e.enterpriseId === item.enterpriseId)!
    if (scope.uscc || item.source !== 'businessList' && scope.name && scope.name.length <= 200) {
      const pages = new Map<number, import('../../lib/platform/live-query').PlatformQueryPage>()
      for (const segment of item.segments) for (const page of segment.pages) if (page.rdjb === item.rdjb && page.status === 'success') pages.set(page.page,page)
      let startPage = 1
      while (pages.has(startPage)) startPage++
      const declaredTotals = new Map<string | null, number>()
      for (const segment of item.segments) for (const page of segment.pages) {
        if (page.rdjb === item.rdjb && page.status === 'success' && page.declaredTotal !== null) declaredTotals.set(item.rdjb,page.declaredTotal)
      }
      const priorFetchedCounts = new Map([[item.rdjb,[...pages.values()].reduce((n,p)=>n+p.fetchedCount,0)]])
      const index = item.segments.length
      const admit = async (segment: PlatformLiveQueryResult) => {
        const { rawData, ...metadata } = segment
        const stored: PlatformLiveQueryResult = { ...metadata, ...(rawData ? { dataRows: rawData.rows } : {}) }
        const { rows: _rows, dataRows: _dataRows, rawData: _rawData, ...coverage } = stored
        item.segments[index] = structuredClone(coverage)
        refresh(result)
        const request = stored.pages.some(page => page.status === 'success') ?
          { idempotencyKey: `collection:${ctx.jobId}:${item.itemId}:${index}:${stored.pages.length}:${stored.fetchedCount}`,
            sourceKind: 'platform_archive' as const, sourceIdentity: `collection:${ctx.jobId}`,
            payload: { platformQueries: [platformResultToImport(stored)] } } : null
        await ctx.admit(stored,item.enterpriseId,request,result)
      }
      const alreadyComplete = provenPages([...pages.values()],item.segments[0]?.limits.pageSize ?? 50) && item.segments.at(-1)?.completeness === 'complete'
      const segment = alreadyComplete ? item.segments.at(-1)! : await runPlatformLiveQuery({ source: item.source, ...(scope.uscc ? { uscc: scope.uscc } : { name: scope.name }), ...(item.rdjb ? { rdjb: item.source === 'queryBusList' ? [item.rdjb] : item.rdjb } : {}), startPage, pageSize: item.segments[0]?.limits.pageSize ?? 50, rawDataVersion: 1 }, { cookie, declaredTotals, priorFetchedCounts, logContext: ctx.logContext })
      if (!alreadyComplete) await admit(segment as PlatformLiveQueryResult)
      for (const page of segment.pages) if (page.rdjb === item.rdjb && page.status === 'success') pages.set(page.page,page)
      item.complete = provenPages([...pages.values()],segment.limits.pageSize) && segment.completeness === 'complete'
      item.rows = item.complete ? [...pages.values()].reduce((n,p)=>n+p.fetchedCount,0) : null
    }
    item.reason = item.complete ? null : item.source === 'businessList' && !scope.uscc ? 'missing_uscc' : item.segments.length ? 'provider_failed_or_partial_pagination' : 'not_queried'
    refresh(result)
    await ctx.checkpoint(result)
    await ctx.progress(result.items.length-result.counts.unfinished, result.items.length)
  }
  result.completeness = result.counts.unfinished ? 'unfinished' : 'complete'
  return { result, progress: { done: result.items.length-result.counts.unfinished, total: result.items.length }, ...(result.counts.unfinished ? { error: 'Snapshot unfinished: identity, provider failure or pagination coverage gaps' } : {}) }
}

export const differenceSnapshotSpec: JobSpec = {
  kind: SNAPSHOT_KIND, status: 'ready', summary: '公布企业平台业务采集',
  paramsHint: 'Use POST /api/roster/difference-snapshots; backup must precede task writes',
  parse: () => ({ ok: false, message: 'Use dedicated difference-snapshots endpoint for verified prestart backup' }),
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
  postgres: {
    taskCenter: { summaries:summarizePostgresSnapshots },
    async run(ctx) {
      const job = (await getPostgresJob(ctx.db,ctx.jobId))!.row
      const cookie = (await resolvePostgresCredential(ctx.db,'sme-roster.miitCookie')).value
      return runSnapshot({ ...ctx, async admit(stored,owner,request,result) {
        if (!request) return ctx.checkpoint(result)
        const reused = await ctx.db.transaction(async tx => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(21785,0)`)
          if (!await reusePostgresCollectedPlatformResult(tx,stored,owner)) return false
          await ctx.checkpoint(result,tx)
          return true
        })
        if (reused) return
        const saved = await commitPostgresPlatformCollection(ctx.db, request, tx => ctx.checkpoint(result, tx))
        if (saved.status!=='committed') fail(409,'Business collection commit failed')
      } },job.result as Receipt,cookie)
    },
  },
}
// Serialize backup + freeze + create inside this process, including duplicate concurrent requests.
let submission: Promise<unknown> = Promise.resolve()
export async function snapshotOperation(db: Db, filesDir: string, raw: unknown) {
  const parsed = snapshotInput.safeParse(raw)
  if (!parsed.success) return fail(400, 'Invalid snapshot action or parameters')
  const input = parsed.data
  if (!getJobSpec(SNAPSHOT_KIND)) registerJob(differenceSnapshotSpec)
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
    const backup = new Database(path, { readonly: true })
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

function initialSnapshot(id:string,scope:Scope[]):Receipt {
  const items: Item[] = scope.flatMap(e => ['queryList', 'businessList', 'queryBusList'].flatMap(source => (source === 'queryList' ? [null] : ['1','2','3']).map(rdjb => ({ itemId: newJobId(), batchId: id, enterpriseId: e.enterpriseId, source, rdjb, complete: false, rows: null, segments: [], reason: 'not_processed' }))))
  return { scope, items, attempt: 0, completeness: 'unfinished', counts: { enterprises: scope.length, requests: 0, rows: 0, unfinished: items.length }, collectionPolicy: 'per_enterprise_fresh_same_job_resume' }
}

async function fileDigest(path: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

const executeBackupTool = promisify(execFile)

async function backupPostgresSnapshot(db: NodePgDatabase, filesDir: string, id: string, enterpriseIds?: number[]) {
  return db.transaction(async tx => {
    // Drizzle 0.45 has no ordered aggregate builder. Preserve the frozen
    // record ID order while returning one row per published enterprise.
    const published = await tx.select({
      enterpriseId: enterprise.id,
      name: enterprise.name,
      uscc: enterprise.usccNorm,
      recordIds: sql<number[]>`json_agg(${record.id} ORDER BY ${record.id})`,
    }).from(record).innerJoin(enterprise, eq(enterprise.id, record.enterpriseId))
      .where(and(eq(record.source, 'jxj'), enterpriseIds ? inArray(enterprise.id, enterpriseIds) : undefined))
      .groupBy(enterprise.id).orderBy(enterprise.id)
    const scope = published.map(row => ({ ...row, uscc: row.uscc?.length === 18 && /^[0-9A-Z]{18}$/.test(row.uscc) ? row.uscc : null }))
    if (enterpriseIds && scope.length !== enterpriseIds.length) fail(400, 'Selected enterprise IDs must identify published enterprises')
    // PostgreSQL's exported MVCC snapshot is shared with pg_dump in this transaction.
    const { rows: [exported] } = await tx.execute<{ snapshot: string }>(sql`SELECT pg_export_snapshot() AS snapshot`)
    const destination = resolve(filesDir,'..','snapshot-backups')
    await mkdir(destination,{ recursive:true,mode:0o700 })
    const directory = await mkdtemp(join(destination,id+'-'))
    const path = join(directory,'business.dump')
    const binary = (name:string) => process.env.NUXT_POSTGRES_BIN ? join(process.env.NUXT_POSTGRES_BIN,name) : name
    const connection = new URL(process.env.NUXT_POSTGRES_DIRECTORY_URL!)
    connection.searchParams.delete('options')
    const password = connection.searchParams.get('password') ?? decodeURIComponent(connection.password)
    connection.password = ''
    connection.searchParams.delete('password')
    try {
      await executeBackupTool(binary('pg_dump'),['--no-password','--format=custom','--schema=business',
        '--dbname='+connection.href,'--snapshot='+exported!.snapshot,'--file='+path],{
        env:{ ...process.env,PGPASSWORD:password,PGOPTIONS:'-c default_transaction_read_only=on' },
      })
      await executeBackupTool(binary('pg_restore'),['--file=/dev/null',path])
      return { scope,backup:{ path,sha256:await fileDigest(path),verifiedAt:new Date().toISOString() } }
    } catch {
      await rm(directory,{ recursive:true,force:true })
      return fail(503,'Unable to verify PostgreSQL snapshot backup')
    }
  },{ isolationLevel:'repeatable read',accessMode:'read only' })
}

async function postgresSnapshotOperation(db: NodePgDatabase, filesDir: string, raw: unknown) {
  const parsed = snapshotInput.safeParse(raw)
  if (!parsed.success) return fail(400,'Invalid snapshot action or parameters')
  const input = parsed.data
  if (!getJobSpec(SNAPSHOT_KIND)) registerJob(differenceSnapshotSpec)
  if (input.action !== 'read') {
    requirePostgresJobsWritable()
    startPostgresJobs(filesDir)
  }
  if (input.action!=='create') {
    const snapshot = await getPostgresJob(db,input.jobId)
    if (!snapshot || snapshot.row.kind!==SNAPSHOT_KIND) return fail(404,'Snapshot not found')
    const row = snapshot.row
    if (input.action==='read') return row
    const receipt = row.params.backup as { path:string; sha256:string }
    const actual = await fileDigest(receipt.path).catch(()=>null)
    if (actual!==receipt.sha256) return fail(409,'Backup checksum mismatch')
    if (row.state!=='done' && row.state!=='failed' && row.state!=='cancelled') return fail(409,'Snapshot is active')
    const reopened = await reopenPostgresJob(db,row.id,row.kind,{ state:row.state,claimToken:snapshot.claimToken },row.params)
    return reopened?.row ?? fail(409,'Snapshot is active')
  }
  return db.transaction(async tx => {
    await lockPostgresJobAdmission(tx,SNAPSHOT_KIND)
    const existing = (await findPostgresJobRequest(tx,SNAPSHOT_KIND,input.clientRequestId))?.row
    if (existing) {
      if (JSON.stringify(existing.params.enterpriseIds ?? null)!==JSON.stringify(input.enterpriseIds ?? null)) {
        return fail(409,'clientRequestId already belongs to a different enterprise scope')
      }
      return existing
    }
    const id = newJobId()
    const snapshotAt = new Date().toISOString()
    const { scope,backup } = await backupPostgresSnapshot(db,filesDir,id,input.enterpriseIds)
    const result = initialSnapshot(id,scope)
    const params = { clientRequestId:input.clientRequestId,snapshotAt,backup,
      ...(input.enterpriseIds ? {enterpriseIds:input.enterpriseIds} : {}) }
    const { row,claimToken } = await createPostgresJob(tx,{ id,kind:SNAPSHOT_KIND,params,
      requestKey:input.clientRequestId,progress:{done:0,total:result.items.length} })
    if (!await setPostgresJobResult(tx,id,{state:'queued',claimToken},result)) throw new Error('Snapshot task was not admitted')
    return { ...row,result }
  })
}

export function snapshotRuntimeOperation(sqlite: () => Db, filesDir: string, raw: unknown) {
  const pg = usePostgresJobsDb()
  return pg ? postgresSnapshotOperation(pg,filesDir,raw) : snapshotOperation(sqlite(),filesDir,raw)
}
