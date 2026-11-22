import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { usePostgresRosterDb } from '../../utils/postgres-roster-db'
import { readPostgresRosterEnterpriseDetail } from '../../../lib/roster/enterprise-detail-postgres'

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
    'businessTimeline 与 qualificationAssessment 在同一只读快照及 asOf 返回；四来源 publication/recognized_list/business_list/apply_list 并列，事项/结论/业务时间/实际期间来自来源事实，collectedAt 仅为辅助采集时间。未知周期不猜，重复采集不产生新事件，不需要 confirmed 对应，不补造公布事件；普通展示使用此窄投影，旧追溯字段保留后台。',
    '按企业 id 查询企业身份、已确认/待核曾用名、各称号记录、生命周期、事件、出处、差异和平台证据。',
    '返回与 `GET /api/roster/enterprises/:id` 相同的详情读模型。只读，不需要 token。',
    '新增 qualificationAssessment：同一只读快照绑定企业、称号、原周期、执行时点及事实/来源/决定/观察版本；分别解释正式资格、主体、地域、平台观察、对应和资料缺口。旧字段原义不变，不生成任务或确认。',
    '新增 titleAssessments 与差异行 queryCoverage/currentDecision/explanationValidity/assessment；覆盖、决定、解释有效性独立；旧 status 保留原义。',
    '已认定查询保留全部原始行；行 enterpriseId 为 null 表示未匹配主体，查询键覆盖不确认归属。',
  ].join('\n'),
  inputSchema: {
    enterpriseId: z.number().int().positive().describe('企业 id'),
  },
  handler: async ({ enterpriseId }) => {
    const detail = await readPostgresRosterEnterpriseDetail(usePostgresRosterDb(), enterpriseId)
    if (!detail) throw createError({ statusCode: 404, statusMessage: 'not found' })
    return JSON.stringify(detail)
  },
})
