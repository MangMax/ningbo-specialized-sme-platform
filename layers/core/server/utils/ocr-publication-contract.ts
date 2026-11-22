import { createHash } from 'node:crypto'
import { closeSync, openSync, readSync, readFileSync, statSync } from 'node:fs'
import { isJobId } from '../../lib/job'
import { pageDirRelPath, PAGES_MANIFEST_NAME } from '../../lib/pdf-page'
import type { JobRow } from './job-contract'
import type { FileRow } from './file-store-contract'
import { resolveWithinRoot } from './pdf-pages'
import { compareFileContentIdentity } from './file-identity'

export type OcrRegisteredInput = Pick<FileRow, 'id' | 'sha256' | 'bytes' | 'removedAt'>
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
  registeredBytes?: number | null
  sourceBytes?: number | null
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

/** Hash input bytes before releasing the publication transaction.
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

export function ocrProviderFingerprint(url: string) {
  return createHash('sha256').update(url.replace(/\/+$/, '')).digest('hex')
}

export function validateOcrResume(prior: JobRow | null | undefined, files: string[], model: string, variant: string, providerFingerprint: string) {
  const publication = (prior?.result as { publication?: OcrPublication } | null)?.publication
  if (!prior || prior.kind !== 'ocr' || !terminalOcrJob(prior.state)
    || publication?.version !== 1 || publication.model !== model || publication.variant !== variant || publication.providerFingerprint !== providerFingerprint
    || JSON.stringify(publication.files.map(f => f.file)) !== JSON.stringify(files)) {
    throw recoveryError('恢复需要同文件、同模型/选项的已结束 OCR 任务及采集检查点')
  }
  return publication
}

export function resumeOcrPublication(publication: OcrPublication, source: JobRow, resumeJobId: string): OcrPublication {
  const sourcePublication = (source.result as { publication?: OcrPublication }).publication
  if (!sourcePublication || publicationIdentity(sourcePublication) !== publicationIdentity(publication)) throw recoveryError('恢复来源输入不一致')
  return { ...structuredClone(publication), resumedFrom: resumeJobId, recovery: { sourceJobId: source.id, anchorJobId: resumeJobId } }
}

export function freezeOcrFile(filesDir: string, file: string, row: OcrRegisteredInput | null | undefined, versions: ReadonlyMap<number, string>) {
  const entry: OcrPublicationFile = {
    file, fileId: row?.id ?? null, registeredSha256: row?.sha256 ?? null, registeredBytes: row?.bytes ?? null,
    sourceBytes: null, sourceSha256: null, targets: {}, images: {}, captures: [], requests: {}, state: 'pending',
  }
  try {
    if (!row || row.removedAt) throw new Error('stored_file 中没有这个文件或已移出库')
    const source = resolveWithinRoot(filesDir, file)
    entry.sourceSha256 = ocrInputHash(source)
    entry.sourceBytes = statSync(source).size
    if (!/^[a-f0-9]{64}$/i.test(row.sha256)) throw new Error('OCR 输入文件内容身份未知;待核实登记')
    if (compareFileContentIdentity({ ...row, fileId: row.id, relPath: file }, { sha256: entry.sourceSha256, bytes: entry.sourceBytes })) throw new Error('OCR 输入文件内容身份冲突;原采集结果保留待处理')
    const manifest = JSON.parse(readFileSync(resolveWithinRoot(filesDir, `${pageDirRelPath(file)}/${PAGES_MANIFEST_NAME}`), 'utf8'))
    if (!Array.isArray(manifest.pages) || manifest.sourceSha256 !== entry.sourceSha256 || manifest.sourceBytes !== entry.sourceBytes) throw new Error('页图输入不匹配,请先渲染最新页图')
    for (const page of manifest.pages) {
      entry.targets[page.page] = versions.get(page.page) ?? null
      entry.images[page.page] = { relPath: page.relPath, sha256: ocrInputHash(resolveWithinRoot(filesDir, page.relPath)) }
    }
  } catch (error) { entry.error = (error as Error).message; entry.state = 'failed' }
  return entry
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
export interface PageClaims { attempts: OcrClaim[] }
export interface PublicationReceipt { taskId: string; versions: Record<number, string> }
export interface RecoveryMetadata {
  version: 1
  pages?: Record<string, PageClaims>
  publications?: Record<string, PublicationReceipt>
}

export const terminalOcrJob = (state: string) => ['done', 'failed', 'cancelled'].includes(state)
export const recoveryError = (message: string) => Object.assign(new Error(message), { statusCode: 409 })
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
export const ocrPageFingerprint = (publication: OcrPublication, file: OcrPublicationFile, page: number) => digest(pageIdentity(publication, file, page))
export const ocrFileFingerprint = (publication: OcrPublication, file: OcrPublicationFile) => digest(fileIdentity(publication, file))

export function validateOcrRecoverySource(row: JobRow | null | undefined, publication: OcrPublication, file: OcrPublicationFile) {
  const result = row?.result as { publication?: OcrPublication; ocrRecovery?: RecoveryMetadata } | null
  const original = result?.publication
  if (!row || row.kind !== 'ocr' || !terminalOcrJob(row.state) || !original || original.resumedFrom || original.recovery
    || publicationIdentity(original) !== publicationIdentity(publication)
    || (result?.ocrRecovery && result.ocrRecovery.version !== 1)) throw recoveryError('恢复来源或共享认领不可核实')
  const originalFile = original.files.find(f => f.file === file.file)
  if (!originalFile || ocrFileFingerprint(original, originalFile) !== ocrFileFingerprint(publication, file)) throw recoveryError('恢复目标输入不一致')
  return { id: row.id, originalFile, metadata: result?.ocrRecovery, result: result! }
}

export function seedPage(sourceId: string, file: OcrPublicationFile, page: number): PageClaims {
  const request = file.requests[page], capture = file.captures.find(c => c.page === page)
  return { attempts: [{ attemptId: sourceId, ownerTaskId: request?.taskId ?? sourceId, anchorJobId: null,
    state: capture ? 'complete' : request?.state ?? 'unsubmitted', ...(request?.jobId ? { jobId: request.jobId } : {}), ...(capture ? { capture } : {}) }] }
}

export function currentOcrClaim(record: PageClaims, publication: OcrPublication, file: OcrPublicationFile, page: number) {
  const claim = record.attempts?.at(-1)
  if (!claim || !claim.ownerTaskId || !claim.attemptId
    || (claim.state === 'accepted' && !claim.jobId)
    || (claim.state === 'complete' && (!claim.capture || claim.capture.page !== page
      || claim.capture.imageSha256 !== file.images[page]?.sha256 || claim.capture.variant !== publication.variant
      || claim.capture.model !== publication.model))) throw recoveryError('共享认领回执不完整或输入不一致,禁止新提交')
  return claim
}

export function applyOcrAttemptUpdate(claim: OcrClaim, update: OcrAttemptUpdate) {
  if (claim.state === 'complete') return
  if (update.state === 'unknown' && claim.state !== 'claimed') throw recoveryError('共享认领不允许重新提交')
  if (update.state === 'accepted' && !['claimed', 'unknown', 'accepted'].includes(claim.state)) throw recoveryError('远端接受回执状态冲突')
  Object.assign(claim, update)
}

export interface SharedOcrAttempt {
  sourceJobId: string
  fingerprint: string
  claim: OcrClaim
  action: 'submit' | 'poll' | 'complete' | 'blocked'
}

export type OcrAttemptUpdate =
  | { state: 'unknown' | 'rejected' | 'failed' }
  | { state: 'accepted'; jobId: string }
  | { state: 'complete'; capture: OcrCapture }

/** Initial executors have no recovery lineage yet. The running check and the
 * durable unknown receipt must be one write transaction BEFORE POST. If restart
 * reconciliation wins first, this executor is fenced; if unknown wins first,
 * every resume sees that uncertainty and cannot obtain another paid attempt.
 * Later callbacks atomically choose the active checkpoint or the terminal
 * source's shared ledger, so reconciliation cannot discard a paid response. */

export function verifyFrozenOcrInput(filesDir: string, file: OcrPublicationFile, row: OcrRegisteredInput | null | undefined) {
  if (file.registeredBytes == null || file.sourceBytes == null || !file.registeredSha256 || !/^[a-f0-9]{64}$/i.test(file.registeredSha256)) throw new Error('OCR 输入文件内容身份未知;原采集结果保留待核实,禁止付费或发布')
  if (!row || row.removedAt || row.id !== file.fileId || row.sha256 !== file.registeredSha256
    || row.bytes !== file.registeredBytes || file.sourceSha256 !== file.registeredSha256 || file.sourceBytes !== file.registeredBytes
    || statSync(resolveWithinRoot(filesDir, file.file)).size !== file.registeredBytes
    || ocrInputHash(resolveWithinRoot(filesDir, file.file)) !== file.registeredSha256) throw new Error('OCR 输入文件内容身份冲突;原采集结果保留待处理')
  for (const image of Object.values(file.images)) {
    if (ocrInputHash(resolveWithinRoot(filesDir, image.relPath)) !== image.sha256) throw new Error('OCR 输入页图内容冲突;原采集结果保留待处理')
  }
}
