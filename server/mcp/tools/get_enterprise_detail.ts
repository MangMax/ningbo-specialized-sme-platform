import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { enterpriseReads } from '../../utils/enterprise-read'

/** 与 `GET /api/roster/enterprises/:id` 共用企业详情读模型。 */
export default defineMcpTool({
  name: 'get_enterprise_detail',
  title: '查询企业详情',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  description: [
    '按企业 id 查询企业身份、已确认/待核曾用名、各称号记录、生命周期、事件、出处、差异和平台证据。',
    '返回与 `GET /api/roster/enterprises/:id` 相同的详情读模型。只读，不需要 token。',
    '已认定查询保留全部原始行；行 enterpriseId 为 null 表示未匹配主体，查询键覆盖不确认归属。',
  ].join('\n'),
  inputSchema: {
    enterpriseId: z.number().int().positive().describe('企业 id'),
  },
  handler: async ({ enterpriseId }, extra) => {
    const detail = await enterpriseReads.json(useDb().$client.name, { operation: 'detail',enterpriseId }, extra?.signal)
    if (!detail.found) throw createError({ statusCode: 404, statusMessage: 'not found' })
    return detail.body.toString('utf8')
  },
})
