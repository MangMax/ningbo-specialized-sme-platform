import { registeredLogModule } from './module'
import { boundedLogOutput } from './output'
import { LOG_DEFAULTS, LOG_LEVELS, LOG_OUTCOMES, LOG_SOURCES, UNLABELED_LOG_MODULE, type LogEvent, type FieldCapturedLogEvent, type LogFilter, type LogInput, type LogPolicy, type LogPolicyPatch, type EffectiveLogPolicy, type LogSummary } from './contract'
import { LOG_FIELD_PROFILES, validateFieldControlsPatch } from './field-controls'
import { validateCollection } from './policy'
import { LOG_INTEGRATIONS } from './contract'
import { safeLogEvent } from './privacy'
import { isDrizzleQueryAttempt } from './drizzle-query'

export class LogServiceError extends Error {
  constructor(public code: string, public statusCode = 503, readonly writeOutcome?: 'unknown' | 'not_written') { super(code) }
}
export interface LogServiceOptions {
  retentionDays?: number; maxBytes?: number
  /** Explicit deployment budgets; bounded above by the frozen defaults. */
  maxQueueEntries?: number; maxQueueBytes?: number; maxEventBytes?: number
  drainTimeoutMs?: number; flushIntervalMs?: number
  stdout?: boolean
}
type PolicyView = EffectiveLogPolicy & { storageBytes: number; pruned: number; cleared: number; accounting: string }
const invalid = () => { throw new LogServiceError('invalid_log_input', 400) }
export function validatePolicy(input: unknown): LogPolicyPatch {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return invalid()
  const raw = input as Record<string, unknown>
  for (const key of Reflect.ownKeys(raw)) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key)!
    if (typeof key !== 'string' || !['retentionDays', 'maxBytes', 'collection', 'fieldControls'].includes(key)
      || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return invalid()
  }
  const { retentionDays, maxBytes } = raw as unknown as LogPolicy
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365 || !Number.isInteger(maxBytes) || maxBytes < 1048576 || maxBytes > 4294967296) return invalid()
  try {
    const result = { retentionDays, maxBytes,
      ...(Object.hasOwn(raw, 'collection') ? { collection: validateCollection(raw.collection) } : {}),
      ...(Object.hasOwn(raw, 'fieldControls') ? { fieldControls: validateFieldControlsPatch(raw.fieldControls, LOG_FIELD_PROFILES) } : {}),
    }
    // Serialized policy arguments only, not the raw HTTP body/JSON-RPC envelope.
    if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > 4096) return invalid()
    return result
  } catch { return invalid() }
}
export function validateLogFilter(input: unknown = {}): LogFilter & { limit: number; beforeSeq?: number } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid()
  const raw = input as Record<string, unknown>
  const filter: Record<string, unknown> = {}
  if (raw.module !== undefined) {
    if (raw.module !== UNLABELED_LOG_MODULE && registeredLogModule(raw.module) === null) return invalid()
    filter.module = raw.module
  }
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

interface LogStorageTransport {
  pending(): number
  call<T>(action: string, data?: unknown): Promise<T>
  close(): Promise<void>
  stop(code: string): void
}

