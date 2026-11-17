import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')
const { createJiti } = createRequire(require.resolve('nuxt/package.json'))('jiti')
const { migrateImportReceiptBodies } = await createJiti(import.meta.url, { fsCache: false }).import('../db/import-receipt-bodies.ts')
if (!process.argv[2]) throw new Error('Usage: node scripts/upgrade-import-receipt-bodies.mjs DATABASE [MAX_MIGRATED_RECEIPTS]; stop writers and back up first; restart with this version after upgrade')
const db = new Database(process.argv[2], { fileMustExist: true })
try {
  db.pragma('foreign_keys=ON')
  db.pragma('busy_timeout=5000')
  console.log(JSON.stringify(migrateImportReceiptBodies(db, process.argv[3] === undefined ? undefined : Number(process.argv[3]))))
} finally { db.close() }
