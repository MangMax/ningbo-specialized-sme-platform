import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nativeAppAdapter } from '../../../support/native-app'

export function postgresLeadFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'lead-pg-'))
  const app = nativeAppAdapter({
    dir, token: 'isolated-lead-pg-token',
    launch: ({ cwd, port: httpPort }) => ({
      args: [join(cwd, '.output/server/index.mjs')],
      env: {
        NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(httpPort),
        NUXT_DB_PATH: join(dir, 'legacy-runtime', 'business.db'),
        NUXT_LOG_DIR: join(dir, 'legacy-logs'),
      },
    }),
  })
  async function start(seed: (fixture: { db: typeof app.db; filesDir: string }) => void | Promise<void>) {
    const filesDir = join(dir, 'files')
    mkdirSync(filesDir)
    await app.prepare()
    await seed({ db: app.db, filesDir })
    await app.start()
  }

  async function close() {
    try {
      await app.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  return { app, dir, start, close }
}
