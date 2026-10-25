import { createHash } from 'node:crypto'
import { closeSync, openSync, readSync, readFileSync } from 'node:fs'
import { eq } from 'drizzle-orm'
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
  requests: Record<number, { state: 'unknown' | 'accepted' | 'rejected' | 'failed'; jobId?: string; taskId?: string; previous?: Array<{ state: string; jobId?: string; taskId?: string }> }>
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
    return { ...structuredClone(publication), resumedFrom: resumeJobId }
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

export function verifyOcrInput(db: Db, filesDir: string, file: OcrPublicationFile): void {
  const row = db.select({ id: schema.storedFile.id, sha256: schema.storedFile.sha256, removedAt: schema.storedFile.removedAt })
    .from(schema.storedFile).where(eq(schema.storedFile.relPath, file.file)).get()
  if (!row || row.removedAt || row.id !== file.fileId || row.sha256 !== file.registeredSha256
    || ocrInputHash(resolveWithinRoot(filesDir, file.file)) !== file.sourceSha256) throw new Error('OCR 输入文件内容身份冲突;原采集结果保留待处理')
  for (const image of Object.values(file.images)) {
    if (ocrInputHash(resolveWithinRoot(filesDir, image.relPath)) !== image.sha256) throw new Error('OCR 输入页图内容冲突;原采集结果保留待处理')
  }
}
