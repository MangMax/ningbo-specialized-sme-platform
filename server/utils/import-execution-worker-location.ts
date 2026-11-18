import { createEnterpriseReadProcess } from '../../layers/sme-roster/server/utils/enterprise-read-process'

/** Nitro replaces this source loader with a packaged, relocatable entry. */
export function createImportExecutionWorker() {
  return createEnterpriseReadProcess(new URL('../../lib/roster/import-execution-source-loader.mjs', import.meta.url))
}
