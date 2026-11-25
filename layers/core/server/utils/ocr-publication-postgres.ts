import { and, DrizzleQueryError, eq, inArray } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { ocrResult, storedFile } from '../../../../db/postgresql/file-tables'
import { job } from '../../../../db/postgresql/job-tables'
import { isJobId } from '../../lib/job'
import { lockPostgresFile } from './file-store-postgres'
import type { PostgresJobContext } from './job-runner-postgres'
import { getJob } from './job-store-postgres'
import {
  applyOcrAttemptUpdate, currentOcrClaim, freezeOcrFile, ocrFileFingerprint, ocrPageFingerprint,
  ocrProviderFingerprint, recoveryError, resumeOcrPublication, seedPage, terminalOcrJob,
  validateOcrRecoverySource, validateOcrResume, verifyFrozenOcrInput,
  type OcrAttemptUpdate, type OcrPublication, type OcrPublicationFile, type OcrRegisteredInput,
  type PageClaims, type PublicationReceipt, type RecoveryMetadata, type SharedOcrAttempt,
} from './ocr-publication-contract'
import { writePostgresOcrResult } from './ocr-result-postgres'
import type { OcrWriteInput } from './ocr-result-contract'

async function registeredInput(db: NodePgDatabase, path: string): Promise<OcrRegisteredInput | null> {
  if (path.includes('\0')) return null
  const [row] = await db.select({
    id: storedFile.id, sha256: storedFile.sha256, bytes: storedFile.bytes, removedAt: storedFile.removedAt,
  }).from(storedFile).where(eq(storedFile.relPath, path))
  return row ? { ...row, bytes: Number(row.bytes) } : null
}

async function readPageVersions(db: NodePgDatabase, fileId: number) {
  const rows = await db.select({ page: ocrResult.page, id: ocrResult.id, revision: ocrResult.revision })
    .from(ocrResult).where(eq(ocrResult.fileId, fileId))
  return new Map(rows.map(({ page, id, revision }) => [page, `${id}:${revision}`]))
}

export async function preparePostgresOcrPublication(
  db: NodePgDatabase, filesDir: string, files: string[], model: string, variant: string, providerUrl: string, resumeJobId?: string,
): Promise<OcrPublication> {
  const providerFingerprint = ocrProviderFingerprint(providerUrl)
  if (resumeJobId) {
    const anchor = isJobId(resumeJobId) ? (await getJob(db, resumeJobId))?.row : undefined
    const publication = validateOcrResume(anchor, files, model, variant, providerFingerprint)
    let source = anchor!
    const seen = new Set<string>()
    while (true) {
      if (seen.has(source.id) || seen.size >= 64) throw recoveryError('恢复来源链不可核实')
      seen.add(source.id)
      const value = (source.result as { publication?: OcrPublication } | null)?.publication
      const parentId = value?.recovery?.sourceJobId ?? value?.resumedFrom
      if (!parentId) return resumeOcrPublication(publication, source, resumeJobId)
      const parent = isJobId(parentId) ? (await getJob(db, parentId))?.row : undefined
      if (!parent || parent.kind !== 'ocr' || !terminalOcrJob(parent.state)) throw recoveryError('恢复来源任务不可核实')
      source = parent
    }
  }
  const entries: OcrPublicationFile[] = []
  for (const file of files) {
    const input = await registeredInput(db, file)
    const versions = input && !input.removedAt ? await readPageVersions(db, input.id) : new Map<number, string>()
    entries.push(freezeOcrFile(filesDir, file, input, versions))
  }
  return { version: 1, model, variant, providerFingerprint, files: entries }
}

async function recoverySource(db: NodePgDatabase, publication: OcrPublication, file: OcrPublicationFile, lock: boolean) {
  if (!publication.recovery) throw recoveryError('没有共享恢复来源')
  return validateOcrRecoverySource((await getJob(db, publication.recovery.sourceJobId, lock))?.row, publication, file)
}

type RecoverySource = Awaited<ReturnType<typeof recoverySource>>
async function writeMetadata(db: NodePgDatabase, source: RecoverySource, metadata: RecoveryMetadata) {
  const changed = await db.update(job).set({ result: JSON.stringify({ ...source.result, ocrRecovery: metadata }) })
    .where(and(eq(job.id, source.id), eq(job.kind, 'ocr'), inArray(job.state, ['done', 'failed', 'cancelled'])))
  if (changed.rowCount !== 1) throw recoveryError('恢复来源已变化,禁止提交')
}

function readPublication(source: RecoverySource, key: string): PublicationReceipt | null {
  return source.metadata?.publications?.[key]
    ?? (source.originalFile.state === 'published' && source.originalFile.publishedVersions
      ? { taskId: source.id, versions: source.originalFile.publishedVersions } : null)
}

async function writePageRecord(db: NodePgDatabase, source: RecoverySource, key: string, record: PageClaims) {
  return writeMetadata(db, source, { ...source.metadata, version: 1, pages: { ...source.metadata?.pages, [key]: record } })
}

