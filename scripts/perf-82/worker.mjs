// Actual repository HTTP handlers on real h3/loopback HTTP. This deliberately
// excludes Nitro middleware/build and MCP transport; see report for boundaries.
import { register } from 'node:module'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createServer } from 'node:http'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { appendFileSync, mkdirSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import v8 from 'node:v8'
import * as h3 from 'h3'
import Database from 'better-sqlite3'

register('./loader.mjs', import.meta.url)
const dbPath = realpathSync(process.env.PERF82_DB)
const work = realpathSync(process.env.PERF82_WORK)
if (!dbPath.startsWith(work + '/') || dbPath.includes('/production-docker/')) throw new Error('DB must be under private work directory')
const filesDir = process.env.PERF82_FILES ? realpathSync(process.env.PERF82_FILES) : resolve(work, 'empty-files')
if (!filesDir.startsWith(work + '/')) throw new Error('Files must be under private work directory')
process.env.NUXT_DB_PATH = dbPath
process.env.NUXT_DB_READONLY = process.env.PERF82_WRITE === '1' ? '0' : '1'
// Never inherit production secrets; no external integrations in this harness.
for (const name of Object.keys(process.env)) if (/TOKEN|COOKIE|PASSWORD|SECRET/.test(name)) delete process.env[name]
const originalFetch = globalThis.fetch
globalThis.fetch = (url, ...args) => {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(String(url)).hostname)) throw new Error('External fetch disabled')
  return originalFetch(url, ...args)
}
Object.assign(globalThis, h3, { defineRouteMeta: x => x, useRuntimeConfig: () => ({ apiToken: 'perf82-local-only', mcpToken: '', filesDir, curatedPath: resolve(work, 'empty-files/curated.json'), reconcilePath: resolve(work, 'empty-files/reconcile.json'), ocrToken: '', miitCookie: '' }) })
mkdirSync(filesDir, { recursive: true, mode: 0o700 })
const als = new AsyncLocalStorage()
function sample(m) {
  const usage = process.memoryUsage()
  m.heapPeak = Math.max(m.heapPeak, usage.heapUsed)
  m.rssPeak = Math.max(m.rssPeak, usage.rss)
}
function record(m) {
  sample(m)
  if (process.env.PERF82_METRICS) appendFileSync(process.env.PERF82_METRICS, stringify(m) + '\n', { mode: 0o600 })
}
const originalPrepare = Database.prototype.prepare
Database.prototype.prepare = function (sql) {
  const stmt = originalPrepare.call(this, sql)
  for (const operation of ['all', 'get', 'run']) {
    const execute = stmt[operation]
    stmt[operation] = function (...params) {
      const m = als.getStore()
      if (!m) return execute.apply(this, params)
      record({ ...m, checkpoint: 'sql-start', sqlShape: sql.replace(/\s+/g, ' ').replace(/'[^']*'/g, "'?'") })
      const t = performance.now()
      const result = execute.apply(this, params)
      m.sqlMs += performance.now() - t
      m.sqlCalls++
      const rows = operation === 'all' ? result : operation === 'get' && result ? [result] : []
      m.sqlRows += rows.length
      // SQLite -> JS payload bytes for strings/blobs, not disk I/O. Numbers are
      // counted as 8-byte estimates. Never retain values/parameters in evidence.
      for (const row of rows) for (const value of Object.values(row)) {
        if (typeof value === 'string') m.sqlBytes += Buffer.byteLength(value)
        else if (typeof value === 'number' || typeof value === 'bigint') m.sqlBytes += 8
        else if (Buffer.isBuffer(value)) m.sqlBytes += value.length
      }
      sample(m)
      record({ ...m, checkpoint: 'sql', sqlShape: sql.replace(/\s+/g, ' ').replace(/'[^']*'/g, "'?'") })
      return result
    }
  }
  return stmt
}
const parse = JSON.parse
JSON.parse = function (...args) {
  const m = als.getStore()
  const t = performance.now()
  try { return parse.apply(this, args) }
  finally { if (m) { m.jsonParseMs += performance.now() - t; m.jsonParseCalls++; m.jsonParseBytes += typeof args[0] === 'string' ? Buffer.byteLength(args[0]) : 0; if (m.jsonParseCalls % 100 === 0) sample(m) } }
}
const stringify = JSON.stringify
JSON.stringify = function (...args) {
  const m = als.getStore()
  const t = performance.now()
  try { return stringify.apply(this, args) }
  finally { if (m) { m.serializationMs += performance.now() - t; m.serializationCalls++ } }
}
const definitions = [
  ['GET', '/api/platform/queries', 'platform/queries.get.ts'],
  ['GET', '/api/roster/enterprises', 'roster/enterprises.get.ts'],
  ['GET', '/api/roster/enterprises/:id', 'roster/enterprises/[id].get.ts'],
  ['GET', '/api/roster/record-comparison/sources', 'roster/record-comparison/sources.get.ts'],
  ['GET', '/api/roster/record-comparison', 'roster/record-comparison.get.ts'],
  ['GET', '/api/roster/correspondences', 'roster/correspondences.get.ts'],
  ['GET', '/api/roster/correspondences/events/:id', 'roster/correspondences/events/[id].get.ts'],
  ['GET', '/api/roster/correspondences/relations/:id', 'roster/correspondences/relations/[id].get.ts'],
  ['POST', '/api/roster/correspondences/candidates', 'roster/correspondences/candidates.post.ts'],
  ['GET', '/api/records', 'records.get.ts'], ['GET', '/api/stats', 'stats.get.ts'],
  ['GET', '/api/quality', 'quality.get.ts'], ['GET', '/api/comparison', 'comparison.get.ts'],
  ['GET', '/api/platform/snapshots', 'platform/snapshots.get.ts'],
  ['GET', '/api/platform/snapshots/diff', 'platform/snapshots/diff.get.ts'],
  ['GET', '/api/roster/comparison-scope-proofs', 'roster/comparison-scope-proofs.get.ts'],
  ['GET', '/api/roster/recognitions', 'roster/recognitions.get.ts'],
  ['GET', '/api/roster/differences', 'roster/differences.get.ts'],
  ['GET', '/api/roster/export', 'roster/export.get.ts'],
  ['GET', '/api/export', 'export.get.ts'],
  ['GET', '/api/jobs', 'jobs/index.get.ts'],
  ['GET', '/api/files', 'files/index.get.ts'],
  ['GET', '/api/ocr-results', 'ocr-results/index.get.ts'],
  ['GET', '/api/ocr-results/markdown', 'ocr-results/markdown.get.ts'],
  ['POST', '/api/roster/import/preflight', 'roster/import/preflight.post.ts'],
  ['POST', '/api/roster/import/commit', 'roster/import/commit.post.ts'],
]
const router = h3.createRouter()
for (const [method, path, file] of definitions) {
  const handler = (await import(new URL('../../server/api/' + file, import.meta.url))).default
  router.add(path, handler, method.toLowerCase())
}
const fileBodyHandler = (await import('../../server/api/files/[...path].get.ts')).default
router.get('/__perf82/file-by-path', h3.defineEventHandler(event => {
  event.context.params = { path: String(h3.getQuery(event).path ?? '') }
  return fileBodyHandler(event)
}))
// Offline full-task planning uses the production planner and no external I/O.
router.get('/__perf82/reconcile-targets', h3.defineEventHandler(async () => {
  const { useDb } = await import('../../db/index.ts')
  const { collectReconcileTargets } = await import('../../server/utils/platform-reconcile.ts')
  const result = collectReconcileTargets(useDb())
  // Keep the real full traversal; only the diagnostic response is a summary.
  return { targetCount: result.targets?.length ?? result.all?.length ?? null, keys: Object.keys(result) }
}))
router.get('/__perf82/ocr-pages', h3.defineEventHandler(async event => {
  const { useDb } = await import('../../db/index.ts')
  const { listOcrResults, ocrMarkdown } = await import('../../server/utils/ocr-result.ts')
  const query = h3.getQuery(event)
  return query.markdown === '1' ? ocrMarkdown(useDb(), Number(query.fileId)) : listOcrResults(useDb(), Number(query.fileId)).map(row => ({ page: row.page, chars: row.markdown.length }))
}))
router.get('/__perf82/calibration-block', h3.defineEventHandler(() => {
  const start = performance.now()
  while (performance.now() - start < 200) { /* deliberate telemetry calibration */ }
  return { diagnosticBlockedMs: 200 }
}))
const histogram = monitorEventLoopDelay({ resolution: 10 })
histogram.enable()
let lastHeartbeat = performance.now(), heartbeatDriftMaxMs = 0
const heartbeat = setInterval(() => {
  const now = performance.now()
  heartbeatDriftMaxMs = Math.max(heartbeatDriftMaxMs, now - lastHeartbeat - 10)
  lastHeartbeat = now
}, 10)
heartbeat.unref()
const app = h3.createApp()
app.use(h3.defineEventHandler(event => {
  const start = performance.now()
  const usage = process.memoryUsage()
  const m = { id: event.node.req.headers['x-perf82-id'] ?? 'unknown', sqlMs: 0, sqlCalls: 0, sqlRows: 0, sqlBytes: 0,
    jsonParseMs: 0, jsonParseCalls: 0, jsonParseBytes: 0, serializationMs: 0, serializationCalls: 0,
    heapStart: usage.heapUsed, heapPeak: usage.heapUsed, rssPeak: usage.rss }
  event.node.res.once('finish', () => {
    m.serverMs = performance.now() - start
    m.status = event.node.res.statusCode
    m.checkpoint = 'finish'
    // Residual includes Drizzle mapping, JSON-independent logic, sanitization,
    // instrumentation, h3 handling and any async waits; not pure CPU aggregation.
    m.logicResidualMs = m.serverMs - m.sqlMs - m.jsonParseMs - m.serializationMs
    record(m)
    process.send?.({ type: 'metric', value: m })
  })
  return als.run(m, async () => {
    const result = await router.handler(event)
    // h3 otherwise serializes after leaving this diagnostic async context.
    // Use the same JSON serialization explicitly so its cost is attributable.
    if (result !== null && typeof result === 'object' && !Buffer.isBuffer(result) && !ArrayBuffer.isView(result) && !(result instanceof ArrayBuffer) && typeof result.pipe !== 'function') {
      const text = JSON.stringify(result)
      sample(m)
      h3.setHeader(event, 'content-type', 'application/json; charset=utf-8')
      return text
    }
    return result
  })
}))
const server = createServer(h3.toNodeListener(app))
server.listen(0, '127.0.0.1', () => process.send?.({ type: 'ready', port: server.address().port, heapLimit: v8.getHeapStatistics().heap_size_limit, node: process.version }))
process.on('message', async message => {
  if (message === 'loop') {
    // Let timer histogram observe the just-finished blocking request.
    await new Promise(r => setTimeout(r, 30))
    process.send?.({ type: 'loop', value: { minMs: histogram.min / 1e6, p50Ms: histogram.percentile(50) / 1e6, p95Ms: histogram.percentile(95) / 1e6, p99Ms: histogram.percentile(99) / 1e6, maxMs: histogram.max / 1e6, heartbeatDriftMaxMs, lifetimeMaxRssKiB: process.resourceUsage().maxRSS } })
    histogram.reset()
    heartbeatDriftMaxMs = 0
  }
  if (message === 'stop') server.close(() => process.exit(0))
})
