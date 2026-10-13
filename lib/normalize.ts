/**
 * 归一化内核(纯函数,无 IO)。
 * 全项目唯一的测试接缝 —— 见 docs/data-model.md 与 SPEC.md。
 * 这些函数不读文件、不碰数据库,便于单测与在导入管道中复用。
 */

/** 零宽字符与全角空格,来源数据里常混入。 */
const INVISIBLE = /[​‌‍﻿　]/g

/** 视为「无统代」的占位值。 */
const USCC_PLACEHOLDERS = new Set(['', '#N/A', 'N/A', 'NA', '0', '-', '无', 'NULL'])

export type EventKind = 'award' | 'review' | 'maintain' | 'nurture'

export interface Batch {
  year: number | null
  seq: number | null
}

/** 统一社会信用代码归一化:去空白与零宽、全角→半角、大写。占位或形状不对则返回 null。 */
export function normalizeUscc(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  let s = String(raw).replace(INVISIBLE, '').replace(/\s+/g, '').trim().toUpperCase()
  s = s.replace(/[（）()]/g, '')
  if (USCC_PLACEHOLDERS.has(s)) return null
  if (!/^[0-9A-Z]{15,18}$/.test(s)) return null
  return s
}

/** 企业名称归一化:去所有空白与零宽、去全/半角括号、去尾随符号。用于无统代时的归并键。 */
export function normalizeName(raw: unknown): string {
  if (raw === null || raw === undefined) return ''
  return String(raw)
    .replace(INVISIBLE, '')
    .replace(/[\s ]+/g, '')
    .replace(/[（）()]/g, '')
    .replace(/[√✓、,，.。;；]+$/g, '')
    .trim()
}

const CN_DIGITS: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
}

/**
 * 解析批次文本。支持 `2024-1`、`2025-2`、`2022`、`2024年度第一批`、`第一批`。
 * 年份缺失时 year 为 null;批次缺失时 seq 为 null。
 */
export function parseBatch(text: unknown): Batch {
  const s = String(text ?? '')

  // 年份区间如 `2021-2022` 不是「年-批次」,取首年、无批次。
  const range = s.match(/(19|20)\d{2}\s*[-–—~至]\s*(19|20)\d{2}/)
  if (range) return { year: Number(range[0].match(/(19|20)\d{2}/)![0]), seq: null }

  const yearMatch = s.match(/(19|20)\d{2}/)
  const year = yearMatch ? Number(yearMatch[0]) : null

  let seq: number | null = null
  const arabic = s.match(/第\s*(\d+)\s*批/)
  if (arabic) {
    seq = Number(arabic[1])
  } else {
    const dash = s.match(/-(\d+)\b/)
    if (dash) seq = Number(dash[1])
    else {
      const cn = s.match(/第\s*([一二三四五六七八九十])\s*批/)
      if (cn?.[1]) seq = CN_DIGITS[cn[1]] ?? null
    }
  }
  return { year, seq }
}

/** 从段落或文件名文本判定事件类型。含“入库培育”优先于“复核”。 */
export function classifyEvent(text: unknown): EventKind {
  const s = String(text ?? '')
  if (s.includes('入库培育')) return 'nurture'
  if (s.includes('复核')) return 'review'
  return 'award'
}

const KIND_PREFIXES: [string, EventKind][] = [
  ['入库培育', 'nurture'],
  ['复核', 'review'],
  ['认定', 'award'],
]

/**
 * 解析公布文件“来源”单元格中的一行,形如:
 *   `认定：省专\2022\00公布文件 / 第一部分（2021年6月起有效） / 序号152`
 * 返回其事件类型与出处;无法识别前缀时返回 null。
 */
export function parseEventLine(line: unknown): {
  kind: EventKind
  sourceFile: string
  attachment: string | null
  listNo: number | null
} | null {
  if (line === null || line === undefined) return null
  const s = String(line).replace(INVISIBLE, '').trim()
  if (!s) return null

  const prefix = KIND_PREFIXES.find(([p]) => s.startsWith(p))
  if (!prefix) return null
  const kind = prefix[1]

  const body = s.split(/[：:]/).slice(1).join('：').trim()
  const parts = body.split('/').map((p) => p.trim()).filter(Boolean)
  const sourceFile = parts[0] ?? ''
  let attachment: string | null = null
  let listNo: number | null = null
  for (const p of parts.slice(1)) {
    const m = p.match(/^序号\s*(\d+)$/)
    if (m) listNo = Number(m[1])
    else attachment = p
  }
  return { kind, sourceFile, attachment, listNo }
}

/** 把可能含逗号分隔的多值年份文本拆成多个批次。 */
export function parseBatchList(text: unknown): Batch[] {
  const s = String(text ?? '').trim()
  if (!s) return []
  return s
    .split(/[,，]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => parseBatch(p))
}
