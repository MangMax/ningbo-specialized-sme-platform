import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { EVENT_ORDER, SOURCE_ORDER, TITLE_ORDER } from '~~/lib/labels'
import { listRecords } from '~~/lib/query'
import { parseRecordQuery } from '../../utils/roster-read-query'

/** 通用记录查询；与 `GET /api/records` 共用参数解析和读模型。 */
export default defineMcpTool({
  name: 'query_records',
  title: '查询名录记录',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  description: [
    '通用名录查询，一行 = 企业×称号，保留全部来源、历史事件和出处。',
    '`year` 是事件所涉年份；`dueYear` 是共享生命周期规则计算出的到期年份，两者不可互换。',
    '`q` 搜企业现名、已确认曾用名或统一社会信用代码。只读，不需要 token。',
  ].join('\n'),
  inputSchema: {
    title: z.array(z.enum(TITLE_ORDER as [string, ...string[]])).optional(),
    source: z.array(z.enum(SOURCE_ORDER as [string, ...string[]])).optional(),
    district: z.string().optional(),
    eventType: z.array(z.enum(EVENT_ORDER as [string, ...string[]])).optional(),
    year: z.array(z.number().int().positive()).optional().describe('事件所涉年份，可多值'),
    dueYear: z.number().int().min(1900).max(2999).optional().describe('生命周期到期年份，单值精确匹配'),
    q: z.string().optional().describe('企业现名、已确认曾用名或统一社会信用代码关键词'),
    flags: z.string().optional().describe('企业质量标记，逗号分隔'),
    page: z.number().int().min(1).optional(),
    pageSize: z.number().int().min(1).max(200).optional(),
  },
  handler: async (input) =>
    listRecords(useDb(), parseRecordQuery(input as Record<string, unknown>)),
})
