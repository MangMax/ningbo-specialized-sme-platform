import { boundedLogOutput } from './output'
import { Worker } from 'node:worker_threads'
import { LOG_DEFAULTS, LOG_LEVELS, LOG_OUTCOMES, LOG_SOURCES, type LogEvent, type LogFilter, type LogInput, type LogPolicy, type LogSummary } from './contract'
import { safeLogEvent } from './privacy'
import { SQLITE_WORKER } from './sqlite-worker'
import { resolveLoggingSqliteModule } from './sqlite-module-location'

export class LogServiceError extends Error {
  constructor(public code: string, public statusCode = 503) { super(code) }
}
export interface LogServiceOptions {
  directory: string
  retentionDays?: number; maxBytes?: number
  /** Explicit deployment budgets; bounded above by the frozen defaults. */
  maxQueueEntries?: number; maxQueueBytes?: number; maxEventBytes?: number
  drainTimeoutMs?: number; flushIntervalMs?: number
  stdout?: boolean
}
const invalid = () => { throw new LogServiceError('invalid_log_input', 400) }
export function validatePolicy(input: unknown): LogPolicy {
  if (!input || typeof input !== 'object') return invalid()
  const { retentionDays, maxBytes } = input as LogPolicy
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365 || !Number.isInteger(maxBytes) || maxBytes < 1048576 || maxBytes > 4294967296) return invalid()
  return { retentionDays, maxBytes }
}
export function validateLogFilter(input: unknown = {}): LogFilter & { limit: number; beforeSeq?: number } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid()
  const raw = input as Record<string, unknown>
  const filter: Record<string, unknown> = {}
  for (const key of ['source','operation','outcome','level','requestId','traceId','taskId','fileId','batchId','resourceId']) {
    const value = raw[key]
    if (value === undefined) continue
    if (typeof value !== 'string' && typeof value !== 'number') return invalid()
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(String(value))) return invalid()
    filter[key] = value
  }
  if (filter.source && !LOG_SOURCES.includes(filter.source as never)) return invalid()
  if (filter.level && !LOG_LEVELS.includes(filter.level as never)) return invalid()
  if (filter.outcome && !LOG_OUTCOMES.includes(filter.outcome as never)) return invalid()
  for (const key of ['from', 'to']) {
    if (raw[key] === undefined) continue
    if (typeof raw[key] !== 'string' || raw[key].length > 32 || !Number.isFinite(Date.parse(raw[key]))) return invalid()
    filter[key] = new Date(raw[key]).toISOString()
  }
  if (filter.from && filter.to && String(filter.from) > String(filter.to)) return invalid()
  const limit = raw.limit === undefined ? 50 : Number(raw.limit)
  if (!Number.isInteger(limit) || limit < 1 || limit > LOG_DEFAULTS.maxPageSize) return invalid()
  if (raw.cursor !== undefined) {
    if (typeof raw.cursor !== 'string' || !/^[1-9][0-9]{0,15}$/.test(raw.cursor) || !Number.isSafeInteger(Number(raw.cursor))) return invalid()
    filter.beforeSeq = Number(raw.cursor)
  }
  return { ...filter, limit } as LogFilter & { limit: number; beforeSeq?: number }
}

