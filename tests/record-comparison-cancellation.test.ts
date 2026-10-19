import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, get } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import Database from 'better-sqlite3'
import { createEvent, createError, defineEventHandler, getQuery, setHeader, type H3Event } from 'h3'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDb, schema } from '../db/client'

let comparison: (event: H3Event) => Promise<unknown>
let catalog: (event: H3Event) => Promise<unknown>
let dir: string, db: ReturnType<typeof useDb>, documentId: number, recordId: number
let native: { prepares: number; begins: number; rollbacks: number; closes: number }

beforeAll(async () => {
  for (const [name, value] of Object.entries({ createError, defineEventHandler, getQuery, setHeader })) vi.stubGlobal(name, value)
  comparison = (await import('../server/api/roster/record-comparison.get')).default
  catalog = (await import('../server/api/roster/record-comparison/sources.get')).default
})
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'comparison-route-cancel-'))
  vi.stubEnv('NUXT_DB_PATH', join(dir, 'test.sqlite'))
  db = useDb()
  documentId = db.insert(schema.sourceDocument).values({ source: 'jxj', title: 'Synthetic', path: 'synthetic.pdf' }).returning().get().id
  const enterpriseId = db.insert(schema.enterprise).values({ name: 'Synthetic', nameNorm: 'Synthetic' }).returning().get().id
  recordId = db.insert(schema.record).values({ enterpriseId, source: 'jxj', titleCode: 'specialized_sme' }).returning().get().id
  db.transaction(tx => {
    for (let n = 0; n < 1024; n++) {
      tx.insert(schema.recordEvent).values({ recordId, eventType: 'award', year: 2024 }).run()
      tx.insert(schema.platformQuery).values({ interface: 'business_list', queryKey: `synthetic:${n}`, rdjb: '2', queriedAt: '2026-10-18T00:00:00Z' }).run()
    }
  })
  native = { prepares: 0, begins: 0, rollbacks: 0, closes: 0 }
  // Observe real native calls on the independent read connection; forward every
  // call unchanged. A counter on the cached writer would miss orphaned scans.
  const prepare = Database.prototype.prepare, exec = Database.prototype.exec, close = Database.prototype.close
  const observed = (connection: Database.Database) => connection.name === db.$client.name && connection.readonly
  vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, sql: string) {
    if (observed(this)) native.prepares++
    return prepare.call(this, sql)
  })
  vi.spyOn(Database.prototype, 'exec').mockImplementation(function (this: Database.Database, sql: string) {
    if (observed(this)) {
      if (sql === 'BEGIN') native.begins++
      if (sql === 'ROLLBACK') native.rollbacks++
    }
    return exec.call(this, sql)
  })
  vi.spyOn(Database.prototype, 'close').mockImplementation(function (this: Database.Database) {
    if (observed(this)) native.closes++
    return close.call(this)
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})
afterAll(() => { vi.unstubAllGlobals() })

// Use actual IncomingMessage/ServerResponse lifetimes. The awaited request drain
// models dispatch after an asynchronous request hook, without replacing readers.
async function requestRoute(url: string, run: (event: H3Event) => Promise<unknown>) {
  let resolveResult: (value: unknown) => void, rejectResult: (error: unknown) => void
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject })
  const server = createServer(async (req, res) => {
    try {
      req.resume()
      await once(req, 'end')
      await setImmediate()
      expect(req.complete).toBe(true)
      expect(req.destroyed).toBe(true)
      expect(req.aborted).toBe(false)
      resolveResult(await run(createEvent(req, res)))
    } catch (error) { rejectResult(error) }
    finally { if (!res.destroyed) res.end() }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const client = get({ hostname: '127.0.0.1', port: (server.address() as { port: number }).port, path: url, agent: false }, res => res.resume())
  client.on('error', () => {})
  try { return await result }
  finally { client.destroy(); await new Promise<void>(resolve => server.close(() => resolve())) }
}

describe.each(['comparison', 'catalog'] as const)('%s public route cancellation', route => {
  const handler = (event: H3Event) => (route === 'comparison' ? comparison : catalog)(event)
  const url = () => route === 'comparison'
    ? `/api/roster/record-comparison?queryIds=1&exportBatchIds=&officialSourceDocumentIds=${documentId}&pageSize=1`
    : '/api/roster/record-comparison/sources?kind=query&pageSize=1'

  it('rejects an already closed response before native reads and removes listeners', async () => {
    await expect(requestRoute(url(), async event => {
      const closed = once(event.node.res, 'close')
      event.node.res.destroy()
      await closed
      expect(event.node.res.destroyed).toBe(true)
      expect(event.node.res.closed).toBe(true)
      // A fully drained request can stay non-aborted even when its response dies.
      expect(event.node.req.aborted).toBe(false)
      try { return await handler(event) }
      finally {
        expect(event.node.req.listenerCount('aborted')).toBe(0)
        expect(event.node.res.listenerCount('close')).toBe(0)
      }
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(native).toEqual({ prepares: 0, begins: 0, rollbacks: 0, closes: 0 })
  })

  it('allows a completed request with an open response and releases its snapshot', async () => {
    const result = await requestRoute(url(), async event => {
      expect(event.node.res.destroyed).toBe(false)
      expect(event.node.res.closed).toBe(false)
      expect(event.node.res.writableFinished).toBe(false)
      try { return await handler(event) }
      finally {
        expect(event.node.req.listenerCount('aborted')).toBe(0)
        expect(event.node.res.listenerCount('close')).toBe(0)
      }
    })
    expect(result).toMatchObject({ total: 1024, rows: [expect.any(Object)] })
    expect(native.prepares).toBeGreaterThan(0)
    expect(native).toMatchObject({ begins: 1, rollbacks: 1, closes: 1 })
  })

  it('cancels an ongoing read and releases its snapshot before the next request', async () => {
    await expect(requestRoute(url(), async event => {
      const reading = handler(event)
      // Attach a rejection handler before triggering the real close event.
      const rejected = expect(reading).rejects.toMatchObject({ name: 'AbortError' })
      await setImmediate()
      expect(native.begins).toBe(1)
      expect(native.closes).toBe(0)
      const closed = once(event.node.res, 'close')
      event.node.res.destroy()
      await closed
      await rejected
      expect(event.node.req.listenerCount('aborted')).toBe(0)
      expect(event.node.res.listenerCount('close')).toBe(0)
      return await reading
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(native).toMatchObject({ begins: 1, rollbacks: 1, closes: 1 })
    db.insert(schema.recordEvent).values({ recordId, eventType: 'award', year: 2025 }).run()
    db.insert(schema.platformQuery).values({ interface: 'business_list', queryKey: 'next-commit', rdjb: '2', queriedAt: '2026-10-18T00:00:00Z' }).run()
    expect(db.$client.pragma('wal_checkpoint(TRUNCATE)')).toEqual([{ busy: 0, log: 0, checkpointed: 0 }])
    expect(await requestRoute(url(), handler)).toMatchObject({ total: 1025 })
    expect(native).toMatchObject({ begins: 2, rollbacks: 2, closes: 2 })
  })
})
