import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { TITLE_ORDER } from '~~/lib/labels'
import { FIRST_RECOGNITION_STATUS_VALUES } from '~~/lib/roster/first-recognition'
import { listEnterprises } from '../../utils/mcp-roster'

/**
 * `list_enterprises` —— 跨称号去重的企业总表（RL-11，契约 §9；读，不鉴权）。
 *
 * 等价 `GET /api/roster/enterprises` 的**最小只读面**：身份（名 / 统代 / 属地 / 存续）
 * + 拿过的称号 + **已确认**曾用名 + 派生的 `rosterState`。
 * 企业详情由 `get_enterprise_detail` 复用 RL-04 详情读模型；通用记录和生命周期查询由
 * `query_records` 对接 `GET /api/records`。
 */
export default defineMcpTool({
  name: 'list_enterprises',
  title: '查企业总表',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  description: [
    '跨称号去重的**企业总表**：一行 = 一家企业，`titles` 是它拿过的称号，`aliasNames` 是**已确认**曾用名。',
    '`q` 同时搜现名与已确认曾用名（未确认的别名不参与）；`rosterState` 为 `current`（有 jxj 认定/复核事件）',
    '或 `removed_platform_only`（仅由平台引入、从当前总表移除，但企业行与公布历史保留）。',
    '`firstYear` / `firstStatus` 按同一企业×称号筛首次认定；`firstYear` 与事件年份不同。',
    '只读 tool，不需要 token。',
  ].join('\n'),
  inputSchema: {
    q: z.string().optional().describe('名称 / 曾用名关键词'),
    title: z.enum(TITLE_ORDER as [string, ...string[]]).optional().describe('称号过滤'),
    district: z.string().optional().describe('属地过滤'),
    rosterState: z.enum(['current', 'removed_platform_only']).optional(),
    firstYear: z.array(z.number().int().positive()).optional().describe('首次正式认定年份，可多值'),
    firstStatus: z
      .array(z.enum(FIRST_RECOGNITION_STATUS_VALUES))
      .optional()
      .describe('首次认定状态，可多值：confirmed / pending'),
    page: z.number().int().min(1).optional().describe('页码，默认 1'),
    pageSize: z.number().int().min(1).max(200).optional().describe('每页数量，默认 50，上限 200'),
  },
  handler: async (input) => ({ ...listEnterprises(useDb(), input) }),
})
