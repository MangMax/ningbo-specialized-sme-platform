import type { ReceiptRuntimeContext } from '../../server/utils/receipt-runtime-context'
import { Stream } from 'documonster/excel'
import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { createWriteStream, createReadStream, mkdtempSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { finished } from 'node:stream/promises'
import { CURRENT_RULE_VERSION, qualificationDay, prepareCurrentReader, QUALIFICATION_ASSESSMENT_VERSION, type CurrentTitle } from './current-qualification'
import { TITLES } from '../labels'
import { CURRENT_STATUS_LABELS, type CurrentStatus } from './current-status'
import { CURRENT_COLUMNS, currentWorkbookValues } from './current-workbook-presentation'
import { appLog, type LogContext } from '../logging'
import { currentCandidateIdBlocks, type CurrentCandidateReader } from './current-candidate-reader'
import { createCurrentTargetContext } from './current-target-context'

export class CurrentWorkbookLimitError extends Error {}
function textCell(value: unknown): string | null {
  if (value == null) return null
  const text=String(value)
  if (text.length > 32767) throw new CurrentWorkbookLimitError('Excel 单元格超过32767字符上限，未发布文件；请核对源数据')
  return text
}
export const CURRENT_HEADERS = [...CURRENT_COLUMNS.map(column => column.header), '有效状态', '有效期及排除依据', '资料缺口与来源备注']
const widths = [...CURRENT_COLUMNS.map(column => column.width), 18, 45, 45]
function rowHeight(values: (string | null)[]) {
  const lines = Math.max(1,...values.map((value,index) => String(value ?? '').split('\n').reduce((sum,line) => sum + Math.max(1,Math.ceil([...line].reduce((length,char) => length + (char.codePointAt(0)! > 255 ? 2 : 1),0) / (widths[index]! - 2))),0)))
  const height = Math.max(26,lines * 17 + 8)
  if (height > 409) throw new CurrentWorkbookLimitError('Excel 行高不足以完整展示长文本，未发布文件；请核对源数据')
  return height
}
function styledRow(sheet: Stream.WorksheetWriter, values: (string | null)[], header = false) {
  const record = sheet.addRow(values.map(textCell))
  record.height = header ? 34 : rowHeight(values)
  Stream.setRowFont(record,{name:'Arial Unicode MS',size:11,bold:header,color:{argb:header?'FFFFFFFF':'FF243247'}})
  Stream.setRowAlignment(record,{vertical:'top',wrapText:true})
  if (header) Stream.setRowFill(record,{type:'pattern',pattern:'solid',fgColor:{argb:'FF204A68'}})
  for (let index=1;index<=values.length;index++) Stream.setCellBorder(Stream.rowCell(record,index),{bottom:{style:'hair',color:{argb:'FFDCE5EB'}}})
  Stream.commitRow(record)
}
function sheetOptions() {
  return {views:[{state:'frozen' as const,xSplit:2,ySplit:1,topLeftCell:'C2',zoomScale:90}]}
}
/** Streaming rows in one pinned SQLite read transaction, owned by the independent executor. */
export async function writeCurrentWorkbook(db: Database.Database, title: CurrentTitle, filename: string, progress: (done: number,total: number,snapshotStartedAt: string) => void, logContext?: LogContext, receiptRuntime?: ReceiptRuntimeContext) {
  return writeCurrentWorkbookBody(db, title, filename, progress, undefined, logContext, receiptRuntime)
}
/** Explicit R4 dependency seam; target qualification and coverage remain R5/X1. */
export async function writeCurrentWorkbookWithCandidates(db: Database.Database, title: CurrentTitle, filename: string, progress: (done: number,total: number,snapshotStartedAt: string) => void, candidateReader: CurrentCandidateReader, logContext?: LogContext, receiptRuntime?: ReceiptRuntimeContext) {
  if(candidateReader.connection!==db)throw new Error('Candidate reader must use the caller connection')
  return writeCurrentWorkbookBody(db, title, filename, progress, candidateReader, logContext, receiptRuntime)
}
async function writeCurrentWorkbookBody(db: Database.Database, title: CurrentTitle, filename: string, progress: (done: number,total: number,snapshotStartedAt: string) => void, candidateReader: CurrentCandidateReader | undefined, logContext?: LogContext, receiptRuntime?: ReceiptRuntimeContext) {
  const generatedAt = new Date().toISOString(), year = Number(qualificationDay(Date.parse(generatedAt)).slice(0,4))
  const output = createWriteStream(filename)
  const completed = finished(output, { cleanup: true })
  // Observe early open/write failures even before the final workbook commit.
  void completed.catch(() => {})
  async function drain() {
    if (output.errored) throw output.errored
    if (output.writableNeedDrain) {
      const controller = new AbortController()
      try { await Promise.race([once(output, 'drain', { signal: controller.signal }), completed]) }
      finally { controller.abort() }
    }
    if (output.errored) throw output.errored
    if (output.destroyed && !output.writableFinished) await completed
  }
  const overflowDir = mkdtempSync(join(tmpdir(), 'current-export-full-text-'))
  const overflowFile = join(overflowDir, 'rows.jsonl')
  let overflowCount = 0
  function overflowValues(values: (string | null)[], sheet: string, row: number) {
    return values.map((value, index) => {
      textCell(value) // Preserve the existing cell-size guard before changing layout.
      const isolated = Array<string | null>(widths.length).fill(null)
      isolated[index] = value
      try { rowHeight(isolated); return value } catch (error) {
        if (!(error instanceof CurrentWorkbookLimitError)) throw error
      }
      const address = `${String.fromCharCode(65 + index)}${row}`
      let chunk = '', part = 0
      function save() {
        if (++overflowCount > 1048575) throw new CurrentWorkbookLimitError('Excel 全文附表超过行数上限，未发布文件')
        appendFileSync(overflowFile, JSON.stringify([sheet,address,String(++part),null,null,null,null,null,null,null,null,chunk]) + '\n')
      }
      for (const char of value ?? '') {
        const probe = Array<string | null>(widths.length).fill(null)
        probe[11] = chunk + char
        try { rowHeight(probe) } catch (error) {
          if (!(error instanceof CurrentWorkbookLimitError)) throw error
          save(); chunk = ''
        }
        chunk += char
      }
      if (chunk) save()
      return `全文见「长文本全文」：${sheet}!${address}`
    })
  }
  const startedAt = Date.now()
  let summaryComplete = false, workbookStarted = false, ownedTransaction = false
  appLog({ source: 'export', operation: 'export.current.summary', outcome: 'started' }, logContext)
  try {
    // SQLite functions must be registered before a streaming SELECT is active.
    prepareCurrentReader(db)
    db.exec('BEGIN')
    ownedTransaction = true
    // Enumerate narrow query keys once inside this pinned snapshot. The export
    // evaluates its title and actual inheritance dependency in bounded blocks.
    const target = createCurrentTargetContext(db, receiptRuntime)
    const candidates = candidateReader ?? target.candidates
    const queryKeys = target.keys.queries
    const assessmentReader = target.assessment
    // Exhaust this one ordered SELECT before full assessments open SAVEPOINTs.
    // Five sheets can hold at most 5 * 1048575 IDs: Float64 chunks cap this
    // narrow projection at 40MiB, without a workbook-sized array of row objects.
    // Consume/release chunks during the canonical pass; deferred IDs keep the
    // existing per-sheet bounds. No temporary ID file survives worker cancellation.
    const candidateChunks: Float64Array[] = []
    let total = 0
    for (const { id } of candidates.iterate(title)) {
      if (total >= 5 * 1048575) throw new CurrentWorkbookLimitError('Excel 五个状态表超过总行数上限，未发布文件；请拆分数据范围')
      const offset = total % 4096
      if (offset === 0) candidateChunks.push(new Float64Array(4096))
      candidateChunks[candidateChunks.length - 1]![offset] = id
      if (++total % 100 === 0) {
        await new Promise<void>(resolve => setImmediate(resolve))
        await drain()
      }
    }
    const snapshotStartedAt = new Date().toISOString()
    workbookStarted = true
    appLog({ source: 'export', operation: 'export.current.workbook', outcome: 'started' }, logContext)
    const workbook = new Stream.WorkbookWriter({ stream: output, useStyles: true, useSharedStrings: false, trueStreaming: true })
    const counts = { eligible: 0, pending: 0, excluded: 0 }, hash = createHash('sha256').update(JSON.stringify([candidateReader === undefined ? 'current-export-assessment-title-v3' : 'current-export-assessment-409-v2',QUALIFICATION_ASSESSMENT_VERSION,CURRENT_RULE_VERSION,year,title]) + '\n')
    const statusCounts = { effective: 0, expired: 0, terminated: 0, moved_out: 0, unrecognized: 0 }
    const deferred: Record<CurrentStatus, number[]> = { effective: [], expired: [], terminated: [], moved_out: [], unrecognized: [] }
    progress(0,total,snapshotStartedAt)
    // ZIP entries are sequential. Finish each sheet before opening the next,
    // rather than buffering compressed pending/excluded sheets behind eligible.
    // Defer only stable IDs (capped by the existing per-sheet row limit), not
    // cell values/XML. Re-read those IDs within the same pinned transaction.
    for (const [group, name] of Object.entries(CURRENT_STATUS_LABELS) as [CurrentStatus, string][]) {
      const sheet = workbook.addWorksheet(name,sheetOptions())
      sheet.columns = widths.map(width => ({width}))
      styledRow(sheet,CURRENT_HEADERS,true)
      let scanned = 0, written = 0
      // Reuse only stable ordered IDs; full evidence is still read in this transaction.
      function* candidateIds() {
        let remaining = total
        while (candidateChunks.length) {
          const chunk = candidateChunks.shift()!
          for (const id of chunk) {
            if (remaining-- === 0) return
            yield id
          }
        }
      }
      const ids = group === 'effective' ? candidateIds() : deferred[group]
      for (const block of currentCandidateIdBlocks(ids)) {
        const classifications = group === 'effective' ? candidateReader === undefined
          ? assessmentReader.readEffectiveTitles(block, Date.parse(generatedAt), title)
          : new Map(block.map(id => [id, assessmentReader.readEffectiveTitle(id,title,Date.parse(generatedAt)).effectiveStatus]))
          : new Map(block.map(id => [id, group]))
        const admitted = block.filter(id => classifications.get(id) === group)
        const prepared = candidateReader === undefined ? assessmentReader.readWorkbookRowsBatch(admitted, Date.parse(generatedAt), title, queryKeys)
          : admitted.map(id => assessmentReader.readWorkbook(id,Date.parse(generatedAt),title,queryKeys))
        const workbookReads = new Map(admitted.map((id, index) => [id, prepared[index]!]))
        for (const id of block) {
          // Count the canonical scan once; defer IDs only, never T2 or cell data.
          // Classification needs eligibility only. The written row below still
          // reads its title assessment (including the giant dependency) and checks status.
          const canonicalGroup = classifications.get(id)!
          if (group === 'effective') {
            if (statusCounts[canonicalGroup] >= 1048575) throw new CurrentWorkbookLimitError('Excel 单表超过1048575条数据上限，未发布文件；请拆分数据范围')
            statusCounts[canonicalGroup]++
            if (canonicalGroup !== 'effective') deferred[canonicalGroup].push(id)
          }
          if (canonicalGroup === group) {
            const { rows, snapshot, workbookPublished } = workbookReads.get(id)!
            const row = rows.find(item => item.assessment!.titleCode === title)!
            if (row.assessment!.effectiveQualification?.status !== group) throw new Error('Workbook scan and full assessment group differ')
            // Keep the original row and its non-enumerable workbookFacts.
            const effective = row.assessment!.effectiveQualification!
            const values = [...currentWorkbookValues(title,row,++written,workbookPublished), name, (effective.presentationBasis ?? []).join('；'), effective.notes.join('；')]
            const { titles: _titles, snapshotId, ...scope } = snapshot
            hash.update(JSON.stringify([group,id,scope,snapshotId,values]) + '\n')
            styledRow(sheet,overflowValues(values,name,written + 1))
            await drain()
          }
          if (++scanned % 100 === 0) {
            if (group === 'effective') progress(scanned,total,snapshotStartedAt)
            await new Promise<void>(resolve => setImmediate(resolve))
            await drain()
          }
        }
      }
      sheet.autoFilter = `A1:${String.fromCharCode(64 + CURRENT_HEADERS.length)}${written + 1}`
      sheet.commit()
      await drain()
      // The eligible pass evaluates every candidate; deferred sheets reuse that
      // pinned snapshot. No additional query/pass is introduced for logging.
      if (group === 'effective') {
        summaryComplete = true
        appLog({ source: 'export', operation: 'export.current.summary', outcome: 'success', durationMs: Date.now() - startedAt, counts: { done: total, total } }, logContext)
      }
      if (group !== 'effective') deferred[group].length = 0
    }
    if (overflowCount) {
      const appendix = workbook.addWorksheet('长文本全文',sheetOptions())
      appendix.columns = widths.map(width => ({width}))
      styledRow(appendix,['业务表','原单元格','分段序号',null,null,null,null,null,null,null,null,'全文（按分段序号直接拼接）'],true)
      const lines = createInterface({input:createReadStream(overflowFile),crlfDelay:Infinity})
      for await (const line of lines) {
        styledRow(appendix,JSON.parse(line) as (string | null)[])
        await drain()
      }
      appendix.commit()
      await drain()
    }
    const dataVersion = 'sha256:' + hash.digest('hex')
    const explanation = workbook.addWorksheet('口径说明')
    explanation.columns = [{width:18},{width:100}]
    counts.eligible = statusCounts.effective
    counts.excluded = total - counts.eligible
    for (const [index,row] of [['项目','说明'],['生成时间',generatedAt],['范围',`当前库已识别的${TITLES[title]}企业；未实时采集，不证明全市完整。`],...Object.entries(CURRENT_STATUS_LABELS).map(([status,label]) => [label,String(statusCounts[status as CurrentStatus])]),['判定说明','复用正式资格期间与完整注销/吊销、迁出事实；资料缺口与来源仅备注。到期无复核不在有效。']].entries()) styledRow(explanation,row,index===0)
    await workbook.commit()
    await completed
    db.exec('COMMIT')
    ownedTransaction = false
    appLog({ source: 'export', operation: 'export.current.workbook', outcome: 'success', durationMs: Date.now() - startedAt, counts: { done: total, total } }, logContext)
    return { generatedAt, snapshotStartedAt, dataVersion, ruleVersion: CURRENT_RULE_VERSION, counts, statusCounts, total }
  } catch (error) {
    if (!summaryComplete) appLog({ source: 'export', operation: 'export.current.summary', outcome: 'failure', level: 'error', errorCode: 'summary_failed' }, logContext)
    if (workbookStarted) appLog({ source: 'export', operation: 'export.current.workbook', outcome: 'failure', level: 'error', errorCode: error instanceof CurrentWorkbookLimitError ? 'workbook_limit' : 'workbook_failed' }, logContext)
    output.destroy(); await completed.catch(() => {}); if (ownedTransaction && db.inTransaction) db.exec('ROLLBACK'); throw error
  } finally {
    rmSync(overflowDir,{recursive:true,force:true})
  }
}
