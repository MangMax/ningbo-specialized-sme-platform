import { join } from 'node:path'
import Database from 'better-sqlite3'
import { createLogService } from '../../../layers/core/lib/logging/sqlite-service'
import { LOG_DEFAULTS } from '../../../layers/core/lib/logging/contract'

export async function seedDebugLogCollection(directory: string): Promise<void> {
  const service = createLogService({ directory })
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
  const db = new Database(join(directory, 'events.db'))
  try {
    db.prepare('DELETE FROM log_events WHERE operation = ?').run('logging.policy')
  } finally {
    db.close()
  }
}
