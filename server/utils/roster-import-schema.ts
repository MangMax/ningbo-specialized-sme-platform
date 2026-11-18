import { z } from 'zod'
import { officialAppendSchema } from '../../layers/sme-roster/server/utils/official-evidence-plan'
import { evidenceCorrectionRequestSchema } from '../../layers/sme-roster/server/utils/roster-evidence-correction'
import { announcementMcpSchema } from './roster-import-announcement-schema'
import { aliasesMcpSchema } from './roster-import-alias-schema'
import { exportSnapshotMcpSchema } from './roster-import-export-schema'

import { platformQueriesMcpSchema } from './roster-import-platform-schema'
import { differencesMcpSchema } from './roster-import-difference-schema'
import { usccBackfillsMcpSchema } from './roster-import-uscc-schema'
import { mergesMcpSchema } from './roster-import-merge-schema'
import { legacyPlatformProvenanceItemsSchema } from '../../layers/sme-roster/lib/platform/legacy-provenance'

const importCorrectionSchema = evidenceCorrectionRequestSchema.omit({ idempotencyKey: true }).optional()
const { $schema: _correctionDialect, ...importCorrectionDiscovery } = z.toJSONSchema(importCorrectionSchema, { io: 'input' })
const correctionOperations = importCorrectionDiscovery.properties!.operations
if (!correctionOperations || typeof correctionOperations !== 'object' || !('items' in correctionOperations)) throw new Error('Missing correction operations discovery')
const correctionOperationDiscovery = correctionOperations.items as { required: string[] }
// The import planner requires explicit row facts; standalone correction parsing retains its legacy form.
correctionOperationDiscovery.required = [...correctionOperationDiscovery.required, 'publishedRow', 'expectedRowRevision']

/** Additive schema: preserve the legacy payload while strictly validating the new command. */
export const rosterImportMcpPayloadSchema = z.object({
  announcement: announcementMcpSchema,
  aliases: aliasesMcpSchema,
  platformQueries: platformQueriesMcpSchema,
  platformLegacyProvenance: legacyPlatformProvenanceItemsSchema.optional().describe('独立 legacy 采集分页补证，typedState=unknown；queryId/自然键/文件SHA/segmentIndex锁定，完整原行核对，绝不改collectionEvidence或内容版本'),
  differences: differencesMcpSchema,
  usccBackfills: usccBackfillsMcpSchema,
  merges: mergesMcpSchema,
  exportSnapshot: exportSnapshotMcpSchema,
  officialEvidenceAppends: z.array(officialAppendSchema).min(1).max(100).optional().describe('精确正式佐证追加；expectedVersion=当前event.revision，显式声明与publishedRow；须先preflight并在payload带回officialEvidencePlanHash'),
  officialEvidenceCorrections: importCorrectionSchema.meta(importCorrectionDiscovery).describe('复用精确更正DTO；导入采用外层幂等键，每项明确publishedRow和expectedRowRevision，与追加/capture共用最终计划'),
  officialEvidencePlanHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  platformRecordObservations: z.array(z.strictObject({ relationId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) })).min(1).max(100).refine(rows => new Set(rows.map(row => row.relationId)).size === rows.length, 'relationId must be unique per request').optional(),
}).catchall(z.unknown()).describe('统一写入载荷；platformRecordObservations 每批1..100条原relationId，sourceKind=platform_archive；collectionEvidence.rawData.version=1 显式选择 typed 原行，缺省保持 legacy，冲突整批拒绝；reuseExisting:true 仅引用已有query坐标，省略正文不清空，显式不可变字段仍核对；同query/导出SHA源行异载荷或补序号整批冲突；legacy无collectionEvidence且rawResponse省略/null为原引用哨兵，不等于字符串null。见名录契约 §8.3')

const { announcement, officialEvidenceAppends, officialEvidenceCorrections, officialEvidencePlanHash } = z.toJSONSchema(rosterImportMcpPayloadSchema, { io: 'input' }).properties!
export const rosterImportOfficialDiscovery = { announcement, officialEvidenceAppends, officialEvidenceCorrections, officialEvidencePlanHash }
const legacyDiscovery = z.toJSONSchema(rosterImportMcpPayloadSchema, { io: 'input' }).properties!
export const rosterImportLegacyDiscovery = { aliases: legacyDiscovery.aliases, exportSnapshot: legacyDiscovery.exportSnapshot, platformQueries: legacyDiscovery.platformQueries, differences: legacyDiscovery.differences, usccBackfills: legacyDiscovery.usccBackfills, merges: legacyDiscovery.merges }
