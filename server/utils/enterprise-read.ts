import { channel } from 'node:diagnostics_channel'
import type { RosterEnterpriseFilter, RosterEnterprisesResult } from '../../lib/roster/enterprise-roster'
import type { EnterpriseReadRequest } from '../../lib/roster/enterprise-read-worker'
import { createEnterpriseWorker } from './enterprise-read-worker-location'
import type { RecognitionReadInput, DifferenceReadInput, SummaryReadInput, OffmainReadOutcome } from '../../lib/roster/offmain-read-protocol'

const diagnostic = channel('ningbo.enterprise-read')
type Detail = ReturnType<typeof import('../../lib/roster/enterprise-roster').getRosterEnterpriseDetail>
type Input = { dbPath: string } & ({ operation: 'list'; filter: RosterEnterpriseFilter } | { operation: 'detail'; enterpriseId: number } | RecognitionReadInput | DifferenceReadInput | SummaryReadInput)
const originalReaderPolicy = (input: Input) => input.operation === 'recognitions' || input.operation === 'differences' || input.operation === 'summary'
type JsonRead = { body: Buffer; found: boolean }
type NativeWorker = {
  on(event: 'message' | 'error' | 'exit', listener: (message: any) => void): unknown
  postMessage(message: EnterpriseReadRequest): void
  ref(): void; unref(): void; terminate(): Promise<unknown>
}
type Job = { input: Input; chunks: Buffer[]; encoding: 'object' | 'json'; id: number; bytes: number; callerSettled: boolean; resolve(value: unknown): void; reject(error: Error): void; signal?: AbortSignal; abort(): void }
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
  let startupTimer: ReturnType<typeof setTimeout> | undefined
  let starting: { promise: Promise<void>; resolve(): void; reject(error: Error): void } | undefined
  const publish = (extra: Record<string, unknown> = {}) => {
    if (diagnostic.hasSubscribers) diagnostic.publish({ pending: queue.length, active: !!active, metadataBytes, workerHeap, workerRss, applicationHeap: process.memoryUsage().heapUsed, ...extra })
  }
  function settleCaller(job: Job, error?: Error, value?: unknown) {
    if (job.callerSettled) return
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
      let owned: NativeWorker
      try { owned = (options.createWorker ?? createEnterpriseWorker)() } catch { retire(unavailable('worker_start_failed')); return }
      worker = owned
      // All readiness/error ownership is established before any asynchronous gap.
      owned.on('message', message => {
        if (worker !== owned) return
        if (message.type === 'ready') {
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
      owned.on('error', () => { if (worker === owned) retire(unavailable('worker_failed')) })
      owned.on('exit', () => { if (worker === owned) retire(unavailable('worker_exited')) })
      startupTimer = setTimeout(() => { if (worker === owned && !ready) retire(unavailable('worker_start_timeout')) }, 5000)
      startupTimer.unref()
    }
    worker.ref()
    if (!ready || !queue.length) return
    active = queue.shift()!
    try { worker.postMessage({ id: active.id, ...active.input } satisfies EnterpriseReadRequest); publish({ phase: 'start' }) } catch { retire(unavailable('worker_send_failed')) }
  }
  function submit(input: Input, signal?: AbortSignal, encoding: 'object' | 'json' = 'object'): Promise<unknown> {
    const failure = (error: Error) => originalReaderPolicy(input)
      ? Promise.resolve<OffmainReadOutcome>({ type: signal?.aborted ? 'cancelled' : 'fallback' }) : Promise.reject(error)
    if (closed) return failure(unavailable('executor_closed'))
    if (signal?.aborted) return failure(aborted())
    const encoded = JSON.stringify(input)
    const bytes = Buffer.byteLength(encoded)
    if (queue.length >= maxPending || bytes + metadataBytes > 65536) return failure(unavailable('enterprise_read_busy'))
    return new Promise((resolve, reject) => {
      const job: Job = { chunks: [], encoding, input: JSON.parse(encoded) as Input, signal, bytes, callerSettled: false, id: ++nextId, resolve, reject, abort() {
        if (active === job) {
          if (originalReaderPolicy(job.input)) settleCaller(job, undefined, { type: 'cancelled' } satisfies OffmainReadOutcome)
          else retire(aborted())
        }
        else {
          const index = queue.indexOf(job)
          if (index >= 0) { queue.splice(index, 1); settle(job, aborted()); pump() }
        }
      } }
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
    json(dbPath: string, request: { operation: 'list'; filter: RosterEnterpriseFilter } | { operation: 'detail'; enterpriseId: number }, signal?: AbortSignal) { return submit({ ...request,dbPath } as Input, signal, 'json') as Promise<JsonRead> },
    recognitions(input: RecognitionReadInput, signal?: AbortSignal) { return submit(input, signal, 'json') as Promise<OffmainReadOutcome> },
    differences(input: DifferenceReadInput, signal?: AbortSignal) { return submit(input, signal, 'json') as Promise<OffmainReadOutcome> },
    summary(input: SummaryReadInput, signal?: AbortSignal) { return submit(input, signal, 'json') as Promise<OffmainReadOutcome> },
    list(dbPath: string, filter: RosterEnterpriseFilter = {}, signal?: AbortSignal) { return submit({ dbPath, operation: 'list', filter }, signal) as Promise<RosterEnterprisesResult> },
    detail(dbPath: string, enterpriseId: number, signal?: AbortSignal) { return submit({ dbPath, operation: 'detail', enterpriseId }, signal) as Promise<Detail> },
    async close() {
      closed = true
      for (const job of queue.splice(0)) settle(job, unavailable('executor_closed'))
      retire(unavailable('executor_closed'))
      await stopping
    },
  }
}
export const enterpriseReads = createEnterpriseReadExecutor()
