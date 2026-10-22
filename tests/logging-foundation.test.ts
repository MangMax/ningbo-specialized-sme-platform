import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogService } from '../lib/logging/service'

const dirs: string[] = []
const services: ReturnType<typeof createLogService>[] = []
function fixture(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'log181-')); dirs.push(dir)
  const service = createLogService({ directory: dir, ...options }); services.push(service)
  return { dir, service }
}
afterEach(async () => { vi.useRealTimers(); for (const s of services.splice(0)) await s.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

it('persists safe events and projects bounded summaries without raw error content', async () => {
  const { service, dir } = fixture()
  service.emit({ source: 'worker', operation: 'fixture.run', outcome: 'failure', level: 'error', taskId: 'task-181', error: new Error('PRIVATE_RAW /Users/private/source Cookie=PRIVATE_TOKEN'), body: { token: 'PRIVATE_TOKEN' }, durationMs: 12 } as any)
  await service.flush()
  const list = await service.list({ taskId: 'task-181', limit: 1 })
  expect(list.rows).toHaveLength(1)
  expect(list.rows[0]).toMatchObject({ source: 'worker', operation: 'fixture.run', outcome: 'failure', durationMs: 12 })
  expect(list.rows[0]).not.toHaveProperty('error')
  const detail = await service.detail(list.rows[0]!.id)
  expect(detail).toMatchObject({ level: 'error', taskId: 'task-181' })
  expect(JSON.stringify({ list, detail })).not.toMatch(/PRIVATE_|\/Users\/|Cookie|body|stack/)
  expect(readFileSync(join(dir,'events.db')).toString('utf8')).not.toMatch(/PRIVATE_|\/Users\/|Cookie/)
})

it('denies every log action without explicit capability and rejects unbounded clearing', async () => {
  const { dispatchLogAction } = await import('../lib/logging/application')
  const { service } = fixture()
  for (const action of ['list','detail','policy','setPolicy','clear'] as const) {
    const denied = await dispatchLogAction(service, action, {}, false)
    expect(denied.status).toBe(401)
    expect(denied.body).toEqual({ error: { code: 'log_access_denied' } })
  }
  expect((await dispatchLogAction(service, 'clear', { confirm: true }, true)).status).toBe(400)
  expect((await dispatchLogAction(service, 'list', { limit: 101 }, true)).status).toBe(400)
})

it('keeps stable disjoint cursors across concurrent appends and survives close and restart', async () => {
  const { dir, service } = fixture()
  for (let i=0;i<5;i++) service.emit({ source: 'worker', operation: 'paging.run', outcome: 'success', resourceId: i })
  await service.flush()
  const first = await service.list({ operation: 'paging.run', limit: 2 })
  service.emit({ source: 'worker', operation: 'paging.run', outcome: 'success', resourceId: 99 })
  await service.flush()
  const second = await service.list({ operation: 'paging.run', limit: 2, cursor: first.nextCursor! })
  const third = await service.list({ operation: 'paging.run', limit: 2, cursor: second.nextCursor! })
  expect(first.rows.map(r => r.resourceId)).toEqual([4,3])
  expect(second.rows.map(r => r.resourceId)).toEqual([2,1])
  expect(third.rows.map(r => r.resourceId)).toEqual([0])
  expect(third.nextCursor).toBeNull()
  service.emit({ source: 'worker', operation: 'close.flush', outcome: 'failure', level: 'error' })
  await service.close()
  const restarted = createLogService({ directory: dir }); services.push(restarted)
  expect((await restarted.list({ operation: 'close.flush' })).rows).toHaveLength(1)
})

it('reports overflow and oversized drops while preserving failure events without sampling', async () => {
  const { service } = fixture({ maxQueueEntries: 2 })
  for (let i=0;i<3;i++) service.emit({ source: 'worker', operation: 'pressure.run', outcome: 'failure', level: 'error' })
  expect(service.status()).toMatchObject({ accepted: 2, dropped: 1, overflow: 1 })
  await service.flush()
  expect((await service.list()).rows).toHaveLength(2)
  const tiny = fixture({ maxEventBytes: 20 }).service
  expect(tiny.emit({ source: 'worker', operation: 'bounded.run', outcome: 'failure' })).toBeNull()
  expect(tiny.status()).toMatchObject({ oversized: 1, dropped: 1, accepted: 0 })
})

it('persists policy changes and confirms only an explicit filtered clear range', async () => {
  const { dir, service } = fixture()
  service.emit({ source: 'worker', operation: 'clear.target', outcome: 'failure' })
  service.emit({ source: 'worker', operation: 'clear.keep', outcome: 'success' })
  await service.flush()
  await service.setPolicy({ retentionDays: 2, maxBytes: 1048576 })
  expect(await service.clear({ from: '2000-01-01', to: '2100-01-01', operation: 'clear.target', confirm: true })).toEqual({ deleted: 1, hasMore: false })
  await service.flush(); await service.close()
  const next = createLogService({ directory: dir }); services.push(next)
  expect(await next.policy()).toMatchObject({ retentionDays: 2, maxBytes: 1048576, cleared: 1 })
  expect((await next.list({ operation: 'clear.keep' })).rows).toHaveLength(1)
  expect((await next.list({ operation: 'logging.clear' })).rows[0]).toMatchObject({ outcome: 'success' })
  expect((await next.list({ operation: 'clear.target' })).rows).toHaveLength(0)
})

it('exposes unavailable and drop accounting when real filesystem storage fails', async () => {
  const { service } = fixture({ directory: '/dev/null/log181' })
  expect(service.emit({ source: 'worker', operation: 'fault.run', outcome: 'success' })).toBeTruthy()
  await service.flush()
  expect(service.status()).toMatchObject({ dropped: 1, stored: 0, unavailable: true, lastError: 'storage_unavailable' })
  const { dispatchLogAction } = await import('../lib/logging/application')
  const result = await dispatchLogAction(service, 'policy', {}, true)
  expect(result.status).toBe(503)
  expect(result.body).toMatchObject({ status: { unavailable: true, dropped: 1 } })
  expect(JSON.stringify(result.body)).not.toContain('/dev/null')
})

it('honors a policy changed by another process owner without reviving startup defaults', async () => {
  const { dir, service } = fixture()
  service.emit({ source: 'worker', operation: 'shared.start', outcome: 'success' }); await service.flush()
  const peer = createLogService({ directory: dir }); services.push(peer)
  await peer.setPolicy({ retentionDays: 3, maxBytes: 2097152 })
  expect(await service.policy()).toMatchObject({ retentionDays: 3, maxBytes: 2097152 })
})

it('bounds drain timeouts and never throws logging failures into callers', async () => {
  const { service } = fixture({ drainTimeoutMs: 1 })
  expect(() => service.emit({ source: 'worker', operation: 'timeout.run', outcome: 'failure', level: 'error' })).not.toThrow()
  await service.flush()
  expect(service.status()).toMatchObject({ dropped: 1, unavailable: true, lastError: 'drain_timeout' })
  const started = Date.now(); await service.close()
  expect(Date.now() - started).toBeLessThan(3100)
})

it('prunes oldest events within the real SQLite page budget and exposes pruning counts', async () => {
  const { service } = fixture({ maxBytes: 1048576 })
  for (let batch=0;batch<15;batch++) {
    for (let row=0;row<64;row++) service.emit({ source: 'worker', operation: 'capacity.run', outcome: 'failure', level: 'error', taskId: 't'.repeat(120), requestId: 'r'.repeat(120), traceId: 'x'.repeat(120), resourceId: batch*64+row, counts: { done: row } })
    await service.flush()
  }
  const policy = await service.policy()
  expect(policy.pruned).toBeGreaterThan(0)
  expect(policy.storageBytes).toBeLessThanOrEqual(1048576)
  expect((await service.list({ limit: 1 })).rows[0]!.resourceId).toBe(959)
  expect(service.status().dropped).toBe(0)
})

it('refuses an existing foreign database without modifying its bytes or schema', async () => {
  const { default: Database } = await import('better-sqlite3')
  const { readFileSync } = await import('node:fs')
  const { dir, service } = fixture()
  const path = join(dir, 'events.db')
  const foreign = new Database(path); foreign.exec('CREATE TABLE business_evidence(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO business_evidence VALUES(1,\'PRIVATE_BUSINESS\')'); foreign.close()
  const before = readFileSync(path)
  service.emit({ source: 'worker', operation: 'foreign.guard', outcome: 'success' }); await service.flush()
  expect(service.status()).toMatchObject({ unavailable: true, dropped: 1, stored: 0 })
  expect(readFileSync(path)).toEqual(before)
})

it('enforces retention at the time boundary and records age pruning independently of clearing', async () => {
  vi.useFakeTimers({ toFake:['Date'] }); vi.setSystemTime(new Date('2026-10-01T00:00:00Z'))
  const { service } = fixture({retentionDays:1})
  service.emit({source:'worker',operation:'age.run',outcome:'success'}); await service.flush()
  vi.setSystemTime(new Date('2026-10-02T00:00:00Z'))
  expect((await service.list()).rows).toHaveLength(1)
  vi.setSystemTime(new Date('2026-10-02T00:00:00.001Z'))
  expect((await service.list()).rows).toHaveLength(0)
  expect(await service.policy()).toMatchObject({pruned:1,cleared:0})
})

it('hides expired rows beyond one bounded maintenance batch', async () => {
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-01T00:00:00Z'))
  const {service}=fixture({retentionDays:1})
  for(let batch=0;batch<20;batch++) {
    for(let i=0;i<64;i++)service.emit({source:'worker',operation:'age.backlog',outcome:'success'})
    await service.flush()
  }
  vi.setSystemTime(new Date('2026-10-03T00:00:00Z'))
  expect((await service.list()).rows).toHaveLength(0)
})

it('refuses to activate a smaller cap until bounded pruning physically satisfies it', async () => {
  const {service}=fixture()
  for(let batch=0;batch<520;batch++) {
    for(let row=0;row<64;row++)service.emit({source:'worker',operation:'shrink.run',outcome:'success',taskId:'t'.repeat(120),requestId:'r'.repeat(120),traceId:'x'.repeat(120),resourceId:'z'.repeat(120)})
    await service.flush()
  }
  const {dispatchLogAction}=await import('../lib/logging/application')
  const pending=await dispatchLogAction(service,'setPolicy',{retentionDays:7,maxBytes:1048576,collection:{integrations:{application:{enabled:false,minLevel:'error'}}}},true)
  expect(pending.status).toBe(409)
  expect(pending.body).toMatchObject({error:{code:'policy_capacity_pending'}})
  expect(await service.policy()).toMatchObject({maxBytes:536870912,revision:0,collection:{integrations:{application:{enabled:true,minLevel:'debug'}}}})
  const applied=await dispatchLogAction(service,'setPolicy',{retentionDays:7,maxBytes:1048576},true)
  expect(applied.status).toBe(200)
  expect(await service.policy()).toMatchObject({maxBytes:1048576})
  expect((await service.policy()).storageBytes).toBeLessThanOrEqual(1048576)
}, 30000)

it('bounds byte-pressure drops and explicit bulk clear batches', async () => {
  const tiny=fixture({maxQueueBytes:100}).service
  tiny.emit({source:'worker',operation:'bytes.run',outcome:'failure'})
  expect(tiny.status()).toMatchObject({dropped:1,overflow:1,queuedBytes:0,accepted:0})
  const {service}=fixture()
  for(let batch=0;batch<20;batch++) {
    for(let row=0;row<64;row++)service.emit({source:'worker',operation:'clear.bulk',outcome:'success'})
    await service.flush()
  }
  const range={from:'2000-01-01',to:'2100-01-01',operation:'clear.bulk',confirm:true}
  expect(await service.clear(range)).toEqual({deleted:1000,hasMore:true})
  expect(await service.clear(range)).toEqual({deleted:280,hasMore:false})
})

it('counts worker stdout rate skips while storing every accepted event', async () => {
  const { service } = fixture({ stdout: true })
  for (let i = 0; i < 20; i++) service.emit({ source: 'system', operation: 'fallback.stall', outcome: 'failure' })
  expect(service.status()).toMatchObject({ accepted: 20, fallbackSkipped: 0, stored: 0 })
  await service.flush()
  expect(service.status()).toMatchObject({ stored: 20, fallbackSkipped: 10, dropped: 0 })
  expect((await service.list({ operation: 'fallback.stall' })).rows).toHaveLength(20)
})