export function createLogService(options: LogServiceOptions) {
  const policy = validatePolicy({ retentionDays: options.retentionDays ?? LOG_DEFAULTS.retentionDays, maxBytes: options.maxBytes ?? LOG_DEFAULTS.maxBytes })
  const budget = (value: number | undefined, fallback: number) => Number.isInteger(value) && value! > 0 ? Math.min(value!, fallback) : fallback
  const maxEntries = budget(options.maxQueueEntries, LOG_DEFAULTS.maxQueueEntries)
  const maxBytes = budget(options.maxQueueBytes, LOG_DEFAULTS.maxQueueBytes)
  const maxEventBytes = budget(options.maxEventBytes, LOG_DEFAULTS.maxEventBytes)
  const timeoutMs = budget(options.drainTimeoutMs, LOG_DEFAULTS.drainTimeoutMs)
  let worker: Worker | undefined, serial = 0, closed = false, closing = false
  let queue: { event: LogEvent; bytes: number }[] = [], queueBytes = 0
  let inFlightEntries = 0, inFlightBytes = 0
  let flushing: Promise<void> | undefined
  const stdout = options.stdout ? boundedLogOutput(process.stdout, maxEventBytes + 1) : undefined
  const stderr = boundedLogOutput(process.stderr, 512, 1)
  const counters = { accepted: 0, stored: 0, dropped: 0, overflow: 0, oversized: 0, drainFailures: 0, fallbackSkipped: 0, unavailable: false, lastError: null as string | null, since: new Date().toISOString() }
  const pending = new Map<number, { resolve(value: any): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }>()
  const status = () => ({ ...counters, queuedEntries: queue.length, queuedBytes: queueBytes, inFlightEntries, inFlightBytes, pending: pending.size, closed })
  function fault(code: string) {
    counters.unavailable = true; counters.lastError = code; counters.drainFailures++
    stderr.write(JSON.stringify({ source: 'system', operation: 'logging.drain', outcome: 'failure', code, dropped: counters.dropped }) + '\n')
  }
  function stopWorker(code: string) {
    const old = worker; worker = undefined
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new LogServiceError(code)) }
    pending.clear()
    if (old) void old.terminate().catch(() => {})
  }
  function start() {
    if (worker) return worker
    const next = new Worker(SQLITE_WORKER, { eval: true, workerData: { directory: options.directory, policy, sqliteModule: resolveLoggingSqliteModule() } })
    next.on('message', message => {
      if (worker !== next) return
      const p = pending.get(message.id); if (!p) return
      clearTimeout(p.timer); pending.delete(message.id)
      if (message.ok) p.resolve(message.result)
      else p.reject(new LogServiceError(message.code))
    })
    next.on('error', () => { if (worker === next) { fault('worker_unavailable'); stopWorker('worker_unavailable') } })
    next.on('exit', () => { if (worker === next) { fault('worker_exited'); stopWorker('worker_exited') } })
    worker = next
    return next
  }
  function call<T>(action: string, data?: unknown): Promise<T> {
    if (closed) return Promise.reject(new LogServiceError('logging_closed'))
    if (pending.size >= LOG_DEFAULTS.maxPendingQueries) return Promise.reject(new LogServiceError('logging_busy', 429))
    return new Promise<T>((resolve, reject) => {
      const id = ++serial
      try {
        const w = start()
        const timer = setTimeout(() => { fault('drain_timeout'); stopWorker('drain_timeout') }, timeoutMs)
        pending.set(id, { resolve, reject, timer }); w.postMessage({ id, action, data, time: Date.now() })
      } catch { reject(new LogServiceError('storage_unavailable')) }
    })
  }
  function emit(input: LogInput): string | null {
    try {
      if (closing || closed) { counters.dropped++; return null }
      const event = safeLogEvent(input)
      const bytes = Buffer.byteLength(JSON.stringify(event))
      if (bytes > maxEventBytes) { counters.dropped++; counters.oversized++; return null }
      if (queue.length >= maxEntries || queueBytes + bytes > maxBytes) { counters.dropped++; counters.overflow++; return null }
      queue.push({ event, bytes }); queueBytes += bytes; counters.accepted++
      if (stdout && !stdout.write(JSON.stringify(event) + '\n')) counters.fallbackSkipped++
      return event.id
    } catch { counters.dropped++; fault('invalid_event'); return null }
  }
  async function drain() {
    while (queue.length) {
      const batch: LogEvent[] = []; let bytes = 0
      while (queue.length && batch.length < LOG_DEFAULTS.batchEntries && bytes + queue[0]!.bytes <= LOG_DEFAULTS.batchBytes) {
        const row = queue.shift()!; queueBytes -= row.bytes; bytes += row.bytes; batch.push(row.event)
      }
      inFlightEntries = batch.length; inFlightBytes = bytes
      try { await call('write', batch); counters.stored += batch.length; counters.unavailable = false }
      catch (error) { counters.dropped += batch.length; fault(error instanceof LogServiceError ? error.code : 'storage_unavailable') }
      finally { inFlightEntries = 0; inFlightBytes = 0 }
    }
  }
  function flush() {
    if (!flushing) flushing = drain().finally(() => { flushing = undefined })
    return flushing
  }
  const timer = setInterval(() => { void flush() }, budget(options.flushIntervalMs, LOG_DEFAULTS.flushIntervalMs)); timer.unref()
  const maintenance = setInterval(() => { if (!closed && !closing) void call('maintain').catch(() => {}) }, 60000); maintenance.unref()
  async function guarded<T>(action: string, data?: unknown) {
    try { return await call<T>(action, data) }
    catch (error) { fault(error instanceof LogServiceError ? error.code : 'storage_unavailable'); throw error }
  }
  return {
    emit, flush, status,
    async list(input: LogFilter = {}) {
      const f = validateLogFilter(input)
      const result = await guarded<{ rows: LogSummary[]; nextSeq: number | null }>('list', f)
      return { rows: result.rows, nextCursor: result.nextSeq === null ? null : String(result.nextSeq), status: status() }
    },
    async detail(id: string) {
      if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) return invalid()
      return guarded<LogEvent | null>('detail', id)
    },
    async policy() { return { ...await guarded<LogPolicy & { storageBytes: number; pruned: number; cleared: number; accounting: string }>('policy'), status: status() } },
    async setPolicy(input: LogPolicy) {
      const result = await guarded<Record<string, unknown>>('policy', validatePolicy(input))
      if (result.transitionPending) throw new LogServiceError('policy_capacity_pending', 409)
      emit({ source: 'system', operation: 'logging.policy', outcome: 'success' })
      return result
    },
    async clear(input: LogFilter & { confirm: boolean }) {
      const f = validateLogFilter(input)
      if (input.confirm !== true || !f.from || !f.to) return invalid()
      const result = await guarded<{ deleted: number; hasMore: boolean }>('clear', f)
      emit({ source: 'system', operation: 'logging.clear', outcome: 'success', counts: { done: result.deleted } })
      return result
    },
    async close() {
      if (closed) return
      closing = true; clearInterval(timer); clearInterval(maintenance)
      let deadline: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([(async () => { await flush(); if (worker) await call('close').catch(() => {}) })(), new Promise<void>(resolve => { deadline = setTimeout(() => { counters.dropped += queue.length; queue = []; queueBytes = 0; stopWorker('close_timeout'); resolve() }, LOG_DEFAULTS.closeTimeoutMs) })])
      } finally { if (deadline) clearTimeout(deadline); closed = true; stopWorker('logging_closed'); stdout?.close(); stderr.close() }
    },
  }
}
export type LogService = ReturnType<typeof createLogService>
