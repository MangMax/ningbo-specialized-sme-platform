import { Stream } from 'documonster/excel'
import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { once } from 'node:events'
import type { Writable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { CURRENT_RULE_VERSION, prepareCurrentReader, readCurrentCandidate, type CurrentTitle } from './current-qualification'
import { relationScopeSql, TITLE_RDJB_CODES } from './current-platform-scope'
import { TITLES } from '../labels'
import { readIdentityKeyVariants } from './current-identity-keys'

export class CurrentWorkbookLimitError extends Error {}
function textCell(value: unknown): string | null {
  if (value == null) return null
  const text=String(value)
  if (text.length > 32767) throw new CurrentWorkbookLimitError('Excel 单元格超过32767字符上限，未发布文件；请核对源数据')
  return text
}
export const CURRENT_HEADERS = ['序号','稳定企业标识','统一社会信用代码','现名','公布名','已确认曾用名','宁波区县','称号','首次认定','最近授予/延续资格依据','复核情况','公布对应情况','备注','可核对依据']
/** Streaming rows in one pinned SQLite read transaction, owned by the independent executor. */
export async function writeCurrentWorkbook(db: Database.Database, title: CurrentTitle, destination: string | Writable, progress: (done: number,total: number,snapshotStartedAt: string) => void) {
  const generatedAt = new Date().toISOString(), year = new Date(generatedAt).getFullYear()
  // SQLite functions must be registered before a streaming SELECT is active.
  prepareCurrentReader(db)
  db.exec('BEGIN')
  const output = typeof destination === 'string' ? createWriteStream(destination) : destination
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
    const keys={queries:readIdentityKeyVariants(db,'queries'),relations:readIdentityKeyVariants(db,'unassignedRelations')}
    const predicate = `with owners as materialized (select id,roster84_uscc(uscc_norm) as uscc from enterprise where uscc_norm is not null)
      select enterprise_id as id from record where title_code=@title
      union select enterprise_id as id from difference_reason where title_code=@title
      union select enterprise_id as id from record_correspondence where title_code=@title and enterprise_id is not null
      union select coalesce(r.enterprise_id,e.id) as id from platform_relation r join platform_query q on q.id=r.query_id
        left join owners e on r.enterprise_id is null and e.uscc=roster84_uscc(r.uscc_raw)
        where coalesce(r.enterprise_id,e.id) is not null and ${relationScopeSql}`
    const bindings={title,rdjb:TITLE_RDJB_CODES[title]}
    const total = (db.prepare(`select count(*) as n from (${predicate})`).get(bindings) as {n:number}).n
    const snapshotStartedAt = new Date().toISOString()
    const workbook = new Stream.WorkbookWriter({ stream: output, useStyles: false, useSharedStrings: false, trueStreaming: true })
    const counts = { eligible: 0, pending: 0, excluded: 0 }, hash = createHash('sha256').update(CURRENT_RULE_VERSION + ':' + year)
    const deferred = { pending: [] as number[], excluded: [] as number[] }
    progress(0,total,snapshotStartedAt)
    // ZIP entries are sequential. Finish each sheet before opening the next,
    // rather than buffering compressed pending/excluded sheets behind eligible.
    // Defer only stable IDs (capped by the existing per-sheet row limit), not
    // cell values/XML. Re-read those IDs within the same pinned transaction.
    for (const [group, name] of [['eligible','有效企业'],['pending','待确认'],['excluded','排除明细']] as const) {
      const sheet = workbook.addWorksheet(name)
      Stream.commitRow(sheet.addRow(CURRENT_HEADERS))
      let scanned = 0, written = 0
      const ids = group === 'eligible' ? db.prepare(`select id from (${predicate}) order by id`).iterate(bindings) as Iterable<{id:number}> : deferred[group]
      for (const candidate of ids) {
        const id = typeof candidate === 'number' ? candidate : candidate.id
        const row = readCurrentCandidate(db,id,title,year,Date.parse(generatedAt),keys)
        if (group === 'eligible') {
          hash.update(JSON.stringify(row))
          if (counts[row.group] >= 1048575) throw new CurrentWorkbookLimitError('Excel 单表超过1048575条数据上限，未发布文件；请拆分数据范围')
          counts[row.group]++
          if (row.group !== 'eligible') deferred[row.group].push(id)
        }
        if (row.group === group) {
          // Every cell is a string/blank: no formula objects or numeric credit codes.
          const values = [String(++written),String(id),row.uscc,row.name,row.publishedNames.join('\n'),row.aliases.join('\n'),row.district,TITLES[title],row.firstYear == null ? null : String(row.firstYear),row.basis,row.reviews,row.publication,row.notes.join('；'),row.references.join('\n')]
          Stream.commitRow(sheet.addRow(values.map(textCell)))
          await drain()
        }
        if (++scanned % 100 === 0) {
          if (group === 'eligible') progress(scanned,total,snapshotStartedAt)
          await new Promise<void>(resolve => setImmediate(resolve))
          await drain()
        }
      }
      sheet.commit()
      await drain()
      if (group !== 'eligible') deferred[group].length = 0
    }
    const dataVersion = 'sha256:' + hash.digest('hex')
    const explanation = workbook.addWorksheet('口径说明')
    for (const row of [['项目','说明'],['规则版本',CURRENT_RULE_VERSION],['生成时间',generatedAt],['数据版本',dataVersion],['快照边界','执行开始时读取事务；排队时间不代表数据时点'],['范围','当前库已识别的本称号企业；未实时采集，不证明全市完整；解释适用性复用#108，未知或已变化列待确认'],['有效企业',String(counts.eligible)],['待确认',String(counts.pending)],['排除明细',String(counts.excluded)]]) Stream.commitRow(explanation.addRow(row))
    await workbook.commit()
    await completed
    db.exec('COMMIT')
    return { generatedAt, snapshotStartedAt, dataVersion, ruleVersion: CURRENT_RULE_VERSION, counts, total }
  } catch (error) { output.destroy(); await completed.catch(() => {}); if (db.inTransaction) db.exec('ROLLBACK'); throw error }
}
