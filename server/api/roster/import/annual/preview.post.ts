import { useDb } from '@db'
import { handleAnnualPreviewRequest } from '../../../../utils/roster-annual-http'

/**
 * **年度名录增量的只读预览**：`POST /api/roster/import/annual/preview`（RL-07，契约 §8.12）。
 *
 * 请求体是**一次年度更新的载荷包**：`{ year?, entries: [ …§8.1 请求… ] }`
 * （单条 §8.1 请求也可直接给，作为「只更新一份文件」的简写）。每一项还是一条统一写入 API
 * 的请求形状（各自的幂等键），所以预览算出来的东西与随后 `/commit` 真会发生的事同源 ——
 * 计划只有一份实现（`planRosterImport`）。
 *
 * 返回三块：
 *  1. 逐项**分类**（新增 / 更新 / 归并 / 无变化 / 冲突 / 重名候选）与逐项错误；
 *  2. **总表增减**：将移出当前总表、因公布历史而保留、因接口失败而**不得据此删除**（待核）；
 *  3. 影响计数（口径逐字沿用契约 §8.5）。
 *
 * **一行都不写**（连 §8.1 预检会落的那条批次记账也不写）：预览没有副作用，
 * 因此也永远不会覆写已提交批次的记账（§8.9.2 的事故形态）。**不鉴权** —— 它是读面；
 * 真正落库仍是 `POST /api/roster/import/commit`（带 token、单批事务、幂等）。
 * 已 `committed` 的幂等键在这里如实报零并带 `batchStatus='committed'`；
 * 要补出处指针的收敛走 `POST /api/roster/import/replay`（§8.9.3）。
 */
defineRouteMeta({
  openAPI: {
    tags: ['名录'],
    summary: '年度名录增量预览（只读，不写任何行）',
    description:
      '把一次年度更新的载荷包（`{ year?, entries:[…] }`，每项一条 §8.1 请求）算成' +
      '逐项分类 + 总表增减 + 影响计数。**不写任何行**（比 §8.1 的预检更严：连批次记账都不落），' +
      '因此不需要 token —— 它是读面。应用仍走 `POST /api/roster/import/commit`。',
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              year: { type: 'integer', nullable: true, description: '展示用的年度；不参与任何判据。' },
              entries: {
                type: 'array',
                description: '本批要应用的来源文件，每项一条 §8.1 形状的请求（幂等键在项内）。',
                items: { type: 'object' },
              },
            },
          },
        },
      },
    },
    responses: {
      200: {
        description: '预览结果。',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                entries: { type: 'array', items: { type: 'object' } },
                totals: { type: 'object' },
                roster: {
                  type: 'object',
                  description:
                    '总表增减：`removed`（将移出）/ `blocked`（接口失败 ⇒ 不得据此删除，待核）/ `keptByAnnouncement`（有公布历史 ⇒ 不因平台缺失而删除）。',
                },
                applyable: { type: 'boolean' },
                blockedReason: { type: 'string', nullable: true },
              },
            },
          },
        },
      },
      400: { description: '载荷包不合法（缺 entries / 缺幂等键 / 缺 payload）。' },
      405: { description: '本端点是 POST。' },
    },
  },
})

export default defineEventHandler(async (event) => {
  const result = handleAnnualPreviewRequest(
    { method: getMethod(event), body: await readBody(event).catch(() => null) },
    { db: useDb() },
  )
  setResponseStatus(event, result.status)
  for (const [name, value] of Object.entries(result.headers)) setHeader(event, name, value)
  return result.body
})
