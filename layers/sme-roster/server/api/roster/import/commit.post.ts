import { createRosterImportHandler } from '../../../utils/roster-import-route'

defineRouteMeta({
  openAPI: {
    tags: ['名录'],
    summary: '留存公布原行或提交其他名录业务批次',
    description:
      '公布原行提交返回 staged、intakeId、sourceDigest、rowCount，人工核对后通过 intake/{id}/supplement 显式补充基础库。含类型化公布证据时另返回 officialEvidencePreflightRequired: true，请使用补充接口按已核对的主体和原行预检。' +
      '平台完整原行提交在同一事务收尾核对来源投影；summary.platformFields 按版本去重报告 eligibleVersions/projectionsCreated/projectionsReused/projectionsChecked、observationsChecked/quarantinedObservations 及 ready/partial/not_performed。旧幂等键返回原回执，历史缺字段表示未记录；reuseExisting 纯引用不执行同步。' +
      'pending_review（待审核）须显式提交 confirmed_reason + confirmed + follow_review；保留正式历史并跟进审核，区别于 needs_review。' +
      '按 body 的 `idempotencyKey` 幂等提交：同键重复调用返回既有批次摘要，不重复写企业/事件。' +
      '单批事务：要么整批 committed，要么 failed（`error` 说明原因）—— 绝不部分提交。' +
      '载荷见 `lib/roster-import-client.ts`；归并血缘落 `item_results`。' +
      '需要 token：`Authorization: Bearer <NUXT_API_TOKEN>`（或 `X-API-Token`）；未配 token 时本接口整体关闭。',
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: '公布原行留存为 staged。其他业务批次返回 committed 或 failed。',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                batchId: { type: 'integer' },
                status: { type: 'string', enum: ['staged', 'committed', 'failed'] },
                intakeId: { type: 'integer' }, sourceDigest: { type: 'string' }, rowCount: { type: 'integer' },
                summary: {
                  type: 'object',
                  properties: {
                    written: { type: 'integer', description: '本次**新增**的行数（收敛不算）。' },
                    skipped: { type: 'integer' },
                    failed: { type: 'integer' },
                    canonicalProjection: {
                      type: 'object', description: '新增业务身份/内容/映射单独记数；不计入旧written。',
                      properties: {
                        recordsCreated: { type: 'integer' }, versionsCreated: { type: 'integer' },
                        observationsCreated: { type: 'integer' }, observationsReused: { type: 'integer' },
                        missingKey: { type: 'integer' }, conflict: { type: 'integer' }, unverifiable: { type: 'integer' },
                      },
                    },
                    evidenceRepointed: {
                      type: 'integer',
                      description:
                        '本次真的改掉了几行 `record_evidence.source_file`（出处指针收敛，§8.9）。' +
                        '与预检的 `preflight.evidenceRepoints` 同口径、可直接相等比对。',
                    },
                  },
                },
                items: {
                  type: 'array',
                  description: '逐项结果；失败项形如 `{ ok:false, kind, ref, error:{ code, field?, message } }`。',
                  items: { type: 'object', properties: {
                    detail: { type: 'object', properties: {
                      canonicalProjection: { type: 'array', items: { type: 'object', properties: {
                        relationId: { type: 'integer' }, recordId: { type: 'integer', nullable: true }, versionId: { type: 'integer', nullable: true },
                        identityState: { type: 'string', enum: ['resolved', 'missing_key', 'conflict'] },
                        contentState: { type: 'string', enum: ['verified', 'unverifiable'] },
                        keySource: { type: 'string', enum: ['relation_key', 'raw_id', 'both', 'none'] },
                        projectionRuleVersion: { type: 'string' }, inputFingerprint: { type: 'string' },
                        recordCreated: { type: 'boolean' }, versionCreated: { type: 'boolean' }, observationCreated: { type: 'boolean' },
                      } } },
                    } },
                  } },
                },
                error: { type: 'string', nullable: true },
              },
            },
          },
        },
      },
      400: { description: '请求体不合法（缺幂等键 / 来源身份 / payload）。' },
      401: { description: '未带 token、token 不匹配，或服务端未配置 `NUXT_API_TOKEN`。' },
      409: { description: '幂等键属于其他请求或来源；历史投影预检/失败后也不能更换命令。' },
    },
  },
})

export default createRosterImportHandler('commit')
