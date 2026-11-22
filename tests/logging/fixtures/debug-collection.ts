import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import { createPostgresLogService } from '../../../layers/core/lib/logging/postgres-service'
import { LOG_DEFAULTS } from '../../../layers/core/lib/logging/contract'

export async function startDebugLogCollection(directory: string) {
  const runtime = await postgresRuntimeFixture({ dir: directory, logsOnly: true })
  const service = createPostgresLogService({ postgresUrl: runtime.url })
  try {
    try {
      await service.setPolicy({
        retentionDays: LOG_DEFAULTS.retentionDays, maxBytes: LOG_DEFAULTS.maxBytes,
        collection: {
          sources: { system: { enabled: true, minLevel: 'debug' }, task: { enabled: true, minLevel: 'debug' } },
          integrations: { drizzle: { enabled: true, minLevel: 'debug' } },
        },
      })
    } finally {
      await service.close()
    }
    runtime.psql(['-c', "TRUNCATE runtime_logs.log_events; UPDATE runtime_logs.log_policy SET logical_bytes = 0;"])
    return runtime
  } catch (error) {
    runtime.close()
    throw error
  }
}
