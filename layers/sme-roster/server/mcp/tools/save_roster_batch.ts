import { submitRosterImportMcp } from '../../utils/roster-import-mcp-submission'
import { z } from 'zod'
import { rosterImportMcpPayloadSchema } from '../../utils/roster-import-schema'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { writeGuard } from '../../../../core/server/utils/mcp-guard'

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
    '公布原行返回 staged、intakeId 和 sourceDigest。人工核对后调用 HTTP POST /api/roster/import/intake/{id}/supplement。含类型化公布证据时，先调用该补充接口并提供 preflight: true，再提交返回的 officialEvidencePlanHash。',
    '平台完整原行提交在同一事务收尾核对来源投影；summary.platformFields 按版本去重报告 eligibleVersions/projectionsCreated/projectionsReused/projectionsChecked、observationsChecked/quarantinedObservations 及 ready/partial/not_performed。旧幂等键返回原回执，历史缺字段表示未记录；reuseExisting 纯引用不执行同步。',
    'platformQueries[].reuseExisting:true 可引用已存采集坐标与已存行号，支持核对 relationKey。新采集提交来源字段，精确历史回放由离线归档处理。',
    '三来源 typed 归档：collectionEvidence.rawData.version=1 显式选择 rawData.rows 为 relations.rawFields 和业务内容版本输入；原页/旧投影/行位/数量/来源/身份必须一致，冲突整批拒绝。无 rawData 的旧格式保持原字符串，不反推类型或重算旧hash。',
    '差异原因 pending_review（待审核）须由代理/用户明确裁决：status=confirmed_reason、verificationStatus=confirmed、measureCode=follow_review；保留正式历史并跟进审核，区别于 needs_review 待核实。',
    'queryBusList 仅作为 recognized_list 显式转存；collectionEvidence 必须保留原结果/时点/页行与完整性，见 lib/platform/recognized-evidence.ts。读回使用 list_platform_queries。',
    '把一批名单数据（企业 / 别名 / 称号事件 / 出处 / 平台查询与关系 / 导出快照 / 差异原因与措施 / 归并）',
    '经**统一写入路径**落库。等价 `POST /api/roster/import/commit`。',
    '**幂等**：同一 `idempotencyKey`（同一来源）重复调用不会重复写企业或事件，返回既有批次摘要。',
    '**单批事务**：要么整批 `committed`，要么 `failed`（`error` 说明原因）—— 绝不部分提交；',
    '逐项错误形如 `{ ok:false, kind, ref, error:{ code, field?, message } }`，不静默丢行。',
    '`payload` 包含归并项 `merges`，血缘可从返回项的 `detail.lineage` 取回。',
    '证据指针可用**自然键**指向**本批新建**的查询/关系（`aliases[].sourceRelationRef`、',
    '`differences[].evidenceQueryRef`/`evidenceRelationRef`、`merges[].sourceRelationRef`/`evidenceQueryRef`，见契约 §8.7）——',
    '一个批次即可写完「查询 → 关系 → 别名/差异证据」；裸 id 仍可用于已存在的行。',
    '**需要鉴权**（Authorization: Bearer <NUXT_MCP_TOKEN>）。',
  ].join('\n'),
  inputSchema: {
    idempotencyKey: z.string().min(1).describe('幂等键；同一来源重复调用必须给同一个值（库层面唯一）'),
    sourceKind: z
      .enum(['announcement', 'platform_export', 'platform_archive', 'alias_evidence'])
      .describe('来源类别：公布名单 / 平台导出 / 别名证据'),
    sourceIdentity: z.string().min(1).describe('来源身份：文件相对路径或逻辑标识（不含凭证）'),
    sourceSha256: z.string().optional().describe('源文件内容 SHA-256；给不出留空'),
    payload: rosterImportMcpPayloadSchema,
  },
  handler: (input) => submitRosterImportMcp('commit', input),
})
