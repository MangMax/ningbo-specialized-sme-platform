import { requestLogContext } from '../../../lib/logging'
import { useDb } from '@db'
import { isJobId } from '#core/lib/job'
import { requireApiToken } from '../../../../../server/utils/api-guard'
import { ensureJobRunnerReady, requestJobCancel } from '../../utils/job-runner'
import { getJob, toJobDto } from '../../utils/job-store'
import { registerJobSpecs } from '../../../../../server/utils/job-specs'

/**
 * 取消一个任务。`DELETE /api/jobs/:id`
 *
 * ⚠️ **取消是「尽力而为」** —— 这不是措辞含糊,是接口契约,`note` 字段会原样说一遍:
 *
 *  - **排队中** → 真取消:从队列摘掉 + 落库 `cancelled`,一次 200,`cancelled: true`;
 *  - **运行中** → 只能**请求**取消:打一个标记,handler 在**下一个检查点**(通常是
 *    「处理下一份文件之前」)才停。已经进到一次 PDFium 渲染 / 一次外部 HTTP 调用里的
 *    那一步**不会被打断**,它跑完。所以这里是 **202**,`cancelRequested: true`,
 *    要再 `GET` 一次才知道最终是不是 `cancelled`;
 *  - **已结束** → 不生效,200 如实回报当前状态与 `alreadyFinished: true`。
 *
 * 为什么不做「强杀」:正在跑的 `render-pages` 手里有 PDFium 的文档句柄和 sharp 的
 * 中间态,强杀会留下 `.tmp` 与不一致的页图目录 —— 那比多跑几秒坏得多。急不得。
 *
 * **需要 token**:取消是改库(把一个任务从「跑着」变成「不跑了」),
 * 与提交同一档风险。
 */
defineRouteMeta({
  openAPI: {
    tags: ['任务'],
    summary: '取消任务(尽力而为)',
    description:
      '排队中的任务会被真正取消;运行中的任务只能请求取消 —— handler 在下一个检查点停止,' +
      '正在执行的单步会先跑完。需要 token(`Authorization: Bearer <NUXT_API_TOKEN>`)。',
    // 引用的安全方案在 `POST /api/jobs` 的 `$global` 里声明(它进 spec 的全局段)。
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: '已取消(排队中)或任务已结束(取消不生效,如实回报状态)。' },
      202: { description: '运行中,已请求取消;稍后 GET 本任务看最终状态。' },
      400: { description: 'id 不是 26 位 ULID。' },
      401: { description: '未带 token 或 token 不匹配。' },
      404: { description: '没有这个任务。' },
    },
  },
})

export default defineEventHandler((event) => {
  requireApiToken(event)
  registerJobSpecs()

  const id = getRouterParam(event, 'id')
  if (!isJobId(id)) throw createError({ statusCode: 400, message: `任务 id 非法(应为 26 位 ULID):${id}` })

  const db = useDb()
  ensureJobRunnerReady(db)

  const outcome = requestJobCancel(db, id, requestLogContext(event))
  if (!outcome.ok) throw createError({ statusCode: 404, message: outcome.message })

  // 运行中的取消请求是**异步**生效的(下一个检查点),用 202 把这个区别说清楚;
  // 排队中/已结束都是当场有结论的,200。
  const accepted = 'cancelRequested' in outcome && outcome.cancelRequested
  if (accepted) setResponseStatus(event, 202)

  return {
    ...toJobDto(getJob(db, id)!),
    cancelled: outcome.cancelled,
    alreadyFinished: 'alreadyFinished' in outcome ? outcome.alreadyFinished : false,
    cancelRequested: accepted,
    note: outcome.note,
  }
})
