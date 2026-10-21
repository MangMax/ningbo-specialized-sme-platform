import { createHash } from 'node:crypto'
import { Workbook, Worksheet } from 'documonster/excel'
import { assertExcelSheets, inspectExcelSource } from '../excel-source'
import { createExcelValueReader } from '../excel-read-value'
import { isNingboDistrict, normalizeUscc } from '../domain'

/**
 * RL-02 —— 经信局《公布历年小巨人企业名单》工作簿的**只读解析器**。
 *
 * ── 这份文件长什么样(已实测,见 `03-RESEARCH-export-and-source-files.md` 的 B3/B5)──
 *
 *  - **单工作表**,名字带一个遗留后缀 ` (2)`(像是从别的簿复制来的)⇒ **按 index 0 取表**,
 *    **不要**按名字取。
 *  - **表头只有一行**(r1),数据从 **r2** 起。这与工信部三张导出表的「两行表头、数据从 r3 起」
 *    **不同**,照抄那张表的读法会整表错位。
 *  - A:J 是这份名单的字段区;**K 起**是备注/主导产品/行业代码等**旁侧杂项**,
 *    其中 M(主导产品)、N–Q(行业)看着也「像名单」,但它们**不是**名单字段 ⇒ 一律不读。
 *  - **G 列与 I 列的表头都叫「联系方式」**(一个是法人的、一个是联系人的)。
 *    按表头名取列必然撞车 ⇒ **本模块一律按列号取值**。
 *
 * ── 本模块只做三件事 ──
 *
 *  1. 按列号把 A:J 读成规范化行(企业名 / 统一社会信用代码 / 属地 / 批次 / 年份);
 *  2. 把**每一条源行**交代清楚:进 `rows`(可入库),或进 `issues`(带原因的待核/警示),
 *     或进 `blankRowNumbers`(A:J 全空)—— 三者之和恒等于 `dataRowCount`;
 *  3. 记录源文件身份与字段映射(SHA-256 / 表名 / 行数 / 列号映射),让整件事可复核。
 *
 * **不写库、不拼 payload、不判重合并** —— 那些是别的模块的事。
 */

/** 本工作簿承载的称号。`db/titles.ts` 的 `little_giant`。 */
export const LITTLE_GIANT_TITLE_CODE = 'little_giant'

/** 名单字段区只到 **J** 列。K 起是旁侧杂项,**永不**当名单读。 */
export const NOTICE_COLUMN_RANGE = { from: 'A', to: 'J' } as const

/** 名单字段区的最后一列号(J = 10)。 */
const NOTICE_LIMIT = 10

/**
 * 批次序号 → 年份:`year = 2018 + batchSeq`。
 *
 * 第 1 批 = 2019 …第 7 批 = 2025;第 8 批若出现 = 2026。
 * 这条约定来自票面与 SPEC,**不是**从文件里推出来的。
 */
export const BATCH_BASE_YEAR = 2018

/** 批次序号 → 年份。 */
export function batchSeqToYear(batchSeq: number): number {
  return BATCH_BASE_YEAR + batchSeq
}

/** 本约定覆盖到第 8 批(= 2026)。缺口只在这个范围内报。 */
export const LAST_KNOWN_BATCH_SEQ = 8

/** 统一社会信用代码的字符集与位数(GB 32100-2015:不含 I/O/S/V/Z)。 */
const USCC_RE = /^[0-9A-HJ-NPQRTUWXY]{18}$/u

export interface LittleGiantRow {
  /** 在**源工作表**里的行号(1 起;r1 是表头,所以第一条数据是 2)。 */
  sourceRowNo: number
  /** A 列「序号」原值(名单内序号)。 */
  listNo: number
  /** B 列「属地」。 */
  district: string
  /** C 列「企业名称」。 */
  name: string
  /** D 列「统一社会信用代码」,去空白并转大写后的值;源里缺则为空串。 */
  uscc: string
  /** D 列原值(未归一),留证。 */
  usccRaw: string
  /** J 列「批次」原值(如 `第2批`)。 */
  batchLabel: string
  /** 批次序号(如 2)。 */
  batchSeq: number
  /** 认定年份 = `2018 + batchSeq`。 */
  year: number
  /**
   * 该源行 **A:J 的原值**(未归一的原文)。留证用 —— 证明这一行**只**从 A:J 读来,
   * K 之后一个字都没进来。E–I(地址/法人/联系人/电话)不在本模块的任何输出里流转,
   * 只在这份原值里留存。
   */
  raw: string[]
}

