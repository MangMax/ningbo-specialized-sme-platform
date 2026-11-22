import { createRequire } from 'node:module'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'

if (process.argv.length !== 2 || !process.env.PGDATABASE) {
  throw new Error('Set PGDATABASE and run node upgrade/pg/2026-11-data-compaction/steps/16-refresh-platform-digests.mjs')
}

const require = createRequire(import.meta.url)
const { createJiti } = createRequire(require.resolve('nuxt/package.json'))('jiti')
const jiti = createJiti(import.meta.url, { fsCache: false })
const { installPlatformRefreshV2 } = await jiti.import('./support/platform-refresh-v2-migration.ts')
const client = new pg.Client()
await client.connect()
try {
  console.log(JSON.stringify(await installPlatformRefreshV2(drizzle(client))))
} finally {
  await client.end()
}
