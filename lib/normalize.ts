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

// ---------------------------------------------------------------------------
// 区县
// ---------------------------------------------------------------------------

/** 宁波市辖 12 个区县(市)。 */
export const NINGBO_DISTRICTS = [
  '海曙区',
  '江北区',
  '北仑区',
  '镇海区',
  '鄞州区',
  '奉化区',
  '余姚市',
  '慈溪市',
  '宁海县',
  '象山县',
  '高新区',
  '前湾新区',
] as const

/** 功能区/园区——公布文件里作为“属地”使用,并非行政区划,原样保留。 */
export const NINGBO_FUNCTIONAL_ZONES = ['杭州湾', '保税区', '大榭'] as const

/**
 * 区县归一化:统一已知的错别字与省略写法到规范名。
 * 来源数据里出现过 `酆州区`(应为鄞州区)与 `象山`(应为象山县)。
 * 无法识别时返回去除空白后的原值,由 quality flag 兜底,不臆造。
 */
const DISTRICT_ALIASES: Record<string, string> = {
  酆州区: '鄞州区',
  鄞州: '鄞州区',
  象山: '象山县',
  慈溪: '慈溪市',
  余姚: '余姚市',
  宁海: '宁海县',
  奉化: '奉化区',
  镇海: '镇海区',
  北仑: '北仑区',
  海曙: '海曙区',
  江北: '江北区',
}

export function normalizeDistrict(raw: unknown): string {
  const s = String(raw ?? '')
    .replace(INVISIBLE, '')
    .replace(/\s+/g, '')
    .trim()
  if (!s) return ''
  return DISTRICT_ALIASES[s] ?? s
}

/** 该区县是否在宁波(含功能区)范围内——用于识别漂移到外市的记录。 */
export function isNingboDistrict(district: string): boolean {
  return (
    (NINGBO_DISTRICTS as readonly string[]).includes(district) ||
    (NINGBO_FUNCTIONAL_ZONES as readonly string[]).includes(district)
  )
}
