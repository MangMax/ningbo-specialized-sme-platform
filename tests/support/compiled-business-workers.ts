// Source-hosted HTTP fixtures exercise real packaged business workers.
import { enterpriseReads, createEnterpriseReadExecutor } from '../../layers/sme-roster/server/utils/enterprise-read'
import { importExecutor, createImportExecutor } from '../../layers/sme-roster/server/utils/import-execution'
import { createEnterpriseReadProcess } from '../../layers/sme-roster/server/utils/enterprise-read-process'
import { createImportExecutionWorker } from '../../layers/sme-roster/server/utils/import-execution-worker-location'

export function installCompiledBusinessWorkers() {
  Object.assign(enterpriseReads, createEnterpriseReadExecutor({
    createWorker: () => createEnterpriseReadProcess(new URL('../../.output/server/enterprise-read-worker.mjs', import.meta.url)),
  }))
  Object.assign(importExecutor, createImportExecutor({
    createWorker: createImportExecutionWorker,
  }))
}
