import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogService, type LogServiceOptions } from '../../../layers/core/lib/logging/service'
import { LOG_DEFAULTS, type LogInput } from '../../../layers/core/lib/logging/contract'
import { safeLogEvent } from '../../../layers/core/lib/logging/privacy'

const owned: { root: string; service: ReturnType<typeof createLogService> }[] = []
function fixture(options: Omit<Partial<LogServiceOptions>, 'directory'> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'logging-reliability-180-'))
  const service = createLogService({ directory: root, ...options })
  owned.push({ root, service }); return service
}
const attempt = (extra: Partial<LogInput> = {}): LogInput => ({ source: 'system', operation: 'db.query.select', outcome: 'started', level: 'debug', origin: { runtime: 'node', integration: 'drizzle', capture: 'hook' }, resourceType: 'database_connection', resourceId: 'primary', ...extra })
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); for (const f of owned.splice(0)) { await f.service.close(); rmSync(f.root, { recursive: true, force: true }) } })

it('coalesces ten thousand query attempts while preserving every task terminal without overflow', async () => {
  const service = fixture()
  for (let task = 0; task < 100; task++) {
    for (let query = 0; query < 100; query++) expect(service.emit(attempt({ taskId: 'task-' + task }))).not.toBeNull()
    service.emit({ source: 'task', operation: 'task.finished', outcome: 'success', taskId: 'task-' + task })
  }
  expect(service.status()).toMatchObject({ accepted: 200, coalesced: 9900, dropped: 0, overflow: 0, queuedEntries: 200 })
  await service.flush()
  const rows = (await service.list({ source: 'system', limit: 100 })).rows
  expect(rows).toHaveLength(100)
  expect(rows.reduce((n, row) => n + row.counts!.total!, 0)).toBe(10000)
  expect((await service.list({ source: 'task', limit: 100 })).rows).toHaveLength(100)
  expect(service.status()).toMatchObject({ stored: 200, dropped: 0, writeUnknown: 0, queuedEntries: 0, inFlightEntries: 0 })
})

it.each([
  { name: 'request', extra: { requestId: 'other-request' } },
  { name: 'trace', extra: { traceId: 'other-trace' } },
  { name: 'task', extra: { taskId: 'other-task' } },
  { name: 'file', extra: { fileId: 2 } },
  { name: 'page', extra: { page: 2 } },
  { name: 'batch', extra: { batchId: 'other-batch' } },
  { name: 'audit', extra: { auditId: 2 } },
  { name: 'receipt', extra: { receiptId: 2 } },
  { name: 'parent', extra: { parentEventId: 'other-parent' } },
  { name: 'connection', extra: { resourceId: 'enterprise_read' } },
  { name: 'verb', extra: { operation: 'db.query.update' } },
  { name: 'execution', extra: { origin: { runtime: 'node', integration: 'drizzle', capture: 'hook', execution: 'worker' } } },
] satisfies { name: string; extra: Partial<LogInput> }[])('keeps different $name facts in separate query summaries', async ({ extra }) => {
  const service = fixture()
  const first = service.emit(attempt()), second = service.emit(attempt(extra))
  expect(first).not.toBe(second)
  expect(service.emit(attempt())).toBe(first)
  await service.flush()
  expect(await service.detail(first!)).toMatchObject({ counts: { total: 2 } })
  expect(await service.detail(second!)).toMatchObject({ ...extra, counts: { total: 1 } })
})

it('ends a query summary segment at a business event and keeps the first identity and timestamp', async () => {
  const service = fixture()
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-24T09:00:00Z'))
  const first = service.emit(attempt())
  vi.setSystemTime(new Date('2026-10-24T09:00:01Z'))
  expect(service.emit(attempt())).toBe(first)
  const terminal = service.emit({ source: 'task', operation: 'task.finished', outcome: 'success' })
  const next = service.emit(attempt())
  expect(next).not.toBe(first)
  await service.flush()
  expect((await service.list()).rows.map(row => row.id)).toEqual([next, terminal, first])
  expect(await service.detail(first!)).toMatchObject({ timestamp: '2026-10-24T09:00:00.000Z', counts: { total: 2 }, outcome: 'started' })
})

