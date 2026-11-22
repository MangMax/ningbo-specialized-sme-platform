import { createRequire } from 'node:module'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'

const require = createRequire(import.meta.url)
const { createJiti } = createRequire(require.resolve('nuxt/package.json'))('jiti')
const jiti = createJiti(import.meta.url, { fsCache: false })
const { prunePostgresPlatformCaptures } = await jiti.import('../../../../layers/sme-roster/server/utils/platform-capture-retention-postgres.ts')
const client = new pg.Client({ options: '-c search_path=business,pg_catalog' })
await client.connect()
try {
  console.log(JSON.stringify({ retiredObservations: await prunePostgresPlatformCaptures(drizzle(client), null, true) }))
} finally {
  await client.end()
}
