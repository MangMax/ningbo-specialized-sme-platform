import type Database from 'better-sqlite3'
import { vi } from 'vitest'
import { closePostgresDirectoryDb } from '../../../../db/postgresql/client'
import { postgresRuntimeFixture } from '../../../support/postgres-fixture.mjs'

/** Use each new offline source checkpoint for native readback until the corpus changes. */
export function migratedSourceReader(dir: string, source: Database.Database) {
  let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
  let version: number | undefined
  async function close() {
    await closePostgresDirectoryDb()
    postgres?.close()
    postgres = undefined
    vi.unstubAllEnvs()
  }
  return {
    async read<T>(fn: () => T) {
      const next = source.prepare('select total_changes()').pluck().get() as number
      if (!postgres || version !== next) {
        await close()
        postgres = await postgresRuntimeFixture({ dir, sourcePath: source.name })
        vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', postgres.url)
        vi.stubEnv('NUXT_DB_READONLY', '1')
        version = next
      }
      return await fn()
    },
    close,
  }
}
