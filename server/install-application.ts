import { appManifests } from '../lib/installed-manifests'
import { installAppModules } from '../lib/app-modules'
import * as coreSpecs from '../layers/core/server/modules/core/job-specs'
import * as rosterSpecs from '../layers/sme-roster/server/modules/sme-roster/job-specs'
import { rosterFileServerCategory } from '../layers/sme-roster/server/modules/sme-roster/files'
import { rosterPostgresTaskListOptions } from '../layers/sme-roster/server/utils/task-center-route'
import { installJobSpecs, registerJobSpecs } from './utils/job-specs'
import { installTaskCenter } from './task-center'
import { configurePostgresFileCategories } from '../layers/core/server/utils/file-category-runtime'
import { libraryFileServerCategory } from '../layers/core/server/utils/library-file-category'
import type { JobSpec } from '../layers/core/server/utils/job-contract'

import * as leadListSpecs from '../layers/lead-lists/server/utils/export-job'
import { leadListFileServerCategory } from '../layers/lead-lists/server/utils/file-category'

export function installApplicationServer(): void {
  installAppModules(appManifests)
  configurePostgresFileCategories([libraryFileServerCategory, rosterFileServerCategory, leadListFileServerCategory])
  installTaskCenter(rosterPostgresTaskListOptions)
  installJobSpecs(new Map<string, Readonly<Record<string, JobSpec>>>([
    ['core', coreSpecs],
    ['sme-roster', rosterSpecs],
    ['lead-lists', leadListSpecs],
  ]))
  registerJobSpecs()
}
