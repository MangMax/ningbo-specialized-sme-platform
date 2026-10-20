import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import { readFileSync } from 'node:fs'

const cgroupCpu = () => {
  try { return Object.fromEntries(readFileSync('/sys/fs/cgroup/cpu.stat', 'utf8').trim().split('\n').map(line => { const [key, value] = line.split(' '); return [key, Number(value)] })) }
  catch { return {} }
}

/** Benchmark-only observations; never loaded by the application without a preload. */
export function createPerformancePhases() {
  const lag = monitorEventLoopDelay({ resolution: 10 })
  const lifetime = monitorEventLoopDelay({ resolution: 10 })
  lag.enable(); lifetime.enable()
  let active = null
  const sample = () => {
    if (!active) return
    const started = performance.now()
    const m = process.memoryUsage()
    active.peakHeap = Math.max(active.peakHeap, m.heapUsed)
    active.peakRss = Math.max(active.peakRss, m.rss)
    active.memorySampleMs += performance.now() - started
  }
  const timer = setInterval(sample, 5); timer.unref()
  return {
    async begin(label) {
      if (active) throw Error('A performance phase is already active')
      await sleep(25)
      // Let overdue timer callbacks from the previous phase run before resetting.
      // Keep the separate lifetime histogram so earlier stalls remain observable.
      lag.reset()
      const m = process.memoryUsage()
      active = { label, start: performance.now(), cpuStart: process.cpuUsage(), cgroupStart: cgroupCpu(), baseHeap: m.heapUsed, peakHeap: m.heapUsed, peakRss: m.rss, memorySampleMs: 0, stages: {} }
    },
    measure(stage, action) {
      const t = performance.now()
      try { return action() } finally {
        if (active) {
          const record = active.stages[stage] ??= { calls: 0, ms: 0, maxMs: 0 }
          const elapsed = performance.now() - t
          record.calls++; record.ms += elapsed; record.maxMs = Math.max(record.maxMs, elapsed)
          sample()
        }
      }
    },
    async end(label) {
      if (!active || active.label !== label) throw Error('Performance phase does not match')
      await sleep(25)
      sample()
      const cpu = process.cpuUsage(active.cpuStart)
      const current = cgroupCpu()
      const cgroupCpuDelta = Object.fromEntries(Object.entries(current).map(([key, value]) => [key, value - (active.cgroupStart[key] ?? value)]))
      const out = { method: 'phase-reset-after-drain; end-tail-in-window; independent-lifetime-v1', ...active, cpuStart: undefined, cgroupStart: undefined, cgroupCpuDelta, elapsedMs: performance.now() - active.start, cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000, heapDelta: active.peakHeap - active.baseHeap, loopP95Ms: lag.percentile(95) / 1e6, loopMaxMs: lag.max / 1e6, loopSamples: lag.count, lifetimeLoopMaxMs: lifetime.max / 1e6, osPeakRss: process.resourceUsage().maxRSS * 1024 }
      active = null
      return out
    },
    close() { clearInterval(timer); lag.disable(); lifetime.disable() },
  }
}
