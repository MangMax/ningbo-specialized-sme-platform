/** Dedicated native SQLite executor. This entry has no Nitro runtime dependency. */
import { getHeapStatistics } from 'node:v8'
import { realpathSync, statSync } from 'node:fs'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { listRosterEnterprises, getRosterEnterpriseDetail, type RosterEnterpriseFilter } from './enterprise-roster'
import { enterpriseJsonChunks } from './enterprise-read-json'
import { listCurrentQualified, type CurrentQualifiedFilter } from './current-qualified-query'
import { listRosterRecognitions } from './recognitions'
import { listRosterDifferences } from './difference-list'
import { readWholeComparisonSummary } from '../comparison-summary-read'
import { captureReaderError, readOwnerIdentity, sameReadOwner, type RecognitionReadInput, type DifferenceReadInput, type SummaryReadInput } from './offmain-read-protocol'

export type EnterpriseReadRequest = { id: number; dbPath: string } & (
  { operation: 'list'; filter: RosterEnterpriseFilter } | { operation: 'detail'; enterpriseId: number } | { operation: 'current-qualified'; filter: CurrentQualifiedFilter } | RecognitionReadInput | DifferenceReadInput | SummaryReadInput
)
const send = (message: object) => new Promise<void>((resolve, reject) => {
  process.send!(message, error => error ? reject(error) : resolve())
})
let connection: Database.Database | undefined, identity: string | undefined
let readPeakHeap = 0, readPeakRss = 0, readPeakExternal = 0
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
process.on('disconnect', () => { closeConnection(); process.exit(0) })
process.on('message', async (request: EnterpriseReadRequest) => {
  const beforeHeap = process.memoryUsage().heapUsed
  readPeakHeap = beforeHeap
  readPeakRss = readPeakExternal = 0
  const started = performance.now()
  try {
    if ((request.operation === 'recognitions' || request.operation === 'differences' || request.operation === 'summary') && !sameReadOwner(request.owner, readOwnerIdentity(request.dbPath))) {
      await send({ type: 'failure', id: request.id, code: 'owner_identity_changed' }); return
    }
    const path = realpathSync(request.dbPath), stat = statSync(path)
    const key = `${path}\0${stat.dev}\0${stat.ino}`
    if (identity !== key) {
      closeConnection()
      connection = new Database(path, { readonly: true, fileMustExist: true })
      observeConnection(connection)
      identity = key
    }
    if ((request.operation === 'recognitions' || request.operation === 'differences' || request.operation === 'summary') && (identity !== `${request.owner.realpath}\0${request.owner.dev}\0${request.owner.ino}`
      || !sameReadOwner(request.owner, readOwnerIdentity(request.dbPath)))) {
      closeConnection(); await send({ type: 'failure', id: request.id, code: 'owner_identity_changed' }); return
    }
    const db = drizzle(connection!, { schema })
    // Each whole reader owns one synchronous transaction across every statement. It
    // lives entirely off-thread, including native cursor drains and JS sorting.
    let result: unknown
    if (request.operation === 'recognitions' || request.operation === 'differences' || request.operation === 'summary') {
      // Open/identity/IPC failures are outside this invocation boundary. Once
      // the reader starts, every exception (including SQLite busy) is terminal.
      try {
        result = request.operation === 'summary' ? readWholeComparisonSummary(db, request.options)
          : request.operation === 'recognitions' ? listRosterRecognitions(db, request.filter) : listRosterDifferences(db, request.filter)
      }
      catch (error) {
        const captured = captureReaderError(error)
        closeConnection()
        await send({ type: 'reader-error', id: request.id, error: captured })
        return
      }
    } else result = request.operation === 'list' ? listRosterEnterprises(db, request.filter) : request.operation === 'detail' ? getRosterEnterpriseDetail(db, request.enterpriseId) : listCurrentQualified(connection!, request.filter)
    const projectedHeap = process.memoryUsage().heapUsed
    const serializationStarted = performance.now()
    let bytes = 0
    for (const payload of enterpriseJsonChunks(result)) {
      bytes += payload.byteLength
      observeHeap()
      await send({ type: 'chunk', id: request.id, payload })
    }
    const metrics = { beforeHeap, heap: Math.max(readPeakHeap, projectedHeap), external: readPeakExternal, rss: readPeakRss, maxRss: process.resourceUsage().maxRSS * 1024, bytes, transferredBytes: bytes, chunkBytes: 65536, readMs: serializationStarted - started, serializeMs: performance.now() - serializationStarted }
    await send({ type: 'result', id: request.id, found: result != null, metrics })
  } catch (error) {
    closeConnection()
    if (process.connected) await send({ type: 'failure', id: request.id, code: (error as { code?: string }).code ?? 'enterprise_read_failed' })
  } finally {
    if (connection?.inTransaction) connection.exec('ROLLBACK')
  }
})
void send({ type: 'ready', heap: process.memoryUsage().heapUsed, rss: process.memoryUsage().rss, heapLimit: getHeapStatistics().heap_size_limit, execArgv: process.execArgv, pid: process.pid })
