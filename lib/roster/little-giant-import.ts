import { normalizeName } from '../domain'
import {
  LITTLE_GIANT_TITLE_CODE,
  batchSeqToYear,
  type LittleGiantDuplicate,
  type LittleGiantIssue,
  type LittleGiantWorkbook,
} from './little-giant-workbook'

/**
 * RL-02 —— 把小巨人工作簿的解析结果拼成
 * **契约 §8.3 的 payload** 与 **给人看的导入报告**。
 *
 * ── 三条本模块负责守住的边界 ──
 *
 *  1. **企业去重、事件不折叠**:同一统一社会信用代码跨批次出现 ⇒ 合成**一条**企业记录,
 *     但**每一批**各自留下一条认定事件(真件里 `91330211316904639T` 在第 2 批与第 6 批
 *     各一次 ⇒ 一条记录、两条事件)。
 *  2. **每条源行都有交代**:进 `rows` 的行才有事件;被阻塞的行**不静默丢弃** ——
 *     它们在报告里带原因待核。
 *  3. **不猜**:来源没给的一律留空(文号、页码、复核结论);认不出的批次**不进**名单。
 *
 * 写库不在这里:「经真实 HTTP 提交」由 `POST /api/roster/import/commit`(RL-11) 完成,
 * 端到端见 `tests/little-giant-import-e2e.test.ts`。
 */

/**
 * 出处的源文件标识 —— 用**来源根下的相对路径**(不含凭证),与 `record_evidence.source_file`
 * 同一口径。文件登记进文件库(`app/files/`)后,可经 `options.sourceFile` 换成库内相对路径;
 * 本票不改文件库,故用源目录口径作为默认值。
 */
export const LITTLE_GIANT_SOURCE_FILE = '经信局名单/小巨人/经信局公布历年小巨人企业名单.xlsx'

/** 公布文件标题。**文号来源里没给** ⇒ `docNumber` 留空,不猜。 */
export const LITTLE_GIANT_SOURCE_TITLE = '经信局公布历年小巨人企业名单'

/** 幂等键前缀。**同一来源文件重复导入必须用同一个键**,故键只由内容哈希决定。 */
export const LITTLE_GIANT_IDEMPOTENCY_PREFIX = 'jxj/little-giant/historical'

export interface RosterImportEvidence {
  sourceFile: string
  attachment: string | null
  listNo: number | null
  page: number | null
}

export interface RosterImportEvent {
  eventType: 'award'
  year: number
  batchSeq: number
  decidedYear: number
  reviewOutcome: null
  evidence: RosterImportEvidence[]
}

export interface RosterImportEnterprise {
  name: string
  uscc: string | null
  /**
   * 属地(源文件 B 列)。**契约 §8.3 示例里没有这个字段** —— 本票按源文件如实带上,
   * 见交付说明的「需要父代理裁决的点」;若写入侧忽略它,属地的唯一来源就只剩源文件本身。
   */
  district: string | null
}

export interface RosterImportRecord {
  enterprise: RosterImportEnterprise
  titleCode: string
  events: RosterImportEvent[]
}

export interface RosterImportPayload {
  announcement: {
    sourceDocument: { source: 'jxj'; title: string; docNumber: string | null }
    records: RosterImportRecord[]
  }
}

/** `POST /api/roster/import/commit`(契约 §8.2)的请求体。 */
export interface RosterImportRequest {
  idempotencyKey: string
  sourceKind: 'announcement'
  sourceIdentity: string
  sourceSha256: string
  payload: RosterImportPayload
}

export interface LittleGiantImportOptions {
  /** 出处的源文件标识。默认 [`LITTLE_GIANT_SOURCE_FILE`]。 */
  sourceFile?: string
  /** 来源身份(入库 `import_batch.source_identity`)。默认与 `sourceFile` 同值。 */
  sourceIdentity?: string
}

export interface LittleGiantImportTotals {
  sourceRows: number
  enterprises: number
  records: number
  events: number
  evidences: number
}

