import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogService, type LogServiceOptions } from '../../../lib/logging/service'
const owned: { root: string; service: ReturnType<typeof createLogService> }[] = []
function fixture(options: Omit<Partial<LogServiceOptions>, 'directory'> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'logging-overload-180-'))
  const service = createLogService({ directory: root, ...options })
  owned.push({ root, service }); return service
}
afterEach(async () => { for (const f of owned.splice(0)) { await f.service.close(); rmSync(f.root, { recursive: true, force: true }) } })
it('admits a task failure terminal when the bounded queue is full of debug query attempts', async () => {
  const service = fixture({ maxQueueEntries: 4 })
  for (let i = 0; i < 4; i++) expect(service.emit({ source: 'system', operation: 'db.query.select', outcome: 'started', level: 'debug', origin: { runtime: 'node', integration: 'drizzle', capture: 'hook' }, resourceId: i })).not.toBeNull()
  const id = service.emit({ source: 'task', operation: 'task.finished', outcome: 'failure', errorCode: 'job_failed', taskId: 'terminal-overload' })
  expect(id, JSON.stringify(service.status())).not.toBeNull()
  expect(service.status().queuedEntries).toBeLessThanOrEqual(4)
  await service.flush()
  const rows = (await service.list({ taskId: 'terminal-overload' })).rows
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ operation: 'task.finished', outcome: 'failure', errorCode: 'job_failed' })
})
it('keeps all five events when the same debug burst drains before the terminal arrives', async () => {
  const service = fixture({ maxQueueEntries: 4 })
  for (let i = 0; i < 4; i++) service.emit({ source: 'system', operation: 'db.query.select', outcome: 'started', level: 'debug' })
  await service.flush()
  expect(service.emit({ source: 'task', operation: 'task.finished', outcome: 'failure', taskId: 'after-drain' })).not.toBeNull()
  await service.flush()
  expect((await service.list()).rows).toHaveLength(5)
  expect(service.status()).toMatchObject({ dropped: 0, overflow: 0, drainFailures: 0 })
})
it('still reports hard overflow when only error events fill the queue', async () => {
  const service = fixture({ maxQueueEntries: 2 })
  const first = service.emit({ source: 'worker', operation: 'failed.first', outcome: 'failure' })
  const second = service.emit({ source: 'worker', operation: 'failed.second', outcome: 'failure' })
  expect(service.emit({ source: 'worker', operation: 'failed.third', outcome: 'failure' })).toBeNull()
  await service.flush()
  expect((await service.list()).rows.map(row => row.id)).toEqual([second, first])
  expect(service.status()).toMatchObject({ accepted: 2, stored: 2, dropped: 1, overflow: 1, drainFailures: 0 })
})

