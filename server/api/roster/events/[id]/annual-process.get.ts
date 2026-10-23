import { defineEventHandler, getMethod, getQuery, getRouterParam, setHeader, setResponseStatus } from 'h3'
import { useDb } from '@db'
import { handleEventAnnualProcessRequest } from '../../../../utils/event-annual-process-api'

defineRouteMeta({ openAPI: { tags: ['名录对应'], summary: '读取单个正式事件的完整年度过程与末态资格', description: '只读GET，不调用preflight或写对应。年度资格先看全部已归档限定范围，再分页展示steps；finalCandidateStepId不等于已确认最终业务。缺年、真冲突、partial和unknown如实返回，不支持asOf/sourceSet。', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }, { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } }, { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } }], responses: { 200: { description: '完整scope资格与来源代次，steps仅展示分页', content: { 'application/json': { schema: { type: 'object', required: ['process', 'sourceGeneration', 'sourceRefs', 'total', 'page', 'pageSize'], properties: {
  process: { type: 'object', required: ['event', 'steps', 'latestStepId', 'latestStepSummary', 'finalCandidateStepId', 'reasons', 'coverage'], properties: {
    event: { type: 'object', description: 'EventSource正式事件字段及record主体/称号' }, ruleVersion: { type: 'string' }, businessYear: { type: 'integer', nullable: true }, declareKind: { type: 'string', nullable: true, enum: ['apply', 'review'] },
    steps: { type: 'array', items: { type: 'object', description: '逻辑业务步：id,year,declareKind,appliedAt(申报时间),status,observedAt,annualEligible,reasons；groups保留共享各接口record/version/observationRefs及实际决定；latestObservationRelationIds/latestVersionRefs/preferredWriteRelationId/corroborationRefs明确末态出处和互证lineage' } },
    latestStepId: { type: 'string', nullable: true }, latestStepSummary: { type: 'object', nullable: true, description: '完整scope最新步id/year/declareKind/appliedAt/status/observedAt；与本响应同代，不依赖当前页' }, finalCandidateStepId: { type: 'string', nullable: true, description: '纯事实资格，不表示已确认对应或最终落地' },
    reasons: { type: 'array', items: { type: 'string' } }, coverage: { type: 'array', items: { type: 'object', description: 'queryId/interface/queriedAt/status/completeness/fullRange，保留partial和legacy未知' } }, coverageReasons: { type: 'array', items: { type: 'string' } }, excludedIdentityRelationIds: { type: 'array', items: { type: 'integer' } },
    finalQualification: { type: 'object', description: '#251当前来源与决定资格读侧扩展', properties: { stepId: { type: 'string', nullable: true }, status: { type: 'string', enum: ['confirmed', 'eligible', 'blocked', 'none'] }, reasons: { type: 'array', items: { type: 'string' } }, decisionRefs: { type: 'array', items: { type: 'object' } } } },
  } }, sourceGeneration: { type: 'string', description: '源集合SHA256，排除对应决定' }, sourceRefs: { type: 'object', description: '完整限定scope/event/evidence/observations/coverage瘦源集合' }, total: { type: 'integer' }, page: { type: 'integer' }, pageSize: { type: 'integer', maximum: 200 },
} } } } }, 400: { description: 'Invalid event or pagination / unknown parameters' }, 404: { description: 'Official award/review event not found' }, 500: { description: 'Sanitized internal error' } } } })
export default defineEventHandler(event => {
  const output = handleEventAnnualProcessRequest({ method: getMethod(event), id: getRouterParam(event, 'id'), query: getQuery(event) }, { get db() { return useDb() } })
  for (const [key, value] of Object.entries(output.headers)) setHeader(event, key, value)
  setResponseStatus(event, output.status)
  return output.body
})