export type LittleGiantIssueCode =
  | 'missing_name'
  | 'missing_batch'
  | 'unknown_batch_label'
  | 'missing_uscc'
  | 'invalid_uscc'
  | 'missing_district'
  | 'unknown_district'
  | 'duplicate_uscc'

export interface LittleGiantIssue {
  sourceRowNo: number
  listNo: number | null
  name: string | null
  uscc: string | null
  /** 机器可读的原因。 */
  code: LittleGiantIssueCode
  /**
   * `blocked` = 这一行**没有**进入名单(必须有人看一眼);
   * `warning` = 已进入名单,但字段可疑(记下来,不阻塞)。
   */
  severity: 'blocked' | 'warning'
  message: string
  /** A:J 原值(留证;**不含** K 之后)。 */
  raw: string[]
}

/** 一个信用代码在本文件里出现了不止一次(跨批次重复认定,不是脏数据)。 */
export interface LittleGiantDuplicate {
  uscc: string
  occurrences: Array<{
    sourceRowNo: number
    listNo: number
    name: string
    batchSeq: number
    year: number
  }>
}

export interface LittleGiantWorkbook {
  /** 源文件内容 SHA-256(版本身份)。 */
  sha256: string
  /** 工作表名(**留证用**;取表一律按 index)。 */
  sheetName: string
  sheetIndex: number
  worksheetCount: number
  /** 表头所在行(本文件恒为 1)。 */
  headerRow: number
  /** 名单字段区(恒为 A:J)。 */
  noticeColumnRange: { from: 'A'; to: 'J' }
  /** 字段名 → 列名。**按列号取值**,故这里记的是列名而不是表头文字。 */
  fieldMapping: { listNo: 'A'; district: 'B'; name: 'C'; uscc: 'D'; batch: 'J' }
  /** 已读的名单字段区表头原文(A:J)。 */
  headers: string[]
  /** r2 起(含空白行)的源行数。 */
  dataRowCount: number
  /** 可入库的行(逐条源行 → 一条认定事件)。 */
  rows: LittleGiantRow[]
  /** 带原因的待核 / 警示清单。 */
  issues: LittleGiantIssue[]
  /** A:J 全空的源行行号 —— 不作名单,但也要有交代。 */
  blankRowNumbers: number[]
  /** 按批次序号的分布(`{ 1: 5, 2: 50, … }`)。 */
  batchDistribution: Record<number, number>
  /** 本约定覆盖到第 8 批,但**文件里没有**的批次(来源未提供,不猜补)。 */
  missingBatches: number[]
  /** 出现不止一次的信用代码,逐条列出「哪几行」。 */
  duplicateUscc: LittleGiantDuplicate[]
}

/**
 * 读一份小巨人工作簿。
 *
 * @param input 工作簿字节(`.xlsx` 原文)。
 */
