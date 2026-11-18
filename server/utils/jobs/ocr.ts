import { resolve } from 'node:path'
import { isJobId } from '../../../layers/core/lib/job'
import { appLog } from '../../../layers/core/lib/logging'
import { DEFAULT_DPI, isPdfPath } from '../../../lib/pdf-page'
import type { JobCompletion, JobContext, JobParseResult, JobSpec } from '../../../layers/core/server/utils/job-runner'
import { setJobResult } from '../../../layers/core/server/utils/job-store'
import { acquireOcrAttempt, checkpointOriginalOcrAttempt, fenceOriginalOcrPublication, prepareOcrPublication, recordSharedOcrPublication, sharedOcrPublication, updateOcrAttempt, verifyOcrInput, type OcrAttemptUpdate, type OcrCapture, type OcrPublication } from '../ocr-publication'
import { listOcrResults } from '../ocr-result'
import {
  MAX_CONCURRENT_PADDLE_JOBS,
  OcrApiError,
  ocrImageFile,
  ocrRequestVariant,
  resolveOcrConfig,
  type OcrPageOut,
} from '../ocr-api'
import {
  OCR_PAGE_CACHE_VERSION,
  ocrPageCacheDirAbs,
  ocrPageCacheKey,
  readOcrPageCache,
  writeOcrPageCache,
} from '../ocr-page-cache'
import { writeOcrResult } from '../ocr-result'
import { listPdfPages, resolveWithinRoot, type PageImageRef } from '../pdf-pages'

/** Online OCR freezes input bytes and target page versions at submission.
 * Paid page responses checkpoint in job.result before publication; the optional
 * page cache remains an accelerator. Conflicts/cancellation never discard a
 * response already received. Explicit resume reuses the original preconditions.
 */

/** 一份文件的识别结果。`ok` 是判据。 */
export type OcrFileOutcome =
  | {
      file: string
      ok: true
      /** `stored_file.id` —— 结果就是挂在这个 id 上的。 */
      fileId: number
      /** 识别出的页数(== 写入 `ocr_result` 的页数)。 */
      pages: number
      /** A replay reports the known publication, but makes no new page writes. */
      writtenPages?: number
      replayed?: true
      /** 票 13 已渲染的页图数;没渲染过是 0。 */
      renderedPageImages: number
      /**
       * 本次**由成功页中转命中**(没再发给 Paddle)的页数。
       * `renderedPageImages - cachedPages` 就是这次真正提交出去的页数 ——
       * 「重跑只补失败页」的直接证据。
       */
      cachedPages: number
      engine: string
      model: string
      /** 每张页图一个 Paddle job,按源页码顺序排列。 */
      apiJobIds: string[]
      elapsedMs: number
    }
  | { file: string; ok: false; error: string }

/** 任务的产出。 */
export interface OcrJobResult {
  files: OcrFileOutcome[]
  publication: OcrPublication
  total: number
  ok: number
  failed: number
  /** 本次写入 `ocr_result` 的**总页数**。 */
  pages: number
  channel: 'api'
  cancelled?: boolean
  /** 停下时**已处理**(尝试过)的份数。 */
  done?: number
}

/** Bound per-file page results retained by one OCR task; page jobs have a separate global permit. */
const MAX_CONCURRENT_OCR_FILES_PER_JOB = 2

/** 已校验的参数。 */
interface OcrParams {
  files: string[]
  model: string | null
  resumeJobId?: string
}

/**
 * 参数校验(纯函数,提交时跑)。
 *
 * 报**第一个**错就够 —— 与 `render-pages` 同一口径:代理拿到一句话就能改,
 * 一份「第 2、第 5 项都不对」的清单只会让它多写一轮重试。
 *
 * ── 为什么不收 `pageRanges` ─────────────────────────────────────────────
 * API 支持只识别某几页,但**那样页码就对不上了**:我们的页码来自「结果是第几段」
 * (整份提交时「第 i 段 == 第 i 页」),只传 `3-5` 时服务端只回 3 段,我们会把它们
 * 落成第 1–3 页 —— 第 5 页的名单被写成 `page_no=3`,`record_evidence.page` **全错**。
 * 那不是空值,是一个**看起来确定却错的**值,正是 SPEC 的「空值优于错误值」要避免的。
 * 要分段识别就分**文件**提交(同一份 PDF 拆成两次调用也会撞上同一个问题),
 * 所以这里直接不收这个参数 —— 宁可少一个能力,不要一个会静默写错页码的能力。
 */
