import { useDb } from '@db'
import { parseCsvQuery } from '#core/lib/csv'
import { JOB_STATES, type JobState } from '#core/lib/job'
import { ensureJobRunnerReady } from '../../utils/job-runner'
import { DEFAULT_JOB_LIMIT, listJobs, listJobSummaries, MAX_JOB_LIMIT } from '../../utils/job-store'
import { jobReadProjector } from '../../../../../server/utils/job-read'
import { registerJobSpecs } from '../../../../../server/utils/job-specs'

/**
 * 列出任务。`GET /api/jobs?kind=&state=&limit=`
 *
 * 只读,**不鉴权**(与 `/api/records` 等一致):看得到任务不等于能改库,
 * 而「我刚才提交的那个跑哪去了」是排查的基本动作,不该还要一把钥匙。
 *
 * `kind` / `state` 都接受逗号分隔的多值(`state=queued,running`),与
 * `/api/records`、`/api/files` 的多值口径一致。**新的在前**(排序见 `listJobs`)。
 */
defineRouteMeta({
  openAPI: {
    tags: ['任务'],
    summary: '列出任务',
    description: '按 kind / state 过滤,新的在前。不需要 token。默认 full 保留完整 params/result（凭据与宿主路径脱敏）；' +
      'view=summary 只读取摘要列，正文按 detailUrl 获取。首次读取仍承担原有 runner 重启对账职责。',
    parameters: [
      {
        name: 'view', in: 'query', required: false,
        schema: { type: 'string', enum: ['full', 'summary'], default: 'full' },
        description: '显式 summary 不含 params/result；错误为固定提示，resultSummary.available 表示当前有可读结果（可为部分结果）。',
      },
      {
        name: 'kind',
        in: 'query',
        required: false,
        schema: { type: 'string' },
        description: '任务种类;多值用逗号分隔(`kind=render-pages,ocr`)。',
      },
      {
        name: 'state',
        in: 'query',
        required: false,
        schema: { type: 'string' },
        description: '状态;多值用逗号分隔(`state=queued,running`)。',
      },
      {
        name: 'limit',
        in: 'query',
        required: false,
        schema: { type: 'integer', minimum: 1, maximum: MAX_JOB_LIMIT, default: DEFAULT_JOB_LIMIT },
        description: `返回条数上限(默认 ${DEFAULT_JOB_LIMIT},最多 ${MAX_JOB_LIMIT})。`,
      },
    ],
    responses: {
      200: {
        description: '任务列表(`rows` 按创建时间倒序)。',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                rows: { type: 'array', items: { type: 'object', anyOf: [
                  { type: 'object', required: ['id', 'kind', 'state', 'params', 'result'] },
                  { $ref: '#/components/schemas/JobSummary' },
                ] } },
                total: { type: 'integer', description: '过滤后的总数(不受 limit 影响)' },
              },
            },
          },
        },
      },
      400: { description: 'view 不是 full 或 summary，或重复指定。' },
    },
    $global: {
      components: {
        schemas: {
          JobSummary: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'kind', 'state', 'progress', 'percent', 'error', 'createdAt', 'startedAt', 'finishedAt', 'resultSummary', 'detailUrl', 'capabilities'],
            properties: {
              id: { type: 'string' },
              kind: { type: 'string' },
              state: { type: 'string', enum: ['queued', 'running', 'done', 'failed', 'cancelled'] },
              progress: {
                type: 'object', required: ['done', 'total'],
                properties: { done: { type: 'integer' }, total: { type: 'integer' } },
              },
              percent: { type: 'integer', nullable: true, minimum: 0, maximum: 100, description: '当前名录导出未知总数时为 null。' },
              error: { type: 'string', nullable: true, description: '有错误时固定为「任务有错误，请读取详情」；完整脱敏正文在 detailUrl。' },
              createdAt: { type: 'string' },
              startedAt: { type: 'string', nullable: true },
              finishedAt: { type: 'string', nullable: true },
              resultSummary: {
                type: 'object', required: ['available'],
                properties: { available: { type: 'boolean', description: '存在非 null 结果；不表示成功或完整，可能是部分结果。' } },
              },
              detailUrl: { type: 'string', description: 'GET 原有完整详情；无 view 或 view=full，正文不截断。' },
              capabilities: {
                type: 'object', required: ['cancel'],
                properties: { cancel: { type: 'boolean', description: 'queued/running 时可请求取消；仍需原有写 token，运行中尽力而为。没有通用 retry 能力。' } },
              },
            },
          },
        },
      },
    },
  },
})

export default defineEventHandler(async (event) => {
  registerJobSpecs()
  const db = useDb()
  ensureJobRunnerReady(db)

  const q = getQuery(event)
  if (q.view !== undefined && q.view !== 'full' && q.view !== 'summary') {
    throw createError({ statusCode: 400, message: 'view 必须是 full 或 summary' })
  }

  const limitRaw = Number(q.limit)
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : DEFAULT_JOB_LIMIT

  const query = {
    kind: parseCsvQuery(q.kind),
    // 状态不在白名单里的值**直接丢掉**(不报 400):列表是查询,拼错一个状态
    // 返回空列表比回一个 400 更符合「查询」的语义。全部丢掉时等同不筛。
    state: parseCsvQuery(q.state)?.filter((s): s is JobState =>
      (JOB_STATES as readonly string[]).includes(s),
    ),
    limit,
  }

  if (q.view === 'summary') return listJobSummaries(db, query)
  const { rows, total } = listJobs(db, query)

  return { rows: await Promise.all(rows.map(jobReadProjector(db))), total }
})
