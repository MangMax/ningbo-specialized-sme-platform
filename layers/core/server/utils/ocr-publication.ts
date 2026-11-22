import { and, eq, inArray, sql } from 'drizzle-orm'
import type { JobContext } from './job-runner'
import { getJob, setJobResult } from './job-store'
import { isJobId } from '../../lib/job'
import * as schema from '../../../../db/schema'
import {
  applyOcrAttemptUpdate, currentOcrClaim, freezeOcrFile, ocrFileFingerprint, ocrPageFingerprint, ocrProviderFingerprint,
  recoveryError, resumeOcrPublication, seedPage, terminalOcrJob, validateOcrRecoverySource, validateOcrResume, verifyFrozenOcrInput,
  type OcrAttemptUpdate, type OcrCapture, type OcrPublication, type OcrPublicationFile, type PublicationReceipt, type SharedOcrAttempt,
} from './ocr-publication-contract'
export * from './ocr-publication-contract'

type Db = JobContext['db']
export function prepareOcrPublication(db: Db, filesDir: string, files: string[], model: string, variant: string, providerUrl: string, resumeJobId?: string): OcrPublication {
  const providerFingerprint = ocrProviderFingerprint(providerUrl)
  if (resumeJobId) {
    const prior = isJobId(resumeJobId) ? getJob(db, resumeJobId) : null
    const publication = validateOcrResume(prior, files, model, variant, providerFingerprint)
    let source = prior!
    const seen = new Set<string>()
    while (true) {
      if (seen.has(source.id) || seen.size >= 64) throw recoveryError('恢复来源链不可核实')
      seen.add(source.id)
      const value = (source.result as { publication?: OcrPublication } | null)?.publication
      const parentId = value?.recovery?.sourceJobId ?? value?.resumedFrom
      if (!parentId) break
      const parent = isJobId(parentId) ? getJob(db, parentId) : null
      if (!parent || parent.kind !== 'ocr' || !terminalOcrJob(parent.state)) throw recoveryError('恢复来源任务不可核实')
      source = parent
    }
    return resumeOcrPublication(publication, source, resumeJobId)
  }
  return { version: 1, model, variant, providerFingerprint, files: files.map(file => {
    const row = db.select({ id: schema.storedFile.id, sha256: schema.storedFile.sha256, bytes: schema.storedFile.bytes, removedAt: schema.storedFile.removedAt })
      .from(schema.storedFile).where(eq(schema.storedFile.relPath, file)).get()
    const versions = row && !row.removedAt ? db.select({ page: schema.ocrResult.pageNo, id: schema.ocrResult.id, revision: schema.ocrResult.revision })
      .from(schema.ocrResult).where(eq(schema.ocrResult.fileId, row.id)).all() : []
    return freezeOcrFile(filesDir, file, row, new Map(versions.map(value => [value.page, `${value.id}:${value.revision}`])))
  }) }
}

/** The host is permanently terminal. Generic active-only checkpoint/finish and
 * startup reconciliation cannot overwrite its appended metadata. Descendant
 * jobs keep their own historical receipts and only refer to this authority. */
function recoverySource(db: Db, publication: OcrPublication, file: OcrPublicationFile) {
  const recovery = publication.recovery
  if (!recovery) throw recoveryError('没有共享恢复来源')
  return validateOcrRecoverySource(getJob(db, recovery.sourceJobId), publication, file)
}

/** Only this namespaced JSON path changes, in the caller's SQLite transaction.
 * Never pass a whole stale root result to setJobResult/finishJob. */
function writeRecoveryPath(db: Db, sourceId: string, path: string, value: unknown) {
  const changed = db.update(schema.job).set({ result: sql`json_set(${schema.job.result}, '$.ocrRecovery.version', 1, ${path}, json(${JSON.stringify(value)}))` })
    .where(and(eq(schema.job.id, sourceId), eq(schema.job.kind, 'ocr'), inArray(schema.job.state, ['done', 'failed', 'cancelled']))).run()
  if (changed.changes !== 1) throw recoveryError('恢复来源已变化,禁止提交')
}

export function checkpointOriginalOcrAttempt(db: Db, publication: OcrPublication, file: OcrPublicationFile, page: number, taskId: string, update: OcrAttemptUpdate, snapshot: () => unknown): OcrCapture | undefined {
  return db.transaction(tx => {
    const row = getJob(tx, taskId)
    if (!row || row.kind !== 'ocr' || publication.recovery || publication.resumedFrom) throw recoveryError('原 OCR 执行来源不可核实')
    if (row.state === 'running') {
      setJobResult(tx, taskId, snapshot())
      return update.state === 'complete' ? update.capture : undefined
    }
    if (update.state === 'unknown') throw recoveryError('原 OCR 执行器已结束,禁止再次提交;请读取共享恢复回执')
    const authority: OcrPublication = { ...publication, recovery: { sourceJobId: taskId, anchorJobId: taskId } }
    const source = recoverySource(tx, authority, file)
    const fingerprint = ocrPageFingerprint(publication, file, page)
    const record = source.metadata?.pages?.[fingerprint] ?? seedPage(source.id, source.originalFile, page)
    const claim = record.attempts.find(c => c.attemptId === taskId && c.ownerTaskId === taskId)
    if (!claim || claim.state === 'unsubmitted' || claim.state === 'claimed') throw recoveryError('原 OCR 提交权威不可核实,保留原回执')
    if (!source.metadata?.pages?.[fingerprint]) writeRecoveryPath(tx, source.id, `$.ocrRecovery.pages."${fingerprint}"`, record)
    return updateOcrAttempt(tx, authority, file, { sourceJobId: source.id, fingerprint, claim, action: 'blocked' }, update).capture
  }, { behavior: 'immediate' })
}

