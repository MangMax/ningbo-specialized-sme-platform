import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
const require = createRequire(import.meta.url)
const { createJiti } = createRequire(require.resolve('nuxt/package.json'))('jiti')
const jiti = createJiti(import.meta.url, { fsCache: false })
const { initializeDb, resolveDbPath } = await jiti.import(new URL('../db/client.ts', import.meta.url).pathname)
const { installLeadListSchema, leadListSchemaPresent } = await jiti.import(new URL('../layers/lead-lists/install-schema.ts', import.meta.url).pathname)
const dbPath = resolveDbPath({ dbPath: process.argv[2] })
const existed = existsSync(dbPath)
const db = initializeDb({ create: true, dbPath })
try {
  if (!existed) db.$client.transaction(() => installLeadListSchema(db.$client)).immediate()
  else if (!leadListSchemaPresent(db.$client)) {
    throw new Error('Existing database needs the explicit offline upgrade: node upgrade/run-lead-lists.mjs OFFLINE_DATABASE')
  }
  console.log(`Native database ready: ${db.$client.name}`)
} finally {
  db.$client.close()
}