export function postgresOcrStorage(ctx: PostgresJobContext) {
  let pending = Promise.resolve()
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = pending.then(operation).catch(error => {
      if (error instanceof DrizzleQueryError) throw new Error('OCR 数据库操作失败，请检查执行日志。', { cause: error })
      throw error
    })
    pending = next.then(() => undefined, () => undefined)
    return next
  }
  async function verify(db: NodePgDatabase, file: OcrPublicationFile) {
    verifyFrozenOcrInput(ctx.filesDir, file, await registeredInput(db, file.file))
  }
  return {
    cancelled: () => serial(() => ctx.cancelled()),
    progress: (done: number, total: number) => serial(() => ctx.progress(done, total)),
    checkpoint: (snapshot: () => unknown) => serial(() => ctx.checkpoint(snapshot())),
    verifyInput: (file: OcrPublicationFile) => serial(() => verify(ctx.db, file)),
    async sharedPublication(publication: OcrPublication, file: OcrPublicationFile) {
      if (!publication.recovery) return null
      return serial(async () => readPublication(await recoverySource(ctx.db, publication, file, false), ocrFileFingerprint(publication, file)))
    },
    acquire(publication: OcrPublication, file: OcrPublicationFile, page: number) {
      return serial(() => ctx.db.transaction(async tx => {
        const source = await recoverySource(tx, publication, file, true)
        const key = ocrPageFingerprint(publication, file, page)
        const record = source.metadata?.pages?.[key] ?? seedPage(source.id, source.originalFile, page)
        let claim = currentOcrClaim(record, publication, file, page)
        let action: SharedOcrAttempt['action'] = claim.state === 'complete' ? 'complete' : claim.state === 'accepted' ? 'poll' : 'blocked'
        if (['unsubmitted', 'rejected', 'failed'].includes(claim.state) && publication.recovery!.anchorJobId === claim.ownerTaskId) {
          const anchor = (await getJob(tx, claim.ownerTaskId))?.row
          if (!anchor || anchor.kind !== 'ocr' || !terminalOcrJob(anchor.state)) throw recoveryError('明确重试锚点尚未结束')
          claim = { attemptId: ctx.jobId, ownerTaskId: ctx.jobId, anchorJobId: anchor.id, state: 'claimed' }
          record.attempts.push(claim)
          action = 'submit'
        }
        await writePageRecord(tx, source, key, record)
        return { sourceJobId: source.id, fingerprint: key, claim, action }
      }))
    },
    persistAttempt(
      publication: OcrPublication, file: OcrPublicationFile, page: number, shared: SharedOcrAttempt | null,
      update: OcrAttemptUpdate, snapshot: () => unknown,
    ) {
      return serial(() => ctx.db.transaction(async tx => {
        if (shared) {
          const source = await recoverySource(tx, publication, file, true)
          const record = source.metadata?.pages?.[shared.fingerprint]
          const claim = record?.attempts.find(item => item.attemptId === shared.claim.attemptId)
          if (!record || !claim || claim.ownerTaskId !== shared.claim.ownerTaskId) throw recoveryError('共享认领已变化')
          if (claim.state === 'complete') return claim.capture
          applyOcrAttemptUpdate(claim, update)
          await writePageRecord(tx, source, shared.fingerprint, record)
          return claim.capture
        }
        const row = (await getJob(tx, ctx.jobId, true))?.row
        if (!row || row.kind !== 'ocr' || publication.recovery || publication.resumedFrom) throw recoveryError('原 OCR 执行来源不可核实')
        if (row.state === 'running') {
          await ctx.checkpoint(snapshot(), tx)
          return update.state === 'complete' ? update.capture : undefined
        }
        if (update.state === 'unknown') throw recoveryError('原 OCR 执行器已结束,禁止再次提交;请读取共享恢复回执')
        const source = validateOcrRecoverySource(row, publication, file)
        const key = ocrPageFingerprint(publication, file, page)
        const record = source.metadata?.pages?.[key] ?? seedPage(source.id, source.originalFile, page)
        const claim = record.attempts.find(item => item.attemptId === ctx.jobId && item.ownerTaskId === ctx.jobId)
        if (!claim || claim.state === 'unsubmitted' || claim.state === 'claimed') throw recoveryError('原 OCR 提交权威不可核实,保留原回执')
        applyOcrAttemptUpdate(claim, update)
        await writePageRecord(tx, source, key, record)
        return claim.capture
      }))
    },
    publish(publication: OcrPublication, file: OcrPublicationFile, input: OcrWriteInput, snapshot: () => unknown) {
      return serial(() => ctx.db.transaction(async tx => {
        const job = await getJob(tx, ctx.jobId, true)
        if (job?.row.state !== 'running') throw recoveryError('原 OCR 执行器已结束;原付费结果保留待显式恢复,禁止发布')
        await lockPostgresFile(tx, input.fileId)
        await verify(tx, file)
        const key = ocrFileFingerprint(publication, file)
        const source = publication.recovery ? await recoverySource(tx, publication, file, true) : null
        const committed = source && readPublication(source, key)
        if (committed) {
          file.state = 'published'
          file.publishedVersions = committed.versions
          await ctx.checkpoint(snapshot(), tx)
          return true
        }
        const written = await writePostgresOcrResult(tx, input)
        if (!written.ok) throw new Error(written.message)
        file.state = 'published'
        file.publishedVersions = Object.fromEntries([...(await readPageVersions(tx, input.fileId))]
          .filter(([page]) => page in file.targets))
        if (source) await writeMetadata(tx, source, { ...source.metadata, version: 1,
          publications: { ...source.metadata?.publications, [key]: { taskId: ctx.jobId, versions: file.publishedVersions } } })
        await ctx.checkpoint(snapshot(), tx)
        return false
      }))
    },
  }
}
