import { createRequire } from 'node:module'
import { existsSync, statSync } from 'node:fs'
import Database from 'better-sqlite3'

const [target, ...extra] = process.argv.slice(2)
if (!target || extra.length) throw new Error('Usage: node upgrade/run-enterprise-addresses.mjs OFFLINE_DATABASE')
for (const suffix of ['-wal', '-journal']) {
  if (existsSync(target + suffix) && statSync(target + suffix).size) throw new Error('Standalone offline target required')
}

const { createJiti } = createRequire(import.meta.resolve('nuxt/package.json'))('jiti')
const jiti = createJiti(import.meta.url, { fsCache: false })
const { upgradeEnterpriseAddresses } = await jiti.import('./enterprise-kernel.ts')
const db = new Database(target, { fileMustExist: true })
try {
  db.pragma('foreign_keys = ON')
  console.log(JSON.stringify(upgradeEnterpriseAddresses(db)))
} finally {
  db.close()
}
