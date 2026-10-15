import { useDb } from '@db'
import { handleRosterImportRequest } from '../../../utils/roster-import-http'

/**
 * **只读预检**：`POST /api/roster/import/preflight`（契约 §8.1）。
 *
 * **不写业务数据** —— 只算「这次提交会发生什么」并落一条 `status='preflight'` 的
 * `import_batch`（幂等键 = body 的 `idempotencyKey`）。想真写就用 `/commit`。
 *
 * 需要 token（`Authorization: Bearer <NUXT_API_TOKEN>` 或 `X-API-Token`）；
 * **未配置 token ⇒ 写入整体关闭**（与 `POST /api/jobs` 同一分法）。
 *
 * 逻辑在 `server/utils/roster-import-http.ts`（不 import h3，可被真实 HTTP 回放测试直接驱动），
 * 路由只做 event → 请求描述 → 响应回填这一件事。
 */
defineRouteMeta({
  openAPI: {
    tags: ['名录'],
    summary: '名录导入预检（只读，不写业务数据）',
    description:
      '算「这次提交会发生什么」并落一条 `status=preflight` 的批次，**不改任何业务数据**。' +
      '幂等键是 body 的 `idempotencyKey`：同键重复调用返回/刷新同一批次。' +
      '需要 token：`Authorization: Bearer <NUXT_API_TOKEN>`（或 `X-API-Token`）；未配 token 时本接口整体关闭。' +
      '载荷见 `docs/roster-lifecycle-contract.md` §8.3（含 §8.4 的 `merges` 归并项）。',
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
                  },
                },
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

export default defineEventHandler(async (event) => {
  const response = handleRosterImportRequest(
    'preflight',
    {
      method: getMethod(event),
      headers: {
        authorization: headerString(event, 'authorization'),
        'x-api-token': headerString(event, 'x-api-token'),
      },
      body: await readBody(event).catch(() => null),
    },
    { db: useDb(), apiToken: useRuntimeConfig().apiToken },
  )
  setResponseStatus(event, response.status)
  for (const [name, value] of Object.entries(response.headers)) setHeader(event, name, value)
  return response.body
})

/** h3 的 `getHeader` 会返回 `string | undefined`；重复头（数组）当没带。 */
function headerString(event: Parameters<typeof getHeader>[0], name: string): string | undefined {
  const value = getHeader(event, name)
  return typeof value === 'string' ? value : undefined
}
