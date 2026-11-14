import { requestLogContext } from '../../../lib/logging'
import { useDb } from '@db'
import { COMPARISON_DIRECTIONS } from '~~/lib/comparison'
import { DIFFERENCE_REASONS, DIFFERENCE_STATUSES } from '~~/lib/labels'
import { readDifferences } from '../../utils/difference-read'
import { withEnterpriseReadSignal } from '../../utils/enterprise-read-signal'
import { parseRosterDifferenceQuery } from '../../utils/roster-read-query'

/**
 * **差异与解释**(契约 §7.3,RL-04)。
 *
 * 只读。两个方向都能筛:**公布有而平台无**(`missing_in_miit`)、
 * **平台有而公布无**(`extra_in_miit`)。
 *
 * ── 展示态只从 `difference_reason.status` 取(父代理 2026-10-16 裁决 #1)──────
 * 「未查询 / 查询失败 / 无记录 / 已确认无差异 / 已确认原因 / 待核实」六态**互不冒充**。
 * 还没有解释记录的坐标显示状态机的**默认态** `not_queried`(**不是**从别的列
 * 二次推导出来的结论),并用 `explanationId === null` 说明「确实没有存下来的解释」。
 *
 * 一行 = 一个 (企业 × 称号 × 方向) 的**当前**解释(时态化:`recordedAt` 最新那条);
 * 旧解释不丢,只是不再出现在这里(契约 §1.5)。
 *
 * queryCoverage / currentDecision / explanationValidity / assessment 是独立增量字段，
 * 不再从旧 status 判断实际查询覆盖。读接口不鉴权，no-store。
 */
defineRouteMeta({
  openAPI: {
    tags: ['名录'],
    summary: '差异与解释',
    description:
      '显式关联主体事实时额外返回 factReferences（enterpriseId/factId/revision/kind）；按存储版本原样读回，不跟随之后更正或撤回；旧空引用不新增空字段。增量返回 queryCoverage/currentDecision/explanationValidity/assessment；当前决定复用 #102，撤回后 current=null 且保留 versionId；旧 status 保持原义。每 (企业 × 称号 × 方向) 一条当前解释;`status` 是契约 §3.2 的六态,`reasonCode` 与 `measureCode` **成对**;`movedIn` 承载迁入的原城市/称号/年份/批次(缺项留空待核)。',
    parameters: [
      {
        name: 'q',
        in: 'query',
        schema: { type: 'string' },
        description: '企业名称 / **已确认**曾用名关键词(与 `GET /api/roster/enterprises` 同一搜索口径)。',
      },
      {
        name: 'title',
        in: 'query',
        schema: { type: 'string' },
        description: '称号代号,多值:`little_giant` / `specialized_sme` / `innovative_sme`。',
      },
      {
        name: 'direction',
        in: 'query',
        schema: { type: 'string', enum: [...COMPARISON_DIRECTIONS] },
        description: '差异方向:公布有而平台无 / 平台有而公布无。多值(逗号分隔)。',
      },
      {
        name: 'status',
        in: 'query',
        schema: { type: 'string', enum: Object.keys(DIFFERENCE_STATUSES) },
        description: '差异状态(契约 §3.2),多值。',
      },
      {
        name: 'reason',
        in: 'query',
        schema: { type: 'string', enum: Object.keys(DIFFERENCE_REASONS) },
        description: '已知原因(契约 §2.8),多值。',
      },
      { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
      { name: 'pageSize', in: 'query', schema: { type: 'integer', default: 50, maximum: 200 } },
    ],
    responses: {
      200: { description: '差异行(`rows` / `counts` / `total` / `page` / `pageSize`)。' },
      400: { description: '`title` / `direction` / `status` / `reason` 取值非法。' },
    },
  },
})

function differenceOptions(query: Record<string, unknown>) {
  return { ...parseRosterDifferenceQuery(query) }
}

export default defineEventHandler((event) => {
  setHeader(event, 'cache-control', 'no-store')
  // Preserve owner-connection acquisition and validation before deferral.
  const owner = useDb()
  const filter = differenceOptions(getQuery(event))
  return withEnterpriseReadSignal(event, async signal => {
    const result = await readDifferences(owner, filter, signal, undefined, requestLogContext(event))
    if (Buffer.isBuffer(result)) setHeader(event, 'content-type', 'application/json')
    return result
  })
})
