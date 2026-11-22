import { closeApplicationLogging, initializeWorkerLogging } from '../../../layers/core/lib/logging'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'

export async function prepareRuntimeLogs(dir: string) {
  const runtime = await postgresRuntimeFixture({ dir, logsOnly: true })
  const previous = Object.entries(runtime.env).map(([key, value]) => {
    const prior = process.env[key]
    process.env[key] = value
    return [key, prior] as const
  })
  initializeWorkerLogging()
  return {
    ...runtime,
    async close() {
      try { await closeApplicationLogging() }
      finally {
        for (const [key, value] of previous) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
        runtime.close()
      }
    },
  }
}

export function storedLogRows(runtime: Awaited<ReturnType<typeof postgresRuntimeFixture>>) {
  return runtime.psql(['-At', '-c', 'SELECT row_to_json(event) FROM runtime_logs.log_events AS event ORDER BY seq'])
}