/** The caller holds the same immediate transaction as the page CAS. A live
 * stack whose original row became terminal may retain results, never publish. */
export function fenceOriginalOcrPublication(db: Db, publication: OcrPublication, taskId: string): void {
  if (!publication.recovery && getJob(db, taskId)?.state !== 'running') throw recoveryError('原 OCR 执行器已结束;原付费结果保留待显式恢复,禁止发布')
}

/** A stable input/page has one current attempt for the entire lineage. A new
 * paid attempt requires its actual terminal owner as the explicit retry anchor;
 * changing caller keys, alias children or returning to an old ancestor cannot
 * advance it. Claimed/unknown never expire into permission for another POST. */
export function acquireOcrAttempt(db: Db, publication: OcrPublication, file: OcrPublicationFile, page: number, taskId: string): SharedOcrAttempt {
  return db.transaction(tx => {
    const source = recoverySource(tx, publication, file)
    const fingerprint = ocrPageFingerprint(publication, file, page)
    const record = structuredClone(source.metadata?.pages?.[fingerprint] ?? seedPage(source.id, source.originalFile, page))
    let claim = currentOcrClaim(record, publication, file, page)
    let action: SharedOcrAttempt['action'] = claim.state === 'complete' ? 'complete' : claim.state === 'accepted' ? 'poll' : 'blocked'
    if (['unsubmitted', 'rejected', 'failed'].includes(claim.state) && publication.recovery!.anchorJobId === claim.ownerTaskId) {
      const anchor = getJob(tx, claim.ownerTaskId)
      if (!anchor || anchor.kind !== 'ocr' || !terminalOcrJob(anchor.state)) throw recoveryError('明确重试锚点尚未结束')
      claim = { attemptId: taskId, ownerTaskId: taskId, anchorJobId: anchor.id, state: 'claimed' }
      record.attempts.push(claim)
      action = 'submit'
    }
    writeRecoveryPath(tx, source.id, `$.ocrRecovery.pages."${fingerprint}"`, record)
    return { sourceJobId: source.id, fingerprint, claim, action }
  }, { behavior: 'immediate' })
}

export function updateOcrAttempt(db: Db, publication: OcrPublication, file: OcrPublicationFile, shared: SharedOcrAttempt, update: OcrAttemptUpdate) {
  return db.transaction(tx => {
    const source = recoverySource(tx, publication, file)
    const record = structuredClone(source.metadata?.pages?.[shared.fingerprint])
    const claim = record?.attempts.find(c => c.attemptId === shared.claim.attemptId)
    if (!record || !claim || claim.ownerTaskId !== shared.claim.ownerTaskId) throw recoveryError('共享认领已变化')
    if (claim.state === 'complete') return claim
    applyOcrAttemptUpdate(claim, update)
    writeRecoveryPath(tx, source.id, `$.ocrRecovery.pages."${shared.fingerprint}"`, record)
    return claim
  }, { behavior: 'immediate' })
}

export function sharedOcrPublication(db: Db, publication: OcrPublication, file: OcrPublicationFile): PublicationReceipt | null {
  if (!publication.recovery) return null
  const source = recoverySource(db, publication, file)
  return source.metadata?.publications?.[ocrFileFingerprint(publication, file)]
    ?? (source.originalFile.state === 'published' && source.originalFile.publishedVersions ? { taskId: source.id, versions: source.originalFile.publishedVersions } : null)
}

/** Caller holds the same publication write transaction as the actual page CAS. */
export function recordSharedOcrPublication(db: Db, publication: OcrPublication, file: OcrPublicationFile, taskId: string) {
  if (!publication.recovery) return
  const source = recoverySource(db, publication, file)
  writeRecoveryPath(db, source.id, `$.ocrRecovery.publications."${ocrFileFingerprint(publication, file)}"`, { taskId, versions: file.publishedVersions })
}

export function verifyOcrInput(db: Db, filesDir: string, file: OcrPublicationFile): void {
  const row = db.select({ id: schema.storedFile.id, sha256: schema.storedFile.sha256, bytes: schema.storedFile.bytes, removedAt: schema.storedFile.removedAt })
    .from(schema.storedFile).where(eq(schema.storedFile.relPath, file.file)).get()
  verifyFrozenOcrInput(filesDir, file, row)
}
