#!/usr/bin/env node
// #87: this command only opens copies in a newly created private directory outside Git.
// node --max-old-space-size=2048 --expose-gc scripts/bench-sqlite-indexes.mjs <frozen-snapshot> <new-absolute-directory>
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, constants, createReadStream, existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync, spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'

const [sourceArg, outputArg] = process.argv.slice(2)
assert.ok(sourceArg && outputArg && isAbsolute(sourceArg) && isAbsolute(outputArg), 'Use absolute frozen snapshot and NEW private output directory')
const source = realpathSync(sourceArg)
const output = join(realpathSync(dirname(outputArg)), outputArg.split('/').at(-1))
const repo = realpathSync(resolve('.'))
assert.ok(relative(repo, output).startsWith('../'), 'Output must be outside the repository')
assert.ok(!existsSync(output), 'Output directory must not exist; never reuse or overwrite a database')
assert.ok(statSync(source).isFile(), 'Snapshot must be a regular file')
assert.ok(!existsSync(source + '-wal') || statSync(source + '-wal').size === 0, 'Use a frozen checkpointed snapshot, not a live WAL database')
mkdirSync(output, { mode: 0o700 })
const emit = (name, value) => writeFileSync(join(output, name + '.json'), JSON.stringify(value, null, 2), { mode: 0o600 })
async function fileHash(path) { const h = createHash('sha256'); for await (const b of createReadStream(path)) h.update(b); return h.digest('hex') }
const sourceHash = await fileHash(source)
const clone = (from, to) => copyFileSync(from, to, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
const beforePath = join(output, 'before.sqlite'), afterPath = join(output, 'after.sqlite')
clone(source, beforePath); clone(source, afterPath)
assert.equal(await fileHash(beforePath), sourceHash); assert.equal(await fileHash(afterPath), sourceHash)
const { createJiti } = createRequire(import.meta.resolve('nuxt/package.json'))('jiti')
const jiti = createJiti(import.meta.url)
const { listPlatformQueries } = await jiti.import('../lib/platform/read.ts')
const { readPlatformQueryEvidence } = await jiti.import('../lib/platform/evidence-read.ts')
const open = path => { const d = new Database(path); d.pragma('foreign_keys=ON'); d.pragma('journal_mode=WAL'); return d }
const before = open(beforePath), after = open(afterPath)
const quote = s => '"' + s.replaceAll('"', '""') + '"'
function fingerprint(d) {
  const tables = d.prepare("select name,sql from sqlite_master where type='table' and name not like '__drizzle%' order by name").all()
  return tables.map(({ name, sql }) => {
    const h = createHash('sha256'); let rows = 0
    for (const row of d.prepare(`select * from ${quote(name)} order by rowid`).raw().safeIntegers().iterate()) {
      const bytes = Buffer.from(JSON.stringify(row, (_, v) => typeof v === 'bigint' ? { bigint: String(v) } : v))
      h.update(String(bytes.length) + ':'); h.update(bytes); rows++
    }
    return { table: name, rows, sha256: h.digest('hex'), schemaSha256: createHash('sha256').update(sql).digest('hex') }
  })
}
function check(d) {
  assert.deepEqual(d.pragma('integrity_check'), [{ integrity_check: 'ok' }], 'SQLite integrity check')
  assert.deepEqual(d.pragma('foreign_key_check'), [], 'SQLite foreign keys')
  return { integrity: 'ok', foreignKeyViolations: 0, foreignKeysEnabled: d.pragma('foreign_keys', { simple: true }) }
}
const preservedBefore = fingerprint(before), checksBefore = check(before)
const uniqueIndexes = d => d.prepare("select name,sql from sqlite_master where type='index' and (sql like 'CREATE UNIQUE%' or sql is null) order by name").all()
const migrationRows = before.prepare('select * from __drizzle_migrations order by created_at').all()
const uniqueBefore = uniqueIndexes(before)
const walBytes = path => existsSync(path + '-wal') ? statSync(path + '-wal').size : 0
const indexBuilds = [], migrationPrepare = after.prepare.bind(after)
after.prepare = (...args) => {
  const statement = migrationPrepare(...args)
  if (/^CREATE INDEX/i.test(statement.source.trim())) {
    const run = statement.run.bind(statement)
    statement.run = (...bindings) => { const start = performance.now(); const result = run(...bindings); indexBuilds.push({ sql: statement.source, ms: performance.now() - start }); return result }
  }
  return statement
}
const migrationStarted = performance.now()
try { migrate(drizzle(after), { migrationsFolder: resolve('db/migrations') }) } finally { after.prepare = migrationPrepare }
const migrationMs = performance.now() - migrationStarted
const migrationWalBytes = walBytes(afterPath)
const preservedAfter = fingerprint(after), checksAfter = check(after)
assert.deepEqual(preservedAfter, preservedBefore, 'Every business/internal sequence table, ID, original field and audit row must survive byte-exact')
assert.deepEqual(uniqueIndexes(after), uniqueBefore, 'Unique index definitions must not change')
assert.deepEqual(after.prepare('select * from __drizzle_migrations order by created_at limit ?').all(migrationRows.length), migrationRows, 'Historical migration ledger must survive')
assert.equal(after.prepare('select count(*) n from __drizzle_migrations').get().n, migrationRows.length + 1)
after.pragma('wal_checkpoint(TRUNCATE)')
const indexSizes = after.prepare("select name,sum(pgsize) bytes,count(*) pages from dbstat where name like 'platform_%' group by name order by name").all()
emit('preservation', { sourceHash, checksBefore, checksAfter, tables: preservedAfter, uniqueDefinitionsUnchanged: true, historicalMigrationRowsPreserved: migrationRows.length })
const key = before.prepare('select query_key from platform_query order by id limit 1').get()?.query_key
const uscc = before.prepare('select uscc_raw from platform_relation where uscc_raw is not null order by id limit 1').get()?.uscc_raw
const enterpriseId = before.prepare('select enterprise_id from platform_relation where enterprise_id is not null order by id limit 1').get()?.enterprise_id
const queryId = before.prepare('select id from platform_query order by length(cast(raw_response as blob)) desc limit 1').get()?.id
assert.ok(key && uscc && enterpriseId && queryId, 'Use the full distribution snapshot')
const n = before.prepare('select count(*) n from platform_query').get().n
const cases = [
  ['summary', { view: 'summary' }], ['deep', { view: 'summary', pageSize: 25, page: Math.max(1, Math.floor(n / 25)) }],
  ['status', { view: 'summary', status: 'failed' }], ['interface', { view: 'summary', interface: 'recognized_list' }],
  ['uscc', { view: 'summary', uscc }], ['enterprise', { view: 'summary', enterpriseId }],
  ['key', { view: 'summary', queryKey: key }], ['title', { view: 'summary', titleCode: 'specialized_sme' }],
  ['full', {}], ['exact', { queryId, pageSize: 1, includeRawResponse: true }],
]
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const percentile = (xs, p) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * p) - 1]
function measure(d, filter) {
  const db = drizzle(d), prepare = d.prepare.bind(d), plans = new Map(), samples = []
  let sqlMs = 0, returnedBytes = 0, peakHeap = 0, peakRss = 0
  const observe = value => {
    if (Array.isArray(value)) for (const v of value) observe(v)
    else if (value && typeof value === 'object' && !Buffer.isBuffer(value)) for (const v of Object.values(value)) observe(v)
    else returnedBytes += typeof value === 'string' ? Buffer.byteLength(value) : Buffer.isBuffer(value) ? value.length : typeof value === 'number' ? 8 : 0
  }
  d.prepare = (...args) => {
    const statement = prepare(...args)
    for (const method of ['get', 'all']) {
      const original = statement[method].bind(statement)
      statement[method] = (...bindings) => {
        if (/^select/i.test(statement.source) && !plans.has(statement.source)) plans.set(statement.source, prepare('explain query plan ' + statement.source).all(...bindings).map(r => r.detail))
        const start = performance.now(), result = original(...bindings)
        sqlMs += performance.now() - start; observe(result)
        const m = process.memoryUsage(); peakHeap = Math.max(peakHeap, m.heapUsed); peakRss = Math.max(peakRss, m.rss)
        return result
      }
    }
    return statement
  }
  try {
    for (let round = 0; round < 6; round++) {
      global.gc?.(); sqlMs = 0; returnedBytes = 0
      const heapBefore = process.memoryUsage().heapUsed, start = performance.now()
      const result = listPlatformQueries(db, filter)
      const serializeStart = performance.now(), body = JSON.stringify(result), serializationMs = performance.now() - serializeStart
      const ms = performance.now() - start, memory = process.memoryUsage()
      peakHeap = Math.max(peakHeap, memory.heapUsed); peakRss = Math.max(peakRss, memory.rss)
      samples.push({ label: round ? 'warm' : 'first-after-copy-and-integrity-check', ms, sqlMs, serializationMs, residualMs: ms - sqlMs - serializationMs, returnedBytes, responseBytes: Buffer.byteLength(body), heapDelta: memory.heapUsed - heapBefore, resultSha256: digest(result) })
    }
  } finally { d.prepare = prepare }
  const hot = samples.slice(1).map(s => s.ms)
  return { samples, hot: { p50: percentile(hot, .5), p95: percentile(hot, .95), p99: percentile(hot, .99) }, peakHeap, peakRss, plans: [...plans].map(([sql, plan]) => ({ sql, plan })) }
}
const reads = []
for (const [name, filter] of cases) {
  const a = measure(before, filter), b = measure(after, filter)
  assert.deepEqual(b.samples.map(x => x.resultSha256), a.samples.map(x => x.resultSha256), name + ' result/order/count/raw equivalence')
  reads.push({ name, before: a, after: b })
}
emit('reads', reads)
const extraPlans = {
  audit: ['select id from record_correspondence_audit where correspondence_id=? order by id', [1]],
  proofAudit: ['select id from comparison_scope_proof_audit where proof_id=? order by id', [1]],
  idempotency: ['select id from import_batch where idempotency_key=?', ['synthetic:missing']],
  relationSequence: ['select id from platform_relation where query_id=? order by sequence_no', [queryId]],
}
emit('inventory', {
  queryCount: n,
  selectivity: {
    status: before.prepare('select status,count(*) n from platform_query group by status').all(),
    interface: before.prepare('select interface,count(*) n from platform_query group by interface').all(),
    relation: before.prepare('select count(*) n,count(distinct uscc_raw) usccKeys,count(distinct enterprise_id) enterpriseKeys from platform_relation').get(),
    payloadBytes: before.prepare('select sum(length(cast(raw_response as blob))) rawBytes,sum(length(cast(collection_evidence as blob))) collectionBytes from platform_query').get(),
  },
  indexes: after.prepare("select name,sql from sqlite_master where type='index' and sql is not null order by name").all(),
  indexSizes,
  extraPlans: Object.fromEntries(Object.entries(extraPlans).map(([k, [sql, args]]) => [k, before.prepare('explain query plan ' + sql).all(...args).map(r => r.detail)])),
})
// The same public evidence helper confirms a large stored body in bounded UTF-8 byte chunks.
for (const field of ['rawResponse', 'collectionEvidence']) {
  const a = readPlatformQueryEvidence(drizzle(before), { queryId, field, length: 65536 })
  assert.equal(digest(readPlatformQueryEvidence(drizzle(after), { queryId, field, length: 65536 })), digest(a), 'Exact evidence chunk equivalence')
}
before.close(); after.close()

