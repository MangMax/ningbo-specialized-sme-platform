import { createHash } from 'node:crypto'
import { closeSync, openSync, readSync, readFileSync } from 'node:fs'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { JobContext } from './job-runner'
import { getJob } from './job-store'
import { isJobId } from '../../lib/job'
import { pageDirRelPath, PAGES_MANIFEST_NAME } from '../../lib/pdf-page'
import * as schema from '../../db/schema'
import { resolveWithinRoot } from './pdf-pages'

type Db = JobContext['db']
export interface OcrCapture {
  page: number
  markdown: string
  raw: unknown
  imageSha256: string
  variant: string
  jobId: string
  model: string
  createdAt: string | null
  taskId: string | null
  sourceSha256: string | null
}
export interface OcrPublicationFile {
  file: string
  fileId: number | null
  registeredSha256: string | null
  sourceSha256: string | null
  targets: Record<number, string | null>
  images: Record<number, { relPath: string; sha256: string }>
  captures: OcrCapture[]
  requests: Record<number, { state: 'claimed' | 'unknown' | 'accepted' | 'rejected' | 'failed'; jobId?: string; taskId?: string; previous?: Array<{ state: string; jobId?: string; taskId?: string }> }>
  claims?: Record<number, { sourceJobId: string; fingerprint: string; attemptId: string; ownerTaskId: string; state: OcrClaim['state'] }>
  state: 'pending' | 'partial' | 'published' | 'conflict' | 'failed' | 'cancelled'
  publishedVersions?: Record<number, string>
  error?: string
}
export interface OcrPublication {
  version: 1
  model: string
  variant: string
  providerFingerprint: string
  resumedFrom?: string
  /** Server-derived lineage only. Claims live on the terminal first source job,
   * never on an active descendant whose finish/checkpoint replaces its result. */
  recovery?: { sourceJobId: string; anchorJobId: string }
  files: OcrPublicationFile[]
}

/** Synchronous final check can sit inside the SQLite publication transaction.
 * Stream chunks, rather than hydrate an entire source PDF in memory. */
export function ocrInputHash(path: string): string {
  const fd = openSync(path, 'r')
  try {
    const hash = createHash('sha256'), chunk = Buffer.allocUnsafe(64 * 1024)
    let n: number
    while ((n = readSync(fd, chunk)) > 0) hash.update(chunk.subarray(0, n))
    return hash.digest('hex')
  } finally { closeSync(fd) }
}

/** Submission-time capture: no markdown/raw hydration and no file-store scan. */
export function prepareOcrPublication(db: Db, filesDir: string, files: string[], model: string, variant: string, providerUrl: string, resumeJobId?: string): OcrPublication {
  const providerFingerprint = createHash('sha256').update(providerUrl.replace(/\/+$/, '')).digest('hex')
  if (resumeJobId) {
    const prior = isJobId(resumeJobId) ? getJob(db, resumeJobId) : null
    const publication = (prior?.result as { publication?: OcrPublication } | null)?.publication
    if (!prior || prior.kind !== 'ocr' || !['done', 'failed', 'cancelled'].includes(prior.state)
      || publication?.version !== 1 || publication.model !== model || publication.variant !== variant || publication.providerFingerprint !== providerFingerprint
      || JSON.stringify(publication.files.map(f => f.file)) !== JSON.stringify(files)) {
      throw Object.assign(new Error('恢复需要同文件、同模型/选项的已结束 OCR 任务及采集检查点'), { statusCode: 409 })
    }
    let source = prior
    const seen = new Set<string>()
    while (true) {
      if (seen.has(source.id) || seen.size >= 64) throw recoveryError('恢复来源链不可核实')
      seen.add(source.id)
      const value = (source.result as { publication?: OcrPublication } | null)?.publication
      const parentId = value?.recovery?.sourceJobId ?? value?.resumedFrom
      if (!parentId) break
      const parent = isJobId(parentId) ? getJob(db, parentId) : null
      if (!parent || parent.kind !== 'ocr' || !terminal(parent.state)) throw recoveryError('恢复来源任务不可核实')
      source = parent
    }
    const sourcePublication = (source.result as { publication?: OcrPublication }).publication
    if (!sourcePublication || publicationIdentity(sourcePublication) !== publicationIdentity(publication)) throw recoveryError('恢复来源输入不一致')
    return { ...structuredClone(publication), resumedFrom: resumeJobId, recovery: { sourceJobId: source.id, anchorJobId: prior.id } }
  }
  return { version: 1, model, variant, providerFingerprint, files: files.map(file => {
    const row = db.select({ id: schema.storedFile.id, sha256: schema.storedFile.sha256, removedAt: schema.storedFile.removedAt })
      .from(schema.storedFile).where(eq(schema.storedFile.relPath, file)).get()
    const entry: OcrPublicationFile = { file, fileId: row?.id ?? null, registeredSha256: row?.sha256 ?? null, sourceSha256: null, targets: {}, images: {}, captures: [], requests: {}, state: 'pending' }
    try {
      if (!row || row.removedAt) throw new Error('stored_file 中没有这个文件或已移出库')
      entry.sourceSha256 = ocrInputHash(resolveWithinRoot(filesDir, file))
      const versions = db.select({ page: schema.ocrResult.pageNo, id: schema.ocrResult.id, revision: schema.ocrResult.revision })
        .from(schema.ocrResult).where(eq(schema.ocrResult.fileId, row.id)).all()
      const manifest = JSON.parse(readFileSync(resolveWithinRoot(filesDir, `${pageDirRelPath(file)}/${PAGES_MANIFEST_NAME}`), 'utf8'))
      if (!Array.isArray(manifest.pages) || manifest.sourceSha256 !== entry.sourceSha256) throw new Error('页图输入不匹配,请先渲染最新页图')
      for (const page of manifest.pages) {
        const existing = versions.find(v => v.page === page.page)
        entry.targets[page.page] = existing ? `${existing.id}:${existing.revision}` : null
        entry.images[page.page] = { relPath: page.relPath, sha256: ocrInputHash(resolveWithinRoot(filesDir, page.relPath)) }
      }
    } catch (error) { entry.error = (error as Error).message; entry.state = 'failed' }
    return entry
  }) }
}

