import { useDb } from '@db'
import { parseCsvQuery } from '~~/lib/csv'
import { JOB_STATES, type JobState } from '~~/lib/job'
import { ensureJobRunnerReady } from '../../utils/job-runner'
import { DEFAULT_JOB_LIMIT, listJobs, MAX_JOB_LIMIT, toJobDto } from '../../utils/job-store'
import { registerJobSpecs } from '../../utils/job-specs'

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
    description: '按 kind / state 过滤,新的在前。只读,不需要 token。',
    parameters: [
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
                rows: { type: 'array', items: { type: 'object' } },
                total: { type: 'integer', description: '过滤后的总数(不受 limit 影响)' },
              },
            },
          },
        },
      },
    },
  },
})

export default defineEventHandler((event) => {
  registerJobSpecs()
  const db = useDb()
  ensureJobRunnerReady(db)

  const q = getQuery(event)

  const limitRaw = Number(q.limit)
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : DEFAULT_JOB_LIMIT

  const { rows, total } = listJobs(db, {
    kind: parseCsvQuery(q.kind),
    // 状态不在白名单里的值**直接丢掉**(不报 400):列表是查询,拼错一个状态
    // 返回空列表比回一个 400 更符合「查询」的语义。全部丢掉时等同不筛。
    state: parseCsvQuery(q.state)?.filter((s): s is JobState =>
      (JOB_STATES as readonly string[]).includes(s),
    ),
    limit,
  })

  return { rows: rows.map(toJobDto), total }
})
