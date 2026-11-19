import { z } from 'zod'

const text = (max: number) => z.string().trim().min(1).max(max).refine(value => value.isWellFormed() && !value.includes('\0'))
export const leadListId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const sourceRow = z.strictObject({
  rowNumber: leadListId,
  name: text(300),
  uscc: text(80).optional(),
  district: text(100).optional(),
  note: text(500).optional(),
})
export const versionInput = z.strictObject({
  series: text(120),
  channel: text(64),
  listType: text(64),
  acquiredOn: z.iso.date(),
  fileId: leadListId,
  rows: z.array(sourceRow).min(1).max(2000).refine(rows => new Set(rows.map(row => row.rowNumber)).size === rows.length, '名单原行序号必须唯一'),
})
export type VersionInput = z.infer<typeof versionInput>

export type LeadVersionSummary = {
  id: number
  series: string
  channel: string
  listType: string
  acquiredOn: string
  fileId: number
  fileName: string
  filePath: string
  fileAvailable: boolean
}
export type LeadRow = {
  id: number
  rowNumber: number
  name: string
  uscc: string | null
  district: string | null
  note: string | null
  enterpriseId: number | null
}
export type LeadVersionDetail = LeadVersionSummary & { rows: LeadRow[] }
export type LeadCatalog = {
  versions: LeadVersionSummary[]
  channels: { code: string; name: string }[]
  listTypes: { code: string; name: string }[]
}
