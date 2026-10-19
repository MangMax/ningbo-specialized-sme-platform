import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

/** Source-only launcher for Vitest. Nitro replaces this module with a bundled
 * entry URL, so production has no loader or checkout dependency. */
export function createEnterpriseWorker(): Worker {
  const jitiPath = createRequire(import.meta.resolve('nuxt/package.json')).resolve('jiti')
  return new Worker(`
    const {workerData}=require('node:worker_threads');
    const {createJiti}=require(workerData.jitiPath);
    createJiti(workerData.entry).import(workerData.entry).catch(error=>{throw error});
  `, {
    eval: true, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 128 },
    workerData: { jitiPath, entry: fileURLToPath(new URL('../../lib/roster/enterprise-read-worker.ts', import.meta.url)) },
  })
}
