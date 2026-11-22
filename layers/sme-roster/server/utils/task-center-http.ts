import { readTasks,summarize } from './jobs/task-summary'
import { exportTitleFilter } from './jobs/export-summary'
import { retryCandidateDiscovery } from './jobs/candidate-discovery'
import { CANDIDATE_JOB_KIND } from './jobs/candidate-discovery-contract'
import type { LogContext } from '../../../core/lib/logging'
import { ANNUAL_CORRESPONDENCE_KIND } from '../../lib/roster/annual-correspondence'
import { and,eq,inArray,sql } from 'drizzle-orm'
import * as schema from '../../../../db/schema'
import type { useApplicationDb } from '../../../../db/client'
import { isJobId,JOB_STATES,type JobState } from '../../../core/lib/job'
import { TASK_EXPORTS } from '../../lib/sme-roster/task-exports'
import { type TaskList } from '../../../core/lib/task-center'
import { getTaskFilterKinds, getTaskKind, resolveTaskFilters, getTaskTabs } from '../../../core/lib/task-catalog'
import { readApiToken,resolveApiAuth } from '../../../core/server/utils/api-auth'
import { requestJobCancel,jobSpecs } from '../../../core/server/utils/job-runner'
import { retryPlatformBatch } from './platform-batch-query'

type Db = ReturnType<typeof useApplicationDb>
type Request = { method: string; path: string; query?: Record<string, unknown>; headers?: Record<string, string | undefined>; body?: unknown }
const error = (status: number, message: string) => ({ status, headers: { 'cache-control': 'no-store' }, body: { message } })
const positive = (raw: unknown, fallback: number, max: number) => typeof raw !== 'object' && Number.isInteger(Number(raw)) && Number(raw) > 0 ? Math.min(Number(raw), max) : fallback
const j = schema.job

export async function handleTaskCenterRequest(action: 'list' | 'detail' | 'cancel' | 'retry', req: Request, ctx: { db: Db; browserAuthorized?: boolean; apiToken?: string; filesDir: string; logContext?: LogContext }) {
  const headers = { 'cache-control': 'no-store' }
  const apiAuthorized = resolveApiAuth({ given: readApiToken(req.headers), configured: ctx.apiToken }).writeAuthorized
  const authorized = ctx.browserAuthorized === true || apiAuthorized
  const method = action === 'list' || action === 'detail' ? 'GET' : 'POST'
  if (req.method !== method) return error(405, 'Method not allowed')
  const q = req.query ?? {}
  if (action === 'list') {
    const { tab, group } = resolveTaskFilters(q.tab, q.group)
    const state = JOB_STATES.includes(q.state as JobState) ? q.state as JobState : undefined
    const page = positive(q.page, 1, 1000000), pageSize = positive(q.pageSize, 25, 200)
    const title = TASK_EXPORTS.find(t => t.titleCode === q.titleCode)
    const stateWhere = and(state ? eq(j.state, state) : undefined, title ? and(eq(j.kind, 'current-roster-export'), exportTitleFilter(title.titleCode)) : undefined)
    const where = and(stateWhere, tab.id === 'all' ? undefined : inArray(j.kind, getTaskFilterKinds(tab.id, group?.id)))
    const total = ctx.db.select({ n: sql<number>`count(*)` }).from(j).where(where).get()!.n
    const rows = await Promise.all(readTasks(ctx.db, where, pageSize, (page - 1) * pageSize).map(row => summarize(row, row.kind === ANNUAL_CORRESPONDENCE_KIND ? apiAuthorized : authorized, ctx.db)))
    const counts: TaskList['counts'] = { ...Object.fromEntries(getTaskTabs().map(({ id }) => [id, 0])), all: 0 }
    for (const row of ctx.db.select({ kind: j.kind, n: sql<number>`count(*)` }).from(j).where(stateWhere).groupBy(j.kind).all()) {
      counts.all += row.n
      const module = getTaskKind(row.kind)?.module
      if (module) counts[module] = (counts[module] ?? 0) + row.n
    }
    return { status: 200, headers, body: { rows, total, page, pageSize, counts, exportReady: jobSpecs().some(spec => spec.kind === 'current-roster-export' && spec.status === 'ready'), authorized } satisfies TaskList }
  }
  const id = req.path.split('/')[3]
  if (!isJobId(id)) return error(400, 'Invalid task ID')
  const row = readTasks(ctx.db, eq(j.id, id), 1)[0]
  if (!row) return error(404, '任务不存在')
  // Annual business commands never borrow task-center's weaker page capability.
  const taskAuthorized = row.kind === ANNUAL_CORRESPONDENCE_KIND ? apiAuthorized : authorized
  if (action === 'detail') return { status: 200, headers, body: await summarize(row, taskAuthorized, ctx.db, true) }
  if (!taskAuthorized) return error(401, '管理操作需要 API 授权')
  if (action === 'cancel') {
    const outcome = requestJobCancel(ctx.db, id, ctx.logContext)
    if (!outcome.ok) return error(404, '任务不存在')
    const cancelRequested = 'cancelRequested' in outcome && outcome.cancelRequested
    return { status: cancelRequested ? 202 : 200, headers, body: { task: await summarize(readTasks(ctx.db, eq(j.id, id), 1)[0]!, taskAuthorized, ctx.db), cancelRequested } }
  }
  const summary = await summarize(row, taskAuthorized, ctx.db)
  if (!summary.capabilities.retry) return error(409, '此任务当前不支持安全重试')
  try {
    const outcome = row.kind === CANDIDATE_JOB_KIND ? retryCandidateDiscovery(ctx.db, id, ctx.filesDir, ctx.logContext) : retryPlatformBatch(ctx.db, { batchId: id, itemIds: summary.capabilities.retryItemIds }, ctx.filesDir, ctx.logContext)
    return { status: 202, headers, body: outcome }
  } catch (cause) {
    // `retryPlatformBatch` 只在 `requeueFinishedJob` 之前就抛错时把异常漏出来 —— 也就是
    // 依赖捕获(`prepare`)失败的那一刻。此时任务**根本没被重开**(`reopenJob` 在 `prepare`
    // 之后),旧终态与旧 `result` 都还在,如实告诉操作者"这次没受理、可以再来"。
    // 注意:平台的 `prepare` 只把凭据快照的空值降级为 not_queried、把敏感条件判成 400,
    // 不会把凭据存储异常传到这里 —— 别把它写成"存储不可用必然 503"。
    const status = (cause as { statusCode?: number }).statusCode
    return status && status < 500 ? error(status, '重试未受理，原结果保留，请刷新任务状态后再试。') : error(503, '重试未受理，原结果保留，请稍后再试。')
  }
}