type ClaimState = 'unsubmitted' | 'claimed' | 'unknown' | 'accepted' | 'rejected' | 'failed' | 'complete'
export interface OcrClaim {
  attemptId: string
  ownerTaskId: string
  anchorJobId: string | null
  state: ClaimState
  jobId?: string
  capture?: OcrCapture
}
interface PageClaims { attempts: OcrClaim[] }
interface PublicationReceipt { taskId: string; versions: Record<number, string> }
interface RecoveryMetadata {
  version: 1
  pages?: Record<string, PageClaims>
  publications?: Record<string, PublicationReceipt>
}

const terminal = (state: string) => ['done', 'failed', 'cancelled'].includes(state)
const recoveryError = (message: string) => Object.assign(new Error(message), { statusCode: 409 })
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function pageIdentity(publication: OcrPublication, file: OcrPublicationFile, page: number) {
  return [file.file, file.fileId, file.registeredSha256, file.sourceSha256, page, file.images[page], file.targets[page], publication.model, publication.variant, publication.providerFingerprint]
}
function fileIdentity(publication: OcrPublication, file: OcrPublicationFile) {
  return Object.keys(file.targets).map(Number).sort((a, b) => a - b).map(page => pageIdentity(publication, file, page))
}
function publicationIdentity(publication: OcrPublication) {
  return digest([publication.model, publication.variant, publication.providerFingerprint, publication.files.map(file => fileIdentity(publication, file))])
}

/** The host is permanently terminal. Generic active-only checkpoint/finish and
 * startup reconciliation cannot overwrite its appended metadata. Descendant
 * jobs keep their own historical receipts and only refer to this authority. */
function recoverySource(db: Db, publication: OcrPublication, file: OcrPublicationFile) {
  const recovery = publication.recovery
  if (!recovery) throw recoveryError('没有共享恢复来源')
  const row = getJob(db, recovery.sourceJobId)
  const result = row?.result as { publication?: OcrPublication; ocrRecovery?: RecoveryMetadata } | null
  const original = result?.publication
  if (!row || row.kind !== 'ocr' || !terminal(row.state) || !original || original.resumedFrom || original.recovery
    || publicationIdentity(original) !== publicationIdentity(publication)
    || (result?.ocrRecovery && result.ocrRecovery.version !== 1)) throw recoveryError('恢复来源或共享认领不可核实')
  const originalFile = original.files.find(f => f.file === file.file)
  if (!originalFile || digest(fileIdentity(original, originalFile)) !== digest(fileIdentity(publication, file))) throw recoveryError('恢复目标输入不一致')
  return { id: row.id, originalFile, metadata: result?.ocrRecovery }
}

/** Only this namespaced JSON path changes, in the caller's SQLite transaction.
 * Never pass a whole stale root result to setJobResult/finishJob. */
function writeRecoveryPath(db: Db, sourceId: string, path: string, value: unknown) {
  const changed = db.update(schema.job).set({ result: sql`json_set(${schema.job.result}, '$.ocrRecovery.version', 1, ${path}, json(${JSON.stringify(value)}))` })
    .where(and(eq(schema.job.id, sourceId), eq(schema.job.kind, 'ocr'), inArray(schema.job.state, ['done', 'failed', 'cancelled']))).run()
  if (changed.changes !== 1) throw recoveryError('恢复来源已变化,禁止提交')
}

function seedPage(sourceId: string, file: OcrPublicationFile, page: number): PageClaims {
  const request = file.requests[page], capture = file.captures.find(c => c.page === page)
  return { attempts: [{ attemptId: sourceId, ownerTaskId: request?.taskId ?? sourceId, anchorJobId: null,
    state: capture ? 'complete' : request?.state ?? 'unsubmitted', ...(request?.jobId ? { jobId: request.jobId } : {}), ...(capture ? { capture } : {}) }] }
}

export interface SharedOcrAttempt {
  sourceJobId: string
  fingerprint: string
  claim: OcrClaim
  action: 'submit' | 'poll' | 'complete' | 'blocked'
}

