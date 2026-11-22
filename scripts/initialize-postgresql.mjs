import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
if (args.length > 1 || (args.length === 1 && args[0] !== '--logs-only')) {
  throw new Error('Usage: node scripts/initialize-postgresql.mjs [--logs-only]')
}
if (!process.env.PGDATABASE) throw new Error('Set PGDATABASE to the new PostgreSQL database')

const require = createRequire(import.meta.url)
const { createJiti } = createRequire(require.resolve('nuxt/package.json'))('jiti')
const jiti = createJiti(import.meta.url, { fsCache: false })
const { TITLE_SEED } = await jiti.import('../db/titles.ts')
const { LOG_DEFAULTS } = await jiti.import('../layers/core/lib/logging/contract.ts')
const { LOG_FIELD_PROFILES, defaultFieldControls } = await jiti.import('../layers/core/lib/logging/field-controls.ts')
const { defaultLogCollection } = await jiti.import('../layers/core/lib/logging/policy.ts')

const logCollection = {
  version: 2,
  collection: defaultLogCollection(),
  fieldControls: defaultFieldControls(LOG_FIELD_PROFILES),
}
const bin = process.env.PGSQL_BIN
const psql = bin && statSync(bin, { throwIfNoEntry: false })?.isDirectory() ? join(bin, 'psql') : bin ?? 'psql'
const result = spawnSync(psql, [
  '-X', '-w',
  '-v', 'logs_only=' + args.includes('--logs-only'),
  '-v', 'titles=' + JSON.stringify(TITLE_SEED),
  '-v', 'retention_days=' + LOG_DEFAULTS.retentionDays,
  '-v', 'max_bytes=' + LOG_DEFAULTS.maxBytes,
  '-v', 'log_collection=' + JSON.stringify(logCollection),
  '-f', fileURLToPath(new URL('../db/postgresql/bootstrap.sql', import.meta.url)),
], { stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
