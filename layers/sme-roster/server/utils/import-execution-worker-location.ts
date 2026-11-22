import { createEnterpriseReadProcess } from './enterprise-read-process'

/** Legacy SQLite worker used by explicit offline and test callers. */
export function createImportExecutionWorker() {
  return createEnterpriseReadProcess(new URL('../../lib/roster/import-execution-source-loader.mjs', import.meta.url))
}
