import { Worker } from 'node:worker_threads'
import { SQLITE_WORKER } from './sqlite-worker'
import { resolveLoggingSqliteModule } from './sqlite-module-location'
import { createBufferedLogService, LogServiceError, type LogServiceOptions as QueueOptions } from './service'

export interface LogServiceOptions extends QueueOptions { directory: string }

export function createLogService(options: LogServiceOptions) {
  return createBufferedLogService(options, ({ policy, maxEventBytes, timeoutMs, fault }) => {
    let worker: Worker | undefined
    let serial = 0
    const pending = new Map<number, { resolve(value: any): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout>; action: string; posted: boolean }>()
    function stopWorker(code: string) {
      const old = worker; worker = undefined
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new LogServiceError(code, 503, p.action === 'write' && p.posted ? 'unknown' : 'not_written')) }
      pending.clear()
      if (old) void old.terminate().catch(() => {})
    }
    function start() {
      if (worker) return worker
      const next = new Worker(SQLITE_WORKER, { eval: true, workerData: { directory: options.directory, policy, stdout: options.stdout, maxEventBytes, sqliteModule: resolveLoggingSqliteModule() } })
      next.on('message', message => {
        if (worker !== next) return
        const p = pending.get(message.id); if (!p) return
        clearTimeout(p.timer); pending.delete(message.id)
        if (message.ok) p.resolve(message.result)
        else p.reject(new LogServiceError(message.code, 503, p.action === 'write' && message.writeOutcome !== 'not_written' ? 'unknown' : 'not_written'))
      })
      next.on('error', () => { if (worker === next) { fault('worker_unavailable'); stopWorker('worker_unavailable') } })
      next.on('exit', () => { if (worker === next) { fault('worker_exited'); stopWorker('worker_exited') } })
      worker = next
      return next
    }

    function call<T>(action: string, data?: unknown): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const id = ++serial
        try {
          const w = start()
          const timer = setTimeout(() => { fault('drain_timeout'); stopWorker('drain_timeout') }, timeoutMs)
          const entry = { resolve, reject, timer, action, posted: false }
          pending.set(id, entry)
          w.postMessage({ id, action, data, time: Date.now() }); entry.posted = true
        } catch {
          const entry = pending.get(id)
          if (entry) { clearTimeout(entry.timer); pending.delete(id) }
          reject(new LogServiceError('storage_unavailable', 503, 'not_written'))
        }
      })
    }

    return {
      pending: () => pending.size,
      call,
      async close() { if (worker) await call('close').catch(() => {}) },
      stop: stopWorker,
    }
  })
}
