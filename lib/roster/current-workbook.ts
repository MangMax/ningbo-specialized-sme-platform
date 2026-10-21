import { Stream } from 'documonster/excel'
import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { once } from 'node:events'
import { finished } from 'node:stream/promises'
import { CURRENT_RULE_VERSION, prepareCurrentReader, createCurrentCandidateReader, type CurrentTitle } from './current-qualification'
import { currentCandidateBindings, currentCandidateSql } from './current-candidates'
import { TITLES } from '../labels'
import { readIdentityKeyVariants } from './current-identity-keys'
import { CURRENT_COLUMNS, currentWorkbookValues } from './current-workbook-presentation'

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
  return {views:[{state:'frozen' as const,xSplit:2,ySplit:1,topLeftCell:'C2',zoomScale:90}],pageSetup:{paperSize:66,orientation:'landscape',fitToPage:true,fitToWidth:1,fitToHeight:0,printTitlesRow:'1:1'}}
}
/** Streaming rows in one pinned SQLite read transaction, owned by the independent executor. */
export async function writeCurrentWorkbook(db: Database.Database, title: CurrentTitle, filename: string, progress: (done: number,total: number,snapshotStartedAt: string) => void) {
  const generatedAt = new Date().toISOString(), year = new Date(generatedAt).getFullYear()
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
  try {
    // SQLite functions must be registered before a streaming SELECT is active.
    prepareCurrentReader(db)
    db.exec('BEGIN')
    const readCandidate = createCurrentCandidateReader(db)
    const keys={queries:readIdentityKeyVariants(db,'queries'),relations:readIdentityKeyVariants(db,'unassignedRelations')}
    const bindings=currentCandidateBindings(title)
    const total = (db.prepare(`select count(*) as n from (${currentCandidateSql})`).get(bindings) as {n:number}).n
    const snapshotStartedAt = new Date().toISOString()
    const workbook = new Stream.WorkbookWriter({ stream: output, useStyles: true, useSharedStrings: false, trueStreaming: true })
    const counts = { eligible: 0, pending: 0, excluded: 0 }, hash = createHash('sha256').update(CURRENT_RULE_VERSION + ':' + year)
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
      const ids = group === 'eligible' ? db.prepare(`select id from (${currentCandidateSql}) order by id`).iterate(bindings) as Iterable<{id:number}> : deferred[group]
      for (const candidate of ids) {
        const id = typeof candidate === 'number' ? candidate : candidate.id
        const row = readCandidate(id,title,year,Date.parse(generatedAt),keys)
        if (group === 'eligible') {
          hash.update(JSON.stringify(row))
          if (counts[row.group] >= 1048575) throw new CurrentWorkbookLimitError('Excel 单表超过1048575条数据上限，未发布文件；请拆分数据范围')
          counts[row.group]++
          if (row.group !== 'eligible') deferred[row.group].push(id)
        }
        if (row.group === group) {
          // Every cell is a string/blank: no formula objects or numeric credit codes.
          const values = currentWorkbookValues(title,row,++written)
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
      if (group !== 'eligible') deferred[group].length = 0
    }
    const dataVersion = 'sha256:' + hash.digest('hex')
    const explanation = workbook.addWorksheet('口径说明',{pageSetup:{orientation:'landscape',fitToPage:true,fitToWidth:1,fitToHeight:0,printTitlesRow:'1:1'}})
    explanation.columns = [{width:18},{width:100}]
    for (const [index,row] of [['项目','说明'],['生成时间',generatedAt],['范围',`当前库已识别的${TITLES[title]}企业；未实时采集，不证明全市完整；无法确认的资格、身份或出处列入待确认。`],['有效企业',String(counts.eligible)],['待确认',String(counts.pending)],['排除明细',String(counts.excluded)],['判定说明','认定与复核依正式公布依据；仅有平台记录或迁入事实不自动证明当前资格；三年有效期届满且复核结论不明时列待确认。']].entries()) styledRow(explanation,row,index===0)
    await workbook.commit()
    await completed
    db.exec('COMMIT')
    return { generatedAt, snapshotStartedAt, dataVersion, ruleVersion: CURRENT_RULE_VERSION, counts, total }
  } catch (error) { output.destroy(); await completed.catch(() => {}); if (db.inTransaction) db.exec('ROLLBACK'); throw error }
}
