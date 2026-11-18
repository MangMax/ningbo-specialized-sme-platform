import { createRequire } from 'node:module'
import { existsSync, statSync } from 'node:fs'
import Database from 'better-sqlite3'

const [target, ...extra] = process.argv.slice(2)
if (!target || extra.length) throw new Error('Usage: node upgrade/run-roster-file-classification.mjs OFFLINE_NATIVE_TARGET')
for (const suffix of ['-wal', '-journal']) {
  if (existsSync(target + suffix) && statSync(target + suffix).size) throw new Error('Standalone offline target required')
}

const { createJiti } = createRequire(import.meta.resolve('nuxt/package.json'))('jiti')
const jiti = createJiti(import.meta.url, { fsCache: false })
const { assertFinalPlatformRuntime } = await jiti.import('../db/schema-phase.ts')
const { upgradeRosterFileClassification } = await jiti.import('./roster-file-classification.ts')
const sqlite = new Database(target, { fileMustExist: true })
try {
  assertFinalPlatformRuntime(sqlite)
  process.stdout.write(JSON.stringify(upgradeRosterFileClassification(sqlite)) + '\n')
} finally {
  sqlite.close()
}
