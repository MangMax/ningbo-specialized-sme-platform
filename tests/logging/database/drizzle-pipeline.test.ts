import { prepareRuntimeLogs } from '../fixtures/runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { sql } from 'drizzle-orm'
import { applicationLogs } from '../../../layers/core/lib/logging'
import { LOG_DEFAULTS, type LogPolicyPatch } from '../../../layers/core/lib/logging/contract'
import { createDrizzleLogger } from '../../../layers/core/lib/logging/drizzle'

describe('Drizzle real evlog and independent PostgreSQL pipeline', () => {
  let directory: string, runtime: Awaited<ReturnType<typeof prepareRuntimeLogs>>, client: Database.Database
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'drizzle-pipeline-'))
    runtime = await prepareRuntimeLogs(directory)
    client = new Database(':memory:')
  })
  afterEach(async () => {
    await runtime?.close()
    vi.restoreAllMocks()
    client.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const base = { retentionDays: 7, maxBytes: LOG_DEFAULTS.maxBytes }
  const query = () => drizzle(client, { logger: createDrizzleLogger({ connection: 'primary' }) })
  const rows = async () => (await applicationLogs().list({ operation: 'db.query.select', limit: 100 })).rows
  async function settle(count: number) {
    await vi.waitFor(async () => {
      await applicationLogs().flush()
      const status = applicationLogs().status()
      expect(status.stored + status.filtered).toBeGreaterThanOrEqual(count)
    })
  }

  it('persists and prints bounded native attempts without SQL params results or native errors', async () => {
    const writes: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any, callback?: any) => { writes.push(String(chunk)); callback?.(); return true })
    const db = query()
    expect(db.get(sql`SELECT ${'PRIVATE_PARAM_MARKER'} value /* PRIVATE_SQL_MARKER */`)).toEqual({ value: 'PRIVATE_PARAM_MARKER' })
    const fault = new Error('PRIVATE_ERROR_MARKER')
    client.function('fail_query', () => { throw fault })
    expect(() => db.get(sql`SELECT fail_query()`)).toThrow(fault)
    await settle(1)
    const listed = await rows()
    expect(listed).toHaveLength(1)
    for (const row of listed) expect(row).toMatchObject({
      source: 'system', operation: 'db.query.select', outcome: 'started', level: 'debug',
      resourceType: 'database_connection', resourceId: 'primary',
      origin: { runtime: 'node', integration: 'drizzle', capture: 'hook' },
      counts: { total: 2 },
    })
    const details = await Promise.all(listed.map(row => applicationLogs().detail(row.id)))
    await vi.waitFor(() => expect(writes.join('')).toContain('db.query.select'))
    for (const text of [JSON.stringify(details), writes.join('')]) {
      expect(text).not.toMatch(/PRIVATE_|fail_query|durationMs|params|stack/)
    }
    // The store also contains field-policy defaults with the legitimate
    // "durationMs" option. Its presence is not a leaked query duration.
    const stored = runtime.psql(['-At', '-c', 'SELECT collection FROM runtime_logs.log_collection WHERE id = 1'])
    expect(stored).toMatch(/"durationMs"\s*:\s*true/)
    const events = runtime.psql(['-At', '-c', 'SELECT row_to_json(event) FROM runtime_logs.log_events AS event'])
    expect(events).not.toMatch(/PRIVATE_|fail_query|params|stack/)
    expect(applicationLogs().status()).toMatchObject({ stored: 1, coalesced: 1, filtered: 0, dropped: 0, writeUnknown: 0 })
  })

  it.each([
    { name: 'disabled-integration', source: { enabled: true, minLevel: 'debug' }, integration: { enabled: false, minLevel: 'debug' } },
    { name: 'disabled-source', source: { enabled: false, minLevel: 'debug' }, integration: { enabled: true, minLevel: 'debug' } },
    { name: 'source-threshold', source: { enabled: true, minLevel: 'info' }, integration: { enabled: true, minLevel: 'debug' } },
    { name: 'integration-threshold', source: { enabled: true, minLevel: 'debug' }, integration: { enabled: true, minLevel: 'info' } },
  ] as const)('source AND integration filtering suppresses rows and stdout: $name', async ({ source, integration }) => {
    const service = applicationLogs()
    // Parent expands the catalog/type in the integration commit.
    await service.setPolicy({ ...base, collection: { sources: { system: source }, integrations: { drizzle: integration } } } as LogPolicyPatch)
    await settle(1)
    const before = service.status()
    const writes: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any, callback?: any) => { writes.push(String(chunk)); callback?.(); return true })
    const db = query()
    expect(db.get(sql`SELECT ${'PRIVATE_DISABLED_MARKER'} value`)).toEqual({ value: 'PRIVATE_DISABLED_MARKER' })
    await settle(before.stored + before.filtered + 1)
    expect(await rows()).toEqual([])
    expect(writes.join('')).not.toContain('db.query')
    expect(service.status().filtered).toBe(before.filtered + 1)
    expect(service.status().dropped).toBe(0)

    await service.setPolicy({ ...base, collection: { sources: { system: { enabled: true, minLevel: 'debug' } }, integrations: { drizzle: { enabled: true, minLevel: 'debug' } } } } as LogPolicyPatch)
    expect(db.get(sql`SELECT 7 value`)).toEqual({ value: 7 })
    await vi.waitFor(async () => { await service.flush(); expect(await rows()).toHaveLength(1) })
    await vi.waitFor(() => expect(writes.join('')).toContain('db.query.select'))
    expect(writes.join('')).not.toContain('PRIVATE_')
  })
})
