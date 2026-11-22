import { getHeapStatistics } from 'node:v8'
import { appManifests } from '../../../../lib/installed-manifests'
import { installAppModules } from '../../../../lib/app-modules'
import { closePostgresDirectoryDb, usePostgresDirectoryDb } from '../../../../db/postgresql/client'
import { appLog, initializeWorkerLogging, closeApplicationLogging, type LogContext, type LogInput } from '../../../core/lib/logging/index'
import { createDrizzleLogger } from '../../../core/lib/logging/drizzle'
import { enterpriseJsonChunks } from './enterprise-read-json'
import { listPostgresCurrentQualified } from './current-qualified-query-postgres'
import type { CurrentQualifiedFilter } from './current-qualified-page'

export type EnterpriseReadRequest = { id: number; filter: CurrentQualifiedFilter; logContext?: LogContext }
const send = (message: object) => new Promise<void>((resolve, reject) => {
  process.send!(message, error => error ? reject(error) : resolve())
})

installAppModules(appManifests)
initializeWorkerLogging()
process.on('disconnect', () => {
  void Promise.allSettled([closeApplicationLogging(), closePostgresDirectoryDb()]).finally(() => process.exit(0))
})
process.on('message', async (request: EnterpriseReadRequest) => {
  let outcome: LogInput['outcome'] = 'failure'
  appLog({ module: 'sme-roster', source: 'worker', operation: 'enterprise_read.execute', outcome: 'started' }, request.logContext)
  const started = performance.now()
  const beforeHeap = process.memoryUsage().heapUsed
  try {
    const db = usePostgresDirectoryDb(createDrizzleLogger({
      connection: 'enterprise_read', execution: 'worker', context: { ...request.logContext, module: 'sme-roster' },
    }))
    const result = await listPostgresCurrentQualified(db, request.filter)
    const serializationStarted = performance.now()
    let bytes = 0
    let { heapUsed: heap, external, rss } = process.memoryUsage()
    for (const payload of enterpriseJsonChunks(result)) {
      bytes += payload.byteLength
      const memory = process.memoryUsage()
      heap = Math.max(heap, memory.heapUsed)
      rss = Math.max(rss, memory.rss)
      external = Math.max(external, memory.external)
      await send({ type: 'chunk', id: request.id, payload })
    }
    const readMs = serializationStarted - started
    const metrics = { beforeHeap, heap: Math.max(beforeHeap, heap), external, rss, maxRss: process.resourceUsage().maxRSS * 1024,
      bytes, transferredBytes: bytes, chunkBytes: 65536, readMs, connectionMs: 0, projectionMs: readMs,
      serializeMs: performance.now() - serializationStarted }
    await send({ type: 'result', id: request.id, metrics })
    outcome = 'success'
  } catch (error) {
    if (process.connected) await send({ type: 'failure', id: request.id, code: (error as { code?: string }).code ?? 'enterprise_read_failed' })
  } finally {
    appLog({ module: 'sme-roster', source: 'worker', operation: 'enterprise_read.execute', outcome, durationMs: performance.now() - started, errorCode: outcome === 'failure' ? 'enterprise_read_execution_failed' : undefined }, request.logContext)
  }
})
void send({ type: 'ready', heap: process.memoryUsage().heapUsed, rss: process.memoryUsage().rss, heapLimit: getHeapStatistics().heap_size_limit, execArgv: process.execArgv, pid: process.pid })
