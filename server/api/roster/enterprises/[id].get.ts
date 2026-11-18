import { requestLogContext } from '../../../../layers/core/lib/logging'
import { admitEnterpriseResponse } from '../../../../layers/sme-roster/server/utils/enterprise-read-response'
import { useDb } from '@db'
import { enterpriseReads } from '../../../../layers/sme-roster/server/utils/enterprise-read'
import { withEnterpriseReadSignal } from '../../../../layers/core/server/utils/enterprise-read-signal'

/**
 * **企业详情**(契约 §7.2,RL-04):一家企业的全部称号历史与证据。
 *
 * 六段:
 *  - `enterprise` —— §7.1 的那一行(现名/统代/属地/`rosterState`/称号/曾用名/首次认定/下次复核);
 *  - `aliases` —— 曾用名逐条(`pending` 也在,只是不参与搜索);
 *  - `records` —— 企业 × 称号 × 来源,每条带该称号的生命周期(契约 §6 的算法);
 *  - `events` —— 认定/复核/维护/培育,含**复核结论**与**结论年份**;
 *  - `evidence` —— 出处(文件/附件/序号/**页码**,RL-10 的跳转依据);
 *  - `differences` —— 每项的**当前**解释(旧解释不丢,只是不在这里);
 *  - `platform` —— 平台查询与**全部**关系(一个统代的多条关联一条不折叠)。
 *
 * 读接口不鉴权。
 */
defineRouteMeta({
  openAPI: {
    tags: ['名录'],
    summary: '企业详情(跨称号)',
    description:
      'businessTimeline 与 qualificationAssessment 在同一只读快照及 asOf 返回；四来源 publication/recognized_list/business_list/apply_list 并列，事项/结论/业务时间/实际期间来自来源事实，collectedAt 仅为辅助采集时间。未知周期不猜，重复采集不产生新事件，不需要 confirmed 对应，不补造公布事件；普通展示使用此窄投影，旧追溯字段保留后台。' +
      '显式关联主体事实时额外返回 factReferences（enterpriseId/factId/revision/kind）；按存储版本原样读回，不跟随之后更正或撤回；旧空引用不新增空字段。新增 publishedPresentation：只含逐出处名称六字段 facts，按 evidence.id 关联；unavailable+安全码保留旧详情，完整C封套仍需原token。详情/正式来源/current-qualified消费新增 titleAssessments 与差异行 queryCoverage/currentDecision/explanationValidity/assessment，覆盖、决定、解释有效性独立。含 aliases / records / events / evidence / recognitions / differences / platform。`recognitions` 按企业 × 称号返回最早正式 `award`、年份(`decidedYear ?? year`)、出处与状态(`confirmed` / `pending`)；`platform.relations` 保留该企业的**全部**平台关联(不按统代折叠)。新增 `platform.businessRecords`：同接口+canonical record 分组、versions、observationRefs、versionCount/observationCount/unknownContentObservationCount、各原行 existingCorrespondenceIds/existingCorrespondences/conflicts；代表按实际 queriedAt 选择，已知 recordId 的未知内容观察同属一条业务、逐次保留且不造版本；无业务身份的原行独立回退。每个 observationRef 新增 typedFields：投影存在时为来源模块拥有的 typed fact（projectionVersionId/projectionRuleVersion/modeledFields 与来源字段）；null 表示未投影、展示回退旧列；typedFields 对象存在但字段为 null 表示来源未知，不回填 raw/导入列。原 queries/relations 与决定端点不变。',
    responses: {
      200: { description: '企业详情。新增 qualificationAssessment：同一只读快照的企业、称号、原周期、执行时点及事实/来源/决定/观察版本；分别解释正式资格、主体、地域、平台观察、对应和资料缺口，旧字段原义不变。不写库、不生成任务。已认定查询保留全部原始行，行 enterpriseId 为 number 或 null；null 表示未匹配主体，查询键覆盖不确认归属。relationCount 与返回行一致。' },
      503: { description: '企业读取队列或响应并发已满，或执行器暂时不可用；可重试，不表示无记录。' },
      400: { description: 'id 不是数字。' },
      404: { description: '没有这个企业。' },
    },
  },
})

export default defineEventHandler((event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isFinite(id)) throw createError({ statusCode: 400, statusMessage: 'invalid id' })
  setHeader(event, 'cache-control', 'no-store')
  admitEnterpriseResponse(event)
  return withEnterpriseReadSignal(event, async signal => {
    const detail = await enterpriseReads.json(useDb().$client.name, { operation: 'detail',enterpriseId: id }, signal, requestLogContext(event))
    if (!detail.found) throw createError({ statusCode: 404, statusMessage: 'not found' })
    setHeader(event, 'content-type', 'application/json; charset=utf-8')
    return detail.body
  })
})
