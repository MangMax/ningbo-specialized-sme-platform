#!/usr/bin/env node
// Serial, fixed-input queue/storage comparison. No HTTP traffic, business DB,
// dependency installation, or production configuration writes.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, appendFileSync, mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(process.argv[2] || '/tmp/implement-spec-180/sqlite-reliability/paired')
assert(output.startsWith('/tmp/implement-spec-180/sqlite-reliability/'))
const baseline = process.argv[3] || '871aa4638b4b65fb4178826cd9f1603bbd6eecd5'
assert(/^[0-9a-f]{40}$/.test(baseline))
const workloads = process.argv[4]?.split(',') || ['business', 'normal', 'burst', 'distinct']
assert(workloads.length > 0 && workloads.every(name => ['business', 'normal', 'burst', 'distinct'].includes(name)))
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trimEnd()
const hash = value => createHash('sha256').update(value).digest('hex')
const directory = join(repo, 'lib/logging')
const nonce = randomUUID()
const oldServicePath = join(directory, `.benchmark-service-${nonce}.ts`)
const oldWorkerPath = join(directory, `.benchmark-worker-${nonce}.ts`)
const workerImport = `./.benchmark-worker-${nonce}`
const serviceSource = git('show', `${baseline}:lib/logging/service.ts`)
const workerSource = git('show', `${baseline}:lib/logging/sqlite-worker.ts`)
assert.equal(serviceSource.split("from './sqlite-worker'").length, 2)
mkdirSync(output, { recursive: true })
assert(!existsSync(join(output, 'results.json')) && !existsSync(join(output, 'cells.ndjson')), 'Use a new evidence directory; never overwrite a previous run')
assert.equal(git('rev-parse', baseline), baseline)
const report = { scope: 'service admission and real SQLite drain only; not application latency or production SLO', baseline,
  candidateHead: git('rev-parse', 'HEAD'), candidateDirty: git('status', '--porcelain') !== '',
  sourceHashes: Object.fromEntries(['service.ts', 'sqlite-worker.ts', 'drizzle-query.ts'].map(name => [name, hash(readFileSync(join(directory, name)))])),
  baselineServiceHash: hash(serviceSource), baselineWorkerHash: hash(workerSource), cells: [], cleanup: [] }
const query = { source: 'system', operation: 'db.query.select', level: 'debug', outcome: 'started', origin: { runtime: 'node', integration: 'drizzle', capture: 'hook' }, resourceType: 'database_connection', resourceId: 'primary' }
async function allRows(service) {
  const rows = []; let cursor
  do { const page = await service.list({ limit: 100, ...(cursor ? { cursor } : {}) }); rows.push(...page.rows); cursor = page.nextCursor } while (cursor)
  return rows
}
try {
  writeFileSync(oldWorkerPath, workerSource)
  writeFileSync(oldServicePath, serviceSource.replace("from './sqlite-worker'", `from '${workerImport}'`))
  assert.equal(readFileSync(oldServicePath, 'utf8').replace(`from '${workerImport}'`, "from './sqlite-worker'"), serviceSource)
  const jitiPath = createRequire(import.meta.resolve('nuxt/package.json')).resolve('jiti')
  const { createJiti } = createRequire(import.meta.url)(jitiPath)
  const jiti = createJiti(import.meta.url)
  const factories = { baseline: (await jiti.import(oldServicePath)).createLogService, candidate: (await jiti.import(join(directory, 'service.ts'))).createLogService }
  for (const workload of workloads) for (let round = 0; round < 4; round++) {
    for (const arm of (round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'])) {
      const root = mkdtempSync(join(output, 'cell-'))
      const service = factories[arm]({ directory: root, stdout: false })
      try {
        await service.policy() // Exclude cold worker startup from the timed loop.
        const queries = ['normal', 'business'].includes(workload) ? 600 : 10000
        const interval = ['normal', 'business'].includes(workload) ? 10 : 100
        const cpu = process.cpuUsage(), started = performance.now()
        for (let i = 0; i < queries; i++) {
          service.emit(workload === 'business'
            ? { source: 'http', operation: 'http.request', outcome: 'success', origin: { runtime: 'node', integration: 'nuxt-nitro', capture: 'framework' }, httpMethod: 'GET', httpRoute: '/api/health', statusCode: 200, requestId: `request-${i}` }
            : { ...query, ...(workload === 'distinct' ? { requestId: `request-${i}` } : {}) })
          if (i % interval === interval - 1) service.emit({ source: 'task', operation: 'task.finished', outcome: 'success', taskId: `task-${i}` })
        }
        const emitMs = performance.now() - started, queued = service.status()
        assert(queued.queuedEntries <= 1024 && queued.queuedBytes <= 4 * 1024 * 1024)
        const drainStart = performance.now(); await service.flush()
        const drainMs = performance.now() - drainStart, elapsedMs = performance.now() - started
        const cpuUse = process.cpuUsage(cpu), final = service.status(), rows = await allRows(service)
        const storedQueries = rows.filter(row => row.origin?.integration === 'drizzle').reduce((sum, row) => sum + (row.counts?.total ?? 1), 0)
        const terminals = rows.filter(row => row.operation === 'task.finished').length
        assert.equal(terminals, queries / interval)
        assert.equal(final.drainFailures, 0)
        assert.equal(final.writeUnknown ?? 0, 0)
        if (workload === 'business') { assert.equal(rows.filter(row => row.source === 'http').length, queries); assert.equal(storedQueries, 0); assert.equal(final.dropped, 0) }
        if (workload === 'normal' || (arm === 'candidate' && workload === 'burst')) {
          assert.equal(storedQueries, queries); assert.equal(final.dropped, 0)
        }
        if (workload === 'distinct') assert.equal(final.coalesced ?? 0, 0)
        const cell = { workload, round, arm, inputEvents: queries, queryAttempts: workload === 'business' ? 0 : queries, expectedTerminals: queries / interval, terminals, storedQueries, observedUnstoredQueries: workload === 'business' ? 0 : queries - storedQueries, emitMs, drainMs, elapsedMs, cpuUs: cpuUse.user + cpuUse.system, rssAfter: process.memoryUsage().rss, queued, final }
        report.cells.push(cell); appendFileSync(join(output, 'cells.ndjson'), JSON.stringify(cell) + '\n')
      } finally {
        await service.close(); rmSync(root, { recursive: true, force: true }); report.cleanup.push({ root, removed: true, closed: service.status().closed })
      }
    }
  }
  report.result = 'PASS'
} catch (error) {
  report.result = 'FAIL'; report.error = String(error); process.exitCode = 1
} finally {
  rmSync(oldServicePath, { force: true }); rmSync(oldWorkerPath, { force: true })
  report.temporarySourcesRemoved = true
  writeFileSync(join(output, 'results.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ result: report.result, cells: report.cells.length, output, temporarySourcesRemoved: true }))
}
