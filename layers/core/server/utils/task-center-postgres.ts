import { createError, getHeader, getQuery, getRouterParam, setHeader, setResponseStatus, type H3Event } from 'h3'
import { requestLogContext } from '../../lib/logging'
import type { TaskCenterAction } from '../../../../server/task-center'
import { registerJobSpecs } from '../../../../server/utils/job-specs'
import { isJobId, JOB_STATES, type JobState, type JobSummaryDto } from '../../lib/job'
import { getTaskFilterKinds, getTaskKind, getTaskTabs, resolveTaskFilters } from '../../lib/task-catalog'
import type { TaskList, TaskSummary } from '../../lib/task-center'
import { readApiToken, resolveApiAuth } from './api-auth'
import { postgresJobHandler } from './job-runner-postgres'
import { cancelPostgresJob, getPostgresJobSummary, listPostgresTaskCenter } from './job-store-postgres'
import { startPostgresJobs } from './postgres-jobs'
import { taskCenterBrowserAccess } from './task-center-access'

function positive(raw: unknown, fallback: number, max: number) {
  return typeof raw !== 'object' && Number.isInteger(Number(raw)) && Number(raw) > 0 ? Math.min(Number(raw), max) : fallback
}

function summarize(row: JobSummaryDto, authorized: boolean): TaskSummary {
  const kind = getTaskKind(row.kind)
  const active = row.state === 'queued' || row.state === 'running'
  return {
    id: row.id, kind: row.kind.slice(0, 100), label: kind?.label ?? row.kind.slice(0, 100),
    module: kind?.module ?? null, group: kind?.group.id ?? 'all', state: row.state,
    createdAt: row.createdAt, startedAt: row.startedAt, finishedAt: row.finishedAt,
    progress: { done: row.progress.done, total: row.percent === null || row.progress.total <= 0 ? null : row.progress.total,
      unit: '项', stage: row.state === 'queued' ? '等待执行' : active ? '执行中' : '执行结束' },
    error: row.state === 'failed' ? row.error : null, outcome: null,
    capabilities: { cancel: active && authorized, retry: false, retryItemIds: [],
      reason: active && authorized ? '可请求取消；实际状态以服务端终态为准。' : '请通过业务入口核对任务。' },
    links: [],
  }
}

export async function handlePostgresTaskCenter(action: TaskCenterAction, event: H3Event) {
  setHeader(event, 'cache-control', 'no-store')
  registerJobSpecs()
  const config = useRuntimeConfig(event)
  const { db } = startPostgresJobs(config.filesDir)!
  const apiAuthorized = resolveApiAuth({ given: readApiToken({
    authorization: getHeader(event, 'authorization'), 'x-api-token': getHeader(event, 'x-api-token'),
  }), configured: config.apiToken }).writeAuthorized
  const browserAuthorized = taskCenterBrowserAccess(event)
  const authorizedFor = (kind: string) => apiAuthorized || (browserAuthorized && postgresJobHandler(kind)?.allowBrowserCancel === true)

  if (action === 'list') {
    const q = getQuery(event)
    const { tab, group } = resolveTaskFilters(q.tab, q.group)
    const state = JOB_STATES.includes(q.state as JobState) ? q.state as JobState : undefined
    const page = positive(q.page, 1, 1_000_000)
    const pageSize = positive(q.pageSize, 25, 200)
    const kinds = tab.id === 'all' ? undefined : getTaskFilterKinds(tab.id, group?.id)
    const data = await listPostgresTaskCenter(db, { page, pageSize, state, kinds })
    const counts: TaskList['counts'] = { ...Object.fromEntries(getTaskTabs().map(({ id }) => [id, 0])), all: 0 }
    for (const { kind, n } of data.counts) {
      const module = getTaskKind(kind)?.module
      counts.all += Number(n)
      if (module) counts[module] = (counts[module] ?? 0) + Number(n)
    }
    return {
      total: data.total, rows: data.rows.map(row => summarize(row, authorizedFor(row.kind))),
      page, pageSize, counts, exportReady: false, authorized: apiAuthorized || browserAuthorized,
    } satisfies TaskList
  }

  const id = getRouterParam(event, 'id')
  if (!isJobId(id)) throw createError({ statusCode: 400, message: 'Invalid task ID' })
  const row = await getPostgresJobSummary(db, id)
  if (!row) throw createError({ statusCode: 404, message: '任务不存在' })
  const authorized = authorizedFor(row.kind)
  if (action === 'detail') return summarize(row, authorized)
  if (!authorized) throw createError({ statusCode: 401, message: '管理操作需要 API 授权' })
  if (action === 'retry') throw createError({ statusCode: 409, message: '此任务当前不支持安全重试' })

  const result = await cancelPostgresJob(db, id, requestLogContext(event))
  if (!result) throw createError({ statusCode: 404, message: '任务不存在' })
  if (result.cancelRequested) setResponseStatus(event, 202)
  const task = await getPostgresJobSummary(db, id)
  if (!task) throw createError({ statusCode: 404, message: '任务不存在' })
  return { task: summarize(task, authorized), cancelRequested: result.cancelRequested }
}
