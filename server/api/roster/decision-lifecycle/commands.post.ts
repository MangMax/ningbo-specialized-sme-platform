import { decisionRoute102 } from '../../../utils/decision-lifecycle-102-route'

defineRouteMeta({
  openAPI: {
    tags: ['差异决定'],
    summary: '追加替代或撤回差异决定',
    description: '需要 API token；每次操作追加版本，保留旧原因。expectedCurrentId 是当前版本（包括撤回标记）的 ID，首次为 null。replace 必须给完整 decision；withdraw/maintain 必须省略 decision。maintain 必须给 reviewedEvidence；replace 可带已审证据，withdraw 禁止带。复核检查最新证据和投影就绪。见 docs/evidence-review-contract-114.md。effectiveAt 是显式业务时点。见 docs/maintenance-102.md。',
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object', additionalProperties: false,
            required: ['enterpriseId','titleCode','direction','action','expectedCurrentId','idempotencyKey','actor','basis','ruleVersion','effectiveAt'],
            properties: {
              enterpriseId: { type: 'integer', minimum: 1 },
              titleCode: { type: 'string', enum: ['little_giant','specialized_sme','innovative_sme'] },
              direction: { type: 'string', enum: ['missing_in_miit','extra_in_miit'] },
              action: { type: 'string', enum: ['replace','withdraw','maintain'] },
              expectedCurrentId: { type: 'integer', nullable: true, minimum: 1 },
              idempotencyKey: { type: 'string', description: '1–200 characters' },
              actor: { type: 'object', additionalProperties: false, required: ['type','id'], properties: { type: { type: 'string', enum: ['user','agent'] }, id: { type: 'string', description: '1–200 characters' } } },
              basis: { type: 'string', description: '1–4000 characters' },
              ruleVersion: { type: 'string', description: '1–200 characters' },
              effectiveAt: { type: 'string', format: 'date-time' },
              reviewedEvidence: { type: 'object', additionalProperties: false, required: ['latestRevisionId','projectionReady'], properties: { latestRevisionId: { type: 'integer', minimum: 0 }, projectionReady: { type: 'boolean', enum: [true] } } },
              decision: {
                type: 'object', additionalProperties: false, required: ['status','measureCode','verificationStatus'],
                properties: {
                  status: { type: 'string', enum: ['not_queried','query_failed','no_record','confirmed_no_diff','confirmed_reason','needs_review'] },
                  reasonCode: { type: 'string', nullable: true, enum: ['moved_out','deregistered','renamed','platform_stale','pending_review','moved_in','other'] },
                  reasonNote: { type: 'string', nullable: true, description: '1–4000 characters when non-null' },
                  measureCode: { type: 'string', enum: ['keep_history','mark_platform_snapshot','follow_review','mark_moved_out','mark_deregistered','update_current_name','record_moved_in','manual_review','none'] },
                  measureNote: { type: 'string', nullable: true, description: '1–4000 characters when non-null' },
                  evidenceQueryId: { type: 'integer', nullable: true, minimum: 1 },
                  evidenceRelationId: { type: 'integer', nullable: true, minimum: 1 },
                  verificationStatus: { type: 'string', enum: ['confirmed','pending'] },
                  currentQualification: { type: 'object', additionalProperties: false, required: ['titleCode','validFrom','validUntil','basis','publicationCheck'], description: '仅确认同称号迁入决定；须引用现有证据并通过#108复核。日期区间为左闭右开；不是从平台状态推定资格。', properties: { titleCode: { type: 'string', enum: ['little_giant','specialized_sme','innovative_sme'] }, validFrom: { type: 'string', format: 'date-time' }, validUntil: { type: 'string', format: 'date-time' }, basis: { type: 'string', description: '1–4000 characters' }, publicationCheck: { type: 'object', additionalProperties: false, required: ['status','scope'], properties: { status: { type: 'string', enum: ['not_found','not_checked'] }, scope: { type: 'string', description: '1–4000 characters' } } } } },
                  movedIn: { type: 'object', additionalProperties: false, properties: { city: { type: 'string', nullable: true, description: '1–4000 characters when non-null' }, titleCode: { type: 'string', nullable: true, enum: ['little_giant','specialized_sme','innovative_sme'] }, year: { type: 'integer', nullable: true, minimum: 1900, maximum: 2200 }, batch: { type: 'integer', nullable: true, minimum: 1 } } },
                },
              },
            },
          },
        },
      },
    },
    responses: {
      200: { description: '回执：versionId/currentId/previousId/action/recordedAt；相同幂等请求返回原回执（currentId 为当次结果）' },
      400: { description: '非法字段、缺元数据或状态组合错误' },
      401: { description: '未配置 token、缺 token 或 token 不匹配' },
      404: { description: '企业不存在' },
      409: { description: 'stale_version / idempotency_conflict / no_current_decision / stale_evidence' },
      422: { description: '证据不存在、归属/称号不符或旧登记时间需核对' },
      500: { description: '事务失败；无部分提交' },
    },
  },
})
export default decisionRoute102('commands')
