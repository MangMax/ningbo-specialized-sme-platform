import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { recognizedConditionShape, platformQueryTitles, type PlatformLiveQueryResult } from '../../lib/platform/live-query'
import { cookieRedactor } from '../../lib/platform/client'
import { newJobId } from '../../lib/job'
import { MAX_BATCH_ATTEMPTS, PLATFORM_BATCH_KIND, platformBatchInputSchema, platformBatchStatusSchema, platformBatchItemSchema, platformBatchRetrySchema, type PlatformBatchItem, type PlatformBatchParams, type PlatformBatchResult } from '../../lib/platform/batch-query'
import { resolvePlatformCookie } from './credential-state'
import { ensureJobRunnerReady, getJobSpec, registerJob, submitJob, requeueFinishedJob, type JobContext, type JobSpec } from './job-runner'
import { getJob, setJobResult } from './job-store'
import { runPlatformLiveQuery } from './platform-live-query'
import { appLog, newLogContext, type LogContext } from '../../lib/logging'
import { logPlatformResult, platformOperation } from '../../lib/platform/logging'

type Db = BetterSQLite3Database<typeof schema>
const fail = (statusCode: number, message: string): never => { throw Object.assign(new Error(message), { statusCode }) }
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8')
function initialItem(entry: PlatformBatchParams['items'][number]): PlatformBatchItem {
  const q = entry.query
  const titles = platformQueryTitles(q)
  return { itemId: entry.itemId, status: 'not_queried', completeness: 'not_queried', segments: [], unfinished: titles.map(rdjb => ({ source: q.source, rdjb, page: q.startPage })) }
}
async function runBatch(ctx: JobContext, raw: Record<string, unknown>, cookie: string) {
  const params = raw as unknown as PlatformBatchParams
  const prior = getJob(ctx.db, ctx.jobId)?.result as PlatformBatchResult | null
  const result: PlatformBatchResult = prior ? structuredClone(prior) : { attempt: 0, completeness: 'partial', items: params.items.map(initialItem), usage: { requests: 0, rows: 0 }, limits: params.limits }
  result.attempt++
  result.usage.requests = 0
  const start = Date.now()
  const logContext = { ...(ctx.logContext ?? newLogContext()), taskId: ctx.jobId, batchId: ctx.jobId }
  const persist = () => {
    result.completeness = result.items.every(item => item.completeness === 'complete') ? 'complete' : 'partial'
    setJobResult(ctx.db, ctx.jobId, result)
    ctx.progress(result.items.filter(item => item.completeness === 'complete').length, result.items.length)
  }
  persist()
  for (const [index, item] of result.items.entries()) {
    if (item.completeness === 'complete' || (params.retryItemIds && !params.retryItemIds.includes(item.itemId))) continue
    const original = params.items[index]!.query
    const itemStarted = Date.now()
    const itemStartRequests = result.usage.requests
    const itemStartRows = result.usage.rows
    // Initial operation uses the source's full traversal policy. Retries use only the
    // explicit outstanding title/page positions; completed titles/pages are immutable.
    const pending = item.segments.length ? [...item.unfinished] : [null]
    for (const position of pending) {
      const requests = Math.min(params.limits.maxRequests - result.usage.requests, original.maxRequests - (result.usage.requests - itemStartRequests))
      const rows = Math.min(params.limits.maxRows - result.usage.rows, original.maxRows - (result.usage.rows - itemStartRows))
      const duration = Math.min(params.limits.maxDurationMs - (Date.now() - start), original.maxDurationMs - (Date.now() - itemStarted))
      const available = params.limits.maxResultBytes - bytes(result) - 16384
      if (ctx.cancelled() || requests <= 0 || rows <= 0 || duration <= 0 || available <= 0) break
      const pageSize = item.segments[0]?.limits.pageSize ?? Math.min(original.pageSize, original.maxRows)
      if (rows < pageSize) break // Never shift page boundaries on a continuation.
      const query = { ...original, ...(position ? { startPage: position.page, ...(position.rdjb ? { rdjb: original.source === 'queryBusList' ? [position.rdjb] : position.rdjb } : {}) } : {}), pageSize, maxRequests: Math.min(original.maxRequests, requests), maxRows: Math.min(original.maxRows, rows), maxDurationMs: Math.min(original.maxDurationMs, duration) }
      const baseRequests = result.usage.requests
      const baseRows = result.usage.rows
      const baseUnfinished = [...item.unfinished]
      const segmentIndex = item.segments.length
      const admit = (segment: PlatformLiveQueryResult) => {
        result.usage.requests = baseRequests + segment.pages.length
        result.usage.rows = baseRows + segment.rows.length
        item.segments[segmentIndex] = segment
        item.unfinished = position ? baseUnfinished.flatMap(p => p.source === position.source && p.rdjb === position.rdjb && p.page === position.page ? segment.unfinished : [p]) : segment.unfinished
        item.completeness = item.unfinished.length ? 'partial' : 'complete'
        item.status = item.completeness === 'complete' ? item.segments.some(s => s.rows.length) ? 'success' : 'no_record' : item.segments.some(s => s.pages.some(p => p.status === 'success')) ? 'partial' : segment.status
        persist()
      }
      const declaredTotals = new Map<string | null, number>()
      const acceptedPages = new Map<string | null, Map<number, number>>()
      for (const prior of item.segments) {
        for (const page of prior.pages) {
          if (page.status !== 'success') continue
          if (page.declaredTotal !== null) declaredTotals.set(page.rdjb, page.declaredTotal)
          if (!acceptedPages.has(page.rdjb)) acceptedPages.set(page.rdjb, new Map())
          acceptedPages.get(page.rdjb)!.set(page.page, page.fetchedCount)
        }
      }
      const priorFetchedCounts = new Map<string | null, number>()
      for (const title of position ? [position.rdjb] : platformQueryTitles(original)) {
        let count = 0
        let page = 1
        for (; page < query.startPage && acceptedPages.get(title)?.has(page); page++) count += acceptedPages.get(title)!.get(page)!
        if (page === query.startPage) priorFetchedCounts.set(title, count)
      }
      const segment = await runPlatformLiveQuery(query, { cookie, declaredTotals, priorFetchedCounts, maxResultBytes: available, onProgress: admit,
        logContext: { ...logContext, resourceType: 'platform_batch_item', resourceId: item.itemId } })
      admit(segment)
      // Authentication is not automatically retried. Other independent items still
      // receive their own outcome using the same immutable submission snapshot.
      if (segment.pages.some(page => page.status === 'auth_failed') || segment.error?.code === 'safety_limit' || (original.source === 'queryBusList' && segment.unfinished.length)) break
    }
    logPlatformResult(platformOperation(original.source, 'item'), item.status, { ...logContext, resourceType: 'platform_batch_item', resourceId: item.itemId },
      { done: result.usage.rows - itemStartRows }, Date.now() - itemStarted)
  }
  persist()
  // This is a collection-attempt summary, not the generic job terminal event.
  appLog({ module: 'sme-roster', source: 'platform', operation: 'platform.batch.collect', outcome: ctx.cancelled() ? 'cancelled' : result.completeness === 'complete' ? 'success' : 'partial',
    durationMs: Date.now() - start, counts: { done: result.items.filter(item => item.completeness === 'complete').length, total: result.items.length,
      failed: result.items.filter(item => item.status === 'failed' || item.status === 'auth_failed').length } }, logContext)
  return { result, progress: { done: result.items.filter(item => item.completeness === 'complete').length, total: result.items.length }, ...(ctx.cancelled() ? { cancelled: true } : result.completeness !== 'complete' ? { error: '批次仍有未完成范围，请查看逐项结果并显式重试。' } : {}) }
}
export const batchSpec: JobSpec = {
  kind: PLATFORM_BATCH_KIND, status: 'ready', summary: '只读平台批量查询（仅保存任务结果）',
  paramsHint: 'Use POST /api/platform/batches; items[{query}], limits; no credentials.',
  // Generic job submission must pass the same strict public validation and generate IDs.
  parse: raw => {
    const parsed = platformBatchInputSchema.safeParse(raw)
    return parsed.success ? { ok: true, params: { ...parsed.data, items: parsed.data.items.map(entry => ({ ...entry, itemId: newJobId() })) } } : { ok: false, message: 'Invalid platform batch parameters' }
  },
  total: params => (params.items as unknown[]).length,
  prepare: (params, db) => {
    let snapshot = ''
    try { snapshot = resolvePlatformCookie(undefined, { db }) } catch { /* sanitized query outcome */ }
    const redact = cookieRedactor(snapshot)
    // Only untrusted condition strings can carry credential echoes. Fixed source,
    // title enums, generated IDs and numeric bounds must survive short collisions.
    for (const item of (params as unknown as PlatformBatchParams).items) {
      for (const key of ['name', 'uscc', ...Object.keys(recognizedConditionShape)]) {
        const raw = (item.query as unknown as Record<string, unknown>)[key]
        if (typeof raw !== 'string') continue
        let decoded = raw
        try { decoded = decodeURIComponent(raw) } catch { /* query need not be URI encoded */ }
        if (redact(raw) !== raw || redact(decoded) !== decoded) return fail(400, 'Platform batch conditions contain sensitive data')
      }
    }
    return (ctx, params) => runBatch(ctx, params, snapshot)
  },
  run: (ctx, params) => runBatch(ctx, params, ''),
}
export function registerPlatformBatchJob() { if (!getJobSpec(PLATFORM_BATCH_KIND)) registerJob(batchSpec) }
export function submitPlatformBatch(db: Db, input: unknown, filesDir: string, logContext?: LogContext) {
  registerPlatformBatchJob(); ensureJobRunnerReady(db)
  const parsed = batchSpec.parse(input as Record<string, unknown>)
  if (!parsed.ok) return fail(400, parsed.message)
  const row = submitJob(db, { kind: PLATFORM_BATCH_KIND, params: parsed.params, filesDir, logContext: logContext ?? newLogContext() })
  return { batchId: row.id, itemIds: (row.params.items as PlatformBatchParams['items']).map(item => item.itemId), state: row.state }
}
export function getPlatformBatch(db: Db, input: unknown) {
  const parsed = platformBatchStatusSchema.safeParse(input)
  if (!parsed.success) return fail(400, 'Invalid batch ID')
  ensureJobRunnerReady(db)
  const row = getJob(db, parsed.data.batchId)
  if (!row || row.kind !== PLATFORM_BATCH_KIND) return fail(404, 'Platform batch not found')
  const params = row.params as unknown as PlatformBatchParams
  const result = row.result as PlatformBatchResult | null
  const items = result?.items ?? params.items.map(initialItem)
  return { batchId: row.id, itemIds: items.map(item => item.itemId), state: row.state, progress: { done: items.filter(i => i.completeness === 'complete').length, total: items.length }, completeness: result?.completeness ?? 'partial', attempt: result?.attempt ?? 0, items, usage: result?.usage ?? { requests: 0, rows: 0 }, limits: params.limits, createdAt: row.createdAt, startedAt: row.startedAt, finishedAt: row.finishedAt, error: row.error }
}
export function getPlatformBatchItem(db: Db, input: unknown) {
  const parsed = platformBatchItemSchema.safeParse(input)
  if (!parsed.success) return fail(400, 'Invalid batch or item ID')
  const batch = getPlatformBatch(db, { batchId: parsed.data.batchId })
  return batch.items.find(item => item.itemId === parsed.data.itemId) ?? fail(404, 'Platform batch item not found')
}

