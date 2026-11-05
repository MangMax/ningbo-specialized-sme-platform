import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { eq, and, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { useDb } from '../../db/client'
import * as s from '../../db/schema'
import { newJobId } from '../../lib/job'
import type { PlatformLiveQueryResult } from '../../lib/platform/live-query'
import { runPlatformLiveQuery } from './platform-live-query'
import { resolvePlatformCookie } from './credential-state'
import { createJob, getJob, setJobResult } from './job-store'
import { enqueuePersistedJob, ensureJobRunnerReady, getJobSpec, registerJob, requeueFinishedJob, type JobSpec } from './job-runner'

type Db = ReturnType<typeof useDb>
export const SNAPSHOT_KIND = 'difference-snapshot'
export const snapshotInput = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('create'), clientRequestId: z.string().trim().min(1).max(120) }),
  z.strictObject({ action: z.enum(['read', 'retry']), jobId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/) }),
])
type Scope = { enterpriseId: number; name: string; uscc: string | null; recordIds: number[] }
type Archive = { origin?: Record<string, unknown>; queryId: number | null; batchId: string | null; itemId: string | null; result: PlatformLiveQueryResult }
type Item = { itemId: string; batchId: string; enterpriseId: number; source: string; rdjb: string | null; complete: boolean; rows: number | null; archives: Archive[]; segments: PlatformLiveQueryResult[]; reason: string | null }
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
      const entries = item.archives.map(a => ({ key: JSON.stringify(['archive',a.queryId,a.batchId,a.itemId,a.result.queriedAt,a.result.completedAt]), result: a.result }))
      item.segments.forEach((segment,index) => {
        if (!item.archives.some(a => JSON.stringify(a.result) === JSON.stringify(segment))) entries.push({ key: `collection:${item.itemId}:${index}`, result: segment })
      })
      for (const entry of entries) for (const page of entry.result.pages.filter(p=>p.rdjb===item.rdjb)) observations.set(JSON.stringify([item.enterpriseId,entry.key,page.rdjb,page.page]),page)
    }
    bySource[source]={requests:observations.size,rows:[...observations.values()].reduce((n,p)=>n+p.fetchedCount,0),failed:[...observations.values()].filter(p=>p.status!=='success').length,unfinished:items.filter(i=>!i.complete).length}
  }
  result.counts.bySource=bySource
  result.counts.requests=Object.values(bySource).reduce((n,s)=>n+s.requests,0)
  result.counts.rows=result.items.reduce((n,i)=>n+(i.rows??0),0)
  result.counts.unfinished=result.items.filter(i=>!i.complete).length
}
const spec: JobSpec = {
  kind: SNAPSHOT_KIND, status: 'ready', summary: '公布名单全量平台快照',
  paramsHint: 'Use POST /api/roster/difference-snapshots; backup must precede task writes',
  parse: () => ({ ok: false, message: 'Use dedicated difference-snapshots endpoint for verified prestart backup' }),
  run: async ctx => {
    const row = getJob(ctx.db, ctx.jobId)!
    const result = structuredClone(row.result) as Receipt
    result.attempt++
    let cookie = ''
    try { cookie = resolvePlatformCookie(undefined, { db: ctx.db }) } catch { /* provider reports credential failure */ }
    for (const item of result.items) {
      if (ctx.cancelled()) return { result, cancelled: true }
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
        const admit = (segment: PlatformLiveQueryResult) => {
          item.segments[index] = structuredClone(segment)
          refresh(result)
          setJobResult(ctx.db,ctx.jobId,result)
        }
        const alreadyComplete = provenPages([...pages.values()],item.segments[0]?.limits.pageSize ?? 50) && item.segments.at(-1)?.completeness === 'complete'
        const segment = alreadyComplete ? item.segments.at(-1)! : await runPlatformLiveQuery({ source: item.source, ...(scope.uscc ? { uscc: scope.uscc } : { name: scope.name }), ...(item.rdjb ? { rdjb: item.source === 'queryBusList' ? [item.rdjb] : item.rdjb } : {}), startPage, pageSize: item.segments[0]?.limits.pageSize ?? 50, rawDataVersion: 1 }, { cookie, declaredTotals, priorFetchedCounts, onProgress: admit, logContext: ctx.logContext })
        if (!alreadyComplete) admit(segment)
        for (const page of segment.pages) if (page.rdjb === item.rdjb && page.status === 'success') pages.set(page.page,page)
        item.complete = provenPages([...pages.values()],segment.limits.pageSize) && segment.completeness === 'complete'
        item.rows = item.complete ? [...pages.values()].reduce((n,p)=>n+p.fetchedCount,0) : null
      }
      item.reason = item.complete ? null : item.source === 'businessList' && !scope.uscc ? 'missing_uscc' : item.segments.length ? 'provider_failed_or_partial_pagination' : item.archives.length ? 'partial_failed_or_unproven_pagination' : 'missing_or_unmatched_archive'
      refresh(result)
      setJobResult(ctx.db, ctx.jobId, result)
      ctx.progress(result.items.length-result.counts.unfinished, result.items.length)
    }
    result.completeness = result.counts.unfinished ? 'unfinished' : 'complete'
    return { result, progress: { done: result.items.length-result.counts.unfinished, total: result.items.length }, ...(result.counts.unfinished ? { error: 'Snapshot unfinished: identity, provider failure or pagination coverage gaps' } : {}) }
  },
}
// Serialize backup + freeze + create inside this process, including duplicate concurrent requests.
let submission: Promise<unknown> = Promise.resolve()
export async function snapshotOperation(db: Db, filesDir: string, raw: unknown) {
  const parsed = snapshotInput.safeParse(raw)
  if (!parsed.success) return fail(400, 'Invalid snapshot action or parameters')
  const input = parsed.data
  if (!getJobSpec(SNAPSHOT_KIND)) registerJob(spec)
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
    if (existing) return getJob(db, existing.id)!
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
    } finally { backup.close() }
    const items: Item[] = scope.flatMap(e => ['queryList', 'businessList', 'queryBusList'].flatMap(source => (source === 'queryList' ? [null] : ['1','2','3']).map(rdjb => ({ itemId: newJobId(), batchId: id, enterpriseId: e.enterpriseId, source, rdjb, complete: false, rows: null, archives: [], segments: [], reason: 'not_processed' }))))
    const result: Receipt = { scope, items, attempt: 0, completeness: 'unfinished', counts: { enterprises: scope.length, requests: 0, rows: 0, unfinished: items.length }, collectionPolicy: 'per_enterprise_fresh_same_job_resume' }
    ensureJobRunnerReady(db)
    db.$client.transaction(() => {
      createJob(db, { id, kind: SNAPSHOT_KIND, params: { clientRequestId: input.clientRequestId, snapshotAt: startedAt, backup: { path, sha256, verifiedAt: new Date().toISOString() } }, progress: { done: 0, total: items.length } })
      setJobResult(db, id, result)
    })()
    enqueuePersistedJob(db, id, filesDir)
    return getJob(db, id)!
  })
  submission = operation
  return operation
}
