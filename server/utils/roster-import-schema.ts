import { z } from 'zod'

/** Additive schema: preserve the legacy payload while strictly validating the new command. */
export const rosterImportMcpPayloadSchema = z.object({
  platformRecordObservations: z.array(z.strictObject({ relationId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) })).min(1).max(100).refine(rows => new Set(rows.map(row => row.relationId)).size === rows.length, 'relationId must be unique per request').optional(),
}).catchall(z.unknown()).describe('统一写入载荷；platformRecordObservations 每批1..100条原relationId，sourceKind=platform_archive；collectionEvidence.rawData.version=1 显式选择 typed 原行，缺省保持 legacy，冲突整批拒绝；reuseExisting:true 仅引用已有query坐标，省略正文不清空，显式不可变字段仍核对；同query/导出SHA源行异载荷或补序号整批冲突；legacy无collectionEvidence且rawResponse省略/null为原引用哨兵，不等于字符串null。见名录契约 §8.3')
