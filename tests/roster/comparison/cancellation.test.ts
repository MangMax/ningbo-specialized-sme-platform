import { submitNativePlatformQuery } from '../../platform/fixtures/native-query'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, get } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { createEvent, createError, defineEventHandler, getQuery, setHeader, type H3Event } from 'h3'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { initializeDb, schema } from '../../../db/client'
import { closePostgresDirectoryDb } from '../../../db/postgresql/client'
import { recordEvent } from '../../../db/postgresql/ledger-tables'
import { writePostgresCollectionHeader } from '../../../layers/sme-roster/lib/platform/postgres-collection-write'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'

let comparison: (event: H3Event) => Promise<unknown>
let catalog: (event: H3Event) => Promise<unknown>
const dir = mkdtempSync(join(tmpdir(), 'comparison-route-cancel-'))
const applicationName = 'comparison-http-reader'
const initialCount = 8
let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
let control: pg.Pool | undefined
let documentId: number, recordId: number

beforeAll(async () => {
  const sourcePath = join(dir, 'seed.sqlite')
  const seed = initializeDb({ create: true, dbPath: sourcePath })
  try {
    documentId = seed.insert(schema.sourceDocument).values({ source: 'jxj', title: 'Synthetic', path: 'synthetic.pdf' }).returning().get().id
    const enterpriseId = seed.insert(schema.enterprise).values({ name: 'Synthetic', nameNorm: 'Synthetic' }).returning().get().id
    recordId = seed.insert(schema.record).values({ enterpriseId, source: 'jxj', titleCode: 'specialized_sme' }).returning().get().id
    seed.transaction(tx => {
      for (let n = 0; n < initialCount; n++) {
        tx.insert(schema.recordEvent).values({ recordId, eventType: 'award', year: 2024 }).run()
        submitNativePlatformQuery(tx, { rawResponse: '{}', interface: 'business_list', queryKey: `synthetic:${n}`, rdjb: '2', queriedAt: '2026-10-18T00:00:00Z' })
      }
    })
  } finally { seed.$client.close() }
  postgres = await postgresRuntimeFixture({ dir, sourcePath })
  const url = new URL(postgres.url)
  url.searchParams.set('application_name', applicationName)
  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', url.href)
  vi.stubEnv('NUXT_DB_READONLY', '0')
  control = new pg.Pool({ connectionString: postgres.url })
  for (const [name, value] of Object.entries({ createError, defineEventHandler, getQuery, setHeader })) vi.stubGlobal(name, value)
  comparison = (await import('../../../layers/sme-roster/server/api/roster/record-comparison.get')).default
  catalog = (await import('../../../layers/sme-roster/server/api/roster/record-comparison/sources.get')).default
}, 90_000)
afterAll(async () => {
  try {
    await closePostgresDirectoryDb()
    await control?.end()
  } finally {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    postgres?.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

async function activeReaderTransactions(waitingForLock = false) {
  const { rows } = await control!.query(`SELECT pid FROM pg_stat_activity
    WHERE application_name = $1 AND xact_start IS NOT NULL
      AND (NOT $2::boolean OR wait_event_type = 'Lock')`, [applicationName, waitingForLock])
  return rows
}

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

  it('rejects an already closed response and removes listeners', async () => {
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
    expect(result).toMatchObject({ total: initialCount, rows: [expect.any(Object)] })
    expect(await activeReaderTransactions()).toEqual([])
  })

  it('cancels an ongoing read and releases its snapshot before the next request', async () => {
    const blocker = await control!.connect()
    try {
      await blocker.query('BEGIN')
      // Both readers join the formal-event table. Hold that read in PostgreSQL
      // until the real ServerResponse closes to remove timing dependence.
      await blocker.query('LOCK TABLE business.record_event IN ACCESS EXCLUSIVE MODE')
      await expect(requestRoute(url(), async event => {
        const reading = handler(event)
        void reading.catch(() => {})
        try {
          await vi.waitFor(async () => expect(await activeReaderTransactions(true)).toHaveLength(1))
          const closed = once(event.node.res, 'close')
          event.node.res.destroy()
          await closed
        } finally { await blocker.query('ROLLBACK') }
        try { return await reading }
        finally {
          expect(event.node.req.listenerCount('aborted')).toBe(0)
          expect(event.node.res.listenerCount('close')).toBe(0)
        }
      })).rejects.toMatchObject({ name: 'AbortError' })
    } finally { blocker.release() }
    expect(await activeReaderTransactions()).toEqual([])

    const db = drizzle(control!)
    if (route === 'comparison') {
      await db.insert(recordEvent).values({ recordId, eventType: 'award', year: 2025 })
    } else {
      const createdAt = '2026-10-18T00:00:00Z'
      await db.transaction(tx => writePostgresCollectionHeader(tx, {
        queryText: JSON.stringify({ rawResponse: '{}', interface: 'business_list', queryKey: 'next-commit', rdjb: '2', queriedAt: createdAt }),
        evidenceText: null,
        createdAt,
        assignments: [],
      }))
    }
    expect(await requestRoute(url(), handler)).toMatchObject({ total: initialCount + 1 })
  })
})
