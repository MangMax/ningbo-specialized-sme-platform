import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { createHash } from 'node:crypto'
import * as schema from '../../../../db/schema'
import { recognizedConditionShape, platformQueryTitles, type PlatformLiveQueryResult } from '../../lib/platform/live-query'
import { cookieRedactor } from '../../lib/platform/client'
import { newJobId } from '../../../core/lib/job'
import { MAX_BATCH_ATTEMPTS, PLATFORM_BATCH_KIND, platformBatchInputSchema, platformBatchStatusSchema, platformBatchItemSchema, platformBatchRetrySchema, type PlatformBatchItem, type PlatformBatchParams, type PlatformBatchResult } from '../../lib/platform/batch-query'
import { resolvePlatformCookie } from './platform-credential'
import { ensureJobRunnerReady, getJobSpec, registerJob, submitJob, requeueFinishedJob, type JobContext, type JobSpec } from '../../../core/server/utils/job-runner'
import { getJob, setJobResult } from '../../../core/server/utils/job-store'
import { runPlatformLiveQuery } from './platform-live-query'
import { appLog, newLogContext, type LogContext } from '../../../core/lib/logging'
import { logPlatformResult, platformOperation } from '../../lib/platform/logging'
import { resolvePostgresCredential } from '../../../core/server/utils/credential-state-postgres'
import { getPostgresJob, reopenPostgresJob } from '../../../core/server/public'
import type { JobRow } from '../../../core/server/utils/job-store'
import { summarizePostgresBatches } from './jobs/batch-summary'

type Db = BetterSQLite3Database<typeof schema>
const fail = (statusCode: number, message: string): never => { throw Object.assign(new Error(message), { statusCode }) }
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8')
function initialItem(entry: PlatformBatchParams['items'][number]): PlatformBatchItem {
  const q = entry.query
  const titles = platformQueryTitles(q)
  return { itemId: entry.itemId, status: 'not_queried', completeness: 'not_queried', segments: [], unfinished: titles.map(rdjb => ({ source: q.source, rdjb, page: q.startPage })) }
}
type BatchContext = Pick<JobContext, 'jobId' | 'logContext'> & {
  cancelled(): boolean | Promise<boolean>
  progress(done: number, total: number): void | Promise<void>
  checkpoint(result: PlatformBatchResult): void | Promise<void>
}

async function runBatch(ctx: BatchContext, raw: Record<string, unknown>, cookie: string, prior: PlatformBatchResult | null) {
  const params = raw as unknown as PlatformBatchParams
  const result: PlatformBatchResult = prior ? structuredClone(prior) : { attempt: 0, completeness: 'partial', items: params.items.map(initialItem), usage: { requests: 0, rows: 0 }, limits: params.limits }
  result.attempt++
  result.usage.requests = 0
  const start = Date.now()
  const logContext = { ...(ctx.logContext ?? newLogContext()), taskId: ctx.jobId, batchId: ctx.jobId }
  const persist = async () => {
    result.completeness = result.items.every(item => item.completeness === 'complete') ? 'complete' : 'partial'
    await ctx.checkpoint(result)
    await ctx.progress(result.items.filter(item => item.completeness === 'complete').length, result.items.length)
  }
  await persist()
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
      if (await ctx.cancelled() || requests <= 0 || rows <= 0 || duration <= 0 || available <= 0) break
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
        return persist()
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
      await admit(segment)
      // Authentication is not automatically retried. Other independent items still
      // receive their own outcome using the same immutable submission snapshot.
      if (segment.pages.some(page => page.status === 'auth_failed') || segment.error?.code === 'safety_limit' || (original.source === 'queryBusList' && segment.unfinished.length)) break
    }
    logPlatformResult(platformOperation(original.source, 'item'), item.status, { ...logContext, resourceType: 'platform_batch_item', resourceId: item.itemId },
      { done: result.usage.rows - itemStartRows }, Date.now() - itemStarted)
  }
  await persist()
  const cancelled = await ctx.cancelled()
  // This is a collection-attempt summary, not the generic job terminal event.
  appLog({ module: 'sme-roster', source: 'platform', operation: 'platform.batch.collect', outcome: cancelled ? 'cancelled' : result.completeness === 'complete' ? 'success' : 'partial',
    durationMs: Date.now() - start, counts: { done: result.items.filter(item => item.completeness === 'complete').length, total: result.items.length,
      failed: result.items.filter(item => item.status === 'failed' || item.status === 'auth_failed').length } }, logContext)
  return { result, progress: { done: result.items.filter(item => item.completeness === 'complete').length, total: result.items.length }, ...(cancelled ? { cancelled: true } : result.completeness !== 'complete' ? { error: '批次仍有未完成范围，请查看逐项结果并显式重试。' } : {}) }
}

function validateConditions(params: Record<string, unknown>, cookie: string) {
  const redact = cookieRedactor(cookie)
  for (const item of (params as unknown as PlatformBatchParams).items) {
    for (const key of ['name', 'uscc', ...Object.keys(recognizedConditionShape)]) {
      const raw = (item.query as unknown as Record<string, unknown>)[key]
      if (typeof raw !== 'string') continue
      let decoded = raw
      try { decoded = decodeURIComponent(raw) } catch { /* query need not be URI encoded */ }
      if (redact(raw) !== raw || redact(decoded) !== decoded) return fail(400, 'Platform batch conditions contain sensitive data')
    }
  }
}