export async function parseLittleGiantWorkbook(
  input: Uint8Array,
): Promise<LittleGiantWorkbook> {
  const workbook = Workbook.create()
  const sourceParts = await inspectExcelSource(input)
  await Workbook.read(workbook, input)

  const sheets = Workbook.getWorksheets(workbook)
  assertExcelSheets(sourceParts, sheets.map(sheet => Worksheet.getName(sheet)))
  const sheet = sheets[0]
  if (!sheet) throw new Error('工作簿里没有工作表')
  const valueAt = await createExcelValueReader(sheet, input, sourceParts.get(Worksheet.getName(sheet))!, { firstRow: 1, columnCount: NOTICE_LIMIT })

  const headers: string[] = []
  for (let column = 1; column <= NOTICE_LIMIT; column += 1) {
    headers.push(cellText(valueAt(1, column)))
  }

  const rows: LittleGiantRow[] = []
  const issues: LittleGiantIssue[] = []
  const blankRowNumbers: number[] = []
  const dataRowCount = Math.max(0, Worksheet.rowCount(sheet) - 1)

  for (let sourceRowNo = 2; sourceRowNo <= Worksheet.rowCount(sheet); sourceRowNo += 1) {
    const raw: string[] = []
    for (let column = 1; column <= NOTICE_LIMIT; column += 1) {
      raw.push(cellText(valueAt(sourceRowNo, column)))
    }
    if (raw.every((value) => value === '')) {
      blankRowNumbers.push(sourceRowNo)
      continue
    }

    const listNoRaw = raw[0]!.trim()
    const district = raw[1]!.trim()
    const name = raw[2]!.trim()
    const usccRaw = raw[3]!.trim()
    const batchLabel = raw[9]!.trim()
    const uscc = normalizeUscc(usccRaw)
    const listNo = parseListNo(listNoRaw)
    const batchSeq = parseBatchSeq(batchLabel)
    const draft = { sourceRowNo, listNo, name, uscc, usccRaw, district, raw }

    // **阻塞**优先:先看「这一行还认不认得出是哪家企业、哪一年」。
    if (name === '') {
      issues.push(blocked(draft, 'missing_name', '源行缺「企业名称」,无法归属企业'))
      continue
    }
    if (batchLabel === '') {
      issues.push(blocked(draft, 'missing_batch', '源行缺「批次」,认定年份无从确定(不猜)'))
      continue
    }
    if (batchSeq === null) {
      issues.push(
        blocked(draft, 'unknown_batch_label', `「批次」写法认不出:「${batchLabel}」(期望形如「第3批」,不猜)`)
      )
      continue
    }

    rows.push({
      sourceRowNo,
      listNo,
      district,
      name,
      uscc,
      usccRaw,
      batchLabel,
      batchSeq,
      year: batchSeqToYear(batchSeq),
      raw,
    })

    // 进名单之后的可疑字段:只警示,**不丢行**。
    if (usccRaw === '') {
      issues.push(
        warning(draft, 'missing_uscc', '源行缺「统一社会信用代码」,企业身份按名称归一(不丢弃该行)'),
      )
    } else if (!USCC_RE.test(uscc)) {
      issues.push(
        warning(
          draft,
          'invalid_uscc',
          `「统一社会信用代码」不是 18 位、或含非法字符:「${usccRaw}」(按源值保留,标待核)`,
        ),
      )
    }
    if (district === '') {
      issues.push(warning(draft, 'missing_district', '源行缺「属地」'))
    } else if (!isNingboDistrict(district)) {
      issues.push(warning(draft, 'unknown_district', `「属地」不在宁波区县/管理区内:「${district}」`))
    }
  }

  const batchDistribution = countByBatch(rows)
  const duplicateUscc = findDuplicates(rows)
  for (const duplicate of duplicateUscc) {
    for (const occurrence of duplicate.occurrences) {
      const source = rows.find((row) => row.sourceRowNo === occurrence.sourceRowNo)!
      issues.push({
        sourceRowNo: source.sourceRowNo,
        listNo: source.listNo,
        name: source.name,
        uscc: source.uscc,
        code: 'duplicate_uscc',
        severity: 'warning',
        message:
          `统一社会信用代码 ${duplicate.uscc} 在本文件里出现 ${duplicate.occurrences.length} 次` +
          `(第 ${duplicate.occurrences.map((o) => o.batchSeq).join(' 批、第 ')} 批)—— ` +
          '企业去重,但**每批都是独立事件**',
        raw: source.raw,
      })
    }
  }
  issues.sort((a, b) => a.sourceRowNo - b.sourceRowNo)

  return {
    sha256: createHash('sha256').update(input).digest('hex'),
    sheetName: Worksheet.getName(sheet),
    sheetIndex: 0,
    worksheetCount: sheets.length,
    headerRow: 1,
    noticeColumnRange: NOTICE_COLUMN_RANGE,
    fieldMapping: { listNo: 'A', district: 'B', name: 'C', uscc: 'D', batch: 'J' },
    headers,
    dataRowCount,
    rows,
    issues,
    blankRowNumbers,
    batchDistribution,
    missingBatches: findMissingBatches(batchDistribution),
    duplicateUscc,
  }
}

