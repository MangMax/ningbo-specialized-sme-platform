/** Dedicated native SQLite executor. This entry has no Nitro runtime dependency. */
import { getHeapStatistics } from 'node:v8'
import { realpathSync, statSync } from 'node:fs'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { listRosterEnterprises, getRosterEnterpriseDetail, type RosterEnterpriseFilter } from './enterprise-roster'
import { enterpriseJsonChunks } from './enterprise-read-json'

export type EnterpriseReadRequest = { id: number; dbPath: string } & (
  { operation: 'list'; filter: RosterEnterpriseFilter } | { operation: 'detail'; enterpriseId: number }
)
const send = (message: object) => new Promise<void>((resolve, reject) => {
  process.send!(message, error => error ? reject(error) : resolve())
})
let connection: Database.Database | undefined, identity: string | undefined
let readPeakHeap = 0, readPeakRss = 0, readPeakExternal = 0
let readSqlMs = 0, readSqlCalls = 0
let measureDetailSql = false
const observeHeap = () => {
  const memory = process.memoryUsage()
  readPeakHeap = Math.max(readPeakHeap, memory.heapUsed)
  readPeakRss = Math.max(readPeakRss, memory.rss)
  readPeakExternal = Math.max(readPeakExternal, memory.external)
}
function observeConnection(client: Database.Database) {
  const prepare = client.prepare.bind(client)
  client.prepare = ((...args: Parameters<typeof prepare>) => {
    const statement = prepare(...args)
    for (const method of ['get','all'] as const) {
      const run = statement[method].bind(statement)
      statement[method] = ((...params: unknown[]) => {
        if (!measureDetailSql) { const result = run(...params); observeHeap(); return result }
        const started = performance.now()
        try { return run(...params) }
        finally { readSqlMs += performance.now() - started; readSqlCalls++; observeHeap() }
      }) as never
    }
    const iterate = statement.iterate.bind(statement)
    statement.iterate = function* (...params: unknown[]) {
      let count=0
      if (!measureDetailSql) {
        try { for (const row of iterate(...params)) { if (++count%256===0) observeHeap(); yield row } }
        finally { observeHeap() }
        return
      }
      const cursor = iterate(...params)
      let complete = false
      readSqlCalls++
      try {
        for (;;) {
          const started = performance.now()
          const next = cursor.next()
          readSqlMs += performance.now() - started
          if (next.done) { complete = true; break }
          if (++count%256===0) observeHeap()
          yield next.value
        }
      }
      finally { if (!complete) cursor.return?.(); observeHeap() }
    }
    return statement
  }) as typeof prepare
}
function closeConnection() { connection?.close(); connection=undefined; identity=undefined }
process.on('disconnect', () => { closeConnection(); process.exit(0) })
process.on('message', async (request: EnterpriseReadRequest) => {
  const beforeHeap = process.memoryUsage().heapUsed
  readPeakHeap = beforeHeap
  readPeakRss = readPeakExternal = 0
  readSqlMs = readSqlCalls = 0
  measureDetailSql = request.operation === 'detail'
  const started = performance.now()
  try {
    const path = realpathSync(request.dbPath), stat = statSync(path)
    const key = `${path}\0${stat.dev}\0${stat.ino}`
    if (identity !== key) {
      closeConnection()
      connection = new Database(path, { readonly: true, fileMustExist: true })
      observeConnection(connection)
      identity = key
    }
    const connectionMs = performance.now() - started
    const db = drizzle(connection!, { schema })
    // Both readers own one synchronous transaction across every statement. It
    // lives entirely off-thread, including native cursor drains and JS sorting.
    const result = request.operation === 'list' ? listRosterEnterprises(db, request.filter) : getRosterEnterpriseDetail(db, request.enterpriseId)
    const projectionMs = performance.now() - started - connectionMs
    const projectedHeap = process.memoryUsage().heapUsed
    const serializationStarted = performance.now()
    let bytes = 0
    for (const payload of enterpriseJsonChunks(result)) {
      bytes += payload.byteLength
      observeHeap()
      await send({ type: 'chunk', id: request.id, payload })
    }
    const metrics = { beforeHeap, heap: Math.max(readPeakHeap, projectedHeap), external: readPeakExternal, rss: readPeakRss, maxRss: process.resourceUsage().maxRSS * 1024, bytes, transferredBytes: bytes, chunkBytes: 65536, readMs: serializationStarted - started, connectionMs, projectionMs, ...(measureDetailSql ? { sqlMs: readSqlMs, sqlCalls: readSqlCalls } : {}), serializeMs: performance.now() - serializationStarted }
    await send({ type: 'result', id: request.id, found: result != null, metrics })
  } catch (error) {
    closeConnection()
    if (process.connected) await send({ type: 'failure', id: request.id, code: (error as { code?: string }).code ?? 'enterprise_read_failed' })
  } finally {
    if (connection?.inTransaction) connection.exec('ROLLBACK')
  }
})
void send({ type: 'ready', heap: process.memoryUsage().heapUsed, rss: process.memoryUsage().rss, heapLimit: getHeapStatistics().heap_size_limit, execArgv: process.execArgv, pid: process.pid })
