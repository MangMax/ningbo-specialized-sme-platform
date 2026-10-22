import { createHttpDrain } from 'evlog/http'
import type { DrainContext } from 'evlog'
import { clientErrorReport, type ClientErrorKind, type ClientPage } from './contract'

/** Only a bounded transport, never a second logger. Server appLog owns event creation. */
export function createClientErrorTransport(options: { online?: () => boolean; now?: () => number } = {}) {
  const send = createHttpDrain({ endpoint: '/api/logs/client', headers: { 'X-Log-Browser': '1' },
    timeout: 2000, credentials: 'same-origin', useBeacon: false })
  const now = options.now ?? Date.now
  const online = options.online ?? (() => typeof navigator === 'undefined' || navigator.onLine !== false)
  let queue: { report: NonNullable<ReturnType<typeof clientErrorReport>>; at: number; attempts: number }[] = []
  const seen = new Map<string, number>()
  let timer: ReturnType<typeof setTimeout> | undefined, active: Promise<void> | undefined
  let disposed = false, sent = 0, dropped = 0, suppressed = 0, failures = 0, inFlight = 0
  function schedule(ms = 500) {
    if (!disposed && !timer && queue.length && online()) timer = setTimeout(() => { timer = undefined; void flush() }, ms)
  }
  function report(kind: ClientErrorKind, page: ClientPage, level: 'error' | 'warn' = 'error') {
    try {
      if (disposed) return
      const safe = clientErrorReport({ kind, page, level })
      if (!safe) { dropped++; return }
      const key = `${safe.page}.${safe.kind}.${safe.level}`, time = now(), previous = seen.get(key)
      if (previous !== undefined && time - previous < 10000) { suppressed++; return }
      seen.set(key, time)
      if (queue.length + inFlight >= 32) { dropped++; return }
      queue.push({ report: safe, at: time, attempts: 0 }); schedule()
    } catch { /* Transport faults never escape into UI or log themselves. */ }
  }
  function flush(): Promise<void> {
    if (active) return active
    if (timer) { clearTimeout(timer); timer = undefined }
    if (disposed) return Promise.resolve()
    queue = queue.filter(item => { if (now() - item.at < 300000) return true; dropped++; return false })
    if (!online() || !queue.length) return Promise.resolve()
    const batch = queue.splice(0, 8); inFlight = batch.length
    active = (async () => {
      try {
        // Official evlog HTTP batch envelope; only our fixed projection enters it.
        await send(batch.map(item => ({ event: item.report })) as unknown as DrainContext[])
        sent += batch.length
      } catch {
        failures++
        for (const item of batch) {
          item.attempts++
          if (!disposed && item.attempts < 3 && now() - item.at < 300000) queue.push(item)
          else dropped++
        }
      } finally {
        inFlight = 0; active = undefined
        schedule(1000)
      }
    })()
    return active
  }
  return { report, flush,
    status: () => ({ queued: queue.length, inFlight, sent, dropped, suppressed, failures }),
    dispose() { disposed = true; if (timer) clearTimeout(timer); timer = undefined; dropped += queue.length; queue = [] },
  }
}
