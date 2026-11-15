// Source-hosted HTTP fixtures exercise real packaged business workers.
import { enterpriseReads, createEnterpriseReadExecutor } from '../../server/utils/enterprise-read'
import { importExecutor, createImportExecutor } from '../../server/utils/import-execution'
import { createEnterpriseReadProcess } from '../../server/utils/enterprise-read-process'

export function installCompiledBusinessWorkers() {
  Object.assign(enterpriseReads, createEnterpriseReadExecutor({
    createWorker: () => createEnterpriseReadProcess(new URL('../../.output/server/enterprise-read-worker.mjs', import.meta.url)),
  }))
  Object.assign(importExecutor, createImportExecutor({
    createWorker: () => createEnterpriseReadProcess(new URL('../../.output/server/import-execution-worker.mjs', import.meta.url)),
  }))
}