export interface LittleGiantImportReport {
  source: {
    sha256: string
    sheetName: string
    sheetIndex: number
    worksheetCount: number
    headerRow: number
    noticeColumnRange: { from: 'A'; to: 'J' }
    fieldMapping: { listNo: 'A'; district: 'B'; name: 'C'; uscc: 'D'; batch: 'J' }
    sourceFile: string
  }
  /** 逐行交代。`reconciled` = 「事件 + 待核 + 空白 = 源行数」成立。 */
  rowAccounting: {
    sourceRows: number
    events: number
    blocked: number
    blank: number
    reconciled: boolean
  }
  batches: {
    distribution: Record<number, number>
    batchYears: Record<number, number>
    missingBatchSeqs: number[]
    notes: string[]
  }
  duplicates: LittleGiantDuplicate[]
  issues: {
    byCode: Record<string, number>
    blocked: Array<Pick<LittleGiantIssue, 'sourceRowNo' | 'listNo' | 'name' | 'code' | 'message'>>
    warnings: Array<Pick<LittleGiantIssue, 'sourceRowNo' | 'listNo' | 'name' | 'code' | 'message'>>
  }
  totals: LittleGiantImportTotals
}

/**
 * 把一次解析结果编成**契约 §8.2** 的提交请求。
 *
 * 幂等键只由**源文件内容 SHA-256** 决定 ⇒ 同一份文件无论什么时候、由谁重复导入,
 * 都是同一个键(写入侧凭它保证不重复写企业/事件)。
 */
export function buildLittleGiantImportRequest(
  workbook: LittleGiantWorkbook,
  options: LittleGiantImportOptions = {},
): RosterImportRequest {
  const sourceFile = options.sourceFile ?? LITTLE_GIANT_SOURCE_FILE
  return {
    idempotencyKey: `${LITTLE_GIANT_IDEMPOTENCY_PREFIX}#sha256:${workbook.sha256}`,
    sourceKind: 'announcement',
    sourceIdentity: options.sourceIdentity ?? sourceFile,
    sourceSha256: workbook.sha256,
    payload: {
      announcement: {
        sourceDocument: { source: 'jxj', title: LITTLE_GIANT_SOURCE_TITLE, docNumber: null },
        records: groupRecords(workbook, sourceFile),
      },
    },
  }
}

/** 逐行交代 + 重复 + 缺口的报告(不含企业名以外的业务细节也能读)。 */
export function buildLittleGiantImportReport(
  workbook: LittleGiantWorkbook,
  options: LittleGiantImportOptions = {},
): LittleGiantImportReport {
  const sourceFile = options.sourceFile ?? LITTLE_GIANT_SOURCE_FILE
  const blocked = workbook.issues.filter((issue) => issue.severity === 'blocked')
  const warnings = workbook.issues.filter((issue) => issue.severity === 'warning')
  const byCode: Record<string, number> = {}
  for (const issue of workbook.issues) byCode[issue.code] = (byCode[issue.code] ?? 0) + 1

  const batchSeqs = Object.keys(workbook.batchDistribution).map(Number).sort((a, b) => a - b)
  const batchYears: Record<number, number> = {}
  for (const seq of batchSeqs) batchYears[seq] = batchSeqToYear(seq)

  const events = workbook.rows.length
  const enterpriseCount = uniqueEnterprises(workbook).length
  const blank = workbook.blankRowNumbers.length
  const notes = [
    `批次取值:${batchSeqs.map((seq) => `第 ${seq} 批`).join('、') || '(无)'}。`,
    missingNote(workbook.missingBatches),
  ].filter((note) => note !== '')

  return {
    source: {
      sha256: workbook.sha256,
      sheetName: workbook.sheetName,
      sheetIndex: workbook.sheetIndex,
      worksheetCount: workbook.worksheetCount,
      headerRow: workbook.headerRow,
      noticeColumnRange: workbook.noticeColumnRange,
      fieldMapping: workbook.fieldMapping,
      sourceFile,
    },
    rowAccounting: {
      sourceRows: workbook.dataRowCount,
      events,
      blocked: blocked.length,
      blank,
      reconciled: events + blocked.length + blank === workbook.dataRowCount,
    },
    batches: {
      distribution: workbook.batchDistribution,
      batchYears,
      missingBatchSeqs: workbook.missingBatches,
      notes,
    },
    duplicates: workbook.duplicateUscc,
    issues: {
      byCode,
      blocked: blocked.map(toIssueLine),
      warnings: warnings.map(toIssueLine),
    },
    totals: {
      sourceRows: workbook.dataRowCount,
      enterprises: enterpriseCount,
      records: enterpriseCount,
      events,
      evidences: events,
    },
  }
}

