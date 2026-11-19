import { normalizeName } from '../domain'
import type {
  RosterImportEvidence,
  RosterImportEvent,
  RosterImportPayload,
  RosterImportRecord,
  RosterImportRequest,
} from '../roster-import-client'
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
 * ── 为什么载荷类型从 `layers/sme-roster/lib/roster-import-client.ts` 取 ────────────────
 * 那是 RL-11 按契约 §8 落的**契约类型**(项目外 `pipeline/` 也直接 import 它)。
 * 本模块只**产出**符合该类型的对象,不另立一套同形接口 —— 于是「我的载荷与写入侧
 * 说的是不是同一个形状」由**类型检查**回答,而不是靠人比对两份同形声明。
 *
 * 写库不在这里:「经真实 HTTP 提交」由 `POST /api/roster/import/commit`(RL-11) 完成,
 * 端到端见 `tests/little-giant-import-e2e.test.ts`。
 */

/**
 * 出处的源文件标识 —— **文件库(`app/files/`)内的相对路径**,与 `record_evidence.source_file`
 * 同一口径,预览/跳转据此解析(RL-16)。
 *
 * 这份工作簿从第 1 批到第 7 批**跨年**,没有单一的「公布年份/批次」,故按
 * `lib/file-store-scope.ts` 的「year/batch 取值」第 4 条**省略这两段**:
 *
 *     files/jxj/announcement/经信局公布历年小巨人企业名单.xlsx
 *
 * 这也正是 app 自己的落位规则对 `(source=jxj, kind=announcement, 无年、无批次)` 给出的路径
 * (`server/utils/tus.ts` 的 `landingSegments`),故这份文件可以由**公开上传接口**原样落进去,
 * 不需要为它开特例。
 *
 * ⚠️ 历史上这里是**来源根相对路径** `经信局名单/小巨人/经信局公布历年小巨人企业名单.xlsx`
 * —— 那个路径不在文件库里,于是出处解析不到文件、预览全断(RL-02 交付时标为 TO-BACKFILL,
 * RL-16 兑现)。**不要再改回库外路径。**
 */
export const LITTLE_GIANT_SOURCE_FILE = 'jxj/announcement/经信局公布历年小巨人企业名单.xlsx'

/** 公布文件标题。**文号来源里没给** ⇒ `docNumber` 留空,不猜。 */
export const LITTLE_GIANT_SOURCE_TITLE = '经信局公布历年小巨人企业名单'

/**
 * 幂等键 —— **来源文件标识 + 内容 SHA-256**(契约 §8.1 的形状:`<来源标识>#sha256:<内容>`)。
 *
 * 为什么键里带**路径**:文件入库(RL-16)后,同一份内容的来源标识从**库外路径**变成
 * **库内路径** —— 那正是「该重导一次」的信号。重导时事件按坐标跳过(历史一行不改、
 * 一行不重复),而**出处指针**收敛到库内路径(见 `layers/sme-roster/server/utils/roster-import.ts` 的重放收敛)。
 *
 * 内容没变、标识没变 ⇒ 键不变 ⇒ 重复导入是彻底的空操作(**幂等**);
 * 键不随调用者、时点变化,故同一份文件任何时候重复导入都是同一个键。
 */
export function littleGiantIdempotencyKey(sourceFile: string, sha256: string): string {
  return `${sourceFile}#sha256:${sha256}`
}

// ---------------------------------------------------------------------------
// 载荷类型:契约 §8.3 的**收窄版**(契约里那些 `?` 是给通用写入方的,本模块从不产半成品)
// ---------------------------------------------------------------------------

/** 出处:本模块**总能**给全四项(契约里可空是因为它还要服务别的来源)。 */
export interface LittleGiantImportEvidence extends RosterImportEvidence {
  sourceFile: string
  attachment: string | null
  listNo: number
  page: number | null
}

/** 认定行及同一行备注中明确记载的复核事件。 */
export interface LittleGiantImportEvent extends RosterImportEvent {
  eventType: 'award' | 'review'
  year: number
  batchSeq: number
  decidedYear: number
  reviewOutcome: 'failed' | null
  evidence: LittleGiantImportEvidence[]
}

/** 企业:属地来自源文件 B 列,随记录一起带上。 */
export interface LittleGiantImportEnterprise {
  name: string
  uscc: string | null
  district: string | null
}

/** 一条记录 = 一家企业 × 小巨人 × jxj,事件按批次序号排好。 */
export interface LittleGiantImportRecord extends RosterImportRecord {
  enterprise: LittleGiantImportEnterprise
  titleCode: string
  events: LittleGiantImportEvent[]
}

export interface LittleGiantImportPayload extends RosterImportPayload {
  announcement: {
    sourceDocument: { source: 'jxj'; title: string; docNumber: string | null }
    records: LittleGiantImportRecord[]
  }
}

/** 契约 §8.2 的提交请求体(本模块产出的那一份)。 */
export interface LittleGiantImportRequest extends RosterImportRequest {
  idempotencyKey: string
  sourceKind: 'announcement'
  sourceIdentity: string
  sourceSha256: string
  payload: LittleGiantImportPayload
}

