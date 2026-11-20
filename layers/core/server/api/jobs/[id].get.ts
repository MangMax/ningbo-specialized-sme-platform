import { postgresJobReadProjector } from '../../utils/job-read-postgres'
import { startPostgresJobs, postgresJobsEnabled } from '../../utils/postgres-jobs'
import { getPostgresJobDetail, getPostgresJobSummary } from '../../utils/job-store-postgres'
import { useDb } from '@db'
import { isJobId } from '#core/lib/job'
import { ensureJobRunnerReady } from '../../utils/job-runner'
import { getJob, getJobSummary } from '../../utils/job-store'
import { jobRuntime } from '../../../../../server/job-runtime'
import { registerJobSpecs } from '../../../../../server/utils/job-specs'

/**
 * 查一个任务。`GET /api/jobs/:id`
 *
 * 轮询用。只读,**不鉴权** —— 但 id 是 26 位 ULID(不是自增整数),
 * 所以「猜别人的任务 id」不是一条实际可走的路(见 `lib/job.ts` 的 `newJobId`)。
 *
 * 返回的 `progress` 是 `{done,total}` 加派生的 `percent`。full 保留完整结果，
 * 包括运行中检查点和失败/取消的部分结果；没有结果或错误时字段为 null。
 * `view=summary` 不读取这些正文，按 detailUrl 获取。
 * `state` 的具体取值与含义见 `lib/job.ts` 的 `JOB_STATES`。
 */
defineRouteMeta({
  openAPI: {
    tags: ['任务'],
    summary: '查一个任务(轮询)',
    description: '默认 full 返回完整参数、结果与错误（凭据与宿主路径脱敏）。view=summary 用于轻量轮询，不读取正文；' +
      '按 detailUrl 无 view 获取完整结果。不需要 token；首次读取仍承担原有 runner 重启对账职责。',
    parameters: [{
      name: 'view', in: 'query', required: false,
      schema: { type: 'string', enum: ['full', 'summary'], default: 'full' },
      description: 'summary 与列表行使用相同摘要 DTO；full 保留原有完整响应。',
    }],
    responses: {
      200: {
        description: '任务。',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              anyOf: [
                {
                  type: 'object',
                  required: ['id', 'kind', 'state', 'params', 'result'],
                  properties: {
                    id: { type: 'string' },
                    kind: { type: 'string' },
                    state: {
                      type: 'string',
                      enum: ['queued', 'running', 'done', 'failed', 'cancelled'],
                    },
                    progress: {
                      type: 'object',
                      properties: { done: { type: 'integer' }, total: { type: 'integer' } },
                    },
                    percent: { type: 'integer', nullable: true, description: '派生量(0–100)，当前名录导出未知总数时 null。' },
                    params: { type: 'object' },
                    result: {
                      type: 'object',
                      nullable: true,
                      description: '形状由 kind 决定；可为运行中检查点或失败/取消的部分结果，没有结果时为 null。',
                    },
                    error: { type: 'string', nullable: true },
                    createdAt: { type: 'string' },
                    startedAt: { type: 'string', nullable: true },
                    finishedAt: { type: 'string', nullable: true },
                  },
                },
                { $ref: '#/components/schemas/JobSummary' },
              ],
            },
          },
        },
      },
      400: { description: 'id 不是 26 位 ULID，或 view 不是单值 full/summary。' },
      404: { description: '没有这个任务。' },
    },
  },
})

export default defineEventHandler(async (event) => {
  registerJobSpecs()
  const id = getRouterParam(event, 'id')
  // 形状先判:把「id 写错了」(400)与「查无此任务」(404)分开,
  // 排查时这句话省一次来回。
  if (!isJobId(id)) throw createError({ statusCode: 400, message: `任务 id 非法(应为 26 位 ULID):${id}` })

  const q = getQuery(event)
  if (q.view !== undefined && q.view !== 'full' && q.view !== 'summary') {
    throw createError({ statusCode: 400, message: 'view 必须是 full 或 summary' })
  }

  if (postgresJobsEnabled()) {
    const config = useRuntimeConfig(event)
    const { db } = startPostgresJobs(config.filesDir)!
    if (q.view === 'summary') {
      const summary = await getPostgresJobSummary(db, id)
      if (!summary) throw createError({ statusCode: 404, message: `任务不存在:${id}` })
      return summary
    }
    const job = await getPostgresJobDetail(db, id)
    if (!job) throw createError({ statusCode: 404, message: `任务不存在:${id}` })
    return postgresJobReadProjector(db, config)(job)
  }

  const db = useDb()
  ensureJobRunnerReady(db)

  if (q.view === 'summary') {
    const summary = getJobSummary(db, id)
    if (!summary) throw createError({ statusCode: 404, message: `任务不存在:${id}` })
    return summary
  }

  const row = getJob(db, id)
  if (!row) throw createError({ statusCode: 404, message: `任务不存在:${id}` })
  return jobRuntime.readProjector(db)(row)
})
