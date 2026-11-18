import { appLog, type LogContext, type LogInput } from '../../lib/logging'
import { channel } from 'node:diagnostics_channel'
import type { RosterEnterpriseFilter, RosterEnterprisesResult } from '../../lib/roster/enterprise-roster'
import type { EnterpriseReadRequest } from '../../lib/roster/enterprise-read-worker'
import type { CurrentQualifiedFilter } from '../../lib/roster/current-qualified-query'
import { createEnterpriseWorker } from './enterprise-read-worker-location'
import type { RecognitionReadInput, DifferenceReadInput, SummaryReadInput, OffmainReadOutcome } from '../../lib/roster/offmain-read-protocol'

const diagnostic = channel('ningbo.enterprise-read')
type Detail = ReturnType<typeof import('../../lib/roster/enterprise-roster').getRosterEnterpriseDetail>
type Input = { dbPath: string } & ({ operation: 'list'; filter: RosterEnterpriseFilter } | { operation: 'detail'; enterpriseId: number } | { operation: 'current-qualified'; filter: CurrentQualifiedFilter } | RecognitionReadInput | DifferenceReadInput | SummaryReadInput)
const originalReaderPolicy = (input: Input) => input.operation === 'recognitions' || input.operation === 'differences' || input.operation === 'summary'
type JsonRead = { body: Buffer; found: boolean }
type NativeWorker = {
  on(event: 'message' | 'error' | 'exit', listener: (message: any) => void): unknown
  postMessage(message: EnterpriseReadRequest): void
  ref(): void; unref(): void; terminate(): Promise<unknown>
}
type Job = { logContext: Readonly<LogContext>; started: number; input: Input; chunks: Buffer[]; encoding: 'object' | 'json'; id: number; bytes: number; callerSettled: boolean; resolve(value: unknown): void; reject(error: Error): void; signal?: AbortSignal; abort(): void }
const unavailable = (code: string) => Object.assign(new Error('Enterprise read temporarily unavailable'), { statusCode: 503, code })
const aborted = () => Object.assign(new Error('Enterprise read aborted'), { name: 'AbortError', statusCode: 499 })

