import { activateCandidateDiscoveryTasks } from './jobs/candidate-discovery'
import { ensureJobRunnerReady } from '../../layers/core/server/utils/job-runner'
import { serialize } from 'node:v8'
import type Database from 'better-sqlite3'
import { realpathSync, statSync } from 'node:fs'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '../../db/schema'
import type { RosterImportRequest, RosterImportItemResult } from '../../lib/roster-import-client'
import { commitRosterImport, preflightRosterImport } from './roster-import'
import { ImportReceiptError } from './import-receipts'
import { createImportExecutionWorker } from './import-execution-worker-location'
import { appLog, type LogContext } from '../../layers/core/lib/logging'
import { logImportFailure } from './roster-import-logging'
import { beginImportWrite } from './import-write-barrier'

type Db = BetterSQLite3Database<typeof schema>
type Action = 'preflight' | 'commit'
type Result = ReturnType<typeof preflightRosterImport> | ReturnType<typeof commitRosterImport>
export interface ImportExecutionMessage { identity: { dev: number; ino: number; schemaVersion: number; migration: { hash: string; created_at: number } | undefined }; id: number; dbPath: string; readonly: boolean; action: Action; payload: Buffer; pageCountErrors: readonly RosterImportItemResult[]; logContext?: LogContext; filesDir?: string }
type Worker = ReturnType<typeof createImportExecutionWorker>
type Job = { onResult?: (result: Result) => void; message: ImportExecutionMessage; resolve(value: Result): void; reject(error: Error): void }
const unavailable = (code: string, message: string) => new ImportReceiptError(503, code, message)

/** One serial writer per app. Active writes have no client cancellation or retry:
 * losing the process is an unknown outcome, recovered by the existing receipt/key.
 * Closing admission drains accepted work before stopping the idle process. */
export function createImportExecutor(options: { createWorker?: () => Worker; maxPending?: number; maxBytes?: number } = {}) {
  const maxPending = options.maxPending ?? 8, maxBytes = options.maxBytes ?? 32 * 1024 * 1024
  if (!Number.isInteger(maxPending) || maxPending < 1 || maxPending > 8 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 32 * 1024 * 1024) throw new RangeError('Import backlog bounds exceed 8 requests / 32MiB')
  const queue: Job[] = []
  let worker: Worker | undefined, ready = false, active: Job | undefined, retainedBytes = 0, nextId = 0, closed = false
  let stopping: Promise<void> | undefined, startupTimer: ReturnType<typeof setTimeout> | undefined
  let closing: Promise<void> | undefined, finishClose: (() => void) | undefined
  let endWrite: (() => void) | undefined
  const releaseWriter = () => { endWrite?.(); endWrite = undefined }
  const settle = (job: Job, error?: Error, result?: Result) => {
    retainedBytes -= job.message.payload.byteLength
    if (error) { logImportFailure('import.execution', error, job.message.logContext); job.reject(error) }
    else { job.onResult?.(result!); job.resolve(result!) }
  }
  function idle() {
    if (active || queue.length || stopping) return
    if (closed) {
      const owned = worker; worker = undefined; ready = false
      if (!owned) { finishClose?.(); return }
      // Business work is already drained. Give only logging a bounded graceful close.
      const timer = setTimeout(() => { void owned.terminate() }, 3500)
      owned.once('exit', () => { clearTimeout(timer); finishClose?.() })
      try { owned.postMessage({ type: 'shutdown' }) } catch { void owned.terminate() }
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
        stopping = owned.terminate().finally(() => { stopping = undefined; releaseWriter(); queueMicrotask(pump) })
      }
      owned.on('error', failed); owned.on('exit', failed)
      owned.on('message', message => {
        if (worker !== owned) return
        if (message.type === 'ready') { clearTimeout(startupTimer); ready = true; pump(); return }
        if (!active || message.id !== active.message.id) return
        const job = active; active = undefined
        if (message.type === 'failure') settle(job, message.error.known ? new ImportReceiptError(message.error.statusCode, message.error.code, message.error.message) : new Error(message.error.message))
        else settle(job, undefined, message.result)
        // Let pending main-process checkpoints persist before the next writer starts.
        releaseWriter()
        queueMicrotask(pump)
      })
      startupTimer = setTimeout(failed, 5000); startupTimer.unref()
    }
    worker.ref()
    if (!ready) return
    active = queue.shift()!
    endWrite = beginImportWrite()
    appLog({ module: 'sme-roster', source: 'import', operation: 'import.execution', outcome: 'started' }, active.message.logContext)
    try { worker.postMessage(active.message) } catch { const owned = worker; worker = undefined; ready = false; const job = active; active = undefined; settle(job, unavailable('import_outcome_unknown', 'Import outcome unknown; read its receipt and retry with the same idempotency key')); stopping = owned.terminate().finally(() => { stopping = undefined; releaseWriter(); queueMicrotask(pump) }) }
  }
  return {
    execute(db: Db, action: Action, request: RosterImportRequest, pageCountErrors: readonly RosterImportItemResult[] = [], context: LogContext = {}, source: { filesDir?: string } = {}): Promise<Result> {
      if (action === 'commit' && request.payload.platformQueries?.length) ensureJobRunnerReady(db)
      const rejectAdmission = (error: ImportReceiptError) => { logImportFailure('import.admission', error, context); return Promise.reject(error) }
      if (closed) return rejectAdmission(unavailable('import_executor_closed', 'Import execution unavailable'))
      const client = (db as Db & { $client: Database.Database }).$client
      // Private/in-memory callers cannot share a native connection across processes.
      if (!client.name || client.name === ':memory:' || client.inTransaction) return Promise.resolve(action === 'preflight' ? preflightRosterImport(db, request, pageCountErrors, { ...context, filesDir: source.filesDir }) : commitRosterImport(db, request, pageCountErrors, { ...context, filesDir: source.filesDir }))
      const pending = queue.length + Number(!!active)
      if (pending >= maxPending || (pending > 0 && retainedBytes >= maxBytes)) return rejectAdmission(unavailable('import_busy', 'Import execution busy'))
      const payload = serialize(request)
      // This is a backlog budget, not a new single-batch size contract. A batch
      // larger than it may run alone; every later admission waits until it settles.
      // Keep the original whole-batch transaction in the isolated process.
      if (pending > 0 && payload.byteLength + retainedBytes > maxBytes) return rejectAdmission(unavailable('import_busy', 'Import execution busy'))
      const path = realpathSync(client.name), stat = statSync(path)
      const identity = { dev: stat.dev, ino: stat.ino, schemaVersion: client.pragma('schema_version', { simple: true }) as number, migration: client.prepare('SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1').get() as { hash: string; created_at: number } | undefined }
      retainedBytes += payload.byteLength
      return new Promise((resolve, reject) => {
        appLog({ module: 'sme-roster', source: 'import', operation: 'import.admission', outcome: 'started' }, context)
        queue.push({ onResult: result => { if ('candidateTaskIds' in result) activateCandidateDiscoveryTasks(db,result.candidateTaskIds,'',context) }, message: { identity, id: ++nextId, dbPath: path, readonly: client.readonly, action, payload, pageCountErrors, logContext: context, filesDir: source.filesDir }, resolve, reject }); pump()
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
