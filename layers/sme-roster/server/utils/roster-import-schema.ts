import { z } from 'zod'
import { officialAppendSchema } from './official-evidence-claim-model'
import { evidenceCorrectionRequestSchema } from './roster-evidence-correction-model'
import { announcementMcpSchema } from './roster-import-announcement-schema'
import { aliasesMcpSchema } from './roster-import-alias-schema'
import { exportSnapshotMcpSchema } from './roster-import-export-schema'

import { platformQueriesMcpSchema } from './roster-import-platform-schema'
import { differencesMcpSchema } from './roster-import-difference-schema'
import { usccBackfillsMcpSchema } from './roster-import-uscc-schema'
import { mergesMcpSchema } from './roster-import-merge-schema'

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
  differences: differencesMcpSchema,
  usccBackfills: usccBackfillsMcpSchema,
  merges: mergesMcpSchema,
  exportSnapshot: exportSnapshotMcpSchema,
  officialEvidenceAppends: z.array(officialAppendSchema).min(1).max(100).optional().describe('精确正式佐证追加；expectedVersion=当前event.revision，显式声明与publishedRow；无公布原行时先调用导入预检并在payload带回officialEvidencePlanHash；含公布原行时使用补充预检'),
  officialEvidenceCorrections: importCorrectionSchema.meta(importCorrectionDiscovery).describe('复用精确更正DTO；导入采用外层幂等键，每项明确publishedRow和expectedRowRevision，与追加/capture共用最终计划'),
  officialEvidencePlanHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).catchall(z.unknown()).describe('统一写入载荷。新采集提交平台来源字段，已存采集通过 reuseExisting:true 引用采集坐标和行号。见名录契约 §8.3')
