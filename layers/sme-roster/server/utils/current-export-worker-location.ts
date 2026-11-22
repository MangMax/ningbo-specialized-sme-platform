import { createSourceEnterpriseReadProcess } from './enterprise-read-process'

/** Source launcher; Nitro replaces this module with a relocatable built child entry. */
export function createCurrentExportWorker() {
  return createSourceEnterpriseReadProcess(new URL('../../lib/roster/current-export-worker.ts', import.meta.url))
}