/** One native worker, bounded FIFO, no result cache or shared connection. Every
 * admitted read is independently executed against the latest committed file. */
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
  function settleCaller(job: Job, error?: Error, value?: unknown) {
    if (job.callerSettled) return
    const valueType = (value as { type?: string } | undefined)?.type
    const code = (error as { code?: string } | undefined)?.code
    const outcome: LogInput['outcome'] = job.signal?.aborted || valueType === 'cancelled' ? 'cancelled'
      : valueType === 'reader-error' ? 'failure'
      : error ? (code === 'worker_start_timeout' ? 'timeout' : ['worker_decode_failed', 'worker_exited', 'worker_failed', 'worker_send_failed', 'executor_closed'].includes(code ?? '') ? 'unknown' : 'failure') : 'success'
    appLog({ module: 'sme-roster', source: 'worker', operation: 'enterprise_read.finished', outcome, durationMs: performance.now() - job.started,
      errorCode: error ? 'enterprise_read_unavailable' : valueType === 'reader-error' ? 'enterprise_reader_failed' : undefined }, job.logContext)
    job.callerSettled = true
    job.chunks = []
    job.signal?.removeEventListener('abort', job.abort)
    if (originalReaderPolicy(job.input) && error) job.resolve({ type: job.signal?.aborted ? 'cancelled' : 'fallback' } satisfies OffmainReadOutcome)
    else if (error) job.reject(error); else job.resolve(value)
  }
  function settle(job: Job, error?: Error, value?: unknown) {
    metadataBytes -= job.bytes
    settleCaller(job, error, value)
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
          if (!active.callerSettled) {
            if (!Buffer.isBuffer(message.payload)) { retire(unavailable('worker_decode_failed')); return }
            active.chunks.push(message.payload)
          }
          return
        }
        const job = active; active = undefined
        if (job.callerSettled) settle(job)
        else if (message.type === 'failure') settle(job, unavailable(message.code))
        else if (message.type === 'reader-error' && originalReaderPolicy(job.input)) {
          settle(job, undefined, { type: 'reader-error', error: message.error } satisfies OffmainReadOutcome)
        }
        else if (message.type !== 'result' || !message.metrics) settle(job, unavailable('worker_decode_failed'))
        else {
          workerHeap = message.metrics.heap
          workerRss = message.metrics.rss
          const start = performance.now()
          try {
            const body = Buffer.concat(job.chunks)
            if (originalReaderPolicy(job.input)) {
              if (message.metrics.bytes !== body.byteLength) throw new Error('Incomplete worker body')
              settle(job, undefined, { type: 'complete', body } satisfies OffmainReadOutcome)
            } else settle(job, undefined, job.encoding === 'json' ? { body,found: message.found } : JSON.parse(body.toString('utf8')))
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
    try { worker.postMessage({ id: active.id, ...active.input, logContext: active.logContext } satisfies EnterpriseReadRequest); publish({ phase: 'start' }) } catch { retire(unavailable('worker_send_failed')) }
  }
  function submit(input: Input, signal?: AbortSignal, encoding: 'object' | 'json' = 'object', logContext?: LogContext): Promise<unknown> {
    const failure = (error: Error) => originalReaderPolicy(input)
      ? Promise.resolve<OffmainReadOutcome>({ type: signal?.aborted ? 'cancelled' : 'fallback' }) : Promise.reject(error)
    if (closed) return failure(unavailable('executor_closed'))
    if (signal?.aborted) return failure(aborted())
    const encoded = JSON.stringify(input)
    const bytes = Buffer.byteLength(encoded)
    if (queue.length >= maxPending || bytes + metadataBytes > 65536) return failure(unavailable('enterprise_read_busy'))
    return new Promise((resolve, reject) => {
      const job: Job = { logContext: Object.freeze({ ...logContext, ...(input.operation === 'detail' ? {resourceType: 'enterprise', resourceId: input.enterpriseId} : {}) }), started: performance.now(), chunks: [], encoding, input: JSON.parse(encoded) as Input, signal, bytes, callerSettled: false, id: ++nextId, resolve, reject, abort() {
        if (active === job) {
          if (originalReaderPolicy(job.input)) settleCaller(job, undefined, { type: 'cancelled' } satisfies OffmainReadOutcome)
          else retire(aborted())
        }
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
    json(dbPath: string, request: { operation: 'list'; filter: RosterEnterpriseFilter } | { operation: 'detail'; enterpriseId: number }, signal?: AbortSignal, logContext?: LogContext) { return submit({ ...request,dbPath } as Input, signal, 'json', logContext) as Promise<JsonRead> },
    currentQualifiedJson(dbPath: string, filter: CurrentQualifiedFilter, signal?: AbortSignal, logContext?: LogContext) { return submit({ dbPath, operation: 'current-qualified', filter }, signal, 'json', logContext) as Promise<JsonRead> },
    recognitions(input: RecognitionReadInput, signal?: AbortSignal, logContext?: LogContext) { return submit(input, signal, 'json', logContext) as Promise<OffmainReadOutcome> },
    differences(input: DifferenceReadInput, signal?: AbortSignal, logContext?: LogContext) { return submit(input, signal, 'json', logContext) as Promise<OffmainReadOutcome> },
    summary(input: SummaryReadInput, signal?: AbortSignal, logContext?: LogContext) { return submit(input, signal, 'json', logContext) as Promise<OffmainReadOutcome> },
    list(dbPath: string, filter: RosterEnterpriseFilter = {}, signal?: AbortSignal, logContext?: LogContext) { return submit({ dbPath, operation: 'list', filter }, signal, 'object', logContext) as Promise<RosterEnterprisesResult> },
    detail(dbPath: string, enterpriseId: number, signal?: AbortSignal, logContext?: LogContext) { return submit({ dbPath, operation: 'detail', enterpriseId }, signal, 'object', logContext) as Promise<Detail> },
    async close() {
      closed = true
      for (const job of queue.splice(0)) settle(job, unavailable('executor_closed'))
      retire(unavailable('executor_closed'))
      await stopping
    },
  }
}
export const enterpriseReads = createEnterpriseReadExecutor()