export function createBufferedLogService(options: LogServiceOptions, createTransport: (config: {
  policy: LogPolicyPatch
  maxEventBytes: number
  timeoutMs: number
  fault(code: string): void
}) => LogStorageTransport) {
  const policy = validatePolicy({ retentionDays: options.retentionDays ?? LOG_DEFAULTS.retentionDays, maxBytes: options.maxBytes ?? LOG_DEFAULTS.maxBytes })
  const budget = (value: number | undefined, fallback: number) => Number.isInteger(value) && value! > 0 ? Math.min(value!, fallback) : fallback
  const maxEntries = budget(options.maxQueueEntries, LOG_DEFAULTS.maxQueueEntries)
  const maxBytes = budget(options.maxQueueBytes, LOG_DEFAULTS.maxQueueBytes)
  const maxEventBytes = budget(options.maxEventBytes, LOG_DEFAULTS.maxEventBytes)
  const timeoutMs = budget(options.drainTimeoutMs, LOG_DEFAULTS.drainTimeoutMs)
  let closed = false, closing = false
  type QueueRow = { event: LogEvent; bytes: number; queryKey?: string }
  let queue: QueueRow[] = [], queueBytes = 0
  // References only pending rows in the current diagnostic segment. No extra
  // producer buffer, timer, or request-context cache; cardinality <= queue size.
  const queryRows = new Map<string, QueueRow>()
  const unindex = (row: QueueRow) => { if (row.queryKey && queryRows.get(row.queryKey) === row) queryRows.delete(row.queryKey) }
  let inFlightEntries = 0, inFlightBytes = 0
  let flushing: Promise<void> | undefined
  let scheduled: ReturnType<typeof setImmediate> | undefined
  const stderr = boundedLogOutput(process.stderr, 512, 1)
  const counters = { accepted: 0, stored: 0, filtered: 0, coalesced: 0, dropped: 0, writeUnknown: 0, overflow: 0, oversized: 0, drainFailures: 0, fallbackSkipped: 0, unavailable: false, lastError: null as string | null, since: new Date().toISOString() }
  const storage = createTransport({ policy, maxEventBytes, timeoutMs, fault })
  const status = () => ({ ...counters, queuedEntries: queue.length, queuedBytes: queueBytes, inFlightEntries, inFlightBytes, pending: storage.pending(), closed })
  function fault(code: string) {
    counters.unavailable = true; counters.lastError = code; counters.drainFailures++
    stderr.write(JSON.stringify({ module: 'core', source: 'system', operation: 'logging.drain', outcome: 'failure', code, dropped: counters.dropped, writeUnknown: counters.writeUnknown }) + '\n')
  }
  function call<T>(action: string, data?: unknown): Promise<T> {
    if (closed) return Promise.reject(new LogServiceError('logging_closed'))
    if (storage.pending() >= LOG_DEFAULTS.maxPendingQueries) return Promise.reject(new LogServiceError('logging_busy', 429))
    return storage.call(action, data)
  }
  function scheduleDrain() {
    if (scheduled || flushing || closing || closed) return
    scheduled = setImmediate(() => { scheduled = undefined; void flush() })
    scheduled.unref()
  }
  function scheduleIfReady(level: LogEvent['level']) {
    if (queue.length >= Math.min(maxEntries, LOG_DEFAULTS.batchEntries)
      || queueBytes >= Math.min(maxBytes, LOG_DEFAULTS.batchBytes)
      || level === 'warn' || level === 'error') scheduleDrain()
  }
  function emit(input: LogInput): string | null {
    try {
      if (closing || closed) { counters.dropped++; return null }
      const event = safeLogEvent(input)
      const queryAttempt = isDrizzleQueryAttempt(event) && event.counts === undefined
      if (queryAttempt) event.counts = { total: 1 }
      const serialized = JSON.stringify(event)
      const bytes = Buffer.byteLength(serialized)
      let queryKey: string | undefined
      // safeLogEvent owns this generated UUID/ISO prefix. Reuse the single
      // serialization for both byte accounting and all remaining safe facts.
      // If its layout changes, decline aggregation instead of ignoring fields.
      const identityPrefix = queryAttempt ? `{"id":"${event.id}","timestamp":"${event.timestamp}",` : ''
      if (queryAttempt && serialized.startsWith(identityPrefix)) {
        queryKey = serialized.slice(identityPrefix.length)
        const prior = queryRows.get(queryKey)
        if (prior && prior.event.counts!.total! < Number.MAX_SAFE_INTEGER) {
          const total = prior.event.counts!.total!, next = total + 1
          // Only this decimal safe-integer counter changes in an indexed row.
          const nextBytes = prior.bytes + String(next).length - String(total).length
          if (nextBytes <= maxEventBytes && queueBytes - prior.bytes + nextBytes <= maxBytes) {
            queueBytes += nextBytes - prior.bytes; prior.event.counts = { total: next }; prior.bytes = nextBytes
            counters.coalesced++; scheduleIfReady(event.level)
            return prior.event.id
          }
        }
      } else queryRows.clear() // Never merge across an intervening business event.
      if (bytes > maxEventBytes) { counters.dropped++; counters.oversized++; return null }
      if (queue.length >= maxEntries || queueBytes + bytes > maxBytes) {
        // A synchronous debug burst can fill the queue before any timer/worker
        // runs. Prefer higher-severity events without growing either budget or
        // waiting in a business caller. Never touch an in-flight batch.
        const rank = LOG_LEVELS.indexOf(event.level ?? 'info')
        const victims = new Set<number>()
        let releasedBytes = 0
        const fits = () => queue.length - victims.size < maxEntries && queueBytes - releasedBytes + bytes <= maxBytes
        if (bytes <= maxBytes) {
          for (let level = 0; level < rank && !fits(); level++) {
            for (let i = 0; i < queue.length && !fits(); i++) {
              if (LOG_LEVELS.indexOf(queue[i]!.event.level ?? 'info') !== level) continue
              victims.add(i); releasedBytes += queue[i]!.bytes
            }
          }
        }
        // Admission is atomic: if lower levels cannot free enough room, keep
        // every queued event and reject only this new event. Equal levels keep
        // FIFO ownership; an all-error overload is still an observable drop.
        if (!fits()) { counters.dropped++; counters.overflow++; return null }
        queue = queue.filter((row, index) => { if (!victims.has(index)) return true; unindex(row); return false })
        queueBytes -= releasedBytes
        counters.dropped += victims.size; counters.overflow += victims.size
      }
      const row = { event, bytes, queryKey }
      queue.push(row); queueBytes += bytes; counters.accepted++
      if (queryKey) queryRows.set(queryKey, row)
      scheduleIfReady(event.level)
      return event.id
    } catch { counters.dropped++; fault('invalid_event'); return null }
  }
  async function drain() {
    while (queue.length) {
      const batch: LogEvent[] = []; let bytes = 0
      while (queue.length && batch.length < LOG_DEFAULTS.batchEntries && bytes + queue[0]!.bytes <= LOG_DEFAULTS.batchBytes) {
        const row = queue.shift()!; unindex(row); queueBytes -= row.bytes; bytes += row.bytes; batch.push(row.event)
      }
      inFlightEntries = batch.length; inFlightBytes = bytes
      try {
        const result = await call<{ stored: number; filtered: number; fallbackSkipped: number; oversized: number; code?: string }>('write', batch)
        counters.oversized += result.oversized; counters.dropped += result.oversized
        counters.stored += result.stored; counters.filtered += result.filtered; counters.fallbackSkipped += result.fallbackSkipped
        if (result.code) { counters.dropped += batch.length - result.filtered - result.oversized - result.stored; fault(result.code) }
        else counters.unavailable = false
      }
      catch (error) {
        if (error instanceof LogServiceError && error.writeOutcome === 'unknown') counters.writeUnknown += batch.length
        else counters.dropped += batch.length
        fault(error instanceof LogServiceError ? error.code : 'storage_unavailable')
      }
      finally { inFlightEntries = 0; inFlightBytes = 0 }
    }
  }
  async function flush() {
    // A drain can have consumed its last row while its finalizer is still
    // pending. Awaiting that promise alone would leave newly accepted rows
    // behind the caller's subsequent read.
    do {
      if (!flushing) flushing = drain().finally(() => { flushing = undefined; if (queue.length) scheduleDrain() })
      await flushing
    } while ((inFlightEntries || queue.length) && !closed)
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
      return guarded<FieldCapturedLogEvent | null>('detail', id)
    },
    async policy() { return { ...await guarded<PolicyView>('policy'), catalog: { integrations: LOG_INTEGRATIONS, profiles: LOG_FIELD_PROFILES }, status: status() } },
    async setPolicy(input: LogPolicyPatch) {
      const result = await guarded<PolicyView | { transitionPending: true }>('policy', validatePolicy(input))
      if ('transitionPending' in result) throw new LogServiceError('policy_capacity_pending', 409)
      emit({ origin: { runtime: 'node', integration: 'application', capture: 'manual' }, module: 'core', source: 'system', operation: 'logging.policy', outcome: 'success' })
      return { ...result, catalog: { integrations: LOG_INTEGRATIONS, profiles: LOG_FIELD_PROFILES } }
    },
    async clear(input: LogFilter & { confirm: boolean }) {
      const f = validateLogFilter(input)
      if (input.confirm !== true || !f.from || !f.to) return invalid()
      const result = await guarded<{ deleted: number; hasMore: boolean }>('clear', f)
      emit({ origin: { runtime: 'node', integration: 'application', capture: 'manual' }, module: 'core', source: 'system', operation: 'logging.clear', outcome: 'success', counts: { done: result.deleted } })
      return result
    },
    async close() {
      if (closed) return
      closing = true; clearInterval(timer); clearInterval(maintenance)
      if (scheduled) { clearImmediate(scheduled); scheduled = undefined }
      let deadline: ReturnType<typeof setTimeout> | undefined
      // An existing drain may have finished consuming rows before its promise
      // settles. Closing disables scheduleDrain, so explicitly drain any tail
      // accepted in that window, within the same shutdown deadline.
      try {
        await Promise.race([(async () => {
          await flush()
          while (queue.length && !closed) await flush()
          await storage.close().catch(() => {})
        })(), new Promise<void>(resolve => { deadline = setTimeout(() => { counters.dropped += queue.length; queue = []; queryRows.clear(); queueBytes = 0; storage.stop('close_timeout'); resolve() }, LOG_DEFAULTS.closeTimeoutMs) })])
      } finally {
        if (deadline) clearTimeout(deadline)
        closed = true
        storage.stop('logging_closed')
        stderr.close()
      }
    },
  }
}
export type LogService = ReturnType<typeof createBufferedLogService>
