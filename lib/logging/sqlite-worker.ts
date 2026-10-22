/** Runs in a dedicated node Worker. Kept self contained so Nitro's native packaging is relocatable. */
export const SQLITE_WORKER = String.raw`
const { parentPort, workerData } = require('node:worker_threads')
const { mkdirSync, statSync, existsSync, chmodSync, openSync, readSync, closeSync } = require('node:fs')
const { join } = require('node:path')
const Database = require(workerData.sqliteModule)
let db
let policy = workerData.policy
let now = Date.now()
const path = join(workerData.directory, 'events.db')
const fileBytes = () => ['', '-journal', '-wal', '-shm'].reduce((n, suffix) => { try { return n + statSync(path + suffix).size } catch { return n } }, 0)
function open() {
  if (db) return
  mkdirSync(workerData.directory, { recursive: true, mode: 0o700 })
  const existed = existsSync(path)
  if (existed) {
    // Inspect only the fixed header before SQLite can recover a foreign hot journal.
    const fd=openSync(path,'r'), header=Buffer.alloc(100)
    try { if(readSync(fd,header,0,100,0)!==100 || header.readUInt32BE(68)!==1163283527) throw new Error('foreign_database') }
    finally { closeSync(fd) }
  }
  db = new Database(path, { timeout: 100 })
  // Fail closed on an unrelated existing SQLite, including a symlink to a business database.
  const owner = db.pragma('application_id', { simple:true })
  if (existed && owner !== 1163283527) throw new Error('foreign_database')
  // auto_vacuum must precede even application_id: that pragma alone materializes page1.
  if (!existed) { db.pragma('auto_vacuum = FULL'); db.pragma('application_id = 1163283527'); chmodSync(path, 0o600) }
  db.pragma('journal_mode = DELETE')
  db.pragma('auto_vacuum = FULL')
  if(db.pragma('auto_vacuum',{simple:true})!==1) db.exec('VACUUM')
  db.pragma('synchronous = FULL')
  db.exec('CREATE TABLE IF NOT EXISTS log_policy (id INTEGER PRIMARY KEY CHECK(id=1), retentionDays INTEGER NOT NULL, maxBytes INTEGER NOT NULL, pruned INTEGER NOT NULL DEFAULT 0, cleared INTEGER NOT NULL DEFAULT 0)')
  db.prepare('INSERT OR IGNORE INTO log_policy(id,retentionDays,maxBytes) VALUES(1,?,?)').run(policy.retentionDays, policy.maxBytes)
  policy = db.prepare('SELECT retentionDays,maxBytes FROM log_policy WHERE id=1').get()
  db.exec('CREATE TABLE IF NOT EXISTS log_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, timestamp TEXT NOT NULL, level TEXT NOT NULL, source TEXT NOT NULL, operation TEXT NOT NULL, outcome TEXT NOT NULL, requestId TEXT, traceId TEXT, taskId TEXT, fileId INTEGER, batchId TEXT, resourceId TEXT, summary TEXT NOT NULL, detail TEXT NOT NULL)')
  for (const key of ['timestamp','level','source','operation','outcome','requestId','traceId','taskId','fileId','batchId','resourceId']) db.exec('CREATE INDEX IF NOT EXISTS log_' + key + ' ON log_events(' + key + ',seq)')
  cap()
}
function cap() {
  // At most one third for main DB, leaving two thirds for SQLite rollback journal and filesystem bookkeeping.
  db.pragma('max_page_count = ' + Math.max(64, Math.floor(policy.maxBytes / 3 / 4096)))
}
function deleted(where, params, counter) {
  const n = db.transaction(() => {
    const result = db.prepare('DELETE FROM log_events WHERE seq IN (SELECT seq FROM log_events WHERE ' + where + ' ORDER BY seq LIMIT 1000)').run(...params).changes
    if (result) db.prepare('UPDATE log_policy SET ' + counter + '=' + counter + '+? WHERE id=1').run(result)
    return result
  })()
  return n
}
function maintain() {
  deleted('timestamp < ?', [new Date(now - policy.retentionDays * 86400000).toISOString()], 'pruned')
  // A lowered capacity can be smaller than the existing DB. Bound each maintenance call.
  for (let i=0; i<32 && fileBytes() > policy.maxBytes / 3; i++) {
    if (!deleted('1=1', [], 'pruned')) break
  }
  cap()
}
function where(filter) {
  const terms = ['1=1'], params = []
  for (const key of ['level','source','operation','outcome','requestId','traceId','taskId','fileId','batchId','resourceId']) {
    if (filter[key] !== undefined) { terms.push(key + '=?'); params.push(String(filter[key])) }
  }
  if (filter.from) { terms.push('timestamp >= ?'); params.push(filter.from) }
  if (filter.to) { terms.push('timestamp <= ?'); params.push(filter.to) }
  return { sql: terms.join(' AND '), params }
}
function execute(action, data) {
  open()
  policy = db.prepare('SELECT retentionDays,maxBytes FROM log_policy WHERE id=1').get()
  if (action === 'write') {
    maintain()
    const insert = db.prepare('INSERT INTO log_events(id,timestamp,level,source,operation,outcome,requestId,traceId,taskId,fileId,batchId,resourceId,summary,detail) VALUES(@id,@timestamp,@level,@source,@operation,@outcome,@requestId,@traceId,@taskId,@fileId,@batchId,@resourceId,@summary,@detail)')
    const write = db.transaction(() => { for (const event of data) {
      const { counts, errorCode, auditId, receiptId, parentEventId, ...summary } = event
      insert.run({ requestId:null,traceId:null,taskId:null,fileId:null,batchId:null,resourceId:null,...event, batchId:event.batchId===undefined?null:String(event.batchId),resourceId:event.resourceId===undefined?null:String(event.resourceId), summary:JSON.stringify(summary),detail:JSON.stringify(event) })
    } })
    try { write() } catch(error) {
      if (error.code !== 'SQLITE_FULL') throw error
      // Capacity pressure evicts oldest diagnostics, with a persistent pruning receipt.
      deleted('1=1', [], 'pruned'); write()
    }
    return { stored: data.length }
  }
  if (action === 'list') {
    maintain()
    const f = where(data)
    // Cleanup is bounded; expired rows never leak through a larger cleanup backlog.
    f.sql += ' AND timestamp >= ?'; f.params.push(new Date(now-policy.retentionDays*86400000).toISOString())
    if (data.beforeSeq) { f.sql += ' AND seq < ?'; f.params.push(data.beforeSeq) }
    const rows = db.prepare('SELECT seq,summary FROM log_events WHERE ' + f.sql + ' ORDER BY seq DESC LIMIT ?').all(...f.params, data.limit + 1)
    const more = rows.length > data.limit; if (more) rows.pop()
    return { rows: rows.map(r => JSON.parse(r.summary)), nextSeq: more ? rows[rows.length-1].seq : null }
  }
  if (action === 'detail') {
    const row = db.prepare('SELECT detail FROM log_events WHERE id=? AND timestamp>=?').get(data, new Date(now - policy.retentionDays * 86400000).toISOString())
    return row ? JSON.parse(row.detail) : null
  }
  if (action === 'policy') {
    if (data) {
      const previous=policy
      policy=data
      maintain()
      if(fileBytes()>policy.maxBytes/3) {
        // Do not report a new hard cap as active while the physical store still exceeds it.
        policy=previous;cap()
        return { transitionPending:true }
      }
      db.prepare('UPDATE log_policy SET retentionDays=?,maxBytes=? WHERE id=1').run(data.retentionDays,data.maxBytes)
      policy = data
    }
    maintain()
    return { ...policy, storageBytes:fileBytes(), ...db.prepare('SELECT pruned,cleared FROM log_policy WHERE id=1').get(), accounting:'events.db + SQLite journal/WAL/SHM; main database <= one third budget; excludes filesystem allocation and container stdout' }
  }
  if (action === 'clear') {
    const f = where(data)
    const n = deleted(f.sql,f.params,'cleared')
    return { deleted:n, hasMore:!!db.prepare('SELECT 1 FROM log_events WHERE ' + f.sql + ' LIMIT 1').get(...f.params) }
  }
  if (action === 'maintain') { maintain(); return null }
  if (action === 'close') { db.close(); db=undefined; return null }
  throw new Error('unsupported')
}
parentPort.on('message', ({id,action,data,time}) => {
  now=time
  try { parentPort.postMessage({ id, ok:true, result:execute(action,data) }) }
  catch(error) {
    const code = error && error.code === 'SQLITE_FULL' ? 'storage_full' : error && String(error.code).startsWith('SQLITE_READONLY') ? 'storage_readonly' : 'storage_unavailable'
    // No raw error/message/path sent to parent or stderr.
    parentPort.postMessage({id,ok:false,code})
    try { db?.close() } catch {}
    db=undefined
  }
})
`
