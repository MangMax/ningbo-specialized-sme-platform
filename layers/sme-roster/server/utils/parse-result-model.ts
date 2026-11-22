import { normalizeAttachment } from '../../lib/attachment'
import { compareParts, partKey, type StoredFilePart } from '../../lib/file-parts'
import type { EventKind, FilePart } from '../../../../db/file-part'
import { EVENT_ORDER, TITLE_ORDER } from '../../lib/labels'

/** 一个段的写入输入。`year` / `batch` / `attachment` 可空(导出表无附件)。 */
export interface ParsePartInput {
  titleCode: string
  eventKind: string
  year?: number | null
  batch?: number | null
  attachment?: string | null
  /** 该段行数。省略为 0(代理只判段、不数行是合法情形)。 */
  rowCount?: number
}

/** 校验一个段;失败给中文原因。`null` 表示通过。 */
function validatePart(raw: ParsePartInput, index: number): string | null {
  const at = `parts[${index}]`
  if (!raw || typeof raw !== 'object') return `${at} 必须是对象`
  if (!TITLE_ORDER.includes(raw.titleCode)) {
    return `${at}.titleCode 不在称号白名单(${TITLE_ORDER.join(' / ')}):${raw.titleCode}`
  }
  if (!EVENT_ORDER.includes(raw.eventKind)) {
    return `${at}.eventKind 不在事件白名单(${EVENT_ORDER.join(' / ')}):${raw.eventKind}`
  }
  const year = raw.year
  if (year !== undefined && year !== null) {
    if (!Number.isInteger(year) || year < 1900 || year > 2100) {
      return `${at}.year 必须是 1900–2100 的整数或 null:${year}`
    }
  }
  const batch = raw.batch
  if (batch !== undefined && batch !== null) {
    if (!Number.isInteger(batch) || batch <= 0) {
      return `${at}.batch 必须是正整数或 null:${batch}`
    }
  }
  const rowCount = raw.rowCount
  if (rowCount !== undefined && (!Number.isInteger(rowCount) || rowCount < 0)) {
    return `${at}.rowCount 必须是非负整数:${rowCount}`
  }
  return null
}

/**
 * 把输入规整成待写入的段:校验 → 附件名归一 → 去重 → 排序。
 *
 * **同一坐标给两遍是错误**(不是自动合并):`stored_file_part` 坐标有唯一索引,
 * 默默求和会让「代理写重了一段」变成一份看不出问题的行数,不如直接报错。
 * 归一见 `layers/sme-roster/lib/attachment.ts`(「附 件 1」与「附件1」必须并成同一段)。
 */
export function normalizeParseParts(
  raw: readonly ParsePartInput[],
): { ok: true; parts: FilePart[] } | { ok: false; message: string } {
  const parts: FilePart[] = []
  const seen = new Set<string>()
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i]!
    const bad = validatePart(item, i)
    if (bad) return { ok: false, message: bad }
    const part: FilePart = {
      titleCode: item.titleCode,
      eventKind: item.eventKind as EventKind,
      year: item.year ?? null,
      batch: item.batch ?? null,
      attachment: normalizeAttachment(item.attachment),
      rowCount: item.rowCount ?? 0,
    }
    const key = partKey(part)
    if (seen.has(key)) {
      return {
        ok: false,
        message: `parts[${i}] 与前面的段重复(同称号/事件/年份/批次/附件):${key.replaceAll('\u0000', '∅')}`,
      }
    }
    seen.add(key)
    parts.push(part)
  }
  return { ok: true, parts: parts.sort(compareParts) }
}

export function mergeParseParts(parts: readonly FilePart[], derived: readonly FilePart[]): StoredFilePart[] {
  const agents = new Map(parts.map(part => [partKey(part), part]))
  const merged = derived.map((part): StoredFilePart => {
    const key = partKey(part)
    const agent = agents.get(key)
    if (!agent) return { ...part, origin: 'derived', hasConflict: false }
    agents.delete(key)
    return { ...agent, origin: 'agent', hasConflict: agent.rowCount !== part.rowCount }
  })
  return [...merged, ...Array.from(agents.values(), part => ({ ...part, origin: 'agent' as const, hasConflict: false }))]
}
