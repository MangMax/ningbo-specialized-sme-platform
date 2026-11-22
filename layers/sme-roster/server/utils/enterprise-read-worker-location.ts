import { createSourceEnterpriseReadProcess } from './enterprise-read-process'

/** Source-only launcher. Nitro replaces the entry with a relocatable bundled URL. */
export function createEnterpriseWorker() {
  return createSourceEnterpriseReadProcess(new URL('../../lib/roster/enterprise-read-worker.ts', import.meta.url))
}
