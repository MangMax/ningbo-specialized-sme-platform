import { registeredFileAtLocator } from '../file-read-identity'
import type { StoredFileContentIdentity } from '../file-identity'
import type { JobCompletion, JobContext, JobSpec } from '../job-runner'
import { renderFiles, renderPagesSpec as postgresSpec } from './render-pages'

export function runRenderPages(
  ctx: JobContext,
  params: Record<string, unknown>,
  registeredInputs?: Array<StoredFileContentIdentity | null>,
): Promise<JobCompletion> {
  const lookup = (path: string) => registeredFileAtLocator(ctx.db, path)
  const inputs = registeredInputs ?? (params.files as string[]).map(lookup)
  return renderFiles(ctx, params, inputs, lookup)
}

export const renderPagesSqliteSpec: JobSpec = {
  ...postgresSpec,
  prepare: (params, db) => {
    const inputs = (params.files as string[]).map(file => registeredFileAtLocator(db, file))
    return (ctx, input) => runRenderPages(ctx, input, inputs)
  },
  run: runRenderPages,
}
