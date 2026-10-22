import { submitRosterImportMcp } from '../../utils/roster-import-mcp-submission'
import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { writeGuard } from '../../utils/mcp-guard'

/**
 * `save_roster_batch` —— **通路 e**：代理经 MCP 把清理后的名单写入统一 API（RL-11，契约 §9）。
 *
 * 等价 `POST /api/roster/import/commit`：**单批事务 + 幂等键**。业务实体、称号事件、
 * 出处、曾用名、平台查询与关系、导出快照、差异原因与措施、以及**归并**都由这一个批次写入，
 * 不再各写一个导入器直连 SQLite。
 *
 * ── 与其它写入 tool 的边界 ────────────────────────────────────────────────
 * 文件元数据/解析段/OCR 仍是 `set_file_category` / `save_parse_result` / `save_ocr_result`
 * 的活（本 tool 不碰文件库）。本 tool 只管**名录实体**与平台证据。
 *
 * 幂等：同一 `idempotencyKey` 重复调用返回既有批次摘要，不重复写企业/事件。
 * `payload` 的形状见 `docs/roster-lifecycle-contract.md` §8.3（归并项 §8.4）。
 *
 * **是写入 tool**，需要鉴权（`Authorization: Bearer <NUXT_MCP_TOKEN>`），未鉴权时
 * 不出现在 `tools/list`，强行调用得到 HTTP 401。
 */
export default defineMcpTool({
  name: 'save_roster_batch',
  title: '提交名录导入批次',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  enabled: writeGuard,
  description: [
    '差异原因 pending_review（待审核）须由代理/用户明确裁决：status=confirmed_reason、verificationStatus=confirmed、measureCode=follow_review；保留正式历史并跟进审核，区别于 needs_review 待核实。',
    'queryBusList 仅作为 recognized_list 显式转存；collectionEvidence 必须保留原结果/时点/页行与完整性，见 docs/platform-recognized-evidence.md。读回使用 list_platform_queries。',
    '把一批名单数据（企业 / 别名 / 称号事件 / 出处 / 平台查询与关系 / 导出快照 / 差异原因与措施 / 归并）',
    '经**统一写入路径**落库。等价 `POST /api/roster/import/commit`。',
    '**幂等**：同一 `idempotencyKey`（同一来源）重复调用不会重复写企业或事件，返回既有批次摘要。',
    '**单批事务**：要么整批 `committed`，要么 `failed`（`error` 说明原因）—— 绝不部分提交；',
    '逐项错误形如 `{ ok:false, kind, ref, error:{ code, field?, message } }`，不静默丢行。',
    '`payload` 形状见 `docs/roster-lifecycle-contract.md` §8.3；归并项 `merges` 见 §8.4，血缘可从返回项的 `detail.lineage` 取回。',
    '证据指针可用**自然键**指向**本批新建**的查询/关系（`aliases[].sourceRelationRef`、',
    '`differences[].evidenceQueryRef`/`evidenceRelationRef`、`merges[].sourceRelationRef`/`evidenceQueryRef`，见契约 §8.7）——',
    '一个批次即可写完「查询 → 关系 → 别名/差异证据」；裸 id 仍可用于已存在的行。',
    '**需要鉴权**（Authorization: Bearer <NUXT_MCP_TOKEN>）。',
  ].join('\n'),
  inputSchema: {
    idempotencyKey: z.string().min(1).describe('幂等键；同一来源重复调用必须给同一个值（库层面唯一）'),
    sourceKind: z
      .enum(['announcement', 'platform_export', 'alias_evidence'])
      .describe('来源类别：公布文件 / 平台导出 / 别名证据'),
    sourceIdentity: z.string().min(1).describe('来源身份：文件相对路径或逻辑标识（不含凭证）'),
    sourceSha256: z.string().optional().describe('源文件内容 SHA-256；给不出留空'),
    payload: z.record(z.string(), z.unknown()).describe('写入载荷（契约 §8.3 / §8.4）'),
  },
  handler: (input) => submitRosterImportMcp('commit', input),
})