export function parseOcrParams(raw: Record<string, unknown>): JobParseResult {
  const rawFiles = raw.files
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    return { ok: false, message: 'files 必须是非空数组(相对文件库根的 PDF 路径)' }
  }
  const files: string[] = []
  for (const item of rawFiles) {
    if (typeof item !== 'string' || !item.trim()) {
      return { ok: false, message: 'files 的每一项都必须是非空字符串' }
    }
    const file = item.trim()
    if (!isPdfPath(file)) {
      return {
        ok: false,
        message: `OCR 只吃 PDF(扫描件;有文字层的 PDF 也走这条路,结果一样):${file}`,
      }
    }
    files.push(file)
  }
  if (raw.model !== undefined && raw.model !== null && typeof raw.model !== 'string') {
    return { ok: false, message: `model 必须是字符串:${JSON.stringify(raw.model)}` }
  }
  // 显式拒掉 `pageRanges`(理由见上),而不是默默忽略 —— 默默忽略会让人以为生效了。
  for (const key of ['pageRanges', 'pages', 'range']) {
    if (raw[key] !== undefined && raw[key] !== null && raw[key] !== '') {
      return {
        ok: false,
        message:
          `不支持 \`${key}\`:只识别某几页会让「第 i 段 == 第 i 页」不再成立,` +
          '页码会被静默写错。要分段识别请把源 PDF 拆开、按整份分别提交。',
      }
    }
  }
  if (raw.resumeJobId !== undefined && (typeof raw.resumeJobId !== 'string' || !isJobId(raw.resumeJobId))) return { ok: false, message: 'resumeJobId 必须是已结束 OCR 任务 ID' }
  if (new Set(files).size !== files.length) return { ok: false, message: 'files 不得重复' }
  return {
    ok: true,
    params: {
      files,
      ...(typeof raw.resumeJobId === 'string' ? { resumeJobId: raw.resumeJobId } : {}),
      model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : null,
    },
  }
}

/** 返回当前源 PDF 的完整最新页图;OCR 最低 300 DPI,已存在的 400 DPI 页图也可用。 */
async function currentPageImages(filesDir: string, relPath: string): Promise<PageImageRef[]> {
  const initial = await listPdfPages(filesDir, relPath, DEFAULT_DPI)
  // 页面默认分辨率下调后,已渲染的 400 DPI 清单按其自身 DPI 复核,不用为了兼容而重渲染。
  const state =
    initial.manifest && initial.dpi !== DEFAULT_DPI
      ? await listPdfPages(filesDir, relPath, initial.dpi)
      : initial
  if (!state.pageCount || state.pageCount < 1) {
    throw new Error(`读不到源 PDF 页数:${relPath}`)
  }
  const continuous =
    state.pages.length === state.pageCount && state.pages.every((page, index) => page.page === index + 1)
  if (
    !state.upToDate ||
    state.dpi < DEFAULT_DPI ||
    state.rendered !== state.pageCount ||
    !continuous
  ) {
    throw new Error(
      `没有完整、最新且至少 ${DEFAULT_DPI} DPI 的页图(${state.rendered}/${state.pageCount} 页,当前 ${state.dpi} DPI);` +
        `请先提交 render-pages 并确认全部成功:${relPath}`,
    )
  }
  return state.pages
}

