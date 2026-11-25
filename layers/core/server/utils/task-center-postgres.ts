import type { SQL } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { createError, getHeader, getQuery, getRouterParam, setHeader, setResponseStatus, type H3Event } from 'h3'
import { requestLogContext } from '../../lib/logging'
import { registerJobSpecs } from '../../../../server/utils/job-specs'
import type { TaskCenterAction } from '../../../../server/task-center'
import { isJobId, JOB_STATES, type JobState } from '../../lib/job'
import { getTaskFilterKinds, getTaskKind, getTaskTabs, resolveTaskFilters } from '../../lib/task-catalog'
import type { TaskList, TaskSummary, TaskSummaryProjection } from '../../lib/task-center'
import { readApiToken, resolveApiAuth } from './api-auth'
import { postgresJobHandler } from './job-runner-postgres'
import { cancelPostgresJob, getPostgresTaskCenterRow, listPostgresTaskCenter, type PostgresTaskCenterRow } from './job-store-postgres'
import { jobsEnabled, requireJobsWritable, useJobsDb } from './postgres-jobs'
import { taskCenterBrowserAccess } from './task-center-access'
import { taskSummaryBase, taskSummaryCapabilities, taskSummaryError } from './task-summary'

async function projectSummaries(
  db: NodePgDatabase, rows: PostgresTaskCenterRow[], authorizedFor: (kind: string) => boolean, detail = false, writable = true,
): Promise<TaskSummary[]> {
  const projections = new Map<string, TaskSummaryProjection>()
  for (const [kind, tasks] of Map.groupBy(rows, row => row.kind)) {
    const handler = postgresJobHandler(kind)?.taskCenter
    if (!handler) continue
    const ids = tasks.map(row => row.id)
    const fields = await handler.summaries(db, ids, detail, { authorized: authorizedFor(kind), writable })
    for (const id of ids) {
      const projection = fields.get(id)
      if (projection) projections.set(id, projection)
    }
  }
  return rows.map(row => {
    const authorized = authorizedFor(row.kind)
    const base = taskSummaryBase(row)
    const fields = projections.get(row.id)
    const retry = fields?.capabilities
    return {
      ...fields,
      ...base,
      label: fields?.label ?? base.label,
      progress: { ...base.progress, ...fields?.progress },
      outcome: fields?.outcome ?? null,
      links: fields?.links ?? [],
      ...(detail ? { items: fields?.items ?? [] } : {}),
      error: fields?.error === undefined ? taskSummaryError(row) : fields.error,
      capabilities: taskSummaryCapabilities(row.state, authorized, writable, retry?.retry, retry?.retryItemIds, retry?.reason),
    }
  })
}

export async function readPostgresTaskCenterEntry(db: NodePgDatabase, id: string, authorizedFor: (kind: string) => boolean, writable = true) {
  return db.transaction(async tx => {
    const current = await getPostgresTaskCenterRow(tx, id)
    return current ? (await projectSummaries(tx, [current], authorizedFor, true, writable))[0]! : null
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

function positive(raw: unknown, fallback: number, max: number) {
  return typeof raw !== 'object' && Number.isInteger(Number(raw)) && Number(raw) > 0 ? Math.min(Number(raw), max) : fallback
}

export type PostgresTaskListOptions = (query: Record<string, unknown>) => { filter?: SQL; exportReady: boolean }

export async function handlePostgresTaskCenter(action: TaskCenterAction, event: H3Event, listOptions?: PostgresTaskListOptions) {
  setHeader(event, 'cache-control', 'no-store')
  registerJobSpecs()
  const config = useRuntimeConfig(event)
  const db = useJobsDb()
  const writable = jobsEnabled()
  if (action === 'cancel' || action === 'retry') requireJobsWritable()
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
    const { filter, exportReady } = listOptions?.(q) ?? { exportReady: false }
    const kinds = tab.id === 'all' ? undefined : getTaskFilterKinds(tab.id, group?.id)
    const { data, rows } = await db.transaction(async tx => {
      const data = await listPostgresTaskCenter(tx, { page, pageSize, state, kinds, filter })
      return { data, rows: await projectSummaries(tx, data.rows, authorizedFor, false, writable) }
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
    const counts: TaskList['counts'] = { ...Object.fromEntries(getTaskTabs().map(({ id }) => [id, 0])), all: 0 }
    for (const { kind, n } of data.counts) {
      const module = getTaskKind(kind)?.module
      counts.all += Number(n)
      if (module) counts[module] = (counts[module] ?? 0) + Number(n)
    }
    return {
      total: data.total, rows,
      page, pageSize, counts,
      exportReady: writable && exportReady,
      authorized: writable && (apiAuthorized || browserAuthorized),
    } satisfies TaskList
  }

  const id = getRouterParam(event, 'id')
  if (!isJobId(id)) throw createError({ statusCode: 400, message: 'Invalid task ID' })
  if (action === 'detail') {
    const task = await readPostgresTaskCenterEntry(db, id, authorizedFor, writable)
    if (!task) throw createError({ statusCode: 404, message: '任务不存在' })
    return task
  }
  const row = await getPostgresTaskCenterRow(db, id)
  if (!row) throw createError({ statusCode: 404, message: '任务不存在' })
  const authorized = authorizedFor(row.kind)
  if (!authorized) throw createError({ statusCode: 401, message: '管理操作需要 API 授权' })
  if (action === 'retry') {
    const retry = postgresJobHandler(row.kind)?.taskCenter?.retry
    const [task] = await projectSummaries(db, [row], authorizedFor)
    if (!retry || !task?.capabilities.retry) throw createError({ statusCode: 409, message: '此任务当前不支持安全重试' })
    try {
      const result = await retry(db, task, requestLogContext(event))
      setResponseStatus(event, 202)
      return result
    } catch (cause) {
      const status = (cause as { statusCode?: number }).statusCode
      throw createError(status && status < 500
        ? { statusCode: status, message: '重试未受理，原结果保留，请刷新任务状态后再试。' }
        : { statusCode: 503, message: '重试未受理，原结果保留，请稍后再试。' })
    }
  }

  const result = await cancelPostgresJob(db, id, requestLogContext(event))
  if (!result) throw createError({ statusCode: 404, message: '任务不存在' })
  if (result.cancelRequested) setResponseStatus(event, 202)
  const task = await getPostgresTaskCenterRow(db, id)
  if (!task) throw createError({ statusCode: 404, message: '任务不存在' })
  return { task: (await projectSummaries(db, [task], authorizedFor))[0], cancelRequested: result.cancelRequested }
}