function runSqliteBatch(ctx: JobContext, params: Record<string, unknown>, cookie: string) {
  return runBatch({
    ...ctx, checkpoint: result => { setJobResult(ctx.db, ctx.jobId, result) },
  }, params, cookie, getJob(ctx.db, ctx.jobId)?.result as PlatformBatchResult | null)
}

const fingerprint = (cookie: string) => createHash('sha256').update(cookie).digest('hex')

async function preparePostgresBatch(db: NodePgDatabase, params: Record<string, unknown>) {
  const cookie = (await resolvePostgresCredential(db, 'sme-roster.miitCookie')).value
  validateConditions(params, cookie)
  return fingerprint(cookie)
}
export const batchSpec: JobSpec = {
  openAPIParams: {
    order: 20,
    description: 'platform-query-batch 使用 /api/platform/batches 的 items/limits，推荐专用接口（支持稳定 itemId 和局部重试）。',
  },
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
    validateConditions(params, snapshot)
    return (ctx, params) => runSqliteBatch(ctx, params, snapshot)
  },
  run: (ctx, params) => runSqliteBatch(ctx, params, ''),
  postgres: {
    allowBrowserCancel: true,
    taskCenter: {
      summaries: summarizePostgresBatches,
      retry: (db, task, context) => retryPostgresPlatformBatch(db, { batchId: task.id, itemIds: task.capabilities.retryItemIds }, context),
    },
    prepare: preparePostgresBatch,
    async run(ctx, params, inputSnapshot) {
      const cookie = (await resolvePostgresCredential(ctx.db, 'sme-roster.miitCookie')).value
      validateConditions(params, cookie)
      const row = (await getPostgresJob(ctx.db, ctx.jobId))!.row
      return runBatch(ctx, params, inputSnapshot === fingerprint(cookie) ? cookie : '', row.result as PlatformBatchResult | null)
    },
  },
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
  return projectBatch(getJob(db, parsed.data.batchId))
}

function projectBatch(row: JobRow | null | undefined) {
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
  validateRetry(batch, parsed.data.itemIds)
  const row = getJob(db, batch.batchId)!
  registerPlatformBatchJob()
  const retryContext = logContext ?? newLogContext()
  if (!requeueFinishedJob(db, { id: batch.batchId, kind: PLATFORM_BATCH_KIND, params: { ...row.params, retryItemIds: parsed.data.itemIds }, filesDir, logContext: retryContext })) return fail(409, 'Platform batch is still active')
  appLog({ module: 'sme-roster', source: 'platform', operation: 'platform.batch.retry', outcome: 'started', counts: { total: parsed.data.itemIds.length } },
    { ...retryContext, taskId: batch.batchId, batchId: batch.batchId })
  return { batchId: batch.batchId, itemIds: batch.itemIds, state: 'queued' }
}

function validateRetry(batch: ReturnType<typeof projectBatch>, itemIds: string[]) {
  if (batch.state === 'queued' || batch.state === 'running') return fail(409, 'Platform batch is still active')
  if (batch.attempt >= MAX_BATCH_ATTEMPTS) return fail(409, 'Platform batch retry limit reached')
  if (itemIds.some(id => !batch.items.some(item => item.itemId === id && item.completeness !== 'complete'))) return fail(409, 'Retry requires existing unfinished items')
}

export async function getPostgresPlatformBatch(db: NodePgDatabase, input: unknown) {
  const parsed = platformBatchStatusSchema.safeParse(input)
  if (!parsed.success) return fail(400, 'Invalid batch ID')
  return projectBatch((await getPostgresJob(db, parsed.data.batchId))?.row)
}

export async function getPostgresPlatformBatchItem(db: NodePgDatabase, input: unknown) {
  const parsed = platformBatchItemSchema.safeParse(input)
  if (!parsed.success) return fail(400, 'Invalid batch or item ID')
  const batch = await getPostgresPlatformBatch(db, { batchId: parsed.data.batchId })
  return batch.items.find(item => item.itemId === parsed.data.itemId) ?? fail(404, 'Platform batch item not found')
}

export async function retryPostgresPlatformBatch(db: NodePgDatabase, input: unknown, logContext?: LogContext) {
  const parsed = platformBatchRetrySchema.safeParse(input)
  if (!parsed.success) return fail(400, 'Invalid batch retry parameters')
  const retry = parsed.data
  const receipt = await db.transaction(async tx => {
    const previous = await getPostgresJob(tx, retry.batchId)
    const batch = projectBatch(previous?.row)
    validateRetry(batch, retry.itemIds)
    const { row, claimToken } = previous!
    if (row.state === 'queued' || row.state === 'running') return fail(409, 'Platform batch is still active')
    const params = { ...row.params, retryItemIds: retry.itemIds }
    const snapshot = await preparePostgresBatch(tx, params)
    const reopened = await reopenPostgresJob(tx, row.id, row.kind, { state: row.state, claimToken }, params, snapshot)
    if (!reopened) return fail(409, 'Platform batch is still active')
    return { batchId: batch.batchId, itemIds: batch.itemIds, state: 'queued' as const }
  })
  appLog({ module: 'sme-roster', source: 'platform', operation: 'platform.batch.retry', outcome: 'started', counts: { total: retry.itemIds.length } },
    { ...logContext, taskId: receipt.batchId, batchId: receipt.batchId })
  return receipt
}
