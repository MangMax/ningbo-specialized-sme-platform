import { createRosterImportHandler } from '../../../utils/roster-import-route'

defineRouteMeta({
  openAPI: {
    tags: ['名录'],
    summary: '名录导入预检（只读，不写业务数据）',
    description:
      'pending_review（待审核）须显式提交 confirmed_reason + confirmed + follow_review；保留正式历史并跟进审核，区别于 needs_review。' +
      '算「这次提交会发生什么」并落一条 `status=preflight` 的批次，**不改任何业务数据**。' +
      '幂等键是 body 的 `idempotencyKey`：同键重复调用返回/刷新同一批次。' +
      '需要 token：`Authorization: Bearer <NUXT_API_TOKEN>`（或 `X-API-Token`）；未配 token 时本接口整体关闭。' +
      '载荷见 `lib/roster-import-client.ts`（含 §8.4 的 `merges` 归并项）。',
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: '预检结果。',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                batchId: { type: 'integer' },
                status: { type: 'string', enum: ['preflight'] },
                preflight: {
                  type: 'object',
                  properties: {
                    add: { type: 'integer', description: '将新增的行数。' },
                    update: { type: 'integer', description: '将复用/更新的既有行数。' },
                    remove: { type: 'integer', description: '归并会删除的企业行数。' },
                    review: { type: 'integer', description: '落在待核状态的行数。' },
                    conflicts: { type: 'array', items: { type: 'object' } },
                    canonicalProjection: {
                      type: 'array', description: '逐观察的业务身份/内容可验证性计划；新观察 relationId 为 null。',
                      items: { type: 'object', properties: {
                        relationId: { type: 'integer', nullable: true },
                        identityState: { type: 'string', enum: ['resolved', 'missing_key', 'conflict'] },
                        contentState: { type: 'string', enum: ['verified', 'unverifiable'] },
                        keySource: { type: 'string', enum: ['relation_key', 'raw_id', 'both', 'none'] },
                      } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      400: { description: '请求体不合法（缺幂等键 / 来源身份 / payload）。' },
      401: { description: '未带 token、token 不匹配，或服务端未配置 `NUXT_API_TOKEN`。' },
      409: { description: '幂等键属于其他请求或来源；历史投影预检后不能更换命令。' },
    },
  },
})

export default createRosterImportHandler('preflight')
