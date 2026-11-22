import { resolve } from 'node:path'
import type { JobCompletion, JobContext, JobSpec } from '../job-runner'
import { setJobResult } from '../job-store'
import { acquireOcrAttempt, checkpointOriginalOcrAttempt, fenceOriginalOcrPublication, prepareOcrPublication, recordSharedOcrPublication, sharedOcrPublication, updateOcrAttempt, verifyOcrInput, type OcrPublication } from '../ocr-publication'
import { listOcrResults, writeOcrResult } from '../ocr-result'
import { ocrRequestVariant } from '../ocr-api'
import { resolveOcrConfig } from '../ocr-config-sqlite'
import { executeOcr, ocrSpec as postgresSpec, type OcrParams, type OcrStorage } from './ocr'

function sqliteOcrStorage(ctx: JobContext): OcrStorage {
  return {
    cancelled: () => ctx.cancelled(),
    progress: (done, total) => ctx.progress(done, total),
    checkpoint: snapshot => { setJobResult(ctx.db, ctx.jobId, snapshot()) },
    verifyInput: file => verifyOcrInput(ctx.db, ctx.filesDir, file),
    sharedPublication: (publication, file) => sharedOcrPublication(ctx.db, publication, file),
    acquire: (publication, file, page) => acquireOcrAttempt(ctx.db, publication, file, page, ctx.jobId),
    persistAttempt: (publication, file, page, shared, update, snapshot) => shared
      ? updateOcrAttempt(ctx.db, publication, file, shared, update).capture
      : checkpointOriginalOcrAttempt(ctx.db, publication, file, page, ctx.jobId, update, snapshot),
    publish: (publication, file, input, snapshot) => ctx.db.transaction(tx => {
      fenceOriginalOcrPublication(tx, publication, ctx.jobId)
      verifyOcrInput(tx, ctx.filesDir, file)
      const committed = sharedOcrPublication(tx, publication, file)
      if (committed) {
        file.state = 'published'
        file.publishedVersions = committed.versions
        setJobResult(tx, ctx.jobId, snapshot())
        return true
      }
      const written = writeOcrResult(tx, input)
      if (!written.ok) throw new Error(written.message)
      file.state = 'published'
      file.publishedVersions = Object.fromEntries(listOcrResults(tx, input.fileId)
        .filter(row => row.page in file.targets).map(row => [row.page, row.version]))
      recordSharedOcrPublication(tx, publication, file, ctx.jobId)
      setJobResult(tx, ctx.jobId, snapshot())
      return false
    }, { behavior: 'immediate' }),
  }
}

export async function runOcr(
  ctx: JobContext,
  params: Record<string, unknown>,
  config = resolveOcrConfig(),
  prepared?: OcrPublication,
): Promise<JobCompletion> {
  const { files, model, resumeJobId } = params as unknown as OcrParams
  const effectiveModel = model ?? config.model
  const publication = prepared ?? prepareOcrPublication(ctx.db, ctx.filesDir, files, effectiveModel, ocrRequestVariant(effectiveModel), config.baseUrl, resumeJobId)
  return executeOcr(ctx, params, config, publication, sqliteOcrStorage(ctx))
}

export const ocrSqliteSpec: JobSpec = {
  ...postgresSpec,
  prepare: (params, db) => {
    const config = resolveOcrConfig()
    const { files, model, resumeJobId } = params as unknown as OcrParams
    const root = typeof useRuntimeConfig === 'function' ? useRuntimeConfig().filesDir : resolve(process.env.NUXT_FILES_DIR || 'files')
    const effectiveModel = model ?? config.model
    const prepared = prepareOcrPublication(db, root, files, effectiveModel, ocrRequestVariant(effectiveModel), config.baseUrl, resumeJobId)
    return (ctx, input) => runOcr(ctx, input, config, prepared)
  },
  run: runOcr,
}
