import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createEnterpriseReadProcess } from './enterprise-read-process'

/** Source-only launcher. Nitro replaces the entry with a relocatable bundled URL. */
export function createEnterpriseWorker() {
  const jitiPath = createRequire(import.meta.resolve('nuxt/package.json')).resolve('jiti')
  const entry = new URL('../../lib/roster/enterprise-read-worker.ts', import.meta.url)
  return createEnterpriseReadProcess(entry, `
    import {createRequire} from 'node:module';
    const {createJiti}=createRequire(import.meta.url)(${JSON.stringify(jitiPath)});
    await createJiti(${JSON.stringify(fileURLToPath(entry))}).import(${JSON.stringify(fileURLToPath(entry))});
  `)
}
