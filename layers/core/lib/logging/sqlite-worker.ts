import { boundedLogOutput } from './output'
import { LOG_LEVELS, LOG_SOURCES, LOG_SUPPORTED_INTEGRATIONS, UNLABELED_LOG_MODULE } from './contract'
import { LOG_FIELD_PROFILES, defaultFieldControls, validateFieldControlsPatch, validateCompleteFieldControls, mergeFieldControls, projectLogFields } from './field-controls'
import { collectionAllowsAtLevels, defaultLogCollection, validateCollectionWithCatalog, decodeStoredLogCollection } from './policy'
/** Runs in a dedicated node Worker. Kept self contained so Nitro's native packaging is relocatable. */
export const SQLITE_WORKER = String.raw`
const { parentPort, workerData } = require('node:worker_threads')
const { mkdirSync, statSync, existsSync, chmodSync, openSync, readSync, closeSync } = require('node:fs')
const { join } = require('node:path')
const Database = require(workerData.sqliteModule)
const LOG_LEVELS = ${JSON.stringify(LOG_LEVELS)}
const LOG_SOURCES = ${JSON.stringify(LOG_SOURCES)}
const LOG_SUPPORTED_INTEGRATIONS = ${JSON.stringify(LOG_SUPPORTED_INTEGRATIONS)}
const UNLABELED_LOG_MODULE = ${JSON.stringify(UNLABELED_LOG_MODULE)}
const profiles = ${JSON.stringify(LOG_FIELD_PROFILES)}
const defaultFieldControls = ${defaultFieldControls.toString()}
const validateFieldControlsPatch = ${validateFieldControlsPatch.toString()}
const validateCompleteFieldControls = ${validateCompleteFieldControls.toString()}
const mergeFieldControls = ${mergeFieldControls.toString()}
const projectLogFields = ${projectLogFields.toString()}
const validateCollection = ${validateCollectionWithCatalog.toString()}
const decodeStoredLogCollection = ${decodeStoredLogCollection.toString()}
const decodeCollection = value => decodeStoredLogCollection(value,initialCollection,profiles,
  value => validateCollection(value,LOG_SOURCES,LOG_SUPPORTED_INTEGRATIONS,LOG_LEVELS),defaultFieldControls,
  (value,profiles) => validateCompleteFieldControls(value,profiles,validateFieldControlsPatch))
const initialCollection = ${JSON.stringify(defaultLogCollection())}
const encodeCollection = (collection,fieldControls) => JSON.stringify({version:2,collection,fieldControls})
const collectionAllows = ${collectionAllowsAtLevels.toString()}
const boundedLogOutput = ${boundedLogOutput.toString()}
const stdout = workerData.stdout ? boundedLogOutput(process.stdout, workerData.maxEventBytes + 1) : undefined
const diagnostics = boundedLogOutput(process.stderr, 512, 1)
const failureCode = error => error && error.code === 'SQLITE_FULL' ? 'storage_full' : error && String(error.code).startsWith('SQLITE_READONLY') ? 'storage_readonly' : 'storage_unavailable'
// Open, policy and BEGIN/SAVEPOINT failures precede insertion. After insertion
// is attempted, an unstructured failure cannot prove the outer commit outcome.
let writeMayCommit = false
function readPolicy() {
  const storage = db.prepare('SELECT retentionDays,maxBytes FROM log_policy WHERE id=1').get()
  const row = db.prepare('SELECT collection,revision FROM log_collection WHERE id=1').get()
  if (!storage || !row || !Number.isSafeInteger(row.revision) || row.revision < 0
    || !Number.isInteger(storage.retentionDays) || storage.retentionDays < 1 || storage.retentionDays > 365
    || !Number.isInteger(storage.maxBytes) || storage.maxBytes < 1048576 || storage.maxBytes > 4294967296) throw new Error('invalid_log_policy')
  const {collection,fieldControls} = decodeCollection(JSON.parse(row.collection))
  return {...storage, collection, fieldControls, revision:row.revision}
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
  // Allow ordinary peer commits within the service drain budget; no replay of writes.
  db = new Database(path, { timeout: 500 })
  // Fail closed on an unrelated existing SQLite, including a symlink to a business database.
  const owner = db.pragma('application_id', { simple:true })
  if (existed && owner !== 1163283527) throw new Error('foreign_database')
  // auto_vacuum must precede even application_id: that pragma alone materializes page1.
  if (!existed) { db.pragma('auto_vacuum = FULL'); db.pragma('application_id = 1163283527'); chmodSync(path, 0o600) }
  db.pragma('journal_mode = DELETE')
  if(db.pragma('auto_vacuum',{simple:true})!==1) { db.pragma('auto_vacuum = FULL'); db.exec('VACUUM') }
  db.pragma('synchronous = FULL')
  db.exec('CREATE TABLE IF NOT EXISTS log_policy (id INTEGER PRIMARY KEY CHECK(id=1), retentionDays INTEGER NOT NULL, maxBytes INTEGER NOT NULL, pruned INTEGER NOT NULL DEFAULT 0, cleared INTEGER NOT NULL DEFAULT 0)')
  if (!db.prepare('SELECT 1 FROM log_policy WHERE id=1').get()) db.prepare('INSERT OR IGNORE INTO log_policy(id,retentionDays,maxBytes) VALUES(1,?,?)').run(policy.retentionDays, policy.maxBytes)
  db.exec('CREATE TABLE IF NOT EXISTS log_collection (id INTEGER PRIMARY KEY CHECK(id=1), collection TEXT NOT NULL, revision INTEGER NOT NULL)')
  if (!db.prepare('SELECT 1 FROM log_collection WHERE id=1').get()) db.prepare('INSERT OR IGNORE INTO log_collection(id,collection,revision) VALUES(1,?,0)').run(encodeCollection(initialCollection,defaultFieldControls(profiles)))
  // Re-read under the writer lock: a concurrent opener/PATCH can never be overwritten
  // by a stale legacy snapshot. Migration preserves the shared observation revision.
  // Current stores need no initialization writer lock. Only legacy payloads
  // require the locked re-read/migration below.
  const storedCollection = db.prepare('SELECT collection FROM log_collection WHERE id=1').get()
  if (decodeCollection(JSON.parse(storedCollection.collection)).needsMigration) db.transaction(() => {
    const row = db.prepare('SELECT collection FROM log_collection WHERE id=1').get()
    const decoded = decodeCollection(JSON.parse(row.collection))
    policy = readPolicy()
    if (decoded.needsMigration) db.prepare('UPDATE log_collection SET collection=? WHERE id=1').run(encodeCollection(decoded.collection,decoded.fieldControls))
  }).immediate()
  db.exec('CREATE TABLE IF NOT EXISTS log_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, timestamp TEXT NOT NULL, level TEXT NOT NULL, source TEXT NOT NULL, module TEXT, operation TEXT NOT NULL, outcome TEXT NOT NULL, requestId TEXT, traceId TEXT, taskId TEXT, fileId INTEGER, batchId TEXT, resourceId TEXT, summary TEXT NOT NULL, detail TEXT NOT NULL)')
  for (const key of ['timestamp','level','source','operation','outcome','requestId','traceId','taskId','fileId','batchId','resourceId']) db.exec('CREATE INDEX IF NOT EXISTS log_' + key + ' ON log_events(' + key + ',seq)')
  const hasModule = () => db.pragma('table_info(log_events)').some(column => column.name === 'module')
  if (!hasModule()) db.transaction(() => {
    // Recheck under the writer lock when multiple producers open an old store.
    if (!hasModule()) db.exec('ALTER TABLE log_events ADD COLUMN module TEXT')
  }).immediate()
  db.exec('CREATE INDEX IF NOT EXISTS log_module ON log_events(module,seq)')
  policy = readPolicy()
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
  if (filter.module === UNLABELED_LOG_MODULE) terms.push('module IS NULL')
  else if (filter.module !== undefined) { terms.push('module=?'); params.push(filter.module) }
  if (filter.from) { terms.push('timestamp >= ?'); params.push(filter.from) }
  if (filter.to) { terms.push('timestamp <= ?'); params.push(filter.to) }
  return { sql: terms.join(' AND '), params }
}
function execute(action, data) {
  if (action === 'close') { db?.close(); db=undefined; initialized=false; stdout?.close(); return null }
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
      const result = {stored:0, filtered:0, oversized:0, fallbackSkipped:0}
      const authorize = () => {
        const collected = data.filter(event => collectionAllows(event, policy.collection, LOG_LEVELS))
        const projected = collected.map(event => projectLogFields(event,policy.fieldControls,policy.revision,profiles))
        const bounded = projected.filter(event => Buffer.byteLength(JSON.stringify(event),'utf8') <= workerData.maxEventBytes)
        result.filtered = data.length-collected.length
        result.oversized = projected.length-bounded.length
        return bounded
      }
      let allowed = authorize()
      if (!allowed.length) return result
      try {
        cap()
        const insert = db.prepare('INSERT INTO log_events(id,timestamp,level,source,module,operation,outcome,requestId,traceId,taskId,fileId,batchId,resourceId,summary,detail) VALUES(@id,@timestamp,@level,@source,@module,@operation,@outcome,@requestId,@traceId,@taskId,@fileId,@batchId,@resourceId,@summary,@detail)')
        const write = db.transaction(() => { for (const event of allowed) {
          const { auditId, receiptId, parentEventId, ...summary } = event
          writeMayCommit = true
          insert.run({module:null,requestId:null,traceId:null,taskId:null,fileId:null,batchId:null,resourceId:null,...event,batchId:event.batchId===undefined?null:String(event.batchId),resourceId:event.resourceId===undefined?null:String(event.resourceId),summary:JSON.stringify(summary),detail:JSON.stringify(event)})
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
          allowed = authorize()
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
    const rows = db.prepare('SELECT seq,module,summary FROM log_events WHERE ' + f.sql + ' ORDER BY seq DESC LIMIT ?').all(...f.params, data.limit + 1)
    const more = rows.length > data.limit; if (more) rows.pop()
    return { rows: rows.map(r => ({ ...JSON.parse(r.summary), module: r.module })), nextSeq: more ? rows[rows.length-1].seq : null }
  }
  if (action === 'detail') {
    const row = db.prepare('SELECT module,detail FROM log_events WHERE id=? AND timestamp>=?').get(data, new Date(now - policy.retentionDays * 86400000).toISOString())
    return row ? { ...JSON.parse(row.detail), module: row.module } : null
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
        db.prepare('UPDATE log_collection SET collection=?,revision=revision+1 WHERE id=1').run(encodeCollection(collection,mergeFieldControls(policy.fieldControls,data.fieldControls ?? {},profiles)))
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
  throw new Error('unsupported')
}
parentPort.on('message', ({id,action,data,time}) => {
  now=time
  writeMayCommit=false
  try { parentPort.postMessage({ id, ok:true, result:execute(action,data) }) }
  catch(error) {
    const code = failureCode(error)
    // Fixed categories only: never expose SQL, paths, payloads or error messages.
    const diagnosticCode = ['SQLITE_BUSY','SQLITE_BUSY_RECOVERY','SQLITE_BUSY_SNAPSHOT','SQLITE_BUSY_TIMEOUT','SQLITE_LOCKED','SQLITE_FULL','SQLITE_READONLY','SQLITE_IOERR','SQLITE_CORRUPT','SQLITE_NOTADB'].includes(error?.code) ? error.code : 'other'
    const operation = ['write','list','detail','policy','clear','maintain','close'].includes(action) ? action : 'other'
    diagnostics.write(JSON.stringify({module:'core',source:'system',operation:'logging.storage',outcome:'failure',code,nativeCode:diagnosticCode,action:operation,phase:initialized?'command':'open'})+'\n')
    parentPort.postMessage({id,ok:false,code,...(action === 'write' ? {writeOutcome:writeMayCommit ? 'unknown' : 'not_written'} : {})})
    if (!reusableAfterBusy(error)) {
      try { db?.close() } catch {}
      db=undefined
      initialized=false
    }
  }
})
`
