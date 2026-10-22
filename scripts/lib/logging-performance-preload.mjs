// Opt-in benchmark observation only. Reuse phase/SQL/JSON meters on every Node thread.
import './performance-preload.mjs'
import wt from 'node:worker_threads'
import { syncBuiltinESMExports } from 'node:module'
const bus = new wt.BroadcastChannel('logging-performance-observation')
bus.unref()
const Original = wt.Worker
const totals = new Map()
if (wt.isMainThread) bus.onmessage = ({ data }) => {
  if (data?.kind === 'sqlite-ack') totals.set(data.owner, data)
}
wt.Worker = class extends Original {
  constructor(...args) {
    super(...args)
    const pending = new Map()
    const counts = { kind: 'sqlite-ack', owner: `${process.pid}:${wt.threadId}:${this.threadId}`, batches: 0, offered: 0, stored: 0, filtered: 0, droppedAcknowledged: 0, fallbackSkipped: 0, failedCalls: 0 }
    const publish = () => { if (wt.isMainThread) totals.set(counts.owner, { ...counts }); else bus.postMessage(counts) }
    const post = this.postMessage.bind(this)
    this.postMessage = (message, ...rest) => {
      if (message?.action === 'write') { pending.set(message.id, message.data.length); counts.offered += message.data.length }
      return post(message, ...rest)
    }
    this.on('message', message => {
      if (!pending.has(message?.id)) return
      const n = pending.get(message.id); pending.delete(message.id); counts.batches++
      if (message.ok) {
        const r = message.result
        counts.stored += r.stored; counts.filtered += r.filtered; counts.fallbackSkipped += r.fallbackSkipped
        counts.droppedAcknowledged += n - r.stored - r.filtered
      } else { counts.failedCalls++; counts.droppedAcknowledged += n }
      publish()
    })
  }
}
syncBuiltinESMExports()
if (wt.isMainThread) process.on('message', message => {
  if (message?.type === 'logging-observation') process.send?.({ type: 'logging-observation', id: message.id, writers: [...totals.values()] })
})
// Child processes inherit NODE_OPTIONS. Independent file telemetry avoids sending
// benchmark control messages to the business worker's unfiltered IPC handler.
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
if (wt.isMainThread && process.env.LOGGING_BENCH_PROCESS_DIR) {
  const lag = monitorEventLoopDelay({ resolution: 10 }); lag.enable()
  const sample = () => {
    const data = { timestamp: Date.now(), pid:process.pid, ppid:process.ppid, cpu:process.cpuUsage(), memory:process.memoryUsage(), stdoutBuffered:process.stdout.writableLength, lagP95Ms:lag.percentile(95)/1e6, lagMaxMs:lag.max/1e6, writers:[...totals.values()] }
    appendFileSync(join(process.env.LOGGING_BENCH_PROCESS_DIR, `${process.pid}.ndjson`), JSON.stringify(data)+'\n')
    lag.reset()
  }
  const timer = setInterval(sample, 500); timer.unref()
  process.on('exit', sample)
}
