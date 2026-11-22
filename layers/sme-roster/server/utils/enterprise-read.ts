import { appLog, type LogContext, type LogInput } from '../../../core/lib/logging'
import { channel } from 'node:diagnostics_channel'
import type { EnterpriseReadRequest } from '../../lib/roster/enterprise-read-worker'
import type { CurrentQualifiedFilter } from '../../lib/roster/current-qualified-page'
import { createEnterpriseWorker } from './enterprise-read-worker-location'

const diagnostic = channel('ningbo.enterprise-read')
type JsonRead = { body: Buffer }
type NativeWorker = {
  on(event: 'message' | 'error' | 'exit', listener: (message: any) => void): unknown
  postMessage(message: EnterpriseReadRequest): void
  ref(): void; unref(): void; terminate(): Promise<unknown>
}
type Job = { logContext: Readonly<LogContext>; started: number; filter: CurrentQualifiedFilter; chunks: Buffer[]; id: number; bytes: number; resolve(value: JsonRead): void; reject(error: Error): void; signal?: AbortSignal; abort(): void }
const unavailable = (code: string) => Object.assign(new Error('Enterprise read temporarily unavailable'), { statusCode: 503, code })
const aborted = () => Object.assign(new Error('Enterprise read aborted'), { name: 'AbortError', statusCode: 499 })

/** One native worker, bounded FIFO, no result cache or shared connection. Every
 * admitted read is independently executed against a PostgreSQL read snapshot. */
