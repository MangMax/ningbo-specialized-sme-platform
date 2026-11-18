// Bind the installed module's job projections and write coordination.
import { jobReadProjector } from '../layers/sme-roster/server/utils/job-read'
import { cleanupCurrentExports } from '../layers/sme-roster/server/utils/current-export-artifact'
import { hasImportWriter, whenImportWriterIdle } from './utils/import-write-barrier'

export const jobRuntime = {
  readProjector: jobReadProjector,
  cleanupArtifacts: cleanupCurrentExports,
  hasForegroundWriter: hasImportWriter,
  whenForegroundWriterIdle: whenImportWriterIdle,
}