/** 一条源行的原始值与按列号读出的字段 —— 判定用的中间形态。 */
interface RowDraft {
  sourceRowNo: number
  listNo: number
  name: string
  uscc: string
  usccRaw: string
  district: string
  raw: string[]
}

function blocked(draft: RowDraft, code: LittleGiantIssueCode, message: string): LittleGiantIssue {
  return { ...issueBase(draft), code, severity: 'blocked', message }
}

function warning(draft: RowDraft, code: LittleGiantIssueCode, message: string): LittleGiantIssue {
  return { ...issueBase(draft), code, severity: 'warning', message }
}

function issueBase(draft: RowDraft) {
  return {
    sourceRowNo: draft.sourceRowNo,
    listNo: draft.listNo,
    name: draft.name === '' ? null : draft.name,
    uscc: draft.usccRaw === '' ? null : draft.uscc,
    raw: draft.raw,
  }
}


function countByBatch(rows: LittleGiantRow[]): Record<number, number> {
  const distribution: Record<number, number> = {}
  for (const row of rows) distribution[row.batchSeq] = (distribution[row.batchSeq] ?? 0) + 1
  return distribution
}

/** 本约定覆盖 1…8 批;文件里没出现的,就是「来源未提供」的缺口。 */
function findMissingBatches(distribution: Record<number, number>): number[] {
  const missing: number[] = []
  for (let seq = 1; seq <= LAST_KNOWN_BATCH_SEQ; seq += 1) {
    if (!distribution[seq]) missing.push(seq)
  }
  return missing
}

function findDuplicates(rows: LittleGiantRow[]): LittleGiantDuplicate[] {
  const byUscc = new Map<string, LittleGiantRow[]>()
  for (const row of rows) {
    if (row.uscc === '') continue
    const bucket = byUscc.get(row.uscc)
    if (bucket) bucket.push(row)
    else byUscc.set(row.uscc, [row])
  }
  const duplicates: LittleGiantDuplicate[] = []
  for (const [uscc, bucket] of byUscc) {
    if (bucket.length < 2) continue
    duplicates.push({
      uscc,
      occurrences: bucket.map((row) => ({
        sourceRowNo: row.sourceRowNo,
        listNo: row.listNo,
        name: row.name,
        batchSeq: row.batchSeq,
        year: row.year,
      })),
    })
  }
  return duplicates
}

/** 单元格取文本;保留原读取器的富文本/公式与日期字符串语义。 */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') {
    const rich = value as { text?: string; result?: unknown; richText?: Array<{ text: string }> }
    if (Array.isArray(rich.richText)) return rich.richText.map((part) => part.text).join('')
    if (typeof rich.text === 'string') return rich.text
    if (rich.result !== undefined) return String(rich.result)
    return String(value)
  }
  return String(value)
}

/** `第2批` → `2`;认不出返回 `null`(认不出就**不进名单**,由调用方记待核)。 */
function parseBatchSeq(label: string): number | null {
  const match = /^第(\d+)批$/.exec(label)
  if (!match) return null
  const seq = Number(match[1])
  return Number.isInteger(seq) && seq > 0 ? seq : null
}

/** A 列「序号」取整;给不出数字时退回 0(它只作留证,不阻塞入库)。 */
function parseListNo(raw: string): number {
  const value = Number(raw)
  return Number.isFinite(value) && raw !== '' ? value : 0
}