it.each([
  { name: 'non-native', extra: { origin: undefined } },
  { name: 'failure', extra: { outcome: 'failure' } },
  { name: 'info', extra: { level: 'info' } },
  { name: 'custom-operation', extra: { operation: 'db.query.custom' } },
  { name: 'unknown-connection', extra: { resourceId: 'not-a-purpose' } },
  { name: 'existing-counts', extra: { counts: { total: 9 } } },
] satisfies { name: string; extra: Partial<LogInput> }[])('never coalesces $name records', async ({ extra }) => {
  const service = fixture()
  const first = service.emit(attempt(extra)), second = service.emit(attempt(extra))
  expect(first).not.toBe(second)
  await service.flush()
  expect((await service.list()).rows).toHaveLength(2)
  expect(service.status()).toMatchObject({ coalesced: 0, stored: 2 })
})

it('does not mutate an in flight summary and removes drained and evicted index entries', async () => {
  const service = fixture({ maxQueueEntries: 2 })
  const first = service.emit(attempt())
  service.emit(attempt())
  const draining = service.flush()
  const second = service.emit(attempt())
  expect(second).not.toBe(first)
  await draining
  expect(await service.detail(first!)).toMatchObject({ counts: { total: 2 } })
  expect(await service.detail(second!)).toMatchObject({ counts: { total: 1 } })
  const evicted = service.emit(attempt())
  service.emit({ source: 'http', operation: 'filler', outcome: 'success' })
  service.emit({ source: 'task', operation: 'terminal', outcome: 'failure' })
  await service.flush()
  expect(await service.detail(evicted!)).toBeNull()
  const fresh = service.emit(attempt())
  expect(fresh).not.toBe(evicted)
  await service.flush()
  expect(await service.detail(fresh!)).toMatchObject({ counts: { total: 1 } })
})

it('accounts for count growth and splits a summary at the exact single event byte limit', async () => {
  const bytes = Buffer.byteLength(JSON.stringify({ ...safeLogEvent(attempt()), counts: { total: 9 } }))
  const service = fixture({ maxEventBytes: bytes, maxQueueBytes: bytes * 2 })
  const first = service.emit(attempt())
  for (let n = 2; n <= 9; n++) expect(service.emit(attempt())).toBe(first)
  const next = service.emit(attempt())
  expect(next).not.toBe(first)
  expect(next).not.toBeNull()
  expect(service.status()).toMatchObject({ accepted: 2, coalesced: 8, dropped: 0, queuedBytes: bytes * 2 })
  await service.flush()
  expect(await service.detail(first!)).toMatchObject({ counts: { total: 9 } })
  expect(await service.detail(next!)).toMatchObject({ counts: { total: 1 } })
})

it('keeps source and integration policy authoritative for queued query summaries', async () => {
  const service = fixture()
  const first = service.emit(attempt()); service.emit(attempt())
  await service.setPolicy({ retentionDays: 7, maxBytes: LOG_DEFAULTS.maxBytes, collection: { integrations: { drizzle: { enabled: false, minLevel: 'debug' } } } })
  await service.flush()
  expect(await service.detail(first!)).toBeNull()
  expect(service.status()).toMatchObject({ coalesced: 1, filtered: 1, dropped: 0, writeUnknown: 0 })
  await service.setPolicy({ retentionDays: 7, maxBytes: LOG_DEFAULTS.maxBytes, collection: { integrations: { drizzle: { enabled: true, minLevel: 'debug' } } } })
  const fresh = service.emit(attempt()); await service.close()
  // An explicit close must persist the last aggregate rather than leaving a producer timer behind.
  expect(service.status()).toMatchObject({ closed: true, queuedEntries: 0, inFlightEntries: 0 })
  expect(fresh).not.toBe(first)
})

