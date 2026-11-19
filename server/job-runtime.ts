import type { JobDto, JobRow } from '../layers/core/server/utils/job-store'
import type { JobContext } from '../layers/core/server/utils/job-runner'

type Db = JobContext['db']

interface JobRuntime {
  readProjector(db: Db): (row: JobRow) => Promise<JobDto>
  cleanupArtifacts(db: Db): Promise<unknown>
  hasForegroundWriter(): boolean
  whenForegroundWriterIdle(): Promise<void>
}

export let jobRuntime: JobRuntime = {
  readProjector() { throw new Error('Job read projector has not been installed') },
  cleanupArtifacts: async () => {},
  hasForegroundWriter: () => false,
  whenForegroundWriterIdle: async () => {},
}

export function installJobRuntime(runtime: JobRuntime): void {
  jobRuntime = runtime
}
