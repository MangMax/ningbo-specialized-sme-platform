import { appManifests } from '../lib/installed-manifests'
import { installAppModules } from '../lib/app-modules'
import * as coreSpecs from '../layers/core/server/modules/core/job-specs'
import * as rosterSpecs from '../layers/sme-roster/server/modules/sme-roster/job-specs'
import { rosterFileServerCategory } from '../layers/sme-roster/server/modules/sme-roster/files'
import { jobReadProjector } from '../layers/sme-roster/server/utils/job-read'
import { cleanupCurrentExports } from '../layers/sme-roster/server/utils/current-export-artifact'
import { hasImportWriter, whenImportWriterIdle } from '../layers/sme-roster/server/utils/import-write-barrier'
import { handleTaskCenterRoute } from '../layers/sme-roster/server/utils/task-center-route'
import { ensureFileStoreReady } from '../layers/sme-roster/server/utils/mcp-files'
import { installJobRuntime } from './job-runtime'
import { installJobSpecs, registerJobSpecs } from './utils/job-specs'
import { installTaskCenter } from './task-center'
import { installMcpFilePreparation } from './mcp-file-store'
import { configureFileStore } from './file-store'
import type { JobSpec } from '../layers/core/server/utils/job-runner'

import { leadListFileServerCategory } from '../layers/lead-lists/server/utils/file-category'

export function installApplicationServer(): void {
  installAppModules(appManifests)
  configureFileStore([rosterFileServerCategory, leadListFileServerCategory])
  installMcpFilePreparation(ensureFileStoreReady)
  installTaskCenter(handleTaskCenterRoute)
  installJobRuntime({
    readProjector: jobReadProjector,
    cleanupArtifacts: cleanupCurrentExports,
    hasForegroundWriter: hasImportWriter,
    whenForegroundWriterIdle: whenImportWriterIdle,
  })
  installJobSpecs(new Map<string, Readonly<Record<string, JobSpec>>>([
    ['core', coreSpecs],
    ['sme-roster', rosterSpecs],
  ]))
  registerJobSpecs()
}