/** A stable input/page has one current attempt for the entire lineage. A new
 * paid attempt requires its actual terminal owner as the explicit retry anchor;
 * changing caller keys, alias children or returning to an old ancestor cannot
 * advance it. Claimed/unknown never expire into permission for another POST. */
export function acquireOcrAttempt(db: Db, publication: OcrPublication, file: OcrPublicationFile, page: number, taskId: string): SharedOcrAttempt {
  return db.transaction(tx => {
    const source = recoverySource(tx, publication, file)
    const fingerprint = digest(pageIdentity(publication, file, page))
    const record = structuredClone(source.metadata?.pages?.[fingerprint] ?? seedPage(source.id, source.originalFile, page))
    let claim = record.attempts?.at(-1)
    if (!claim || !claim.ownerTaskId || !claim.attemptId
      || (claim.state === 'accepted' && !claim.jobId)
      || (claim.state === 'complete' && (!claim.capture || claim.capture.page !== page
        || claim.capture.imageSha256 !== file.images[page]?.sha256 || claim.capture.variant !== publication.variant
        || claim.capture.model !== publication.model))) throw recoveryError('共享认领回执不完整或输入不一致,禁止新提交')
    let action: SharedOcrAttempt['action'] = claim.state === 'complete' ? 'complete' : claim.state === 'accepted' ? 'poll' : 'blocked'
    if (['unsubmitted', 'rejected', 'failed'].includes(claim.state) && publication.recovery!.anchorJobId === claim.ownerTaskId) {
      const anchor = getJob(tx, claim.ownerTaskId)
      if (!anchor || anchor.kind !== 'ocr' || !terminal(anchor.state)) throw recoveryError('明确重试锚点尚未结束')
      claim = { attemptId: taskId, ownerTaskId: taskId, anchorJobId: anchor.id, state: 'claimed' }
      record.attempts.push(claim)
      action = 'submit'
    }
    writeRecoveryPath(tx, source.id, `$.ocrRecovery.pages."${fingerprint}"`, record)
    return { sourceJobId: source.id, fingerprint, claim, action }
  }, { behavior: 'immediate' })
}

export function updateOcrAttempt(db: Db, publication: OcrPublication, file: OcrPublicationFile, shared: SharedOcrAttempt, update: { state: Exclude<ClaimState, 'unsubmitted' | 'claimed'>; jobId?: string; capture?: OcrCapture }) {
  return db.transaction(tx => {
    const source = recoverySource(tx, publication, file)
    const record = structuredClone(source.metadata?.pages?.[shared.fingerprint])
    const claim = record?.attempts.find(c => c.attemptId === shared.claim.attemptId)
    if (!record || !claim || claim.ownerTaskId !== shared.claim.ownerTaskId) throw recoveryError('共享认领已变化')
    // A late poll/error must not erase an already captured paid response.
    if (claim.state === 'complete') return claim
    if (update.state === 'unknown' && claim.state !== 'claimed') throw recoveryError('共享认领不允许重新提交')
    if (update.state === 'accepted' && !['claimed', 'unknown', 'accepted'].includes(claim.state)) throw recoveryError('远端接受回执状态冲突')
    Object.assign(claim, update)
    writeRecoveryPath(tx, source.id, `$.ocrRecovery.pages."${shared.fingerprint}"`, record)
    return claim
  }, { behavior: 'immediate' })
}

export function sharedOcrPublication(db: Db, publication: OcrPublication, file: OcrPublicationFile): PublicationReceipt | null {
  if (!publication.recovery) return null
  const source = recoverySource(db, publication, file)
  return source.metadata?.publications?.[digest(fileIdentity(publication, file))]
    ?? (source.originalFile.state === 'published' && source.originalFile.publishedVersions ? { taskId: source.id, versions: source.originalFile.publishedVersions } : null)
}

/** Caller holds the same publication write transaction as the actual page CAS. */
export function recordSharedOcrPublication(db: Db, publication: OcrPublication, file: OcrPublicationFile, taskId: string) {
  if (!publication.recovery) return
  const source = recoverySource(db, publication, file)
  writeRecoveryPath(db, source.id, `$.ocrRecovery.publications."${digest(fileIdentity(publication, file))}"`, { taskId, versions: file.publishedVersions })
}

export function verifyOcrInput(db: Db, filesDir: string, file: OcrPublicationFile): void {
  const row = db.select({ id: schema.storedFile.id, sha256: schema.storedFile.sha256, removedAt: schema.storedFile.removedAt })
    .from(schema.storedFile).where(eq(schema.storedFile.relPath, file.file)).get()
  if (!row || row.removedAt || row.id !== file.fileId || row.sha256 !== file.registeredSha256
    || ocrInputHash(resolveWithinRoot(filesDir, file.file)) !== file.sourceSha256) throw new Error('OCR 输入文件内容身份冲突;原采集结果保留待处理')
  for (const image of Object.values(file.images)) {
    if (ocrInputHash(resolveWithinRoot(filesDir, image.relPath)) !== image.sha256) throw new Error('OCR 输入页图内容冲突;原采集结果保留待处理')
  }
}
