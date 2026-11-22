import { postgresJobsEnabled } from '../../utils/postgres-jobs'
import { postgresJobHandler } from '../../utils/job-runner-postgres'
import { jobSpecs } from '../../utils/job-spec-registry'
import { registerJobSpecs } from '../../../../../server/utils/job-specs'

/**
 * 列出**任务种类**。`GET /api/jobs/kinds`
 *
 * 这一条是给**代理**的:它在技能里用 `curl`,看不到任何编译期类型,唯一能问
 * 「现在这儿能派什么活」的地方就是这个接口。所以不只报名字,还报:
 *  - `status`:`ready` 能跑 / `todo` 已登记但尚未接入(提交会得到 501);
 *  - `summary` / `paramsHint`:这个 kind 干什么、`params` 怎么拼;
 *  - `note`:`todo` 的原因与去处(接在哪张票上)。
 *
 * **不报 handler**:那是个函数,不进 JSON,也不该让调用方依赖内部实现。
 *
 * 只读,不鉴权 —— 与 `GET /api/jobs` 同理。
 *
 * 静态段优先于 `[id]`:Nitro 的路由表里静态路由排在动态参数之前,所以
 * `/api/jobs/kinds` 不会被 `server/api/jobs/[id].get.ts` 抢走。这条不是猜测 ——
 * 验收里实测过它返回的是种类表而不是 400「任务 id 非法」。
 */
defineRouteMeta({
  openAPI: {
    tags: ['任务'],
    summary: '列出任务种类(能力发现)',
    description: '代理用它查「现在能提交哪些 kind、参数怎么拼」。只读,不需要 token。',
    responses: {
      200: {
        description: '已登记的任务种类。',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                kinds: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      kind: { type: 'string' },
                      status: { type: 'string', enum: ['ready', 'todo'] },
                      summary: { type: 'string' },
                      paramsHint: { type: 'string', nullable: true },
                      note: { type: 'string', nullable: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
})

export default defineEventHandler(() => {
  registerJobSpecs()
  const writable = postgresJobsEnabled()
  return {
    kinds: jobSpecs().map((spec) => ({
      kind: spec.kind,
      status: writable && postgresJobHandler(spec.kind) ? 'ready' : 'todo',
      summary: spec.summary,
      paramsHint: spec.paramsHint ?? null,
      note: !writable ? '当前任务中心只读'
        : spec.status === 'ready' && !postgresJobHandler(spec.kind) ? '尚未接入 PostgreSQL' : spec.note ?? null,
    })),
  }
})
