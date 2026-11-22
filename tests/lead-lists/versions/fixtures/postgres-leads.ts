import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { installLeadListSchema } from '../../../../layers/lead-lists/install-schema'
import { nativeAppAdapter } from '../../../support/native-app'
import { postgresRuntimeFixture } from '../../../support/postgres-fixture.mjs'

export function postgresLeadFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'lead-pg-'))
  let runtime: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
  let db: pg.Pool | undefined
  const app = nativeAppAdapter({
    dir, token: 'isolated-lead-pg-token',
    launch: ({ cwd, port: httpPort }) => ({
      args: [join(cwd, '.output/server/index.mjs')],
      env: {
        NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(httpPort),
        NUXT_DB_PATH: join(dir, 'legacy-runtime', 'business.db'),
        NUXT_LOG_DIR: join(dir, 'legacy-logs'),
        ...runtime!.env,
      },
    }),
  })
  async function start(seed?: (fixture: { db: typeof app.db; filesDir: string }) => void) {
    const filesDir = join(dir, 'files')
    mkdirSync(filesDir)
    installLeadListSchema(app.db.$client)
    seed?.({ db: app.db, filesDir })
    app.db.$client.pragma('wal_checkpoint(TRUNCATE)')
    runtime = await postgresRuntimeFixture({ dir, sourcePath: app.dbPath, bin: process.env.LEAD_TEST_POSTGRES_BIN })
    db = new pg.Pool({ connectionString: runtime.url, options: '-c search_path=business,public' })
    await app.start()
    return db
  }

  async function close() {
    try {
      await app.close()
    } finally {
      try {
        await db?.end()
        runtime?.close()
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  }

  return { app, dir, start, close }
}