const severityPairs = [
  ['debug', 'debug', false], ['debug', 'info', true], ['debug', 'warn', true], ['debug', 'error', true],
  ['info', 'debug', false], ['info', 'info', false], ['info', 'warn', true], ['info', 'error', true],
  ['warn', 'debug', false], ['warn', 'info', false], ['warn', 'warn', false], ['warn', 'error', true],
  ['error', 'debug', false], ['error', 'info', false], ['error', 'warn', false], ['error', 'error', false],
] as const
it.each(severityPairs)('full queue keeps the correct event for %s then %s', async (oldLevel, nextLevel, replaces) => {
  const service = fixture({ maxQueueEntries: 1 })
  const original = service.emit({ source: 'system', operation: 'first.event', outcome: 'started', level: oldLevel })
  const next = service.emit({ source: 'task', operation: 'next.event', outcome: 'started', level: nextLevel })
  expect(next === null).toBe(!replaces)
  expect(service.status()).toMatchObject({ queuedEntries: 1, dropped: 1, overflow: 1, accepted: replaces ? 2 : 1 })
  await service.flush()
  expect((await service.list()).rows.map(row => row.id)).toEqual([replaces ? next : original])
})
it('releases enough lower severity bytes while preserving surviving FIFO order and both queue budgets', async () => {
  const { safeLogEvent } = await import('../../../lib/logging/privacy')
  const small = { source: 'system', operation: 'small.event', outcome: 'started', level: 'debug', resourceId: '0' } as const
  const large = { source: 'task', operation: 'task.finished', outcome: 'failure', resourceId: 'L'.repeat(80) } as const
  const size = Buffer.byteLength(JSON.stringify(safeLogEvent(small)))
  const largeSize = Buffer.byteLength(JSON.stringify(safeLogEvent(large)))
  expect(largeSize).toBeGreaterThan(size); expect(largeSize).toBeLessThanOrEqual(2 * size)
  const service = fixture({ maxQueueEntries: 4, maxQueueBytes: 3 * size })
  const ids = [0, 1, 2].map(i => service.emit({ ...small, resourceId: String(i) }))
  expect(ids.every(Boolean)).toBe(true)
  const terminal = service.emit(large)
  expect(terminal).not.toBeNull()
  expect(service.status()).toMatchObject({ queuedEntries: 2, accepted: 4, dropped: 2, overflow: 2 })
  expect(service.status().queuedBytes).toBeLessThanOrEqual(3 * size)
  await service.flush()
  expect((await service.list()).rows.map(row => row.id)).toEqual([terminal, ids[2]])
})
it('rejects atomically without discarding lower events when protected bytes still prevent admission', async () => {
  const { safeLogEvent } = await import('../../../lib/logging/privacy')
  const low = { source: 'system', operation: 'low.event', outcome: 'started', level: 'debug' } as const
  const high = { source: 'worker', operation: 'high.event', outcome: 'failure' } as const
  const next = { source: 'http', operation: 'next.event', outcome: 'denied', level: 'warn', resourceId: 'L'.repeat(80) } as const
  const size = (event: Parameters<typeof safeLogEvent>[0]) => Buffer.byteLength(JSON.stringify(safeLogEvent(event)))
  const budget = size(low) + size(high)
  expect(size(next)).toBeGreaterThan(size(low)); expect(size(next)).toBeLessThanOrEqual(budget)
  const service = fixture({ maxQueueEntries: 3, maxQueueBytes: budget })
  const first = service.emit(low), second = service.emit(high)
  expect(service.emit(next)).toBeNull()
  expect(service.status()).toMatchObject({ queuedEntries: 2, queuedBytes: budget, accepted: 2, dropped: 1, overflow: 1 })
  await service.flush()
  expect((await service.list()).rows.map(row => row.id)).toEqual([second, first])
})
it('never evicts in flight events while prioritizing the still queued batch', async () => {
  const service = fixture({ maxQueueEntries: 2 })
  const event = { source: 'system', operation: 'db.query.select', outcome: 'started', level: 'debug' } as const
  const inFlight = [service.emit(event), service.emit(event)]
  const draining = service.flush()
  expect(service.status()).toMatchObject({ inFlightEntries: 2, queuedEntries: 0 })
  const evicted = service.emit(event), survivor = service.emit(event)
  const terminal = service.emit({ source: 'task', operation: 'task.finished', outcome: 'success' })
  expect(service.status()).toMatchObject({ inFlightEntries: 2, queuedEntries: 2, dropped: 1, overflow: 1 })
  await draining
  expect((await service.list()).rows.map(row => row.id)).toEqual([terminal, survivor, inFlight[1], inFlight[0]])
  expect((await service.list()).rows.map(row => row.id)).not.toContain(evicted)
})
it('keeps current collection and field policies authoritative after priority admission', async () => {
  const service = fixture({ maxQueueEntries: 4 })
  await service.setPolicy({ retentionDays: 7, maxBytes: 536870912,
    collection: { integrations: { drizzle: { enabled: false, minLevel: 'debug' } } },
    fieldControls: { http: { warn: { httpRoute: false } } },
  })
  await service.flush()
  for (let i = 0; i < 4; i++) service.emit({ source: 'system', operation: 'db.query.select', outcome: 'started', level: 'debug', origin: { runtime: 'node', integration: 'drizzle', capture: 'hook' } })
  const id = service.emit({ source: 'http', operation: 'http.request', outcome: 'denied', level: 'warn', origin: { runtime: 'node', integration: 'nuxt-nitro', capture: 'framework' }, httpMethod: 'GET', httpRoute: '/api/files/:id', statusCode: 403 })
  expect(id).not.toBeNull()
  await service.flush()
  const result = await service.detail(id!)
  expect(result).toMatchObject({ httpMethod: 'GET', statusCode: 403, fieldCapture: { profile: 'http', disabled: ['httpRoute'] } })
  expect(result).not.toHaveProperty('httpRoute')
  expect((await service.list({ operation: 'db.query.select' })).rows).toHaveLength(0)
  expect(service.status()).toMatchObject({ filtered: 3, dropped: 1, overflow: 1, drainFailures: 0 })
})
it('replaces the lowest severity first even when an older info event is also eligible', async () => {
  const service = fixture({ maxQueueEntries: 3 })
  const info = service.emit({ source: 'http', operation: 'first.info', outcome: 'success' })
  const debug = service.emit({ source: 'system', operation: 'later.debug', outcome: 'started', level: 'debug' })
  const warning = service.emit({ source: 'http', operation: 'later.warning', outcome: 'denied', level: 'warn' })
  const error = service.emit({ source: 'task', operation: 'task.finished', outcome: 'failure' })
  expect(error).not.toBeNull()
  await service.flush()
  const ids = (await service.list()).rows.map(row => row.id)
  expect(ids).toEqual([error, warning, info])
  expect(ids).not.toContain(debug)
})
it('still applies a later disable rule to an already prioritized queued failure', async () => {
  const service = fixture({ maxQueueEntries: 3 })
  for (let i = 0; i < 3; i++) service.emit({ source: 'system', operation: 'db.query.select', outcome: 'started', level: 'debug' })
  expect(service.emit({ source: 'task', operation: 'task.finished', outcome: 'failure', taskId: 'disabled-priority' })).not.toBeNull()
  await service.setPolicy({ retentionDays: 7, maxBytes: 536870912, collection: { sources: { task: { enabled: false, minLevel: 'debug' } } } })
  await service.flush()
  expect((await service.list({ taskId: 'disabled-priority' })).rows).toHaveLength(0)
  // Early drain frees pending rows while the management RPC is completing;
  // its metadata no longer evicts a second diagnostic just to obtain a slot.
  expect(service.status()).toMatchObject({ filtered: 1, dropped: 1, overflow: 1, drainFailures: 0 })
})
