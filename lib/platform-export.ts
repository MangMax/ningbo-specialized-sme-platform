/**
 * 工信部**三张导出表** → 年度对照快照的解析层(RL-05)。
 *
 * 边界(契约 §0):平台导出 = **采集时点现状**;它**绝不改写** `record` / `record_event`
 * 等公布历史,`platform_export_*` 与 `record*` 也**不互相 join 出历史事实**。
 * 本模块只做「文件 → 规范化快照行 → 契约 §8.3 的 `exportSnapshot` payload」,
 * **不碰数据库**(写入走统一写 API,见契约 §8)。
 *
 * ── 为什么按**列号**而不是列名 ────────────────────────────────────────────
 * 实测(2026-10-16)三张表列号各不相同:
 *
 * | 语义             | 专精特新中小企业 | 专精特新小巨人 | 创新型 |
 * |------------------|------------------|----------------|--------|
 * | 统一社会信用代码 | 18               | 18             | 15     |
 * | 审核状态         | 300              | 271            | 95     |
 * | 维护批次         | 303              | 274            | 98     |
 *
 * 且表头两行(r1 分组 + r2 叶子)、**数据从 r3 起**;r2 的叶子列名里存在重名,
 * 按名取列会撞车。所以这里把列位固化在 `PLATFORM_EXPORT_LAYOUTS` 里,按列号读。
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import ExcelJS from 'exceljs'

/** 三张导出表对应的称号(与 `db/titles.ts` 的 `TitleCode` 同值)。 */
export type PlatformExportTitleCode = 'specialized_sme' | 'little_giant' | 'innovative_sme'

/**
 * 一张导出表的**列位布局**(列号一律 **1-based**)。
 *
 * `sheetName` 只用于**自动识别**(工作表名仍是文件里那个名,别按名字取表,
 * 解析一律取 index 0 —— 见勘察笔记 B3 的教训)。
 */
export interface PlatformExportLayout {
  titleCode: PlatformExportTitleCode
  sheetName: string
  /** 数据起始行:两行表头之后。 */
  firstDataRow: number
  nameColumn: number
  /** 企业注册地(单列空格分隔文本,需拆省/市/区县)。 */
  registrationColumn: number
  usccColumn: number
  industryColumn: number
  reviewStatusColumn: number
  recommendedColumn: number
  applyTypeColumn: number
  maintenanceBatchColumn: number
  totalScoreColumn: number | null
}

/** 三个称号的列位表(实测固化;改这里必须先重新实测源文件)。 */
export const PLATFORM_EXPORT_LAYOUTS: Record<PlatformExportTitleCode, PlatformExportLayout> = {
  specialized_sme: {
    titleCode: 'specialized_sme',
    sheetName: '专精特新中小企业导出Excel',
    firstDataRow: 3,
    nameColumn: 1,
    registrationColumn: 2,
    usccColumn: 18,
    industryColumn: 20,
    reviewStatusColumn: 300,
    recommendedColumn: 301,
    applyTypeColumn: 302,
    maintenanceBatchColumn: 303,
    totalScoreColumn: 304,
  },
  little_giant: {
    titleCode: 'little_giant',
    sheetName: '专精特新小巨人导出Excel',
    firstDataRow: 3,
    nameColumn: 1,
    registrationColumn: 2,
    usccColumn: 18,
    industryColumn: 20,
    reviewStatusColumn: 271,
    recommendedColumn: 272,
    applyTypeColumn: 273,
    maintenanceBatchColumn: 274,
    totalScoreColumn: null,
  },
  innovative_sme: {
    titleCode: 'innovative_sme',
    sheetName: '创新型中小企业导出Excel',
    firstDataRow: 3,
    nameColumn: 1,
    registrationColumn: 2,
    usccColumn: 15,
    industryColumn: 17,
    reviewStatusColumn: 95,
    recommendedColumn: 96,
    applyTypeColumn: 97,
    maintenanceBatchColumn: 98,
    totalScoreColumn: 99,
  },
}

