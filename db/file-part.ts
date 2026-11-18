/** 与 record_event.event_type、stored_file_part.event_kind 一致。 */
export type EventKind = 'award' | 'review' | 'maintain' | 'nurture'

/** 文件内容的一段名单。year、batch 和 attachment 均可未知。 */
export interface FilePart {
  titleCode: string
  eventKind: EventKind
  /** 复核段记录被复核的原始认定年份。 */
  year: number | null
  batch: number | null
  /** 归一后的附件名（附件或附件N）。 */
  attachment: string | null
  rowCount: number
}
