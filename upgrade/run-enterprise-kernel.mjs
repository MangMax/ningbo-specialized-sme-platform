import { createRequire } from 'node:module'
import { existsSync, statSync } from 'node:fs'
import Database from 'better-sqlite3'

const [target, region, industry, ...extra] = process.argv.slice(2)
if (!target || !region || !industry || extra.length) {
  throw new Error('Usage: node upgrade/run-enterprise-kernel.mjs OFFLINE_DATABASE REGION_EXPORT INDUSTRY_EXPORT')
}
for (const suffix of ['-wal', '-journal']) {
  if (existsSync(target + suffix) && statSync(target + suffix).size) throw new Error('Standalone offline target required')
}
const { createJiti } = createRequire(import.meta.resolve('nuxt/package.json'))('jiti')
const jiti = createJiti(import.meta.url, { fsCache: false })
const { readEnterpriseDictionaries } = await jiti.import('./enterprise-dictionaries.ts')
const { upgradeEnterpriseKernel } = await jiti.import('./enterprise-kernel.ts')
const dictionaries = readEnterpriseDictionaries(region, industry)
const db = new Database(target, { fileMustExist: true })
try {
  db.pragma('foreign_keys = ON')
  const outcome = upgradeEnterpriseKernel(db, dictionaries)
  console.log(JSON.stringify({
    ...outcome, regions: dictionaries.regions.length, industries: dictionaries.industries.length,
    regionSha256: dictionaries.regionSha256, industrySha256: dictionaries.industrySha256,
  }))
} finally {
  db.close()
}
