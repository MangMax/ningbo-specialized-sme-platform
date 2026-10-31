import type { ReceiptRuntimeContext } from '../../server/utils/receipt-runtime-context'
import { Stream } from 'documonster/excel'
import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { once } from 'node:events'
import { finished } from 'node:stream/promises'
import { CURRENT_RULE_VERSION, qualificationDay, prepareCurrentReader, createCurrentQualificationAssessmentReader, QUALIFICATION_ASSESSMENT_VERSION, type CurrentTitle } from './current-qualification'
import { currentCandidateBindings, currentCandidateSqlFor } from './current-candidates'
import { readIdentityKeyVariants } from './current-identity-keys'
import { TITLES } from '../labels'
import { CURRENT_COLUMNS, currentWorkbookValues } from './current-workbook-presentation'
import { appLog, type LogContext } from '../logging'

export class CurrentWorkbookLimitError extends Error {}
function textCell(value: unknown): string | null {
  if (value == null) return null
  const text=String(value)
  if (text.length > 32767) throw new CurrentWorkbookLimitError('Excel 单元格超过32767字符上限，未发布文件；请核对源数据')
  return text
}
export const CURRENT_HEADERS = CURRENT_COLUMNS.map(column => column.header)
const widths = CURRENT_COLUMNS.map(column => column.width)
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
  const startedAt = Date.now()
  let summaryComplete = false, workbookStarted = false
  appLog({ source: 'export', operation: 'export.current.summary', outcome: 'started' }, logContext)
  try {
    // SQLite functions must be registered before a streaming SELECT is active.
    prepareCurrentReader(db)
    db.exec('BEGIN')
    // Enumerate narrow query keys once inside this pinned snapshot. Full T2
    // still reads and verifies every title and source; only coverage lookup changes.
    const queryKeys = readIdentityKeyVariants(db, 'queries')
    const assessmentReader = createCurrentQualificationAssessmentReader(db, receiptRuntime)
    const bindings=currentCandidateBindings(title)
    const currentCandidateSql=currentCandidateSqlFor(db)
    const total = (db.prepare(`select count(*) as n from (${currentCandidateSql})`).get(bindings) as {n:number}).n
    const snapshotStartedAt = new Date().toISOString()
    workbookStarted = true
    appLog({ source: 'export', operation: 'export.current.workbook', outcome: 'started' }, logContext)
    const workbook = new Stream.WorkbookWriter({ stream: output, useStyles: true, useSharedStrings: false, trueStreaming: true })
    const counts = { eligible: 0, pending: 0, excluded: 0 }, hash = createHash('sha256').update(JSON.stringify(['current-export-assessment-409-v2',QUALIFICATION_ASSESSMENT_VERSION,CURRENT_RULE_VERSION,year,title]) + '\n')
    const deferred = { pending: [] as number[], excluded: [] as number[] }
    progress(0,total,snapshotStartedAt)
    // ZIP entries are sequential. Finish each sheet before opening the next,
    // rather than buffering compressed pending/excluded sheets behind eligible.
    // Defer only stable IDs (capped by the existing per-sheet row limit), not
    // cell values/XML. Re-read those IDs within the same pinned transaction.
    for (const [group, name] of [['eligible','有效企业'],['pending','待确认'],['excluded','排除明细']] as const) {
      const sheet = workbook.addWorksheet(name,sheetOptions())
      sheet.columns = widths.map(width => ({width}))
      styledRow(sheet,CURRENT_HEADERS,true)
      let scanned = 0, written = 0
      // Exhaust each bounded SELECT before full T2 opens its nested SAVEPOINT.
      function* candidateIds() {
        let after = -1
        const statement = db.prepare(`select id from (${currentCandidateSql}) where id > @after order by id limit 100`)
        while (true) {
          const batch = statement.all({...bindings,after}) as {id:number}[]
          if (!batch.length) return
          for (const item of batch) yield item.id
          after = batch[batch.length-1]!.id
        }
      }
      const ids = group === 'eligible' ? candidateIds() : deferred[group]
      for (const id of ids) {
        // Count the canonical scan once; defer IDs only, never T2 or cell data.
        const canonicalGroup = group === 'eligible' ? assessmentReader.readTitle(id,title,Date.parse(generatedAt)).group : group
        if (group === 'eligible') {
          if (counts[canonicalGroup] >= 1048575) throw new CurrentWorkbookLimitError('Excel 单表超过1048575条数据上限，未发布文件；请拆分数据范围')
          counts[canonicalGroup]++
          if (canonicalGroup !== 'eligible') deferred[canonicalGroup].push(id)
        }
        if (canonicalGroup === group) {
          const { rows, snapshot, workbookPublished } = assessmentReader.readWorkbook(id,Date.parse(generatedAt),title,queryKeys)
          const row = rows.find(item => item.assessment!.titleCode === title)!
          if (row.assessment!.group !== group) throw new Error('Workbook scan and full assessment group differ')
          // Keep the original row and its non-enumerable workbookFacts.
          const values = currentWorkbookValues(title,row,++written,workbookPublished)
          const { titles: _titles, snapshotId, ...scope } = snapshot
          hash.update(JSON.stringify([group,id,scope,snapshotId,values]) + '\n')
          styledRow(sheet,values)
          await drain()
        }
        if (++scanned % 100 === 0) {
          if (group === 'eligible') progress(scanned,total,snapshotStartedAt)
          await new Promise<void>(resolve => setImmediate(resolve))
          await drain()
        }
      }
      sheet.autoFilter = `A1:${String.fromCharCode(64 + CURRENT_COLUMNS.length)}${written + 1}`
      sheet.commit()
      await drain()
      // The eligible pass evaluates every candidate; deferred sheets reuse that
      // pinned snapshot. No additional query/pass is introduced for logging.
      if (group === 'eligible') {
        summaryComplete = true
        appLog({ source: 'export', operation: 'export.current.summary', outcome: 'success', durationMs: Date.now() - startedAt, counts: { done: total, total } }, logContext)
      }
      if (group !== 'eligible') deferred[group].length = 0
    }
    const dataVersion = 'sha256:' + hash.digest('hex')
    const explanation = workbook.addWorksheet('口径说明')
    explanation.columns = [{width:18},{width:100}]
    for (const [index,row] of [['项目','说明'],['生成时间',generatedAt],['范围',`当前库已识别的${TITLES[title]}企业；未实时采集，不证明全市完整；无法确认的资格、身份或出处列入待确认。`],['有效企业',String(counts.eligible)],['待确认',String(counts.pending)],['排除明细',String(counts.excluded)],['判定说明','认定与复核依正式公布依据；仅有平台记录或迁入事实不自动证明当前资格；三年有效期届满且复核结论不明时列待确认。']].entries()) styledRow(explanation,row,index===0)
    await workbook.commit()
    await completed
    db.exec('COMMIT')
    appLog({ source: 'export', operation: 'export.current.workbook', outcome: 'success', durationMs: Date.now() - startedAt, counts: { done: total, total } }, logContext)
    return { generatedAt, snapshotStartedAt, dataVersion, ruleVersion: CURRENT_RULE_VERSION, counts, total }
  } catch (error) {
    if (!summaryComplete) appLog({ source: 'export', operation: 'export.current.summary', outcome: 'failure', level: 'error', errorCode: 'summary_failed' }, logContext)
    if (workbookStarted) appLog({ source: 'export', operation: 'export.current.workbook', outcome: 'failure', level: 'error', errorCode: error instanceof CurrentWorkbookLimitError ? 'workbook_limit' : 'workbook_failed' }, logContext)
    output.destroy(); await completed.catch(() => {}); if (db.inTransaction) db.exec('ROLLBACK'); throw error
  }
}
