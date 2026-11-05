import { z } from 'zod'
import { TITLE_ORDER } from '../../lib/labels'
import type { RosterImportExportRow, RosterImportExportSnapshot } from '../../lib/roster-import-client'

const exportSnapshotDiscoverySchema = z.looseObject({
  titleCode: z.enum(TITLE_ORDER as [string, ...string[]]),
  year: z.number().describe('来源年度；沿用核心 optionalInt 非零判据，写入保留给定数值'),
  collectedOn: z.string(),
  originalFilename: z.string(),
  sha256: z.string().describe('来源快照身份；原核心只要求非空，不新增 hash 格式拒绝'),
  rows: z.array(z.looseObject({
    sourceRowNo: z.number().describe('原行序；沿用 optionalInt，同批不得重复'),
    usccRaw: z.string().nullable().optional(),
    nameRaw: z.string().nullable().optional(),
    district: z.string().nullable().optional(),
    province: z.string().nullable().optional(),
    city: z.string().nullable().optional(),
    regStatus: z.string().nullable().optional(),
    rawFields: z.record(z.string(), z.unknown()).nullable().optional(),
  } satisfies Record<keyof RosterImportExportRow, z.ZodType>)).optional(),
} satisfies Record<keyof RosterImportExportSnapshot, z.ZodType>).describe('平台导出快照现状对照；省略 rows 可提交空快照，不重解释为正式公布历史；同 SHA 重放、源行冲突由原核心判定。')

const { $schema: _, ...exportSnapshotDiscovery } = z.toJSONSchema(exportSnapshotDiscoverySchema, { io: 'input' })
export const exportSnapshotMcpSchema = z.unknown().optional().meta(exportSnapshotDiscovery)