export function retryPlatformBatch(db: Db, input: unknown, filesDir: string, logContext?: LogContext) {
  const parsed = platformBatchRetrySchema.safeParse(input)
  if (!parsed.success) return fail(400, 'Invalid batch retry parameters')
  const batch = getPlatformBatch(db, { batchId: parsed.data.batchId })
  if (batch.state === 'queued' || batch.state === 'running') return fail(409, 'Platform batch is still active')
  if (batch.attempt >= MAX_BATCH_ATTEMPTS) return fail(409, 'Platform batch retry limit reached')
  if (parsed.data.itemIds.some(id => !batch.items.some(item => item.itemId === id && item.completeness !== 'complete'))) return fail(409, 'Retry requires existing unfinished items')
  const row = getJob(db, batch.batchId)!
  registerPlatformBatchJob()
  const retryContext = logContext ?? newLogContext()
  if (!requeueFinishedJob(db, { id: batch.batchId, kind: PLATFORM_BATCH_KIND, params: { ...row.params, retryItemIds: parsed.data.itemIds }, filesDir, logContext: retryContext })) return fail(409, 'Platform batch is still active')
  appLog({ module: 'sme-roster', source: 'platform', operation: 'platform.batch.retry', outcome: 'started', counts: { total: parsed.data.itemIds.length } },
    { ...retryContext, taskId: batch.batchId, batchId: batch.batchId })
  return { batchId: batch.batchId, itemIds: batch.itemIds, state: 'queued' }
}
