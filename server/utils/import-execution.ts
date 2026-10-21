import { serialize } from 'node:v8'
import type Database from 'better-sqlite3'
import { realpathSync, statSync } from 'node:fs'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '../../db/schema'
import type { RosterImportRequest, RosterImportItemResult } from '../../lib/roster-import-client'
import { commitRosterImport, preflightRosterImport } from './roster-import'
import { ImportReceiptError } from './import-receipts'
import { createImportExecutionWorker } from './import-execution-worker-location'

type Db = BetterSQLite3Database<typeof schema>
type Action = 'preflight' | 'commit'
type Result = ReturnType<typeof preflightRosterImport> | ReturnType<typeof commitRosterImport>
export interface ImportExecutionMessage { identity: { dev: number; ino: number; schemaVersion: number; migration: { hash: string; created_at: number } | undefined }; id: number; dbPath: string; readonly: boolean; action: Action; payload: Buffer; pageCountErrors: readonly RosterImportItemResult[] }
type Worker = ReturnType<typeof createImportExecutionWorker>
type Job = { message: ImportExecutionMessage; resolve(value: Result): void; reject(error: Error): void }
const unavailable = (code: string, message: string) => new ImportReceiptError(503, code, message)

/** One serial writer per app. Active writes have no client cancellation or retry:
 * losing the process is an unknown outcome, recovered by the existing receipt/key.
 * Closing admission drains accepted work before stopping the idle process. */
export function createImportExecutor(options: { createWorker?: () => Worker; maxPending?: number; maxBytes?: number } = {}) {
  const maxPending = options.maxPending ?? 8, maxBytes = options.maxBytes ?? 32 * 1024 * 1024
  if (!Number.isInteger(maxPending) || maxPending < 1 || maxPending > 8 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 32 * 1024 * 1024) throw new RangeError('Import admission bounds exceed 8 requests / 32MiB')
  const queue: Job[] = []
  let worker: Worker | undefined, ready = false, active: Job | undefined, retainedBytes = 0, nextId = 0, closed = false
  let stopping: Promise<void> | undefined, startupTimer: ReturnType<typeof setTimeout> | undefined
  let closing: Promise<void> | undefined, finishClose: (() => void) | undefined
  const settle = (job: Job, error?: Error, result?: Result) => {
    retainedBytes -= job.message.payload.byteLength
    if (error) job.reject(error); else job.resolve(result!)
  }
  function idle() {
    if (active || queue.length || stopping) return
    if (closed) {
      const owned = worker; worker = undefined; ready = false
      void (owned?.terminate() ?? Promise.resolve()).then(() => finishClose?.())
    } else worker?.unref()
  }
  function pump() {
    if (active || stopping) return
    if (!queue.length) { idle(); return }
    if (!worker) {
      let owned: Worker
      try { owned = (options.createWorker ?? createImportExecutionWorker)() }
      catch { settle(queue.shift()!, unavailable('import_worker_unavailable', 'Import execution unavailable')); pump(); return }
      worker = owned
      const failed = () => {
        if (worker !== owned) return
        clearTimeout(startupTimer)
        const wasReady = ready
        worker = undefined; ready = false
        if (!wasReady && queue.length) settle(queue.shift()!, unavailable('import_worker_unavailable', 'Import execution unavailable'))
        if (active) { const job = active; active = undefined; settle(job, unavailable('import_outcome_unknown', 'Import outcome unknown; read its receipt and retry with the same idempotency key')) }
        // Do not replay a possibly committed command. A new process may serve only
        // later admitted requests, whose normal core checks the durable key.
        stopping = owned.terminate().finally(() => { stopping = undefined; pump() })
      }
      owned.on('error', failed); owned.on('exit', failed)
      owned.on('message', message => {
        if (worker !== owned) return
        if (message.type === 'ready') { clearTimeout(startupTimer); ready = true; pump(); return }
        if (!active || message.id !== active.message.id) return
        const job = active; active = undefined
        if (message.type === 'failure') settle(job, message.error.known ? new ImportReceiptError(message.error.statusCode, message.error.code, message.error.message) : new Error(message.error.message))
        else settle(job, undefined, message.result)
        pump()
      })
      startupTimer = setTimeout(failed, 5000); startupTimer.unref()
    }
    worker.ref()
    if (!ready) return
    active = queue.shift()!
    try { worker.postMessage(active.message) } catch { const owned = worker; worker = undefined; ready = false; const job = active; active = undefined; settle(job, unavailable('import_outcome_unknown', 'Import outcome unknown; read its receipt and retry with the same idempotency key')); stopping = owned.terminate().finally(() => { stopping = undefined; pump() }) }
  }
  return {
    execute(db: Db, action: Action, request: RosterImportRequest, pageCountErrors: readonly RosterImportItemResult[] = []): Promise<Result> {
      if (closed) return Promise.reject(unavailable('import_executor_closed', 'Import execution unavailable'))
      const client = (db as Db & { $client: Database.Database }).$client
      // Private/in-memory callers cannot share a native connection across processes.
      if (!client.name || client.name === ':memory:' || client.inTransaction) return Promise.resolve(action === 'preflight' ? preflightRosterImport(db, request, pageCountErrors) : commitRosterImport(db, request, pageCountErrors))
      if (queue.length + Number(!!active) >= maxPending) return Promise.reject(unavailable('import_busy', 'Import execution busy'))
      const payload = serialize(request)
      if (payload.byteLength + retainedBytes > maxBytes) return Promise.reject(unavailable('import_busy', 'Import execution busy'))
      const path = realpathSync(client.name), stat = statSync(path)
      const identity = { dev: stat.dev, ino: stat.ino, schemaVersion: client.pragma('schema_version', { simple: true }) as number, migration: client.prepare('SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1').get() as { hash: string; created_at: number } | undefined }
      retainedBytes += payload.byteLength
      return new Promise((resolve, reject) => {
        queue.push({ message: { identity, id: ++nextId, dbPath: path, readonly: client.readonly, action, payload, pageCountErrors }, resolve, reject }); pump()
      })
    },
    close() {
      if (closing) return closing
      closed = true
      closing = new Promise<void>(resolve => { finishClose = resolve })
      idle()
      return closing
    },
  }
}
export const importExecutor = createImportExecutor()