async function writeProbe(path, label) {
  const probePath = join(output, `write-${label}.sqlite`); clone(path, probePath)
  const d = open(probePath), rounds = [], payload = 'x'.repeat(25618)
  const insertQ = d.prepare('insert into platform_query(interface,query_key,rdjb,queried_at,status,raw_response,created_at) values(?,?,?,?,?,?,?)')
  const insertR = d.prepare('insert into platform_relation(query_id,sequence_no,uscc_raw,raw_fields,created_at) values(?,?,?,?,?)')
  try {
    for (let round = 0; round < 5; round++) {
      d.pragma('wal_checkpoint(TRUNCATE)')
      const start = performance.now()
      d.transaction(() => {
        for (let i = 0; i < 300; i++) {
          const key = `synthetic:87:${round}:${i}`, at = '2026-10-19'
          const q = insertQ.run('recognized_list', key, '', at, 'success', payload, at)
          for (let seq = 1; seq <= 2; seq++) insertR.run(q.lastInsertRowid, seq, key, JSON.stringify({ payload: 'x'.repeat(5394) }), at)
        }
      })()
      const ms = performance.now() - start
      rounds.push({ ms, queriesPerSecond: 300000 / ms, insertedQueries: 300, insertedRelations: 600, walBytes: walBytes(probePath) })
    }
    // An independent SQLite writer holds BEGIN IMMEDIATE; real driver busy handling must time out.
    const child = spawn(process.execPath, ['--input-type=module', '-e', `import Database from 'better-sqlite3';const d=new Database(process.argv[1]);d.exec('BEGIN IMMEDIATE');process.send('locked');process.on('message',()=>{d.exec('ROLLBACK');d.close();process.exit(0)})`, probePath], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    let childError = ''
    child.stderr.on('data', b => { childError = (childError + b).slice(-1000) })
    try {
      await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); child.once('exit', code => reject(Error(`Lock writer exited ${code}: ${childError}`))) })
      d.pragma('busy_timeout=100')
      const start = performance.now(); let code
      try { d.exec('BEGIN IMMEDIATE'); d.exec('ROLLBACK') } catch (e) { code = e.code }
      assert.equal(code, 'SQLITE_BUSY')
      const lockWaitMs = performance.now() - start
      child.send('release'); await new Promise(resolve => child.once('exit', resolve))
      d.exec('BEGIN IMMEDIATE'); d.exec('ROLLBACK')
      return { rounds, synchronous: d.pragma('synchronous', { simple: true }), foreignKeysEnabled: d.pragma('foreign_keys', { simple: true }), busyTimeoutMs: 100, lockWaitMs, lockResult: code, lockReleasedRetry: 'ok', integrity: check(d) }
    } finally { if (child.exitCode === null) child.kill('SIGTERM') }
  } finally {
    d.close()
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(probePath + suffix)) unlinkSync(probePath + suffix)
  }
}
const writesBefore = await writeProbe(beforePath, 'before'), writesAfter = await writeProbe(afterPath, 'after')
emit('writes', { before: writesBefore, after: writesAfter, note: 'Five 300-query/600-relation synthetic transactions on separate disposable full-distribution copies; default WAL autocheckpoint, observed synchronous=1 (NORMAL), FK ON. Lock wait uses a deliberately held writer and busy_timeout=100ms, not production contention.' })
assert.equal(await fileHash(source), sourceHash, 'Shared snapshot main file must remain unchanged')
assert.ok(!existsSync(source + '-wal') || statSync(source + '-wal').size === 0, 'Shared snapshot must remain checkpointed')
const result = { runAt: new Date().toISOString(), sourceUnchanged: true, sourceSha256: sourceHash, gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), gitDiffSha256: createHash('sha256').update(execFileSync('git', ['diff', 'HEAD'])).digest('hex'), node: process.version, sqlite: new Database(':memory:').prepare('select sqlite_version() version').get().version, heapLimit: (await import('node:v8')).getHeapStatistics().heap_size_limit, migrationMs, indexBuilds, migrationWalBytes, beforeBytes: statSync(beforePath).size, afterBytes: statSync(afterPath).size, osPeakRssBytes: process.resourceUsage().maxRSS * 1024, readCases: reads.map(r => ({ name: r.name, beforeP50: r.before.hot.p50, afterP50: r.after.hot.p50 })), allRowsAndUniqueDefinitionsPreserved: true }
emit('summary', result)
console.log(JSON.stringify(result))
