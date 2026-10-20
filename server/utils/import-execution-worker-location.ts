import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createEnterpriseReadProcess } from './enterprise-read-process'

/** Nitro replaces this source loader with a packaged, relocatable entry. */
export function createImportExecutionWorker() {
  const jitiPath = createRequire(import.meta.resolve('nuxt/package.json')).resolve('jiti')
  const entry = new URL('../../lib/roster/import-execution-worker.ts', import.meta.url)
  return createEnterpriseReadProcess(entry, `
    import {createRequire} from 'node:module';
    const {createJiti}=createRequire(import.meta.url)(${JSON.stringify(jitiPath)});
    await createJiti(${JSON.stringify(fileURLToPath(entry))}).import(${JSON.stringify(fileURLToPath(entry))});
  `)
}
