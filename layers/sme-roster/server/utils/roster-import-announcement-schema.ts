import { z } from 'zod'
import { record, recordEvent } from '../../../../db/postgresql/ledger-tables'
import { sourceDocument } from '../../../../db/postgresql/official-evidence-tables'
import { TITLE_ORDER } from '../../lib/labels'
import { officialPublishedRowSchema } from './official-evidence-claim-model'

// Discovery describes commands; legacy normalization and item errors remain in roster-import.
export const announcementDiscoverySchema = z.looseObject({
  sourceDocument: z.looseObject({
    source: z.enum(sourceDocument.source.enumValues),
    title: z.string(),
    docNumber: z.string().nullable().optional(),
    issueDate: z.string().nullable().optional(),
  }),
  records: z.array(z.looseObject({
    enterprise: z.looseObject({
      name: z.string(),
      uscc: z.string().nullable().optional(),
      district: z.string().nullable().optional(),
    }),
    titleCode: z.enum(TITLE_ORDER as [string, ...string[]]),
    source: z.enum(record.source.enumValues).optional(),
    events: z.array(z.looseObject({
      eventType: z.enum(recordEvent.eventType.enumValues),
      year: z.number().nullable().optional().describe('所涉年份；旧载荷按领域 optionalInt 处理'),
      batchSeq: z.number().nullable().optional(),
      decidedYear: z.number().nullable().optional(),
      reviewOutcome: z.enum(recordEvent.reviewOutcome.enumValues).nullable().optional(),
      evidence: z.array(z.looseObject({
        sourceFile: z.string(),
        attachment: z.string().nullable().optional(),
        listNo: z.number().nullable().optional(),
        page: z.number().int().positive().nullable().optional().describe('仅 PDF 实际页码；非 PDF 须省略或 null'),
        publishedRow: officialPublishedRowSchema.optional(),
      })).optional(),
    })).optional(),
  })),
}).describe('公布文件历史命令；未知附加字段保留，遗漏/null/归一化及逐项错误由现有领域校验处理；publishedRow 使用正式事实严格 DTO，原行留存后须对已核企业身份和事实调用补充预检，并在补充请求带回 officialEvidencePlanHash')

const { $schema: _, ...announcementJsonSchema } = z.toJSONSchema(announcementDiscoverySchema, { io: 'input' })
// Metadata enriches tools/list without turning legacy payloads into Zod validation failures.
export const announcementMcpSchema = z.unknown().optional().meta(announcementJsonSchema)