/** 注册地拆解结果;缺项为 `null`(不猜填)。 */
export interface RegistrationAddress {
  province: string | null
  city: string | null
  district: string | null
}

const EMPTY_ADDRESS: RegistrationAddress = { province: null, city: null, district: null }

/**
 * 把 `浙江省 宁波市 宁海县` 这类**单列空格分隔**注册地拆成省 / 市 / 区县。
 *
 * 源数据实测**恒为三段**,但这里对凑不齐的情况**留空而不是猜填**:
 * 两段按「省 市」处理(district 留空),一段当作区县(province/city 留空)。
 * 「高新区」「前湾新区」这类非标准区县名**照原样**留给 `district`。
 */
export function splitRegistrationAddress(raw: string | null | undefined): RegistrationAddress {
  const text = raw == null ? '' : String(raw).trim()
  if (!text) return { ...EMPTY_ADDRESS }
  const parts = text.split(/[\s　]+/).filter(Boolean)
  if (parts.length === 0) return { ...EMPTY_ADDRESS }
  if (parts.length === 1) return { province: null, city: null, district: parts[0]! }
  if (parts.length === 2) return { province: parts[0]!, city: parts[1]!, district: null }
  return { province: parts[0]!, city: parts[1]!, district: parts.slice(2).join(' ') }
}

/** 一行规范化快照行(对应契约 §1.7 `platform_export_row`)。 */
export interface PlatformExportRow {
  /** 源行号(该行在源文件里的物理行序,从 1 起;数据从 `firstDataRow` 开始)。 */
  sourceRowNo: number
  usccRaw: string | null
  nameRaw: string | null
  province: string | null
  city: string | null
  district: string | null
  /** 平台「审核状态」列原值(不是工商登记状态)。 */
  regStatus: string | null
  /** 整行原始字段,键是 **1-based 列号字符串**;只留**非空**值。 */
  rawFields: Record<string, string>
}

/** 解析结果:文件身份 + 规范化行。 */
export interface ParsedPlatformExport {
  titleCode: PlatformExportTitleCode
  originalFilename: string
  /** 文件内容 SHA-256(版本身份,契约 §1.6)。 */
  sha256: string
  /** 表头行数(两张导出表都是 2)。 */
  headerRowCount: number
  columnCount: number
  /** 数据行数 = `rows.length`。 */
  rowCount: number
  rows: PlatformExportRow[]
}

/** 计算文件内容 SHA-256。 */
export function sha256OfFile(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

/** 单元格取值 → 文本;富文本 / 超链接 / 公式结果都能取到字面量。 */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  const obj = value as Record<string, unknown>
  if (Array.isArray(obj.richText)) {
    return (obj.richText as Array<{ text?: string }>).map((x) => x.text ?? '').join('')
  }
  if (typeof obj.text === 'string') return obj.text
  if (obj.result !== undefined) return cellText(obj.result)
  if (obj.hyperlink !== undefined && obj.text === undefined) return String(obj.hyperlink)
  return String(value)
}

/** 空串归一成 `null`(契约里可空列统一用 null,不用空串)。 */
function blankToNull(text: string): string | null {
  const t = text.trim()
  return t === '' ? null : t
}

/**
 * 解析一张导出表。**按列号**读两行表头之后的数据行(契约 §1.7)。
 *
 * `titleCode` 不给时按工作表名自动识别(三张表的名字各不相同);识别不出**报错**,
 * 不猜。文件不存在同样直接抛 —— 调用方必须给一个真实存在的源文件。
 */