/** 本模块产出的请求体就是契约 §8.2 的请求体 —— 收窄类型**继承**契约类型,故可互换。 */
export type { RosterImportPayload, RosterImportRequest }

export interface LittleGiantImportOptions {
  /** 出处的源文件标识(**文件库内相对路径**)。默认 [`LITTLE_GIANT_SOURCE_FILE`]。 */
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
  /** 备注原文保留供主体/跨称号事实另行核验，不自动改主体状态。 */
  remarks: Array<{ sourceRowNo: number; listNo: number; primary: string; secondary: string; reviewImported: boolean }>
}

/**
 * 把一次解析结果编成**契约 §8.2** 的提交请求。
 *
 * 幂等键由**来源标识(库内相对路径)+ 源文件内容 SHA-256** 决定(见
 * [`littleGiantIdempotencyKey`]) ⇒ 同一份文件、同一个位置,无论什么时候、由谁重复导入,
 * 都是同一个键(写入侧凭它保证不重复写企业/事件);文件入库换了位置 ⇒ 换键 ⇒ 重导一次以收敛出处指针。
 */
export function buildLittleGiantImportRequest(
  workbook: LittleGiantWorkbook,
  options: LittleGiantImportOptions = {},
): LittleGiantImportRequest {
  const sourceFile = options.sourceFile ?? LITTLE_GIANT_SOURCE_FILE
  return {
    idempotencyKey: littleGiantIdempotencyKey(sourceFile, workbook.sha256) + (workbook.rows.some(row => failedReviewYear(row.remarks?.primary ?? '', row.batchSeq, row.year) !== null) ? '#review-notes-v1' : ''),
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
  const reviews = workbook.rows.filter(row => failedReviewYear(row.remarks?.primary ?? '', row.batchSeq, row.year) !== null).length
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
      events: events + reviews,
      evidences: events + reviews,
    },
    remarks: workbook.rows.filter(row => row.remarks?.primary || row.remarks?.secondary).map(row => ({ sourceRowNo: row.sourceRowNo, listNo: row.listNo, primary: row.remarks?.primary ?? '', secondary: row.remarks?.secondary ?? '', reviewImported: failedReviewYear(row.remarks?.primary ?? '', row.batchSeq, row.year) !== null })),
  }
}

/**
 * 同一家企业(**优先按统一社会信用代码**,缺码时按与 app 同规则的名称归一)只出一条记录,
 * 它名下的每一批各自成一条认定事件。
 *
 * 组的先后 = 首次出现的源行先后(稳定、可复现)。
 */
function groupRecords(workbook: LittleGiantWorkbook, sourceFile: string): LittleGiantImportRecord[] {
  const groups = new Map<string, LittleGiantImportRecord>()
  for (const row of workbook.rows) {
    const key = row.uscc === '' ? `name:${normalizeName(row.name)}` : `uscc:${row.uscc}`
    const event: LittleGiantImportEvent = {
      eventType: 'award',
      year: row.year,
      batchSeq: row.batchSeq,
      // 认定事件的「结论年份」就是认定年份本身(公布名单的批次 → 年份是权威约定)。
      decidedYear: row.year,
      // 原认定仍保留；备注里的复核另建事件，不覆盖认定历史。
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

    const reviewYear = failedReviewYear(row.remarks?.primary ?? '', row.batchSeq, row.year)
    const events = reviewYear === null ? [event] : [event, { ...event, eventType: 'review' as const, decidedYear: reviewYear, reviewOutcome: 'failed' as const }]
    const existing = groups.get(key)
    if (!existing) {
      groups.set(key, {
        enterprise: {
          name: row.name,
          uscc: row.uscc === '' ? null : row.uscc,
          // 属地(源文件 B 列)一并带上:RL-11 会把它写进 `enterprise.district` /
          // `record.district`(`layers/sme-roster/lib/roster-import-client.ts` 的 `RosterImportRecord` 有这一项);
          // 丢掉它,RL-04 的按区县筛选就没有来源。
          district: row.district === '' ? null : row.district,
        },
        titleCode: LITTLE_GIANT_TITLE_CODE,
        events,
      })
      continue
    }
    existing.events.push(...events)
  }

  // 事件按批次序号排(源行顺序已经如此,这里显式钉死,免得日后改读法悄悄变序)。
  for (const record of groups.values()) {
    record.events.sort((a, b) => a.batchSeq - b.batchSeq)
  }
  return [...groups.values()]
}

/** 只接收本工作簿 K 列的明确失败陈述；市专备注、模糊状态和冲突批次不映射。 */
function failedReviewYear(note: string, batch: number, awardYear: number): number | null {
  const match = /^(?:企业注销-|企业停产-|已是大企业-)?(\d{4})年未通过(?:第([一二三四五六七八]|\d+)批)?(?:小巨人)?(?:复核|复评)(?:$|[，；;])/u.exec(note)
  if (!match) return null
  const statedBatch = match[2] == null ? batch : Number(match[2]) || '一二三四五六七八'.indexOf(match[2]) + 1
  const year = Number(match[1])
  return statedBatch === batch && year >= awardYear ? year : null
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
