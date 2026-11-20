import { appManifests } from '../lib/installed-manifests'
import { installAppModules } from '../lib/app-modules'
import * as coreSpecs from '../layers/core/server/modules/core/job-specs'
import * as rosterSpecs from '../layers/sme-roster/server/modules/sme-roster/job-specs'
import { rosterFileServerCategory } from '../layers/sme-roster/server/modules/sme-roster/files'
import { jobReadProjector } from '../layers/sme-roster/server/utils/job-read'
import { cleanupCurrentExports } from '../layers/sme-roster/server/utils/current-export-artifact'
import { hasImportWriter, whenImportWriterIdle } from '../layers/sme-roster/server/utils/import-write-barrier'
import { handleTaskCenterRoute, rosterPostgresTaskListOptions } from '../layers/sme-roster/server/utils/task-center-route'
import { ensureFileStoreReady } from '../layers/sme-roster/server/utils/mcp-files'
import { installJobRuntime } from './job-runtime'
import { installJobSpecs, registerJobSpecs } from './utils/job-specs'
import { installTaskCenter } from './task-center'
import { installMcpFilePreparation } from './mcp-file-store'
import { configureFileStore } from './file-store'
import { libraryFileServerCategory } from '../layers/core/server/utils/library-file-category'
import type { JobSpec } from '../layers/core/server/utils/job-runner'

import * as leadListSpecs from '../layers/lead-lists/server/utils/export-job'
import { leadListFileServerCategory } from '../layers/lead-lists/server/utils/file-category'

export function installApplicationServer(): void {
  installAppModules(appManifests)
  configureFileStore([libraryFileServerCategory, rosterFileServerCategory, leadListFileServerCategory])
  installMcpFilePreparation(ensureFileStoreReady)
  installTaskCenter(handleTaskCenterRoute, rosterPostgresTaskListOptions)
  installJobRuntime({
    readProjector: jobReadProjector,
    cleanupArtifacts: cleanupCurrentExports,
    hasForegroundWriter: hasImportWriter,
    whenForegroundWriterIdle: whenImportWriterIdle,
  })
  installJobSpecs(new Map<string, Readonly<Record<string, JobSpec>>>([
    ['core', coreSpecs],
    ['sme-roster', rosterSpecs],
    ['lead-lists', leadListSpecs],
  ]))
  registerJobSpecs()
}
