import { createRequire } from 'node:module'
const { createJiti } = createRequire(import.meta.resolve('nuxt/package.json'))('jiti')
const [source,target,evidence,resume] = process.argv.slice(2)
if (!source || !target || !evidence) throw new Error('Usage: node upgrade/run-complete-platform.mjs FROZEN_SOURCE NEW_ISOLATED_TARGET EXISTING_EVIDENCE_DIR')
const { completePlatformMigration } = await createJiti(import.meta.url, { fsCache:false }).import('./complete-platform.ts')
completePlatformMigration(source,target,evidence,resume === '--resume')
