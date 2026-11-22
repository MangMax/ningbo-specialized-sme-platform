import { readBody, setHeader, setResponseStatus, type H3Event } from 'h3'
import { checkBrowserReviewRequest } from '../../../utils/browser-review-102'
import { browserDecisionCommand102, DecisionError102, parse102, type DecisionCommand102 } from '../../../utils/decision-lifecycle-102/contract'
import { decisionFailure102, postgresDecisionOutput102 } from '../../../utils/decision-lifecycle-102-output'

import { usePostgresRosterDb } from '../../../utils/postgres-roster-db'
import { savePostgresDecision102 } from '../../../utils/decision-lifecycle-102/postgres-writes'

defineRouteMeta({
  openAPI: {
    tags: ['证据复核'],
    summary: '页面同源人工复核（maintain / replace）',
    description: [
      '同源页面默认可提交，不识别个人身份；保留精确 Origin、JSON、业务预检和版本冲突校验。',
      '请求必须由同源浏览器页面发起：Origin 必须精确等于服务端规范化后的请求 origin，Sec-Fetch-Site 不得为跨站；缺失 Origin 一律拒绝，curl/MCP 不豁免。',
      '只接受业务字段，actor 与 ruleVersion 不允许出现在请求体中。落库的 actor/ruleVersion 是真实的 JSON null（“未记录”），幂等哈希覆盖含 null 的完整内部命令。HTTP/MCP 的既有 commands 入口仍要求 actor/ruleVersion 必填。',
    ].join(' '),
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object', additionalProperties: false,
            required: ['enterpriseId', 'titleCode', 'direction', 'action', 'expectedCurrentId', 'idempotencyKey', 'basis', 'effectiveAt'],
            properties: {
              enterpriseId: { type: 'integer', minimum: 1 },
              titleCode: { type: 'string', enum: ['little_giant', 'specialized_sme', 'innovative_sme'] },
              direction: { type: 'string', enum: ['missing_in_miit', 'extra_in_miit'] },
              action: { type: 'string', enum: ['replace', 'maintain'] },
              expectedCurrentId: { type: 'integer', nullable: true, minimum: 1 },
              idempotencyKey: { type: 'string', description: '1–200 characters' },
              basis: { type: 'string', description: '1–4000 characters' },
              effectiveAt: { type: 'string', format: 'date-time' },
              reviewedEvidence: { type: 'object', additionalProperties: false, required: ['latestRevisionId', 'projectionReady'], properties: { latestRevisionId: { type: 'integer', minimum: 0 }, projectionReady: { type: 'boolean', enum: [true] } } },
              decision: {
                type: 'object', additionalProperties: false, required: ['status', 'measureCode', 'verificationStatus'],
                properties: {
                  status: { type: 'string', enum: ['not_queried', 'query_failed', 'no_record', 'confirmed_no_diff', 'confirmed_reason', 'needs_review'] },
                  reasonCode: { type: 'string', nullable: true, enum: ['moved_out', 'deregistered', 'renamed', 'platform_stale', 'pending_review', 'moved_in', 'other'] },
                  reasonNote: { type: 'string', nullable: true, description: '1–4000 characters when non-null' },
                  measureCode: { type: 'string', enum: ['keep_history', 'mark_platform_snapshot', 'follow_review', 'mark_moved_out', 'mark_deregistered', 'update_current_name', 'record_moved_in', 'manual_review', 'none'] },
                  measureNote: { type: 'string', nullable: true, description: '1–4000 characters when non-null' },
                  evidenceQueryId: { type: 'integer', nullable: true, minimum: 1 },
                  evidenceRelationId: { type: 'integer', nullable: true, minimum: 1 },
                  factReferences: {
                    type: 'array', maxItems: 100,
                    items: {
                      type: 'object', additionalProperties: false, required: ['enterpriseId', 'factId', 'revision', 'kind'],
                      properties: {
                        enterpriseId: { type: 'integer', minimum: 1, maximum: 9007199254740991 },
                        factId: { type: 'integer', minimum: 1, maximum: 9007199254740991 },
                        revision: { type: 'integer', minimum: 1, maximum: 9007199254740991 },
                        kind: { type: 'string', enum: ['moved_in', 'moved_out', 'cancelled', 'registration_status'] },
                      },
                    },
                  },
                  verificationStatus: { type: 'string', enum: ['confirmed', 'pending'] },
                  currentQualification: { type: 'object', additionalProperties: false, required: ['titleCode','validFrom','validUntil','basis','publicationCheck'], description: '仅确认同称号迁入决定；须引用现有证据并通过#108复核。日期区间为左闭右开；不是从平台状态推定资格。', properties: { titleCode: { type: 'string', enum: ['little_giant','specialized_sme','innovative_sme'] }, validFrom: { type: 'string', format: 'date-time' }, validUntil: { type: 'string', format: 'date-time' }, awardYear: { type: 'integer', minimum: 1900, maximum: 2200, description: '可选真实新授予年份，不由区间/维护/自由文本推定；不得晚于区间起点年份' }, basis: { type: 'string', description: '1–4000 characters' }, publicationCheck: { type: 'object', additionalProperties: false, required: ['status','scope'], properties: { status: { type: 'string', enum: ['not_found','not_checked'] }, scope: { type: 'string', description: '1–4000 characters' } } } } },
                  movedIn: { type: 'object', additionalProperties: false, properties: { city: { type: 'string', nullable: true }, titleCode: { type: 'string', nullable: true, enum: ['little_giant', 'specialized_sme', 'innovative_sme'] }, year: { type: 'integer', nullable: true, minimum: 1900, maximum: 2200 }, batch: { type: 'integer', nullable: true, minimum: 1 } } },
                },
              },
            },
          },
        },
      },
    },
    responses: {
      200: { description: '回执：versionId/currentId/previousId/action/recordedAt；相同幂等请求返回原回执' },
      400: { description: '非法字段、携带 actor/ruleVersion 或状态组合错误' },
      403: { description: '部署开关未启用、跨站请求、缺 Origin 或 Origin 不匹配' },
      409: { description: 'stale_version / stale_evidence / idempotency_conflict / no_current_decision' },
      415: { description: 'content-type 不是 application/json' },
      422: { description: '证据不存在、归属/称号不符或旧登记时间需核对' },
      500: { description: '事务失败；无部分提交' },
    },
  },
})

export default defineEventHandler(async (event: H3Event) => {
  setHeader(event, 'cache-control', 'no-store')
  try {
    const gate = checkBrowserReviewRequest(event, { write: true })
    if (!gate.ok) throw new DecisionError102(gate.status, gate.code, gate.message)
    let body: unknown
    try {
      body = await readBody(event)
    } catch {
      throw new DecisionError102(400, 'invalid_request', 'Malformed JSON request body')
    }
    const parsed = parse102(browserDecisionCommand102, body)
    // A browser review has no recorded actor and no real business rule version. Null is
    // the honest value; it is filled only here, never accepted from the request body.
    const command: DecisionCommand102 = { ...parsed, actor: null, ruleVersion: null }
    const postgres = usePostgresRosterDb(true)
    const output = await postgresDecisionOutput102(postgres)
    return output(await savePostgresDecision102(postgres, command))
  } catch (error) {
    const failure = decisionFailure102(error)
    if (failure.status === 401) setHeader(event, 'www-authenticate', 'Bearer realm="agent-api"')
    setResponseStatus(event, failure.status)
    return failure.body
  }
})
