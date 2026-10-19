/** Dedicated native SQLite executor. This entry has no Nitro runtime dependency. */
import { parentPort } from 'node:worker_threads'
import { realpathSync, statSync } from 'node:fs'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { listRosterEnterprises, getRosterEnterpriseDetail, type RosterEnterpriseFilter } from './enterprise-roster'

export type EnterpriseReadRequest = { id: number; dbPath: string } & (
  { operation: 'list'; filter: RosterEnterpriseFilter } | { operation: 'detail'; enterpriseId: number }
)
const port = parentPort!
let connection: Database.Database | undefined, identity: string | undefined
let readPeakHeap = 0
const observeHeap = () => { readPeakHeap = Math.max(readPeakHeap,process.memoryUsage().heapUsed) }
function observeConnection(client: Database.Database) {
  const prepare = client.prepare.bind(client)
  client.prepare = ((...args: Parameters<typeof prepare>) => {
    const statement = prepare(...args)
    for (const method of ['get','all'] as const) {
      const run = statement[method].bind(statement)
      statement[method] = ((...params: unknown[]) => { const result=run(...params); observeHeap(); return result }) as never
    }
    const iterate = statement.iterate.bind(statement)
    statement.iterate = function* (...params: unknown[]) {
      let count=0
      try { for (const row of iterate(...params)) { if (++count%256===0) observeHeap(); yield row } }
      finally { observeHeap() }
    }
    return statement
  }) as typeof prepare
}
function closeConnection() { connection?.close(); connection=undefined; identity=undefined }
port.on('close', closeConnection)
port.on('message', (request: EnterpriseReadRequest) => {
  const beforeHeap = process.memoryUsage().heapUsed
  readPeakHeap = beforeHeap
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
    const db = drizzle(connection!, { schema })
    // Both readers own one synchronous transaction across every statement. It
    // lives entirely off-thread, including native cursor drains and JS sorting.
    const result = request.operation === 'list' ? listRosterEnterprises(db, request.filter) : getRosterEnterpriseDetail(db, request.enterpriseId)
    const projectedHeap = process.memoryUsage().heapUsed
    const serializationStarted = performance.now()
    const text = JSON.stringify(result)
    const payload = Buffer.allocUnsafeSlow(Buffer.byteLength(text))
    payload.write(text)
    const metrics = { beforeHeap, heap: Math.max(readPeakHeap, projectedHeap, process.memoryUsage().heapUsed), external: process.memoryUsage().external, bytes: payload.byteLength, transferredBytes: payload.buffer.byteLength, readMs: serializationStarted - started, serializeMs: performance.now() - serializationStarted }
    port.postMessage({ type: 'result', id: request.id, found: result != null, payload, metrics }, [payload.buffer as ArrayBuffer])
  } catch (error) {
    closeConnection()
    port.postMessage({ type: 'failure', id: request.id, code: (error as { code?: string }).code ?? 'enterprise_read_failed' })
  } finally {
    if (connection?.inTransaction) connection.exec('ROLLBACK')
  }
})
port.postMessage({ type: 'ready', heap: process.memoryUsage().heapUsed })
