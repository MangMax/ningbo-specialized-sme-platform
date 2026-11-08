import { submitRosterImportMcp } from '../../utils/roster-import-mcp-submission'
import { z } from 'zod'
import { rosterImportMcpPayloadSchema } from '../../utils/roster-import-schema'
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
    '平台完整原行提交在同一事务收尾核对来源投影；summary.platformFields 按版本去重报告 eligibleVersions/projectionsCreated/projectionsReused/projectionsChecked、observationsChecked/quarantinedObservations 及 ready/partial/not_performed。旧幂等键返回原回执，历史缺字段表示未记录；reuseExisting 纯引用不执行同步。',
    'platformQueries[].reuseExisting:true 仅引用已存在采集坐标；缺来源结构化失败，显式不可变字段仍核对，省略正文不清空。旧无collectionEvidence且rawResponse省略/null只作原引用哨兵，正文字符串null/typed JSON null仍按原类型处理。同query/导出SHA源行异载荷或补序号整批冲突。',
    '三来源 typed 归档：collectionEvidence.rawData.version=1 显式选择 rawData.rows 为 relations.rawFields 和业务内容版本输入；原页/旧投影/行位/数量/来源/身份必须一致，冲突整批拒绝。无 rawData 的旧格式保持原字符串，不反推类型或重算旧hash。',
    'platformLegacyProvenance[]：独立legacy分页补证，绑定queryId+自然键+sourceSha256+segmentIndex；完整原行/分页重核，typedState仍unknown，不改collectionEvidence、内容版本和人工决定。',
    'platformRecordObservations:[{relationId}]：sourceKind=platform_archive，每批1..100条，服务端读取原文建立业务身份/内容版本/观察映射；源缺失、漂移、同采集异原文整批失败。预检记录账本但不写业务，commit重核。',
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
      .enum(['announcement', 'platform_export', 'platform_archive', 'alias_evidence'])
      .describe('来源类别：公布文件 / 平台导出 / 别名证据'),
    sourceIdentity: z.string().min(1).describe('来源身份：文件相对路径或逻辑标识（不含凭证）'),
    sourceSha256: z.string().optional().describe('源文件内容 SHA-256；给不出留空'),
    payload: rosterImportMcpPayloadSchema,
  },
  handler: (input) => submitRosterImportMcp('commit', input),
})
