import { useDb } from '@db'
import { handleImportBatchesRequest } from '../../../utils/roster-annual-http'

/**
 * **导入批次流水**：`GET /api/roster/import/batches?limit=N`（RL-07）。
 *
 * 「应用结果和失败项**可追溯**」不需要新表：`import_batch` 本来就记着幂等键、来源身份、
 * 状态、摘要、逐项结果与错误。这里按 id 倒序取最近若干条（默认 20，上限 200），
 * **不重算任何东西**。失败批次的逐项错误原样带出 ⇒ 「**可重试**」也有了依据：
 * 拿同一条幂等键 + 修好的载荷重发即可（`failed` 的批次不落业务数据，重试不会写第二遍）。
 *
 * 读面，不鉴权（与 §7 的其它读接口一致）。
 */
defineRouteMeta({
  openAPI: {
    tags: ['名录'],
    summary: '导入批次流水（只读）',
    description:
      '最近的导入批次：幂等键、来源、状态（`preflight` / `committed` / `failed`）、摘要、' +
      '预检计数、逐项结果与错误。失败批次照实带出逐项错误，便于按同一幂等键重试。' +
      '只读，不鉴权。',
    parameters: [
      {
        name: 'limit',
        in: 'query',
        required: false,
        schema: { type: 'integer', default: 20, maximum: 200 },
        description: '取最近多少条（默认 20，上限 200）。',
      },
    ],
    responses: {
      200: {
        description: '批次流水（按 id 倒序）。',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                batches: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      batchId: { type: 'integer' },
                      idempotencyKey: { type: 'string' },
                      status: { type: 'string', enum: ['preflight', 'committed', 'failed'] },
                      sourceKind: { type: 'string' },
                      sourceIdentity: { type: 'string' },
                      summary: {
                        type: 'object',
                        nullable: true,
                        description: '提交摘要；预检批为 `null`（「没提交过」不是「写了 0 行」）。',
                      },
                      error: { type: 'string', nullable: true },
                      committedAt: { type: 'string', nullable: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
      405: { description: '本端点是 GET。' },
    },
  },
})

export default defineEventHandler((event) => {
  const result = handleImportBatchesRequest(
    { method: getMethod(event), query: getQuery(event) },
    { db: useDb() },
  )
  setResponseStatus(event, result.status)
  for (const [name, value] of Object.entries(result.headers)) setHeader(event, name, value)
  return result.body
})
