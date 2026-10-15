import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { preflightRosterImport, validateImportRequest } from '../../utils/roster-import'

/**
 * `preflight_roster_batch` —— 名录导入的**只读预检**（RL-11，契约 §9）。
 *
 * 等价 `POST /api/roster/import/preflight`：**不写业务数据**，只算影响
 * （`add` / `update` / `remove` / `review` / `conflicts`）并落一条 `status='preflight'`
 * 的 `import_batch`。参数与 `save_roster_batch` 相同。
 *
 * 契约 §9 把它归为**读 tool**（只读预检），因此按「只读不鉴权、写入必带 token」的
 * 既有分法**不带 token**；真正改库的是 `save_roster_batch`（带 token）。
 */
export default defineMcpTool({
  name: 'preflight_roster_batch',
  title: '预检名录导入批次',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  description: [
    '只算「这次提交会发生什么」，**不写业务数据**：返回 `{ add, update, remove, review, conflicts }`。',
    '等价 `POST /api/roster/import/preflight`。参数与 `save_roster_batch` 相同；',
    '`conflicts` 列出每一项不合法的原因（不静默丢行）。确认无误后再用 `save_roster_batch` 提交。',
    '载荷形状见 `docs/roster-lifecycle-contract.md` §8.3（归并项 §8.4）。',
  ].join('\n'),
  inputSchema: {
    idempotencyKey: z.string().min(1).describe('幂等键；与随后的 save_roster_batch 用同一个值'),
    sourceKind: z.enum(['announcement', 'platform_export', 'alias_evidence']),
    sourceIdentity: z.string().min(1).describe('来源身份：文件相对路径或逻辑标识（不含凭证）'),
    sourceSha256: z.string().optional(),
    payload: z.record(z.string(), z.unknown()).describe('写入载荷（契约 §8.3 / §8.4）'),
  },
  handler: async (input) => {
    const validated = validateImportRequest({
      idempotencyKey: input.idempotencyKey,
      sourceKind: input.sourceKind,
      sourceIdentity: input.sourceIdentity,
      sourceSha256: input.sourceSha256 ?? null,
      payload: input.payload,
    })
    if (!validated.ok) throw createError({ statusCode: validated.status, message: validated.message })
    return preflightRosterImport(useDb(), validated.value)
  },
})
