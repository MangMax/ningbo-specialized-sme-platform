// Opt-in benchmark preload. SQL includes native execution and row materialization;
// nested JSON timings overlap and must not be added to SQL or wall time.
import dc from 'node:diagnostics_channel'
import { createRequire } from 'node:module'
import { getHeapStatistics } from 'node:v8'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { createPerformancePhases } from './performance-phases.mjs'

const meter = createPerformancePhases()
const legacy = monitorEventLoopDelay({ resolution: 10 }); legacy.enable()
const require = createRequire(new URL('../../.output/server/index.mjs', import.meta.url))
const Database = require('better-sqlite3')
const probe = new Database(':memory:')
const proto = Object.getPrototypeOf(probe.prepare('select 1')); probe.close()
for (const method of ['all', 'get', 'run']) {
  const original = proto[method]
  proto[method] = function (...args) { return meter.measure(`sql.${method}`, () => original.apply(this, args)) }
}
for (const method of ['parse', 'stringify']) {
  const original = JSON[method]
  JSON[method] = function (...args) { return meter.measure(`json.${method}`, () => original.apply(this, args)) }
}
let requestCount = 0
dc.channel('http.server.response.finish').subscribe(() => { requestCount++ })
process.on('message', async message => {
  if (message?.type !== 'performance-phase') return
  try {
    const result = message.action === 'begin' ? await meter.begin(message.label) : await meter.end(message.label)
    process.send?.({ type: 'performance-phase', id: message.id, result: { ...result, heapLimit: getHeapStatistics().heap_size_limit, requestCount, legacyCumulativeP95Ms: legacy.percentile(95) / 1e6, legacyCumulativeMaxMs: legacy.max / 1e6 } })
  } catch (error) { process.send?.({ type: 'performance-phase', id: message.id, error: String(error) }) }
})