/**
 * 同一家企业(**优先按统一社会信用代码**,缺码时按与 app 同规则的名称归一)只出一条记录,
 * 它名下的每一批各自成一条认定事件。
 *
 * 组的先后 = 首次出现的源行先后(稳定、可复现)。
 */
function groupRecords(workbook: LittleGiantWorkbook, sourceFile: string): RosterImportRecord[] {
  const groups = new Map<string, RosterImportRecord>()
  for (const row of workbook.rows) {
    const key = row.uscc === '' ? `name:${normalizeName(row.name)}` : `uscc:${row.uscc}`
    const event: RosterImportEvent = {
      eventType: 'award',
      year: row.year,
      batchSeq: row.batchSeq,
      // 认定事件的「结论年份」就是认定年份本身(公布名单的批次 → 年份是权威约定)。
      decidedYear: row.year,
      // 复核结论:本来源是认定名单,**没有**复核信息 ⇒ 留空(未知不猜成通过)。
      reviewOutcome: null,
      evidence: [
        {
          sourceFile,
          attachment: workbook.sheetName,
          listNo: row.listNo,
          // 表格没有「页」的概念 ⇒ 页码留空(空值优于错误值)。
          page: null,
        },
      ],
    }

    const existing = groups.get(key)
    if (!existing) {
      groups.set(key, {
        enterprise: {
          name: row.name,
          uscc: row.uscc === '' ? null : row.uscc,
          district: row.district === '' ? null : row.district,
        },
        titleCode: LITTLE_GIANT_TITLE_CODE,
        events: [event],
      })
      continue
    }
    existing.events.push(event)
  }

  // 事件按批次序号排(源行顺序已经如此,这里显式钉死,免得日后改读法悄悄变序)。
  for (const record of groups.values()) {
    record.events.sort((a, b) => a.batchSeq - b.batchSeq)
  }
  return [...groups.values()]
}

function uniqueEnterprises(workbook: LittleGiantWorkbook): string[] {
  const keys = new Set<string>()
  for (const row of workbook.rows) {
    keys.add(row.uscc === '' ? `name:${normalizeName(row.name)}` : `uscc:${row.uscc}`)
  }
  return [...keys]
}

function toIssueLine(issue: LittleGiantIssue) {
  return {
    sourceRowNo: issue.sourceRowNo,
    listNo: issue.listNo,
    name: issue.name,
    code: issue.code,
    message: issue.message,
  }
}

/**
 * 缺口说明。**不造空记录**:只是把「本约定覆盖到第 8 批,而文件里没有这些批」写清楚。
 * 第 8 批单列一句,因为它是票面点名的那一个。
 */
function missingNote(missingBatchSeqs: number[]): string {
  if (missingBatchSeqs.length === 0) return ''
  const labels = missingBatchSeqs
    .map((seq) => `第 ${seq} 批(${batchSeqToYear(seq)} 年)`)
    .join('、')
  const eighth = missingBatchSeqs.includes(8)
    ? '其中**第 8 批**按约定应为 2026 年:当前源文件未提供,列作缺口,**不造空记录**。'
    : '当前源文件未提供这些批次的名单,**不造空记录**。'
  return `本约定覆盖第 1–8 批;文件里没有:${labels}。${eighth}`
}
