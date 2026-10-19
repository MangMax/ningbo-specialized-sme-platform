// Optional production-build observer: no routing or application changes.
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import v8 from 'node:v8'
const loop = monitorEventLoopDelay({ resolution: 10 })
loop.enable()
let lastHeartbeat = performance.now(), heartbeatDriftMaxMs = 0
setInterval(() => { const now = performance.now(); heartbeatDriftMaxMs = Math.max(heartbeatDriftMaxMs, now - lastHeartbeat - 10); lastHeartbeat = now }, 10).unref()
const original = globalThis.fetch
globalThis.fetch = (input, ...rest) => {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(typeof input === 'string' || input instanceof URL ? input : input.url).hostname)) throw new Error('perf82: external network disabled')
  return original(input, ...rest)
}
process.on('message', async message => {
  if (message !== 'perf82-observe') return
  await new Promise(r => setTimeout(r, 30))
  process.send?.({ type: 'perf82-observation', memory: process.memoryUsage(), maxRssKiB: process.resourceUsage().maxRSS,
    heapLimit: v8.getHeapStatistics().heap_size_limit, loop: { p95Ms: loop.percentile(95) / 1e6, p99Ms: loop.percentile(99) / 1e6, maxMs: loop.max / 1e6, heartbeatDriftMaxMs } })
  loop.reset()
  heartbeatDriftMaxMs = 0
})