it.each(['batch', 'warning'] as const)('schedules one early drain for %s without waiting for the periodic timer', async mode => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setImmediate', 'clearImmediate'] })
  const service = fixture()
  const size = mode === 'batch' ? LOG_DEFAULTS.batchEntries : 1
  for (let i = 0; i < size; i++) service.emit({ source: 'task', operation: 'schedule.event', outcome: 'started', level: mode === 'batch' ? 'info' : 'warn', resourceId: i })
  expect(service.status()).toMatchObject({ queuedEntries: size, inFlightEntries: 0, pending: 0 })
  expect(vi.getTimerCount()).toBe(3) // Two intervals and one coalesced immediate, not one per emit.
  await vi.advanceTimersByTimeAsync(0)
  expect(service.status().queuedEntries).toBe(0)
  await service.flush()
  expect(service.status()).toMatchObject({ stored: size, dropped: 0, writeUnknown: 0 })
})

it('drains an event arriving between an empty flush and its completion without waiting for a timer', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setImmediate', 'clearImmediate'] })
  const service = fixture()
  const empty = service.flush()
  service.emit({ source: 'task', operation: 'handoff.event', outcome: 'success' })
  await empty
  expect(vi.getTimerCount()).toBe(3)
  await vi.advanceTimersByTimeAsync(0)
  await service.flush()
  expect(service.status()).toMatchObject({ stored: 1, queuedEntries: 0, writeUnknown: 0 })
})

it('schedules on the byte budget before the entry batch threshold and closes without a pending immediate', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setImmediate', 'clearImmediate'] })
  const scheduled = vi.spyOn(globalThis, 'setImmediate')
  const cancelled = vi.spyOn(globalThis, 'clearImmediate')
  const input = { source: 'task', operation: 'bytes.schedule', outcome: 'success' } as const
  const bytes = Buffer.byteLength(JSON.stringify(safeLogEvent(input)))
  const service = fixture({ maxQueueBytes: bytes * 2 })
  service.emit(input); service.emit(input)
  expect(service.status()).toMatchObject({ queuedEntries: 2, queuedBytes: bytes * 2 })
  expect(vi.getTimerCount()).toBe(3)
  const drainHandle = scheduled.mock.results[0]!.value
  await service.close()
  expect(cancelled).toHaveBeenCalledWith(drainHandle)
  expect(service.status()).toMatchObject({ closed: true, stored: 2, queuedEntries: 0 })
})

it('does not exceed the queue byte budget when a count gains a digit and no split fits', async () => {
  const bytes = Buffer.byteLength(JSON.stringify({ ...safeLogEvent(attempt()), counts: { total: 9 } }))
  const service = fixture({ maxQueueBytes: bytes })
  const first = service.emit(attempt())
  for (let i = 2; i <= 9; i++) expect(service.emit(attempt())).toBe(first)
  expect(service.emit(attempt())).toBeNull()
  expect(service.status()).toMatchObject({ coalesced: 8, overflow: 1, dropped: 1, queuedEntries: 1, queuedBytes: bytes })
  await service.flush()
  expect(await service.detail(first!)).toMatchObject({ counts: { total: 9 } })
})

it('keeps exact UTF8 byte accounting across interleaved summary digit boundaries', async () => {
  const a = attempt({ requestId: 'request-a' }), b = attempt({ requestId: 'request-b' })
  const size = (input: LogInput, total: number) => Buffer.byteLength(JSON.stringify({ ...safeLogEvent(input), counts: { total } }), 'utf8')
  const expected = size(a, 10) + size(b, 100)
  const service = fixture({ maxQueueBytes: expected })
  const first = service.emit(a), second = service.emit(b)
  for (let n = 2; n <= 100; n++) {
    if (n <= 10) expect(service.emit(a)).toBe(first)
    expect(service.emit(b)).toBe(second)
    expect(service.status().queuedBytes).toBe(size(a, Math.min(n, 10)) + size(b, n))
  }
  expect(service.status()).toMatchObject({ accepted: 2, coalesced: 108, queuedBytes: expected, overflow: 0, dropped: 0 })
  await service.flush()
  expect(await service.detail(first!)).toMatchObject({ counts: { total: 10 } })
  expect(await service.detail(second!)).toMatchObject({ counts: { total: 100 } })
})
