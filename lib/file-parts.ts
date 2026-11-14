/**
 * 文件的**段**(票 17)。纯逻辑:聚合、排序、展示用的派生值。
 *
 * 为什么要有「段」:一份公布文件常含**多年份、多事件** —— 《〔2024〕192号》一份文件里
 * 既有「2024 年第二批认定」(附件1)又有「2021 年第二批到期复核」(附件2);《〔2022〕145号》
 * 在同一个「附件」里并置了 2021 与 2022 两段名单。所以**文件级的单个 year/batch 是错的**,
 * 真实粒度是 `(称号, 事件类型, 年份, 批次, 附件)`。
 *
 * 文件级另有 `stored_file.year` / `batch`,那是**目录给出的「这份文件是哪一批公布的」**
 * (单值、可排序,页面标签写作「公布年份/批次」),与这里的**内容年份/批次**是两回事 —— 别混。
 *
 */
import { EVENT_ORDER, TITLE_ORDER, TITLE_RANK } from './labels'

/** 事件类型。与 `record_event.event_type`、`stored_file_part.event_kind` 同一套取值。 */
export type EventKind = 'award' | 'review' | 'maintain' | 'nurture'

/** 一个段。`year` / `batch` / `attachment` 都可空(导出表无附件;部分维护批次无年份)。 */
export interface FilePart {
  titleCode: string
  eventKind: EventKind
  /** **内容**年份(复核段是**被复核的原始认定年份**,不是公布年份)。 */
  year: number | null
  batch: number | null
  /** 归一后的附件名(`附件` / `附件N`),见 `lib/attachment.ts`。 */
  attachment: string | null
  /** 该段的行数(这一份文件里这一段名单有多少条被台账引用)。 */
  rowCount: number
}

/** 段的持久化来源。 */
export type FilePartOrigin = 'derived' | 'agent' | 'legacy'

/** 从 app 读模型读出的段,包含来源与可查询的来源冲突标记。 */
export interface StoredFilePart extends FilePart {
  origin: FilePartOrigin
  hasConflict: boolean
}

/** 聚合的输入行:一条 `record_evidence` 折算出来的段坐标(不含计数)。 */
export interface PartEvidence {
  titleCode: string
  eventKind: EventKind
  year: number | null
  batch: number | null
  attachment: string | null
}

/** `null` 在分组键里要有个不会与真值撞车的占位(附件名不会含控制字符)。 */
const NIL = '\u0000'

/** 段的**去重键**。`null` 用占位符表示,免得「无年份」与「年份是某值」混为一谈。 */
export function partKey(p: PartEvidence): string {
  return [p.titleCode, p.eventKind, p.year ?? NIL, p.batch ?? NIL, p.attachment ?? NIL].join('|')
}

/**
 * 称号等级(小巨人 1 < 专精特新 2 < 创新型 3);认不出排最后。
 *
 * 直接用 `lib/labels.ts` 的 `TITLE_RANK`(称号 → 等级的唯一来源),不另算一份 ——
 * 两处各算一次,迟早有一处忘了改。
 */
function titleRank(code: string): number {
  return TITLE_RANK[code] ?? TITLE_ORDER.length + 1
}

/** 事件次序(认定 → 复核 → 维护 → 入库培育);认不出排最后。 */
function eventRank(kind: string): number {
  const i = EVENT_ORDER.indexOf(kind)
  return i < 0 ? EVENT_ORDER.length : i
}

/** `null` 一律排在**最后**(不是最前)—— 「未知」不该插在有值的中间。 */
function nullsLast(a: number | null, b: number | null): number {
  if (a === b) return 0
  if (a === null) return 1
  if (b === null) return -1
  return a - b
}

/**
 * 段的**展示顺序**:称号等级 → 事件次序 → 年份 → 批次 → 附件。
 *
 * 这样 192号 读作「先认定(附件1)、后复核(附件2)」,145号 读作「2021 段、2022 段」——
 * 与文件的正文顺序一致,人一眼能对上。
 */
export function compareParts(a: FilePart, b: FilePart): number {
  return (
    titleRank(a.titleCode) - titleRank(b.titleCode) ||
    eventRank(a.eventKind) - eventRank(b.eventKind) ||
    nullsLast(a.year, b.year) ||
    nullsLast(a.batch, b.batch) ||
    (a.attachment ?? '').localeCompare(b.attachment ?? '', 'zh-CN')
  )
}

/**
 * 把展开的段坐标**聚合**成段:同坐标的行数相加。
 *
 * 输入是 `record_evidence` 按段坐标摊平的每一行(一条记录一行),输出按 `compareParts` 排好序。
 * 是纯函数,不碰库 —— 聚合口径能单测。
 */
export function aggregateParts(rows: readonly PartEvidence[]): FilePart[] {
  const byKey = new Map<string, FilePart>()
  for (const row of rows) {
    const key = partKey(row)
    const hit = byKey.get(key)
    if (hit) {
      hit.rowCount += 1
      continue
    }
    byKey.set(key, {
      titleCode: row.titleCode,
      eventKind: row.eventKind,
      year: row.year,
      batch: row.batch,
      attachment: row.attachment,
      rowCount: 1,
    })
  }
  return [...byKey.values()].sort(compareParts)
}

/** 段里出现过的年份(去重、升序;无年份的段不计入)。用于列表的「年份」列。 */
export function partYears(parts: readonly FilePart[]): number[] {
  const set = new Set<number>()
  for (const p of parts) if (p.year !== null) set.add(p.year)
  return [...set].sort((a, b) => a - b)
}

/** 段里出现过的批次(去重、升序;无批次的段不计入)。用于列表的「批次」列。 */
export function partBatches(parts: readonly FilePart[]): number[] {
  const set = new Set<number>()
  for (const p of parts) if (p.batch !== null) set.add(p.batch)
  return [...set].sort((a, b) => a - b)
}

/**
 * 把一组数字拼成展示串(`2021、2022`);空数组返回 `null`,让页面走「—」而不是空串。
 * 用「、」而不是「,」 —— 中文顿号,列表语义。
 */
export function joinSeries(values: readonly number[]): string | null {
  return values.length ? values.map((v) => String(v)).join('、') : null
}

/**
 * **列表列**用的展示串:同上,但超过 `max` 个时只列前 `max` 个并缀 `+剩 N`。
 *
 * 为什么要有上限:工信部导出表的段跨 2021–2026 六七年、批次十来个,
 * 全列出来会把窄列撑破、压掉旁边几列(实测过)。**完整清单在展开的段明细里**,
 * 列表这一列只回答「大概几个、都有哪几年」。上限取 2 是为了让 `+N` 也留在列内
 * (取 3 时后缀会被列宽裁掉,反而看不清还有几个)。
 */
export function seriesLabel(values: readonly number[], max = 2): string | null {
  if (!values.length) return null
  if (values.length <= max) return joinSeries(values)
  return `${joinSeries(values.slice(0, max))} +${values.length - max}`
}
