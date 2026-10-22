import Database from 'better-sqlite3'
import { realpathSync, statSync } from 'node:fs'
import { channel } from 'node:diagnostics_channel'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { createDrizzleLogger } from '../../lib/logging/drizzle'
import * as schema from '../../db/schema'
import { listPlatformQueries, type PlatformQueryFilter } from '../../lib/platform/read'

type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database }
export interface SummaryCacheOptions {
  maxBytes?: number
  maxEntryBytes?: number
  maxEntries?: number
  ttlMs?: number
  maxSources?: number
  now?: () => number
}
const limits = { maxBytes: 8 * 1024 * 1024, maxEntryBytes: 64 * 1024, maxEntries: 128, ttlMs: 5000, maxSources: 4 }
// Aggregate counters only: no keys, paths, credentials or response data.
const telemetry = channel('ningbo.platform-summary-cache')

function fileIdentity(path: string) {
  const st = statSync(path, { bigint: true })
  return `${path}\0${st.dev}:${st.ino}`
}
function clamp(value: number | undefined, fallback: number, max: number) {
  const n = Number(value)
  return !Number.isFinite(n) || n < 1 ? fallback : Math.min(Math.floor(n), max)
}

/** Committed-only reader. The public REST adapter opts in; MCP/no-store never uses it. */
export function createPlatformSummaryCache(options: SummaryCacheOptions = {}) {
  const budget = { ...limits }
  for (const name of Object.keys(limits) as (keyof typeof limits)[]) {
    const value = options[name] ?? limits[name]
    if (!Number.isSafeInteger(value) || value < 1 || value > limits[name]) throw new RangeError(`Invalid summary cache ${name}`)
    budget[name] = value
  }
  const sources = new Map<string, { db: Db; version: number; generation: number; identity: string }>()
  const entries = new Map<string, { body: Buffer; charge: number; expires: number; source: string }>()
  const now = options.now ?? (() => performance.now())
  let bytes = 0, hits = 0, misses = 0, evictions = 0, bypasses = 0
  function remove(key: string) {
    bytes -= entries.get(key)!.charge
    entries.delete(key)
  }
  function invalidate(path: string) {
    for (const [key, entry] of entries) if (entry.source === path) remove(key)
  }
  function dropSource(path: string) {
    const source = sources.get(path)
    if (!source) return
    invalidate(path)
    source.db.$client.close()
    sources.delete(path)
  }
  const stats = () => ({ hits, misses, entries: entries.size, bytes, sources: sources.size, evictions, bypasses })

  function read(db: Db, filter: PlatformQueryFilter, policy: { allowStore?: boolean }) {
    const page = clamp(filter.page, 1, Number.MAX_SAFE_INTEGER), pageSize = clamp(filter.pageSize, 25, 200)
    // Only the measured first-page, unfiltered metadata scenario. Other selectors remain uncached.
    if (policy.allowStore === false || filter.view !== 'summary' || filter.includeRawResponse || page !== 1 || pageSize > 50
      || filter.queryId != null || filter.interface || filter.queryKey || filter.titleCode || filter.uscc || filter.enterpriseId != null || filter.status
      || !db.$client.name || db.$client.name === ':memory:' || db.$client.inTransaction) {
      bypasses++
      return listPlatformQueries(db, filter)
    }
    for (const [key, entry] of entries) if (entry.expires <= now()) remove(key)
    const request = [filter.view, filter.queryId ?? null, filter.interface ?? null, filter.queryKey || null,
      filter.titleCode || null, filter.uscc || null, filter.enterpriseId ?? null, filter.status ?? null, page, pageSize, false]
    const path = realpathSync(db.$client.name), identity = fileIdentity(path)
    if (sources.get(path)?.identity !== identity) dropSource(path)
    let source = sources.get(path)
    if (!source) {
      while (sources.size >= budget.maxSources) dropSource(sources.keys().next().value!)
      const reader = drizzle(new Database(path, { readonly: true, fileMustExist: true }), { schema, logger: createDrizzleLogger({ connection: 'platform_summary' }) })
      source = { db: reader, version: reader.$client.pragma('data_version', { simple: true }) as number, generation: 0, identity }
      sources.set(path, source)
    }
    sources.delete(path)
    sources.set(path, source)
    // This observer NEVER writes. Compare its own data_version over its own lifetime, never across connections.
    // Commits by the application's writer and external writers both change it; rollback does not.
    const version = source.db.$client.pragma('data_version', { simple: true }) as number
    if (version !== source.version) {
      invalidate(path)
      source.version = version
      source.generation++
    }
    const key = JSON.stringify(['platform-summary-v1', identity, source.generation, 'public-rest-v1', 'queriedAt-desc,id-desc-v1', request])
    const cached = entries.get(key)
    if (cached) {
      hits++
      entries.delete(key)
      entries.set(key, cached)
      return JSON.parse(cached.body.toString()) as ReturnType<typeof listPlatformQueries>
    }
    misses++
    // Synchronous SQLite transaction: a burst cannot create concurrent fills or pending promises.
    // Errors propagate and never become an empty/no_record entry.
    const result = listPlatformQueries(source.db, filter)
    const body = Buffer.from(JSON.stringify(result))
    // Encoded payload + conservative UTF-16 key charge + per-entry overhead. No retained result graph.
    const charge = body.byteLength + 2 * Buffer.byteLength(key) + 256
    // A commit/replacement during the read may return its committed snapshot, but may not publish it.
    if (fileIdentity(path) === identity && !result.rows.some(row => row.query.failureReason)
      && version === source.db.$client.pragma('data_version', { simple: true })
      && charge <= budget.maxBytes && charge <= budget.maxEntryBytes) {
      while (entries.size >= budget.maxEntries || bytes + charge > budget.maxBytes) {
        remove(entries.keys().next().value!)
        evictions++
      }
      entries.set(key, { body, charge, expires: now() + budget.ttlMs, source: path })
      bytes += charge
    }
    return result
  }
  return {
    read(db: Db, filter: PlatformQueryFilter, policy: { allowStore?: boolean } = {}) {
      try { return read(db, filter, policy) }
      finally { if (telemetry.hasSubscribers) telemetry.publish(stats()) }
    },
    stats,
    close() {
      for (const path of sources.keys()) dropSource(path)
    },
  }
}
export const platformSummaryCache = createPlatformSummaryCache()
