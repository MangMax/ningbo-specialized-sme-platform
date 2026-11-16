import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')
const { createJiti } = createRequire(require.resolve('nuxt/package.json'))('jiti')
const jiti = createJiti(import.meta.url, { fsCache: false })
const { upgradeTitleCycleDisposition } = await jiti.import(new URL('../db/title-cycle-disposition.ts', import.meta.url).pathname)
if (!process.argv[2]) throw new Error('An explicit offline database path is required')
const db = new Database(process.argv[2], { fileMustExist: true })
try {
 db.pragma('foreign_keys=ON')
 upgradeTitleCycleDisposition(db)
} finally { db.close() }
