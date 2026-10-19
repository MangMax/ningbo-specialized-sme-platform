#!/usr/bin/env node
/** #85 isolated synthetic SQLite + public application REST/MCP adapter benchmark.
 * node --expose-gc --max-old-space-size=2048 scripts/bench-correspondence-reads.mjs prepare /absolute/scratch.db [scale=1]
 * node --expose-gc --max-old-space-size=2048 scripts/bench-correspondence-reads.mjs read /absolute/scratch.db [scale=1] [source-root=cwd] [concurrency=1] [rounds=20]
 * Source-root allows identical-input comparison against a detached baseline checkout.
 * Does not read production, publish raw data, or mutate an existing DB during measurement.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { performance, monitorEventLoopDelay } from 'node:perf_hooks'
import { execFileSync } from 'node:child_process'
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const { createJiti } = createRequire(import.meta.resolve('nuxt/package.json'))('jiti')
const jiti = createJiti(import.meta.url)
const [action, dbPath, scaleText = '1', rootText = process.cwd(), concurrencyText = '1', roundsText = '20'] = process.argv.slice(2)
const scale = Number(scaleText), root = resolve(rootText), concurrency = Number(concurrencyText), rounds = Number(roundsText)
assert.ok(['prepare', 'read'].includes(action) && dbPath?.startsWith('/') && !dbPath.includes('full-snapshot') && [1, 2, 5].includes(scale) && [1, 2, 5].includes(concurrency))
if (action === 'prepare') assert.ok(!existsSync(dbPath), 'prepare requires a new isolated synthetic DB')
const { useDb, schema } = await jiti.import(root + '/db/client.ts')
const db = useDb({ dbPath, readOnly: action === 'read' })
if (action === 'prepare') {
  const raw = 'synthetic-source🙂'.repeat(2048), provenance = { syntheticOriginal: 'synthetic'.repeat(4096) }
  const at = '2026-10-19T00:00:00.000Z'
  db.transaction(() => {
    const e = db.insert(schema.enterprise).values({ name: 'synthetic', nameNorm: 'synthetic', usccNorm: '91330211255994457P', createdAt: at }).returning().get()
    const r = db.insert(schema.record).values({ enterpriseId: e.id, titleCode: 'specialized_sme', source: 'jxj', usccRaw: e.usccNorm, createdAt: at }).returning().get()
    for (let i = 1; i <= 400 * scale; i++) {
      const event = db.insert(schema.recordEvent).values({ recordId: r.id, eventType: 'award', year: 2022, batchSeq: 1 }).returning().get()
      const query = db.insert(schema.platformQuery).values({ interface: 'business_list', queryKey: i === 1 ? e.usccNorm : `synthetic:${i}`, rdjb: '2', titleCode: 'specialized_sme', queriedAt: at, status: 'partial', rawResponse: raw, collectionEvidence: { rows: [{ payload: raw }], completeness: 'partial' }, createdAt: at }).returning({ id: schema.platformQuery.id }).get()
      const relation = db.insert(schema.platformRelation).values({ queryId: query.id, sequenceNo: 1, enterpriseId: e.id, usccRaw: e.usccNorm, declareKind: 'apply', year: 2022, rawFields: { original: 'synthetic-original' }, createdAt: at }).returning({ id: schema.platformRelation.id }).get()
      db.insert(schema.recordCorrespondence).values({ edgeKey: `synthetic:${i}`, eventId: event.id, relationId: relation.id, enterpriseId: e.id, titleCode: 'specialized_sme', type: 'event_process', role: 'context_only', status: 'candidate', revision: 1, targetIdentity: {}, provenance, sourceFingerprint: 'synthetic', ruleId: 'manual', ruleVersion: '1', createdAt: at }).run()
    }
    const batch = db.insert(schema.importBatch).values({ idempotencyKey: 'synthetic-audit', sourceKind: 'correspondence_decision', sourceIdentity: 'synthetic/audit', status: 'committed', createdAt: at }).returning().get()
    for (let i = 0; i < 500 * scale; i++) db.insert(schema.recordCorrespondenceAudit).values({ correspondenceId: 1, batchId: batch.id, idempotencyKey: `synthetic-audit-${i}`, toStatus: 'candidate', expectedRevision: i, resultingRevision: i + 1, actorType: 'agent', actorId: 'synthetic', basis: 'synthetic evidence', ruleId: 'manual', ruleVersion: '1', evidence: provenance, decidedAt: at }).run()
  })
  db.$client.pragma('wal_checkpoint(TRUNCATE)')
  console.log(JSON.stringify({ action, scale, dbBytes: statSync(dbPath).size }))
  db.$client.close()
  process.exit(0)
}
const { handleRecordCorrespondenceRequest: handle } = await jiti.import(root + '/server/utils/record-correspondence-api.ts')
const { dispatchRecordCorrespondenceMcp: mcp } = await jiti.import(root + '/server/utils/mcp-record-correspondence.ts')
const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
let sqlBytes = 0, sqlMs = 0, sqlStatements = 0, peakHeap = 0, peakRss = 0, baseHeap = 0
const sampleMemory = () => { const m = process.memoryUsage(); peakHeap = Math.max(peakHeap, m.heapUsed); peakRss = Math.max(peakRss, m.rss) }
const size = v => typeof v === 'string' ? Buffer.byteLength(v) : typeof v === 'number' ? 8 : v && typeof v === 'object' ? Object.values(v).reduce((n, x) => n + size(x), 0) : 0
const prepare = db.$client.prepare.bind(db.$client)
db.$client.prepare = (...args) => {
  const statement = prepare(...args)
  for (const method of ['all', 'get']) {
    const run = statement[method].bind(statement)
    statement[method] = (...args) => { const start = performance.now(), result = run(...args); sqlMs += performance.now() - start; sqlBytes += size(result); sqlStatements++; sampleMemory(); return result }
  }
  return statement
}
const modes = {
  list: { action: 'list', method: 'GET', query: { page: 1, pageSize: 25 } },
  deep: { action: 'list', method: 'GET', query: { page: 300, pageSize: 1 } },
  point: { action: 'get', method: 'GET', id: 1 },
  event: { action: 'source', method: 'GET', id: 1, kind: 'event' },
  audit: { action: 'audit', method: 'GET', id: 1, query: { page: 400, pageSize: 1 } },
  candidates: { action: 'candidates', method: 'POST', body: { eventId: 1, queryIds: [1], exportBatchIds: [], ruleVersion: '1', page: 1, pageSize: 50 } },
}
const server = createServer(async (req, res) => {
  const mode = req.url.slice(1), input = modes[mode]
  if (!input) { res.writeHead(404); res.end(); return }
  const out = handle(input, { db })
  res.writeHead(out.status, { ...out.headers, 'content-type': 'application/json' }); res.end(JSON.stringify(out.body))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
try {
  for (const [mode, input] of Object.entries(modes)) {
    global.gc?.(); baseHeap = process.memoryUsage().heapUsed; peakHeap = baseHeap; peakRss = 0
    const lag = monitorEventLoopDelay({ resolution: 10 }); lag.enable()
    const samples = [], hashes = new Set()
    const request = async () => {
      const start = performance.now(), response = await fetch(`${base}/${mode}`), raw = await response.text()
      assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store')
      sampleMemory(); hashes.add(createHash('sha256').update(JSON.stringify(canonical(JSON.parse(raw)))).digest('hex'))
      return { ms: performance.now() - start, responseBytes: Buffer.byteLength(raw) }
    }
    sqlBytes = 0; sqlMs = 0; sqlStatements = 0
    const cold = await request(), coldSqlBytes = sqlBytes
    const args = input.action === 'list' ? input.query : input.action === 'candidates' ? input.body : { id: input.id, kind: input.kind, ...input.query }
    const mcpResult = mcp(input.action, args, { db })
    assert.equal(createHash('sha256').update(JSON.stringify(canonical(mcpResult))).digest('hex'), [...hashes][0], 'REST/MCP semantic equality')
    // Warmup and equality check excluded from hot measurements.
    sqlBytes = 0; sqlMs = 0; sqlStatements = 0
    for (let i = 0; i < rounds; i += concurrency) samples.push(...await Promise.all(Array.from({ length: Math.min(concurrency, rounds - i) }, request)))
    await new Promise(resolve => setTimeout(resolve, 20)); lag.disable()
    assert.equal(hashes.size, 1, 'stable results')
    const times = samples.map(s => s.ms).sort((a, b) => a - b), p = n => times[Math.ceil(n * times.length) - 1]
    console.log(JSON.stringify({ sourceHead, action, mode, scale, concurrency, coldLabel: 'first request for lane; fresh process only for list; OS cache not purged', cold, coldSqlBytes, samples: samples.length, hot: { p50: p(.5), p95: p(.95), p99: p(.99) }, responseBytes: samples[0].responseBytes, hotSqlBytesPerRequest: sqlBytes / samples.length, hotSqlStatementsPerRequest: sqlStatements / samples.length, hotSqlMsPerRequest: sqlMs / samples.length, peakHeap, incrementalHeap: peakHeap - baseHeap, peakRss, maxRss: process.resourceUsage().maxRSS * 1024, eventLoopP95Ms: lag.percentile(95) / 1e6, eventLoopMaxMs: lag.max / 1e6, responseSha256: [...hashes][0], dbBytes: statSync(dbPath).size }))
  }
} finally { await new Promise(resolve => server.close(resolve)); db.$client.close() }