/** Two files at a time; failed/cancelled files keep individual page receipts. */
export async function runOcr(
  ctx: JobContext,
  params: Record<string, unknown>,
  config = resolveOcrConfig(),
  prepared?: OcrPublication,
): Promise<JobCompletion> {
  const { files, model, resumeJobId } = params as unknown as OcrParams
  const effectiveModel = model ?? config.model
  const publication = prepared ?? prepareOcrPublication(ctx.db, ctx.filesDir, files, effectiveModel, ocrRequestVariant(effectiveModel), config.baseUrl, resumeJobId)
  const logContext = { ...ctx.logContext, taskId: ctx.jobId }
  const startedAt = Date.now()
  appLog({ module: 'core', source: 'ocr', operation: 'ocr.recognize', outcome: 'started', counts: { total: files.length } }, logContext)
  if (!config.token) {
    appLog({ module: 'core', source: 'ocr', operation: 'ocr.recognize', outcome: 'failure', level: 'error', errorCode: 'ocr_not_configured' }, logContext)
    // 配置错**在动手之前**就报出来 —— 逐份失败会得到 N 条一模一样的错,而它一次就说清了。
    throw new Error(
      '缺少 OCR token:在配置页面保存,或设 `NUXT_OCR_TOKEN`(或 `PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN`)再提交。' +
        '凭证不入库;页面通路(b 上传结果)不需要 token。',
    )
  }

  const outcomes: Array<OcrFileOutcome | undefined> = Array.from({ length: files.length })
  let doneFiles = 0
  let totalPages = 0
  let failed = 0

  const snapshot = (): OcrJobResult => ({
    files: outcomes.filter((outcome): outcome is OcrFileOutcome => outcome !== undefined),
    total: files.length,
    ok: outcomes.filter((outcome) => outcome?.ok).length,
    failed,
    pages: totalPages,
    channel: 'api',
    publication,
  })
  const checkpoint = () => setJobResult(ctx.db, ctx.jobId, snapshot())
  checkpoint()

  const processFile = async (file: string, fileIndex: number): Promise<OcrFileOutcome | null> => {
    if (ctx.cancelled()) return null
    const fileStarted = Date.now()
    const receipt = publication.files[fileIndex]!
    const fileId: number | null = receipt.fileId
    let processedPages = 0
    let timedOutPages = 0
    let failedPages = 0
    let expectedPages: number | undefined
    try {
      if (receipt.error && !receipt.sourceSha256) throw new Error(receipt.error)
      verifyOcrInput(ctx.db, ctx.filesDir, receipt)
      if (fileId === null) throw new Error('文件库里没有这个文件')
      const images = await currentPageImages(ctx.filesDir, file)
      if (images.length !== Object.keys(receipt.targets).length || images.some(image => receipt.images[image.page]?.relPath !== image.relPath)) throw new Error('OCR 输入页集合冲突')
      expectedPages = images.length
      const variant = publication.variant
      // Publication and receipt are committed together. A resumed published file
      // is a replay, never a new write, even if a human has since revised it.
      const sharedPublication = sharedOcrPublication(ctx.db, publication, receipt)
      if (sharedPublication) {
        receipt.state = 'published'
        receipt.publishedVersions = sharedPublication.versions
        checkpoint()
      }
      if (receipt.state === 'published') return {
        file, ok: true, fileId, pages: images.length, writtenPages: 0, replayed: true, renderedPageImages: images.length,
        cachedPages: images.length, engine: 'paddleocr', model: effectiveModel,
        apiJobIds: receipt.captures.map(c => c.jobId), elapsedMs: Date.now() - fileStarted,
      }
      receipt.state = 'pending'
      delete receipt.error
      checkpoint()
      const cacheDir = ocrPageCacheDirAbs(ctx.filesDir, file)
      const startedAt = Date.now()
      const pageResults: Array<OcrPageOut | undefined> = Array.from({ length: images.length })
      const apiJobIds: Array<string | undefined> = Array.from({ length: images.length })
      const pageErrors: Array<string | undefined> = Array.from({ length: images.length })
      let cachedPages = 0
      let nextIndex = 0

      const recognizeNextPages = async (): Promise<void> => {
        while (!ctx.cancelled()) {
          const index = nextIndex
          nextIndex += 1
          if (index >= images.length) return
          const image = images[index]!
          const pageStarted = Date.now()
          const pageContext = { ...logContext, fileId: fileId!, page: image.page }
          try {
            const imagePath = resolveWithinRoot(ctx.filesDir, image.relPath)
            const imageSha256 = receipt.images[image.page]!.sha256
            const cacheKey = ocrPageCacheKey(imageSha256, variant)
            const shared = publication.recovery ? acquireOcrAttempt(ctx.db, publication, receipt, image.page, ctx.jobId) : null
            const persistAttempt = (update: OcrAttemptUpdate) => shared
              ? updateOcrAttempt(ctx.db, publication, receipt, shared, update).capture
              : checkpointOriginalOcrAttempt(ctx.db, publication, receipt, image.page, ctx.jobId, update, snapshot)
            if (shared) {
              receipt.claims ??= {}
              receipt.claims[image.page] = { sourceJobId: shared.sourceJobId, fingerprint: shared.fingerprint, attemptId: shared.claim.attemptId, ownerTaskId: shared.claim.ownerTaskId, state: shared.claim.state }
              if (shared.claim.state !== 'unsubmitted' && shared.claim.state !== 'complete') receipt.requests[image.page] = { state: shared.claim.state, taskId: shared.claim.ownerTaskId, ...(shared.claim.jobId ? { jobId: shared.claim.jobId } : {}) }
              checkpoint()
              if (shared.action === 'blocked') throw new Error(`OCR 共享认领 ${shared.claim.state === 'unknown' ? '提交结果未知' : shared.claim.state === 'claimed' ? '已认领,结果待核实' : '拒绝/失败回执重放'};原尝试任务 ${shared.claim.ownerTaskId},不得从旧锚点重复付费`)
            }
            // 先问中转:这一页的页图 + 模型 + 选项都跟上次一样时,直接用上次那页的结果,
            // 不再花钱、也不再打一次容易被限流的提交。
            const retained = shared?.claim.capture ?? receipt.captures.find(c => c.page === image.page && c.imageSha256 === imageSha256 && c.variant === variant)
            const remote = receipt.requests[image.page]
            const candidate = retained ?? (shared || remote ? null : await readOcrPageCache(cacheDir, cacheKey, { imageSha256, variant }))
            const cached = candidate?.model === effectiveModel ? candidate : null
            if (cached) {
              pageResults[index] = { page: image.page, markdown: cached.markdown, raw: cached.raw }
              apiJobIds[index] = cached.jobId
              if (shared || !receipt.captures.some(c => c.page === image.page)) {
                receipt.captures = receipt.captures.filter(c => c.page !== image.page)
                receipt.captures.push(retained ?? { page: image.page, markdown: cached.markdown, raw: cached.raw, imageSha256, variant, jobId: cached.jobId, model: cached.model, createdAt: cached.createdAt, taskId: null, sourceSha256: null })
                receipt.state = 'partial'
                checkpoint()
              }
              cachedPages += 1
              processedPages += 1
              appLog({ module: 'core', source: 'ocr', operation: 'ocr.page.cache', outcome: 'skipped', durationMs: Date.now() - pageStarted }, pageContext)
              continue
            }
            if (remote?.state === 'unknown') throw new Error('远端提交结果未知;保留原回执,禁止自动重复付费提交')
            const out = await ocrImageFile({
              resumeJobId: remote?.state === 'accepted' ? remote.jobId : undefined,
              expectedImageSha256: imageSha256,
              onSubmissionStarted: () => {
                verifyOcrInput(ctx.db, ctx.filesDir, receipt)
                receipt.requests[image.page] = { state: 'unknown', taskId: ctx.jobId, ...(remote ? { previous: [...(remote.previous ?? []), { state: remote.state, ...(remote.jobId ? { jobId: remote.jobId } : {}), ...(remote.taskId ? { taskId: remote.taskId } : {}) }] } : {}) }
                persistAttempt({ state: 'unknown' })
                if (shared) receipt.claims![image.page]!.state = 'unknown'
                checkpoint()
              },
              onSubmitted: jobId => {
                Object.assign(receipt.requests[image.page]!, { state: 'accepted', jobId })
                persistAttempt({ state: 'accepted', jobId })
                if (shared) receipt.claims![image.page]!.state = 'accepted'
                checkpoint()
              },
              onSubmissionRejected: () => {
                receipt.requests[image.page]!.state = 'rejected'
                persistAttempt({ state: 'rejected' })
                if (shared) receipt.claims![image.page]!.state = 'rejected'
                checkpoint()
              },
              onRemoteFailed: () => {
                receipt.requests[image.page]!.state = 'failed'
                persistAttempt({ state: 'failed' })
                if (shared) receipt.claims![image.page]!.state = 'failed'
                checkpoint()
              },
              token: config.token,
              baseUrl: config.baseUrl,
              model: effectiveModel,
              pollTimeoutMs: config.pollTimeoutMs,
              filePath: imagePath,
              fileName: image.relPath.split('/').pop(),
              isCancelled: () => ctx.cancelled(),
            })
            // Paddle 没有源文档页码;这里由清单中的本地页号绑定,不从 OCR 文本猜页码。
            // Durable business receipt first; cache loss must not cause a second charge.
            let capture: OcrCapture = { page: image.page, markdown: out.page.markdown, raw: out.page.raw, imageSha256, variant, jobId: out.jobId, model: out.model, createdAt: new Date().toISOString(), taskId: receipt.requests[image.page]?.taskId ?? null, sourceSha256: receipt.sourceSha256 }
            // Include the paid response in the initial executor's active
            // checkpoint; terminal originals append only to their shared ledger.
            receipt.captures = receipt.captures.filter(c => c.page !== image.page)
            receipt.captures.push(capture)
            receipt.state = 'partial'
            const durable = persistAttempt({ state: 'complete', capture })
            if (!durable) throw new Error('OCR 原结果回执不完整;禁止丢弃原采集或重新提交')
            capture = durable
            if (shared) receipt.claims![image.page]!.state = 'complete'
            pageResults[index] = { page: image.page, markdown: capture.markdown, raw: capture.raw }
            apiJobIds[index] = capture.jobId
            receipt.captures = receipt.captures.filter(c => c.page !== image.page)
            receipt.captures.push(capture)
            receipt.state = 'partial'
            checkpoint()
            // A legacy/retained timestamp may be unknown. Keep null in the
            // durable capture and omit this optional cache write, never invent it.
            if (typeof capture.createdAt === 'string') await writeOcrPageCache(cacheDir, cacheKey, {
              version: OCR_PAGE_CACHE_VERSION,
              imageSha256,
              variant,
              jobId: capture.jobId,
              model: capture.model,
              markdown: capture.markdown,
              raw: capture.raw,
              createdAt: capture.createdAt,
            })
            processedPages += 1
            appLog({ module: 'core', source: 'ocr', operation: 'ocr.page', outcome: 'success', durationMs: Date.now() - pageStarted }, pageContext)
          } catch (error) {
            const timedOut = error instanceof OcrApiError && error.failureKind === 'timeout'
            appLog({ module: 'core', source: 'ocr', operation: 'ocr.page', outcome: ctx.cancelled() ? 'cancelled' : timedOut ? 'timeout' : 'failure', level: ctx.cancelled() ? 'info' : 'error', errorCode: ctx.cancelled() ? undefined : timedOut ? 'ocr_page_timeout' : 'ocr_page_failed', durationMs: Date.now() - pageStarted }, pageContext)
            if (ctx.cancelled()) return
            failedPages += 1
            if (timedOut) timedOutPages += 1
            pageErrors[index] = `第 ${image.page} 页 OCR 失败:${(error as Error).message}`
          }
        }
      }

      await Promise.all(
        Array.from(
          { length: Math.min(MAX_CONCURRENT_PADDLE_JOBS, images.length) },
          () => recognizeNextPages(),
        ),
      )
      if (ctx.cancelled()) {
        appLog({ module: 'core', source: 'ocr', operation: 'ocr.file', outcome: 'cancelled', fileId, counts: { done: processedPages, total: expectedPages, failed: failedPages }, durationMs: Date.now() - fileStarted }, logContext)
        receipt.state = 'cancelled'
        checkpoint()
        return null
      }

      const errors = pageErrors.filter((error): error is string => error !== undefined)
      if (errors.length) throw new Error(errors.join('；'))
      const completePages = pageResults.filter((page): page is OcrPageOut => page !== undefined)
      const completeJobIds = apiJobIds.filter((jobId): jobId is string => jobId !== undefined)
      if (completePages.length !== images.length || completeJobIds.length !== images.length) {
        throw new Error(`并发 OCR 未返回全部页(${completePages.length}/${images.length}):${file}`)
      }
      if (ctx.cancelled()) return null

      let replayed = false
      ctx.db.transaction(tx => {
        fenceOriginalOcrPublication(tx, publication, ctx.jobId)
        verifyOcrInput(tx, ctx.filesDir, receipt)
        const committed = sharedOcrPublication(tx, publication, receipt)
        if (committed) {
          receipt.state = 'published'
          receipt.publishedVersions = committed.versions
          replayed = true
          setJobResult(tx, ctx.jobId, snapshot())
          return
        }
        const written = writeOcrResult(tx, {
          fileId: fileId!, pages: completePages.map(page => {
            const capture = receipt.captures.find(c => c.page === page.page)!
            return { ...page, capture: { taskId: capture.taskId, sourceSha256: capture.sourceSha256, imageSha256: capture.imageSha256, variant: capture.variant, jobId: capture.jobId, createdAt: capture.createdAt } }
          }), expectedVersions: receipt.targets,
          channel: 'api', engine: 'paddleocr', model: effectiveModel, sourceRelPath: file,
        })
        if (!written.ok) throw new Error(written.message)
        receipt.state = 'published'
        receipt.publishedVersions = Object.fromEntries(listOcrResults(tx, fileId!).filter(r => r.page in receipt.targets).map(r => [r.page, r.version]))
        recordSharedOcrPublication(tx, publication, receipt, ctx.jobId)
        setJobResult(tx, ctx.jobId, snapshot())
      }, { behavior: 'immediate' })
      appLog({ module: 'core', source: 'ocr', operation: 'ocr.file', outcome: 'success', fileId, counts: { done: completePages.length, total: expectedPages }, durationMs: Date.now() - fileStarted }, logContext)
      return {
        file,
        ok: true,
        fileId,
        pages: completePages.length,
        ...(replayed ? { replayed: true as const, writtenPages: 0 } : {}),
        renderedPageImages: images.length,
        cachedPages,
        engine: 'paddleocr',
        model: effectiveModel,
        apiJobIds: completeJobIds,
        elapsedMs: Date.now() - startedAt,
      }
    } catch (error) {
      appLog({ module: 'core', source: 'ocr', operation: 'ocr.file', outcome: ctx.cancelled() ? 'cancelled' : processedPages > 0 ? 'partial' : timedOutPages === expectedPages ? 'timeout' : 'failure', level: ctx.cancelled() ? 'info' : 'error', ...(fileId === null ? {} : { fileId }), counts: { done: processedPages, total: expectedPages, failed: failedPages }, errorCode: ctx.cancelled() ? undefined : 'ocr_file_failed', durationMs: Date.now() - fileStarted }, logContext)
      receipt.error = (error as Error).message ?? String(error)
      if (Object.values(receipt.requests).some(request => request.state === 'unknown')) receipt.error += ';远端提交结果未知,禁止自动重复付费提交'
      delete receipt.publishedVersions
      receipt.state = ctx.cancelled() ? 'cancelled' : /冲突/.test(receipt.error) ? 'conflict' : 'failed'
      checkpoint()
      if (ctx.cancelled()) return null
      return { file, ok: false, error: receipt.error }
    }
  }

  let nextFile = 0
  const recognizeNextFiles = async (): Promise<void> => {
    while (!ctx.cancelled()) {
      const index = nextFile
      nextFile += 1
      if (index >= files.length) return
      const outcome = await processFile(files[index]!, index)
      if (!outcome) return
      outcomes[index] = outcome
      if (outcome.ok) totalPages += outcome.writtenPages ?? outcome.pages
      else failed += 1
      doneFiles += 1
      checkpoint()
      ctx.progress(doneFiles, files.length)
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(MAX_CONCURRENT_OCR_FILES_PER_JOB, files.length) },
    () => recognizeNextFiles(),
  ))

  if (ctx.cancelled()) {
    appLog({ module: 'core', source: 'ocr', operation: 'ocr.recognize', outcome: 'cancelled', counts: { done: doneFiles, total: files.length, failed }, durationMs: Date.now() - startedAt }, logContext)
    return { result: { ...snapshot(), cancelled: true, done: doneFiles }, cancelled: true }
  }

  const result = snapshot()
  appLog({ module: 'core', source: 'ocr', operation: 'ocr.recognize', outcome: failed ? (result.ok ? 'partial' : 'failure') : 'success', level: failed ? 'error' : 'info', counts: { done: doneFiles, total: files.length, failed }, durationMs: Date.now() - startedAt }, logContext)
  return failed
    ? { result, error: `${files.length} 份里 ${failed} 份识别失败(逐项原因见 result.files[].error)` }
    : { result }
}

export const ocrSpec: JobSpec = {
  kind: 'ocr',
  status: 'ready',
  summary:
    '先渲染并增强 PDF 页图,并发提交单页 PNG 给 PaddleOCR,按源页码完整入库到 ocr_result;' +
    '原付费结果保留在任务检查点,恢复以 resumeJobId 显式复用原输入/页版本',
  paramsHint:
    '{ files: string[](相对文件库根的 PDF 路径,非空;须先生成完整且至少 300 DPI 页图), model?: string, resumeJobId?: string(已结束 OCR 任务,同文件/模型/选项) }',
  parse: parseOcrParams,
  // 分母提交时就知道 —— 轮询方一上来就能看到「一共 3 份」。
  total: (params) => (params.files as string[]).length,
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
