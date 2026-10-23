// Opt-in private benchmark telemetry. No production import or configuration change.
import { createRequire } from 'node:module'
import { appendFileSync } from 'node:fs'
import dc from 'node:diagnostics_channel'
import { getHeapStatistics } from 'node:v8'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { createPerformancePhases } from './performance-phases.mjs'
const meter = createPerformancePhases()
const Database = createRequire(process.env.PERF227_ENTRY)('better-sqlite3')
const probe = new Database(':memory:')
const prototype = Object.getPrototypeOf(probe.prepare('select 1')); probe.close()
for (const op of ['all', 'get', 'run']) {
  const original = prototype[op]
  prototype[op] = function (...args) { return meter.measure('sql.' + op, () => original.apply(this, args)) }
}
const iterate = prototype.iterate
prototype.iterate = function* (...args) {
  const it = iterate.apply(this, args)
  try {
    for (;;) { const next = meter.measure('sql.iterate.next', () => it.next()); if (next.done) return; yield next.value }
  } finally { it.return?.() }
}
for (const op of ['parse', 'stringify']) {
  const original = JSON[op]
  JSON[op] = function (...args) { return meter.measure('json.' + op, () => original.apply(this, args)) }
}
const isApp = process.argv[1] === process.env.PERF227_ENTRY
const lag = monitorEventLoopDelay({ resolution: 10 }); lag.enable()
const privateLog = value => appendFileSync(process.env.PERF227_TELEMETRY, JSON.stringify({ pid: process.pid, at: Date.now(), ...value }) + '\n', { mode: 0o600 })
if (!isApp) {
  // Native process metrics do not travel through the application's IPC protocol.
  // Log privately; never invent messages that could affect application dispatch.
  const sample = () => privateLog({ kind: 'native-sample', memory: process.memoryUsage(), cpu: process.cpuUsage(), loopP95Ms: lag.percentile(95) / 1e6, loopMaxMs: lag.max / 1e6, loopSamples: lag.count, heapLimit: getHeapStatistics().heap_size_limit })
  const timer = setInterval(sample, 10); timer.unref()
  process.on('beforeExit', () => { clearInterval(timer); sample(); meter.close(); lag.disable() })
}
let workerLast = null, workerPeakHeap = 0, workerPeakRss = 0, workerMaxRss = 0, combinedPeakHeap = 0, workers = []
dc.channel('ningbo.enterprise-read').subscribe(m => {
  workerLast = m
  workerPeakHeap = Math.max(workerPeakHeap, m.workerHeap ?? 0, m.heap ?? 0)
  workerPeakRss = Math.max(workerPeakRss, m.workerRss ?? 0, m.rss ?? 0)
  workerMaxRss = Math.max(workerMaxRss, m.maxRss ?? 0)
  combinedPeakHeap = Math.max(combinedPeakHeap, (m.workerHeap ?? 0) + process.memoryUsage().heapUsed)
  if (m.phase === 'ready' || m.phase === 'result') workers.push(m)
})
if (isApp) process.on('message', async message => {
  if (message?.type !== 'perf227-phase') return
  try {
    let result
    if (message.action === 'begin') {
      workerPeakHeap = workerLast?.workerHeap ?? 0; workerPeakRss = workerLast?.workerRss ?? 0; workerMaxRss = 0; combinedPeakHeap = 0; workers = []
      result = await meter.begin(message.label)
    } else {
      const app = await meter.end(message.label)
      result = { ...app, heapLimit: getHeapStatistics().heap_size_limit, workers, workerPeakHeap, workerPeakRss, workerMaxRss, combinedPeakHeap, combinedRssUpperBound: workerPeakRss + app.peakRss }
    }
    process.send?.({ type: 'perf227-phase', id: message.id, result })
  } catch (error) { process.send?.({ type: 'perf227-phase', id: message.id, error: String(error) }) }
})
