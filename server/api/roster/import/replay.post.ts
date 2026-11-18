import { createRosterImportHandler } from '../../../../layers/sme-roster/server/utils/roster-import-route'

/**
 * **出处指针收敛重放**：`POST /api/roster/import/replay`（契约 §8.9.3）。
 *
 * 请求体与 `/commit` 完全相同。差别只在**做什么**：
 *  - `/commit` 按幂等键**一次性地**写入企业 / 记录 / 事件 / 出处；键被消费后，
 *    同键再调只用返回既有摘要，一行不写（§8.2 的幂等，保持不变）；
 *  - `/replay` **只把既有出处行的 `source_file` 收敛到载荷给的新路径** —— 一行不加、
 *    一行不删、事件坐标与结论一个字节不动，**对已 `committed` 的键也能跑**。
 *
 * 为什么要它：出处指针的收敛依赖「来源文件已经入库」这件事，而它可能**晚于**那次提交
 * （提交跑的是旧构建、载荷当时还指着库外路径、文件后落位……）。没有这条路径，受影响的库
 * 就永远修不回来 —— 幂等键已经消费掉了。
 *
 * 幂等键在 body 的 `idempotencyKey`；本次收敛的记账行键是 `<原键>#repoint`
 * （同一份请求重放多少次都是同一行记账，且一眼看出是哪一批的收敛）。
 * 重放本身也是幂等的：指针已经收敛过之后，谓词不再命中 ⇒ `evidenceRepointed: 0`。
 *
 * 需要 token（`Authorization: Bearer <NUXT_API_TOKEN>` 或 `X-API-Token`）；未配 token ⇒ 整体关闭。
 */
defineRouteMeta({
  openAPI: {
    tags: ['名录'],
    summary: '出处指针收敛重放（只改 source_file，不含新增）',
    description:
      '把既有 `record_evidence.source_file` 收敛到载荷给的新路径（同一份来源内容入库后位置变了）。' +
      '一行不加、一行不删、事件坐标与结论不动；对已 committed 的幂等键也能跑，故幂等键被消费后仍可修复。' +
      '记账行键 = `<idempotencyKey>#repoint`，可重复调用（已收敛则为 0）。' +
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
              idempotencyKey: { type: 'string', description: '幂等键（记账行会加 `#repoint` 后缀）。' },
              sourceKind: {
                type: 'string',
                enum: ['announcement', 'platform_export', 'alias_evidence'],
              },
              sourceIdentity: { type: 'string', description: '来源身份：文件库内相对路径 / 逻辑标识（不含凭证）。' },
              sourceSha256: { type: 'string', nullable: true },
              payload: { type: 'object', description: '写入载荷（契约 §8.3）；重放只读其中的出处坐标与路径。' },
            },
          },
        },
      },
    },
    responses: {
      200: {
        description:
          '`{ batchId, status, update, evidenceRepointed, items, error }`。' +
          '`update` = 将收敛的**计划项**数（同 §8.5 的 `update` 口径）；' +
          '`evidenceRepointed` = 真的改掉的**出处行**数（同预检 `evidenceRepoints` 口径）。',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                batchId: { type: 'integer' },
                status: { type: 'string', enum: ['replayed', 'failed'] },
                update: { type: 'integer' },
                evidenceRepointed: { type: 'integer' },
                items: { type: 'array', items: { type: 'object' } },
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

export default createRosterImportHandler('replay')
