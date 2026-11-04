import { createReadTurns, runReadTurn } from '../../utils/read-turn'
import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { TITLE_ORDER } from '~~/lib/labels'
import { listDifferences } from '../../utils/mcp-roster'

const differenceReads = createReadTurns((input: Parameters<typeof listDifferences>[1] & { [key: string]: string | number | undefined }) =>
  listDifferences(useDb(), input))

/**
 * `list_differences` —— 差异与解释（RL-11，契约 §9；读，不鉴权）。
 *
 * 等价 `GET /api/roster/differences` 的**最小只读面**：每 (企业 × 称号 × 方向) 的
 * **当前解释**（`recordedAt` 最新那条）+ 原因/措施的成对取值 + 证据指向的平台查询。
 * 旧解释不丢，只是不再出现在这里（时态化，见契约 §1.5）。
 */
export default defineMcpTool({
  name: 'list_differences',
  title: '查差异与解释',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  description: [
    '显式关联主体事实时额外返回 factReferences（enterpriseId/factId/revision/kind）；按存储版本原样读回，不跟随之后更正或撤回；旧空引用不新增空字段。',
    '名录与平台的差异及其**当前解释**（每 企业×称号×方向 取 `recordedAt` 最新那条）。',
    '`status` 是契约 §3.2 的六态（未查询 / 查询失败 / 无记录 / 已确认无差异 / 已确认原因 / 待核实 —— 彼此可区分）；',
    '`reasonCode` 与 `measureCode` **成对**；`movedIn` 承载迁入的原城市/称号/年份/批次（缺项留空待核）。',
    '增量 queryCoverage/currentDecision/explanationValidity/assessment 与 REST/企业详情同源；旧 status 保留原义。当前决定复用 #102，撤回保留 versionId 且 current=null。契约 docs/query-coverage-contract-108.md。',
    '`evidence` 指向支撑该解释的平台查询。只读 tool，不需要 token。',
  ].join('\n'),
  inputSchema: {
    title: z.enum(TITLE_ORDER as [string, ...string[]]).optional().describe('称号过滤'),
    direction: z.enum(['missing_in_miit', 'extra_in_miit']).optional(),
    status: z
      .enum([
        'not_queried',
        'query_failed',
        'no_record',
        'confirmed_no_diff',
        'confirmed_reason',
        'needs_review',
      ])
      .optional(),
    page: z.number().int().min(1).optional(),
    pageSize: z.number().int().min(1).max(200).optional(),
  },
  handler: async (input, extra) => {
    useDb()
    // Project only SDK-validated primitive options, never the SDK request.
    const options = { title: input.title, direction: input.direction, status: input.status, page: input.page, pageSize: input.pageSize }
    const result = await runReadTurn(differenceReads, options, extra?.signal)
    // Propagate the SDK's own cancellation reason, never a domain 499/503 or
    // an empty successful list for a cancelled call.
    if (result === undefined) extra?.signal.throwIfAborted()
    return result!
  },
})