export function createEnterpriseReadExecutor(options: { createWorker?: () => NativeWorker; maxPending?: number } = {}) {
  const maxPending = options.maxPending ?? 16
  if (!Number.isInteger(maxPending) || maxPending < 1 || maxPending > 16) throw new RangeError('maxPending must be 1..16')
  const queue: Job[] = []
  let worker: NativeWorker | undefined, ready = false, active: Job | undefined, closed = false
  let nextId = 0, metadataBytes = 0, stopping: Promise<unknown> | undefined
  let workerHeap = 0, workerRss = 0
  let setWorkerContext: ((context: Readonly<LogContext>) => void) | undefined
  let startupTimer: ReturnType<typeof setTimeout> | undefined
  let starting: { promise: Promise<void>; resolve(): void; reject(error: Error): void } | undefined
  const publish = (extra: Record<string, unknown> = {}) => {
    if (diagnostic.hasSubscribers) diagnostic.publish({ pending: queue.length, active: !!active, metadataBytes, workerHeap, workerRss, applicationHeap: process.memoryUsage().heapUsed, ...extra })
  }
  function settle(job: Job, result: Error | JsonRead) {
    metadataBytes -= job.bytes
    const error = result instanceof Error ? result : undefined
    const code = (error as { code?: string } | undefined)?.code
    const outcome: LogInput['outcome'] = job.signal?.aborted ? 'cancelled'
      : error ? (code === 'worker_start_timeout' ? 'timeout' : ['worker_decode_failed', 'worker_exited', 'worker_failed', 'worker_send_failed', 'executor_closed'].includes(code ?? '') ? 'unknown' : 'failure') : 'success'
    appLog({ module: 'sme-roster', source: 'worker', operation: 'enterprise_read.finished', outcome, durationMs: performance.now() - job.started,
      errorCode: error ? 'enterprise_read_unavailable' : undefined }, job.logContext)
    job.chunks = []
    job.signal?.removeEventListener('abort', job.abort)
    if (result instanceof Error) job.reject(result)
    else job.resolve(result)
  }
  function retire(error: Error) {
    clearTimeout(startupTimer)
    if (starting) { starting.reject(error); starting=undefined }
    const retiring = worker
    setWorkerContext = undefined
    worker = undefined; ready = false; workerHeap = 0; workerRss = 0
    if (active) { const job = active; active = undefined; settle(job, error) }
    else if (queue.length) settle(queue.shift()!, error)
    if (retiring) {
      stopping = retiring.terminate().finally(() => { stopping = undefined; pump() })
    } else pump()
  }
  function pump() {
    if (closed || stopping || active || (!queue.length && !starting)) { if (!active && !queue.length) worker?.unref(); return }
    if (!worker) {
      let processContext = queue[0]?.logContext
      setWorkerContext = context => { processContext = context }
      appLog({ module: 'sme-roster', source: 'worker', operation: 'enterprise_read.process.start', outcome: 'started' }, processContext)
      let owned: NativeWorker
      try { owned = (options.createWorker ?? createEnterpriseWorker)() } catch { appLog({ module: 'sme-roster', source: 'worker', operation: 'enterprise_read.process.start', outcome: 'failure', errorCode: 'worker_start_failed' }, processContext); retire(unavailable('worker_start_failed')); return }
      worker = owned
      // All readiness/error ownership is established before any asynchronous gap.
      owned.on('message', message => {
        if (worker !== owned) return
        if (message.type === 'ready') {
          appLog({ module: 'sme-roster', source: 'worker', operation: 'enterprise_read.process.ready', outcome: 'success' }, processContext)
          clearTimeout(startupTimer); ready = true; workerHeap = message.heap; workerRss = message.rss ?? 0
          starting?.resolve(); starting=undefined
          publish({ phase: 'ready', heapLimit: message.heapLimit, execArgv: message.execArgv, workerPid: message.pid }); pump(); return
        }
        if (!active || message.id !== active.id) return
        if (message.type === 'chunk') {
          if (!Buffer.isBuffer(message.payload)) { retire(unavailable('worker_decode_failed')); return }
          active.chunks.push(message.payload)
          return
        }
        const job = active; active = undefined
        if (message.type === 'failure') settle(job, unavailable(message.code))
        else if (message.type !== 'result' || !message.metrics) settle(job, unavailable('worker_decode_failed'))
        else {
          workerHeap = message.metrics.heap
          workerRss = message.metrics.rss
          const start = performance.now()
          try {
            const body = Buffer.concat(job.chunks)
            if (message.metrics.bytes !== body.byteLength) throw new Error('Incomplete worker body')
            settle(job, { body })
          } catch { settle(job, unavailable('worker_decode_failed')) }
          publish({ phase: 'result', ...message.metrics, deserializeMs: performance.now() - start })
        }
        pump()
      })
      owned.on('error', () => { if (worker === owned) { appLog({ module: 'sme-roster', source: 'worker', operation: 'enterprise_read.process.error', outcome: 'failure', errorCode: 'worker_failed' }, active?.logContext ?? processContext); retire(unavailable('worker_failed')) } })
      owned.on('exit', () => { appLog({ module: 'sme-roster', source: 'worker', operation: 'enterprise_read.process.exit', outcome: worker === owned && !closed ? 'unknown' : 'cancelled' }, processContext); if (worker === owned) retire(unavailable('worker_exited')) })
      startupTimer = setTimeout(() => {
        if (worker === owned && !ready) {
          appLog({ module: 'sme-roster', source: 'worker', operation: 'enterprise_read.process.start', outcome: 'timeout', errorCode: 'worker_start_timeout' }, processContext)
          retire(unavailable('worker_start_timeout'))
        }
      }, 5000)
      startupTimer.unref()
    }
    worker.ref()
    if (!ready || !queue.length) return
    active = queue.shift()!
    setWorkerContext?.(active.logContext)
    appLog({ module: 'sme-roster', source: 'worker', operation: 'enterprise_read.started', outcome: 'started' }, active.logContext)
    try { worker.postMessage({ id: active.id, filter: active.filter, logContext: active.logContext } satisfies EnterpriseReadRequest); publish({ phase: 'start' }) } catch { retire(unavailable('worker_send_failed')) }
  }
  function currentQualifiedJson(filter: CurrentQualifiedFilter, signal?: AbortSignal, logContext?: LogContext): Promise<JsonRead> {
    if (closed) return Promise.reject(unavailable('executor_closed'))
    if (signal?.aborted) return Promise.reject(aborted())
    const encoded = JSON.stringify(filter)
    const bytes = Buffer.byteLength(encoded)
    if (queue.length >= maxPending || bytes + metadataBytes > 65536) return Promise.reject(unavailable('enterprise_read_busy'))
    return new Promise((resolve, reject) => {
      const job: Job = { logContext: Object.freeze({ ...logContext }), started: performance.now(), chunks: [], filter: JSON.parse(encoded) as CurrentQualifiedFilter, signal, bytes, id: ++nextId, resolve, reject, abort() {
        if (active === job) retire(aborted())
        else {
          const index = queue.indexOf(job)
          if (index >= 0) { queue.splice(index, 1); settle(job, aborted()); pump() }
        }
      } }
      appLog({ module: 'sme-roster', source: 'worker', operation: 'enterprise_read.queued', outcome: 'started' }, job.logContext)
      metadataBytes += bytes; queue.push(job)
      signal?.addEventListener('abort', job.abort, { once: true })
      if (signal?.aborted) { job.abort(); return }
      pump()
    })
  }
  return {
    start(): Promise<void> {
      if (closed) return Promise.reject(unavailable('executor_closed'))
      if (ready) return Promise.resolve()
      if (starting) return starting.promise
      let resolve!: () => void, reject!: (error: Error) => void
      const promise = new Promise<void>((yes,no) => { resolve=yes; reject=no })
      starting={ promise,resolve,reject }; pump()
      return promise
    },
    currentQualifiedJson,
    async close() {
      closed = true
      for (const job of queue.splice(0)) settle(job, unavailable('executor_closed'))
      retire(unavailable('executor_closed'))
      await stopping
    },
  }
}
export const enterpriseReads = createEnterpriseReadExecutor()
