import { submitRosterImportMcp } from '../../utils/roster-import-mcp-submission'
import { z } from 'zod'
import { rosterImportMcpPayloadSchema } from '../../utils/roster-import-schema'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'

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
    'platformQueries[].reuseExisting:true 可引用已存采集坐标与已存行号，支持核对 relationKey。新采集提交来源字段，精确历史回放由离线归档处理。',
    '三来源 typed 归档：collectionEvidence.rawData.version=1 显式选择 rawData.rows 为 relations.rawFields 和业务内容版本输入；原页/旧投影/行位/数量/来源/身份必须一致，冲突整批拒绝。无 rawData 的旧格式保持原字符串，不反推类型或重算旧hash。',
    '差异原因 pending_review（待审核）须由代理/用户明确裁决：status=confirmed_reason、verificationStatus=confirmed、measureCode=follow_review；保留正式历史并跟进审核，区别于 needs_review 待核实。',
    'queryBusList 仅作为 recognized_list 显式转存；collectionEvidence 必须保留原结果/时点/页行与完整性，见 lib/platform/recognized-evidence.ts。读回使用 list_platform_queries。',
    '只算「这次提交会发生什么」，**不写业务数据**：返回 `{ add, update, remove, review, conflicts }`。',
    '等价 `POST /api/roster/import/preflight`。参数与 `save_roster_batch` 相同；',
    '`conflicts` 列出每一项不合法的原因（不静默丢行）。确认无误后再用 `save_roster_batch` 提交。',
    '载荷形状见 `lib/roster-import-client.ts`。',
  ].join('\n'),
  inputSchema: {
    idempotencyKey: z.string().min(1).describe('幂等键；与随后的 save_roster_batch 用同一个值'),
    sourceKind: z.enum(['announcement', 'platform_export', 'platform_archive', 'alias_evidence']),
    sourceIdentity: z.string().min(1).describe('来源身份：文件相对路径或逻辑标识（不含凭证）'),
    sourceSha256: z.string().optional(),
    payload: rosterImportMcpPayloadSchema,
  },
  handler: (input) => submitRosterImportMcp('preflight', input),
})
