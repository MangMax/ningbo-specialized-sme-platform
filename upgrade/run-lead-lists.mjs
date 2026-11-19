import { createRequire } from 'node:module'
import { existsSync, statSync } from 'node:fs'
import Database from 'better-sqlite3'

const [target, ...extra] = process.argv.slice(2)
if (!target || extra.length) throw new Error('Usage: node upgrade/run-lead-lists.mjs OFFLINE_DATABASE')
for (const suffix of ['-wal', '-journal']) {
  if (existsSync(target + suffix) && statSync(target + suffix).size) throw new Error('Standalone offline database required')
}
const { createJiti } = createRequire(import.meta.resolve('nuxt/package.json'))('jiti')
const jiti = createJiti(import.meta.url, { fsCache: false })
const { assertApplicationSchema } = await jiti.import('../db/schema-phase.ts')
const { installLeadListSchema } = await jiti.import('../layers/lead-lists/install-schema.ts')
const db = new Database(target, { fileMustExist: true })
try {
  db.pragma('foreign_keys = ON')
  db.transaction(() => {
    assertApplicationSchema(db)
    installLeadListSchema(db)
    if (db.pragma('foreign_key_check').length) throw new Error('Foreign key conflict')
  }).exclusive()
  console.log('Lead lists schema ready')
} finally {
  db.close()
}
