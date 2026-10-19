import { currentJobDto } from '../../utils/current-export-artifact'
import { useDb } from '@db'
import { isJobId } from '~~/lib/job'
import { ensureJobRunnerReady } from '../../utils/job-runner'
import { getJob } from '../../utils/job-store'
import { registerJobSpecs } from '../../utils/job-specs'

/**
 * 查一个任务。`GET /api/jobs/:id`
 *
 * 轮询用。只读,**不鉴权** —— 但 id 是 26 位 ULID(不是自增整数),
 * 所以「猜别人的任务 id」不是一条实际可走的路(见 `lib/job.ts` 的 `newJobId`)。
 *
 * 返回的 `progress` 是 `{done,total}` 加派生的 `percent`;`result` / `error` 在
 * 任务结束前都是 `null`(字段在,值是 null —— 客户端不用去猜 undefined)。
 * `state` 的具体取值与含义见 `lib/job.ts` 的 `JOB_STATES`。
 */
defineRouteMeta({
  openAPI: {
    tags: ['任务'],
    summary: '查一个任务(轮询)',
    description: '返回状态、进度、结果与错误。只读,不需要 token。',
    responses: {
      200: {
        description: '任务。',
        content: {
          'application/json': {
            schema: {
              type: 'object',
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
                percent: { type: 'integer', nullable: true, description: '派生量(0–100)，当前名录导出未知总数时null。' },
                params: { type: 'object' },
                result: {
                  type: 'object',
                  nullable: true,
                  description: '形状由 kind 决定;未结束为 null。',
                },
                error: { type: 'string', nullable: true },
                createdAt: { type: 'string' },
                startedAt: { type: 'string', nullable: true },
                finishedAt: { type: 'string', nullable: true },
              },
            },
          },
        },
      },
      400: { description: 'id 不是 26 位 ULID。' },
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

  const db = useDb()
  ensureJobRunnerReady(db)

  const row = getJob(db, id)
  if (!row) throw createError({ statusCode: 404, message: `任务不存在:${id}` })
  return currentJobDto(row,db.$client.name)
})
