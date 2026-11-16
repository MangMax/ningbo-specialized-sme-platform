import { decisionRoute102 } from '../../../utils/decision-lifecycle-102-route'

defineRouteMeta({ openAPI: { tags: ['差异决定'], summary: '提交来源版本绑定迁入资格', description: '仅 replace 且必须提供 currentQualification；需要 API token。预检绑定命令、规则、head、来源身份/内容/归属和事实修订；提交在 immediate 事务内重验。原 commands 保持历史语义。', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['command','planHash'], properties: { command: {
            type: 'object', additionalProperties: false,
            required: ['enterpriseId','titleCode','direction','action','expectedCurrentId','idempotencyKey','actor','basis','ruleVersion','effectiveAt','decision'],
            properties: {
              enterpriseId: { type: 'integer', minimum: 1 },
              titleCode: { type: 'string', enum: ['little_giant','specialized_sme','innovative_sme'] },
              direction: { type: 'string', enum: ['missing_in_miit','extra_in_miit'] },
              action: { type: 'string', enum: ['replace'] },
              expectedCurrentId: { type: 'integer', nullable: true, minimum: 1 },
              idempotencyKey: { type: 'string', description: '1–200 characters' },
              actor: { type: 'object', additionalProperties: false, required: ['type','id'], properties: { type: { type: 'string', enum: ['user','agent'] }, id: { type: 'string', description: '1–200 characters' } } },
              basis: { type: 'string', description: '1–4000 characters' },
              ruleVersion: { type: 'string', description: '1–200 characters' },
              effectiveAt: { type: 'string', format: 'date-time' },
              reviewedEvidence: { type: 'object', additionalProperties: false, required: ['latestRevisionId','projectionReady'], properties: { latestRevisionId: { type: 'integer', minimum: 0 }, projectionReady: { type: 'boolean', enum: [true] } } },
              decision: {
                type: 'object', additionalProperties: false, required: ['status','measureCode','verificationStatus','currentQualification'],
                properties: {
                  status: { type: 'string', enum: ['not_queried','query_failed','no_record','confirmed_no_diff','confirmed_reason','needs_review'] },
                  reasonCode: { type: 'string', nullable: true, enum: ['moved_out','deregistered','renamed','platform_stale','pending_review','moved_in','other'] },
                  reasonNote: { type: 'string', nullable: true, description: '1–4000 characters when non-null' },
                  measureCode: { type: 'string', enum: ['keep_history','mark_platform_snapshot','follow_review','mark_moved_out','mark_deregistered','update_current_name','record_moved_in','manual_review','none'] },
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
                  verificationStatus: { type: 'string', enum: ['confirmed','pending'] },
                  currentQualification: { type: 'object', additionalProperties: false, required: ['titleCode','validFrom','validUntil','basis','publicationCheck'], description: '仅确认同称号迁入决定；须引用现有证据并通过#108复核。日期区间为左闭右开；不是从平台状态推定资格。', properties: { titleCode: { type: 'string', enum: ['little_giant','specialized_sme','innovative_sme'] }, validFrom: { type: 'string', format: 'date-time' }, validUntil: { type: 'string', format: 'date-time' }, awardYear: { type: 'integer', minimum: 1900, maximum: 2200, description: '可选真实新授予年份，不由区间/维护/自由文本推定；不得晚于区间起点年份' }, basis: { type: 'string', description: '1–4000 characters' }, publicationCheck: { type: 'object', additionalProperties: false, required: ['status','scope'], properties: { status: { type: 'string', enum: ['not_found','not_checked'] }, scope: { type: 'string', description: '1–4000 characters' } } } } },
                  movedIn: { type: 'object', additionalProperties: false, properties: { city: { type: 'string', nullable: true, description: '1–4000 characters when non-null' }, titleCode: { type: 'string', nullable: true, enum: ['little_giant','specialized_sme','innovative_sme'] }, year: { type: 'integer', nullable: true, minimum: 1900, maximum: 2200 }, batch: { type: 'integer', nullable: true, minimum: 1 } } },
                },
              },
            },
          }, planHash: { type: 'string', description: '预检返回的 SHA-256；必须为64个小写十六进制字符，由提交协议严格校验' } } } } } }, responses: { '200': { description: '成功' }, '400': { description: '严格输入错误' }, '401': { description: '需要授权' }, '409': { description: '版本或幂等冲突' }, '422': { description: '来源或事实不匹配' } } } })
export default decisionRoute102('qualification-commit')
