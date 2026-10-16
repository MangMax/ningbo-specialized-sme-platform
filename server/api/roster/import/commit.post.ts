import { createRosterImportHandler } from '../../../utils/roster-import-route'

/**
 * **事务提交**：`POST /api/roster/import/commit`（契约 §8.2）。
 *
 * 请求体同 `/preflight`。**幂等键在 body 的 `idempotencyKey`**（`import_batch.idempotency_key` 唯一）：
 * 同一 key 重复调用**不再重复写企业/事件**，返回既有批次的摘要。
 *
 * **单批事务**：要么整批 `committed`，要么 `failed` 且 `error` 说明原因 —— 绝不部分提交。
 * 逐项错误形状 `{ ok:false, kind, ref, error:{ code, field?, message } }`，不静默丢行。
 *
 * 需要 token（`Authorization: Bearer <NUXT_API_TOKEN>` 或 `X-API-Token`）；未配 token ⇒ 整体关闭。
 */
defineRouteMeta({
  openAPI: {
    tags: ['名录'],
    summary: '名录导入提交（单批事务、幂等重放）',
    description:
      '按 body 的 `idempotencyKey` 幂等提交：同键重复调用返回既有批次摘要，不重复写企业/事件。' +
      '单批事务：要么整批 committed，要么 failed（`error` 说明原因）—— 绝不部分提交。' +
      '载荷见 `docs/roster-lifecycle-contract.md` §8.3，归并项见 §8.4（血缘落 `item_results`）。' +
      '需要 token：`Authorization: Bearer <NUXT_API_TOKEN>`（或 `X-API-Token`）；未配 token 时本接口整体关闭。',
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['idempotencyKey', 'sourceKind', 'sourceIdentity', 'payload'],
            properties: {
              idempotencyKey: { type: 'string', description: '幂等键（库层面唯一）。' },
              sourceKind: {
                type: 'string',
                enum: ['announcement', 'platform_export', 'alias_evidence'],
              },
              sourceIdentity: { type: 'string', description: '来源身份：文件相对路径 / 逻辑标识（不含凭证）。' },
              sourceSha256: { type: 'string', nullable: true },
              payload: { type: 'object', description: '写入载荷（契约 §8.3 / §8.4）。' },
            },
          },
        },
      },
    },
    responses: {
      200: {
        description: '提交结果（`committed` 或 `failed`；`failed` 时业务数据一行未写）。',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                batchId: { type: 'integer' },
                status: { type: 'string', enum: ['committed', 'failed'] },
                summary: {
                  type: 'object',
                  properties: {
                    written: { type: 'integer', description: '本次**新增**的行数（收敛不算）。' },
                    skipped: { type: 'integer' },
                    failed: { type: 'integer' },
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
                  items: { type: 'object' },
                },
                error: { type: 'string', nullable: true },
              },
            },
          },
        },
      },
      400: { description: '请求体不合法（缺幂等键 / 来源身份 / payload）。' },
      401: { description: '未带 token、token 不匹配，或服务端未配置 `NUXT_API_TOKEN`。' },
    },
  },
})

export default createRosterImportHandler('commit')