export async function readPlatformExport(
  filePath: string,
  options: { titleCode?: PlatformExportTitleCode } = {},
): Promise<ParsedPlatformExport> {
  const workbook = new ExcelJS.Workbook()
  // 文件不存在时 exceljs 直接抛(ENOENT)—— 不静默返回空表。
  await workbook.xlsx.readFile(filePath)
  const sheet = workbook.worksheets[0]
  if (!sheet) throw new Error(`导出表没有工作表:${filePath}`)

  const layout = options.titleCode
    ? PLATFORM_EXPORT_LAYOUTS[options.titleCode]
    : detectLayout(sheet.name, basename(filePath))

  const columnCount = sheet.columnCount
  const rows: PlatformExportRow[] = []
  for (let rowNo = layout.firstDataRow; rowNo <= sheet.rowCount; rowNo++) {
    const row = sheet.getRow(rowNo)
    const rawFields: Record<string, string> = {}
    for (let col = 1; col <= columnCount; col++) {
      const text = cellText(row.getCell(col).value).trim()
      if (text !== '') rawFields[String(col)] = text
    }
    // 整行都没有内容(常见于表尾的空白行)→ 不是一条快照行。
    if (Object.keys(rawFields).length === 0) continue

    const address = splitRegistrationAddress(rawFields[String(layout.registrationColumn)])
    rows.push({
      sourceRowNo: rowNo,
      nameRaw: blankToNull(rawFields[String(layout.nameColumn)] ?? ''),
      usccRaw: blankToNull(rawFields[String(layout.usccColumn)] ?? ''),
      province: address.province,
      city: address.city,
      district: address.district,
      regStatus: blankToNull(rawFields[String(layout.reviewStatusColumn)] ?? ''),
      rawFields,
    })
  }

  return {
    titleCode: layout.titleCode,
    originalFilename: basename(filePath),
    sha256: sha256OfFile(filePath),
    headerRowCount: 2,
    columnCount,
    rowCount: rows.length,
    rows,
  }
}

/** 按工作表名(再退一步按文件名)识别是哪个称号的导出表;识别不出报错。 */
function detectLayout(sheetName: string, filename: string): PlatformExportLayout {
  const layouts = Object.values(PLATFORM_EXPORT_LAYOUTS)
  const bySheet = layouts.find((l) => l.sheetName === sheetName)
  if (bySheet) return bySheet
  const byName = layouts.find((l) => filename.includes(l.sheetName))
  if (byName) return byName
  throw new Error(
    `无法识别导出表称号(工作表名「${sheetName}」不在已实测的三张表之列);请显式传 titleCode。`,
  )
}

/**
 * 把解析结果包成契约 §8.3 的 `exportSnapshot` payload(交给统一写 API 提交)。
 *
 * `year` / `collectedOn` 由调用方给出 —— 本模块**不从文件内容推断年度**
 * (导出表里那列 `维护批次` 是平台口径的维护批次,不是快照年度)。
 */
export function buildExportSnapshotPayload(
  parsed: ParsedPlatformExport,
  meta: { year: number; collectedOn: string },
): ExportSnapshotPayload {
  return {
    titleCode: parsed.titleCode,
    year: meta.year,
    collectedOn: meta.collectedOn,
    originalFilename: parsed.originalFilename,
    sha256: parsed.sha256,
    rows: parsed.rows.map((row) => ({
      sourceRowNo: row.sourceRowNo,
      usccRaw: row.usccRaw,
      nameRaw: row.nameRaw,
      province: row.province,
      city: row.city,
      district: row.district,
      regStatus: row.regStatus,
      rawFields: row.rawFields,
    })),
  }
}

/** 契约 §8.3 的 `payload.exportSnapshot` 形状。 */
export interface ExportSnapshotPayload {
  titleCode: PlatformExportTitleCode
  year: number
  collectedOn: string
  originalFilename: string
  sha256: string
  rows: Array<{
    sourceRowNo: number
    usccRaw: string | null
    nameRaw: string | null
    province: string | null
    city: string | null
    district: string | null
    regStatus: string | null
    rawFields: Record<string, string>
  }>
}
