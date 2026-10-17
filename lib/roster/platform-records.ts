import type { RosterPlatformQueryRow, RosterPlatformRelationRow } from './enterprise-roster'

export type PlatformRecordQuery = RosterPlatformQueryRow
export type PlatformRecord = RosterPlatformRelationRow & { aliasNameRaw?: string | null }

/** 原始字段保留在数据层；界面说明使用业务名称。 */
export function platformNoteForDisplay(note: string | null | undefined): string | null {
  if (!note) return null
  return note
    .replace(/business_list|businessList/g, '称号查询记录')
    .replace(/apply_list|applyList/g, '申报办理记录')
    .replace(/rdjb\s*=\s*1/g, '创新型中小企业')
    .replace(/rdjb\s*=\s*2/g, '专精特新中小企业')
    .replace(/rdjb\s*=\s*3/g, '专精特新“小巨人”')
    .replace(/tyshxydm/g, '统一社会信用代码')
}
