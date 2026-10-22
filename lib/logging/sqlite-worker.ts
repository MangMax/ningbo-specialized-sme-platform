import { boundedLogOutput } from './output'
import { collectionAllows, defaultLogCollection } from './policy'
/** Runs in a dedicated node Worker. Kept self contained so Nitro's native packaging is relocatable. */
export const SQLITE_WORKER = String.raw`
const { parentPort, workerData } = require('node:worker_threads')
const { mkdirSync, statSync, existsSync, chmodSync, openSync, readSync, closeSync } = require('node:fs')
const { join } = require('node:path')
const Database = require(workerData.sqliteModule)
const initialCollection = ${JSON.stringify(defaultLogCollection())}
const collectionAllows = ${collectionAllows.toString()}
const boundedLogOutput = ${boundedLogOutput.toString()}
const stdout = workerData.stdout ? boundedLogOutput(process.stdout, workerData.maxEventBytes + 1) : undefined
const failureCode = error => error && error.code === 'SQLITE_FULL' ? 'storage_full' : error && String(error.code).startsWith('SQLITE_READONLY') ? 'storage_readonly' : 'storage_unavailable'
function readPolicy() {
  const storage = db.prepare('SELECT retentionDays,maxBytes FROM log_policy WHERE id=1').get()
  const row = db.prepare('SELECT collection,revision FROM log_collection WHERE id=1').get()
  const stored = JSON.parse(row.collection)
  const object = value => value && typeof value === 'object' && !Array.isArray(value)
  if (!object(stored) || !object(stored.sources) || !object(stored.integrations)) throw new Error('invalid_log_policy')
  for (const dimension of ['sources','integrations']) for (const rule of Object.values(stored[dimension])) {
    if (!object(rule) || typeof rule.enabled !== 'boolean' || !['debug','info','warn','error'].includes(rule.minLevel)) throw new Error('invalid_log_policy')
  }
  if (Object.keys(initialCollection.sources).some(key => !Object.hasOwn(stored.sources,key))) throw new Error('invalid_log_policy')
  // A collector added by a newer build receives the documented default rule.
  // Existing choices win, and a read alone never changes the saved revision.
  const collection = {sources:stored.sources, integrations:{...initialCollection.integrations,...stored.integrations}}
  return {...storage, collection, revision:row.revision}
}
let db
let initialized = false
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
  db.exec('CREATE TABLE IF NOT EXISTS log_collection (id INTEGER PRIMARY KEY CHECK(id=1), collection TEXT NOT NULL, revision INTEGER NOT NULL)')
  db.prepare('INSERT OR IGNORE INTO log_collection(id,collection,revision) VALUES(1,?,0)').run(JSON.stringify(initialCollection))
  policy = readPolicy()
  db.exec('CREATE TABLE IF NOT EXISTS log_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, timestamp TEXT NOT NULL, level TEXT NOT NULL, source TEXT NOT NULL, operation TEXT NOT NULL, outcome TEXT NOT NULL, requestId TEXT, traceId TEXT, taskId TEXT, fileId INTEGER, batchId TEXT, resourceId TEXT, summary TEXT NOT NULL, detail TEXT NOT NULL)')
  for (const key of ['timestamp','level','source','operation','outcome','requestId','traceId','taskId','fileId','batchId','resourceId']) db.exec('CREATE INDEX IF NOT EXISTS log_' + key + ' ON log_events(' + key + ',seq)')
  cap()
  initialized = true
}
function reusableAfterBusy(error) {
  // Only completed initialization and an idle, responsive connection qualify.
  // Transaction wrappers must already have rolled back/released their snapshot.
  if (!['SQLITE_BUSY','SQLITE_BUSY_RECOVERY','SQLITE_BUSY_SNAPSHOT','SQLITE_BUSY_TIMEOUT'].includes(error?.code)
    || !initialized || !db?.open || db.inTransaction) return false
  try { db.prepare('SELECT 1').get(); return true } catch { return false }
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
  if (action === 'policy' && !data) {
    // A deferred read transaction pins all database fields to one committed
    // snapshot, without maintenance or reserving the single SQLite writer.
    const snapshot = db.transaction(() => {
      policy = readPolicy()
      return {...policy,...db.prepare('SELECT pruned,cleared FROM log_policy WHERE id=1').get()}
    })()
    // Filesystem bytes are an observation, not a physical snapshot synchronized
    // with the database fields (another writer may change files at any time).
    return {...snapshot,storageBytes:fileBytes(),accounting:'events.db + SQLite journal/WAL/SHM; main database <= one third budget; excludes filesystem allocation and container stdout'}
  }
  policy = readPolicy()
  if (action === 'write') {
    // Same lock as management writes: no stale process-local rule can authorize output.
    // Keep physical auto-vacuum/pruning commits independent, as in the original
    // store. The later locked decision re-reads policy after this maintenance.
    try { maintain() } catch {}
    const writeBatch = retry => db.transaction(() => {
      policy = readPolicy()
      let allowed = data.filter(event => collectionAllows(event, policy.collection))
      const result = {stored:0, filtered:data.length-allowed.length, fallbackSkipped:0}
      if (!allowed.length) return result
      try {
        cap()
        const insert = db.prepare('INSERT INTO log_events(id,timestamp,level,source,operation,outcome,requestId,traceId,taskId,fileId,batchId,resourceId,summary,detail) VALUES(@id,@timestamp,@level,@source,@operation,@outcome,@requestId,@traceId,@taskId,@fileId,@batchId,@resourceId,@summary,@detail)')
        const write = db.transaction(() => { for (const event of allowed) {
          const { auditId, receiptId, parentEventId, ...summary } = event
          insert.run({requestId:null,traceId:null,taskId:null,fileId:null,batchId:null,resourceId:null,...event,batchId:event.batchId===undefined?null:String(event.batchId),resourceId:event.resourceId===undefined?null:String(event.resourceId),summary:JSON.stringify(summary),detail:JSON.stringify(event)})
        } })
        write()
        result.stored = allowed.length
      } catch(error) {
        if (error.code === 'SQLITE_FULL' && !retry) throw error
        result.code = failureCode(error)
        // SQLITE_FULL/IOERR (or a ROLLBACK trigger) may release the outer
        // transaction. Never output a decision whose lock has been lost:
        // reacquire and authorize again against the latest committed policy.
        if (!db.inTransaction) {
          db.exec('BEGIN IMMEDIATE')
          policy = readPolicy()
          allowed = data.filter(event => collectionAllows(event, policy.collection))
          result.filtered = data.length - allowed.length
        }
      }
      // Storage failures do not expose raw events. Only this authorized projection
      // can reach stdout; backpressure/rate failures remain bounded and isolated.
      if (stdout) for (const event of allowed) if (!stdout.write(JSON.stringify(event)+'\n')) result.fallbackSkipped++
      return result
    }).immediate()
    try { return writeBatch(false) } catch(error) {
      if (error.code !== 'SQLITE_FULL') throw error
      // Rollback first, then prune with a physical commit before retrying.
      deleted('1=1', [], 'pruned')
      return writeBatch(true)
    }
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
    // Capacity pruning must commit before measuring physical bytes. It can
    // delete diagnostics on a rejected shrink, but never activates new rules.
    if (data) {
      policy = {...policy,retentionDays:data.retentionDays,maxBytes:data.maxBytes}
      try { maintain() } finally { policy = readPolicy(); cap() }
    }
    return db.transaction(() => {
      policy = readPolicy()
      if (data) {
        if(fileBytes()>data.maxBytes/3) return {transitionPending:true}
        const collection = {
          sources:{...policy.collection.sources,...data.collection?.sources},
          integrations:{...policy.collection.integrations,...data.collection?.integrations},
        }
        db.prepare('UPDATE log_policy SET retentionDays=?,maxBytes=? WHERE id=1').run(data.retentionDays,data.maxBytes)
        db.prepare('UPDATE log_collection SET collection=?,revision=revision+1 WHERE id=1').run(JSON.stringify(collection))
        policy = readPolicy()
        cap()
      }
      return {...policy,storageBytes:fileBytes(),...db.prepare('SELECT pruned,cleared FROM log_policy WHERE id=1').get(),accounting:'events.db + SQLite journal/WAL/SHM; main database <= one third budget; excludes filesystem allocation and container stdout'}
    }).immediate()
  }
  if (action === 'clear') {
    const f = where(data)
    const n = deleted(f.sql,f.params,'cleared')
    return { deleted:n, hasMore:!!db.prepare('SELECT 1 FROM log_events WHERE ' + f.sql + ' LIMIT 1').get(...f.params) }
  }
  if (action === 'maintain') { maintain(); return null }
  if (action === 'close') { db.close(); db=undefined; initialized=false; stdout?.close(); return null }
  throw new Error('unsupported')
}
parentPort.on('message', ({id,action,data,time}) => {
  now=time
  try { parentPort.postMessage({ id, ok:true, result:execute(action,data) }) }
  catch(error) {
    const code = failureCode(error)
    // No raw error/message/path sent to parent or stderr.
    parentPort.postMessage({id,ok:false,code})
    if (!reusableAfterBusy(error)) {
      try { db?.close() } catch {}
      db=undefined
      initialized=false
    }
  }
})
`
