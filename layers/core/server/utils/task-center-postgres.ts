import { TITLE_SEED } from '../../../../db/titles'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
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
import { postgresJobsEnabled, requirePostgresJobsWritable, usePostgresJobsDb } from './postgres-jobs'
import { taskCenterBrowserAccess } from './task-center-access'

async function projectSummaries(db: NodePgDatabase, rows: JobSummaryDto[], authorizedFor: (kind: string) => boolean, detail = false) {
  const projections = new Map<string, Partial<TaskSummary>>()
  for (const [kind, tasks] of Map.groupBy(rows, row => row.kind)) {
    const handler = postgresJobHandler(kind)?.taskCenter
    if (!handler) continue
    for (const [id, fields] of await handler.summaries(db, tasks.map(row => row.id), detail, authorizedFor(kind))) projections.set(id, fields)
  }
  return rows.map(row => {
    const authorized = authorizedFor(row.kind)
    const base = summarize(row, authorized)
    const fields = projections.get(row.id)
    if (!fields) return base
    const capabilities = fields.capabilities ?? base.capabilities
    return { ...base, ...fields, capabilities: { ...capabilities, cancel: base.capabilities.cancel, retry: authorized && capabilities.retry,
      reason: !authorized ? '当前请求仅可查看任务。' : base.capabilities.cancel ? base.capabilities.reason : capabilities.reason } }
  })
}

function readonlySummary(task: TaskSummary): TaskSummary {
  return {
    ...task,
    capabilities: { cancel: false, retry: false, retryItemIds: [], reason: '当前任务中心只读。' },
    ...(task.export ? { export: { ...task.export, canRegenerate: false } } : {}),
  }
}

export async function readPostgresTaskCenterEntry(db: NodePgDatabase, id: string, authorizedFor: (kind: string) => boolean) {
  return db.transaction(async tx => {
    const current = await getPostgresJobSummary(tx, id)
    return current ? (await projectSummaries(tx, [current], authorizedFor, true))[0]! : null
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

function positive(raw: unknown, fallback: number, max: number) {
  return typeof raw !== 'object' && Number.isInteger(Number(raw)) && Number(raw) > 0 ? Math.min(Number(raw), max) : fallback
}

function summarize(row: JobSummaryDto, authorized: boolean): TaskSummary {
  const kind = getTaskKind(row.kind)
  const active = row.state === 'queued' || row.state === 'running'
  const unit = kind?.module === 'core' && kind.group.id === 'ocr' ? '份文件' : '项'
  return {
    id: row.id, kind: row.kind.slice(0, 100), label: kind?.label ?? row.kind.slice(0, 100),
    module: kind?.module ?? null, group: kind?.group.id ?? 'all', state: row.state,
    createdAt: row.createdAt, startedAt: row.startedAt, finishedAt: row.finishedAt,
    progress: { done: row.progress.done, total: row.percent === null || row.progress.total <= 0 ? null : row.progress.total,
      unit, stage: row.state === 'queued' ? '等待执行' : active ? '执行中' : '执行结束' },
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
  const db = usePostgresJobsDb()!
  const writable = postgresJobsEnabled()
  if (action === 'cancel' || action === 'retry') requirePostgresJobsWritable()
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
    const titleCode = TITLE_SEED.find(title => title.code === q.titleCode)?.code
    const kinds = tab.id === 'all' ? undefined : getTaskFilterKinds(tab.id, group?.id)
    const { data, rows } = await db.transaction(async tx => {
      const data = await listPostgresTaskCenter(tx, { page, pageSize, state, kinds, titleCode })
      return { data, rows: await projectSummaries(tx, data.rows, authorizedFor) }
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
    const counts: TaskList['counts'] = { ...Object.fromEntries(getTaskTabs().map(({ id }) => [id, 0])), all: 0 }
    for (const { kind, n } of data.counts) {
      const module = getTaskKind(kind)?.module
      counts.all += Number(n)
      if (module) counts[module] = (counts[module] ?? 0) + Number(n)
    }
    return {
      total: data.total, rows: writable ? rows : rows.map(readonlySummary),
      page, pageSize, counts,
      exportReady: writable && Boolean(postgresJobHandler('current-roster-export')),
      authorized: writable && (apiAuthorized || browserAuthorized),
    } satisfies TaskList
  }

  const id = getRouterParam(event, 'id')
  if (!isJobId(id)) throw createError({ statusCode: 400, message: 'Invalid task ID' })
  if (action === 'detail') {
    const task = await readPostgresTaskCenterEntry(db, id, authorizedFor)
    if (!task) throw createError({ statusCode: 404, message: '任务不存在' })
    return writable ? task : readonlySummary(task)
  }
  const row = await getPostgresJobSummary(db, id)
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
  const task = await getPostgresJobSummary(db, id)
  if (!task) throw createError({ statusCode: 404, message: '任务不存在' })
  return { task: (await projectSummaries(db, [task], authorizedFor))[0], cancelRequested: result.cancelRequested }
}
