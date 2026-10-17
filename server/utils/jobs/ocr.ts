import { DEFAULT_DPI, isPdfPath } from '../../../lib/pdf-page'
import type { JobCompletion, JobContext, JobParseResult, JobSpec } from '../job-runner'
import { findFileIdByRelPath } from '../mcp-files'
import {
  MAX_CONCURRENT_PADDLE_JOBS,
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
  sha256OfFile,
  writeOcrPageCache,
} from '../ocr-page-cache'
import { writeOcrResult } from '../ocr-result'
import { listPdfPages, resolveWithinRoot, type PageImageRef } from '../pdf-pages'

/**
 * `ocr` —— **批量**把扫描 PDF 识别成文本(通路 a:在线 API)。
 *
 * 票 19 把 `ocr` 登记成 `todo` 时给的理由很具体:「结果无处可放」。票 14 把
 * `ocr_result` 表建起来之后,这里就是那句话的答案 —— **`todo` → `ready`**,
 * 注册表(`job-specs.ts`)与提交路由一行都不用改。
 *
 * OCR 前必须先完成票 13 的页图渲染(默认 300 DPI,旧的 400 DPI 页图也可用)。
 * 一份 PDF 的页图并发调用 Paddle,
 * 并把每次返回绑定到页图清单中的源页码;没有完整、最新的页图就拒绝提交。
 *
 * ── 取消检查 ───────────────────────────────────────────────────────────
 * 每张 PNG 轮询时都检查取消标记;取消后页池不再启动新请求,已完成的整份 PDF 才会保留。
 * 结果只在一份 PDF 的所有页成功后替换,因此取消或单页失败不会留下半份新结果。
 *
 * ── 成功页中转(断点续跑)──────────────────────────────────────────────
 * 每一页**一识别成功**就把结果写进该 PDF 自己的页结果缓存
 * (`ocr-page-cache.ts`,落在页图目录下的 `.ocr-cache/`),不等全份跑完。这样:
 *  - 一份里部分页失败(典型是 Paddle 的 HTTP 429,而 4xx **不自动重试**)时,跑成功
 *    的那些页不再随内存一起丢 —— 它们已经在缓存里,**重跑只补缺失/失败的那几页**;
 *  - `ocr_result` 的写法**一点没变**:仍是一份全成功才在单个事务里整份替换
 *    (`replaceExistingPages`),所以「部分成功」**不会**在正式结果里留下半份新数据
 *    —— 缓存只是中转,不是结果。
 * 命中判据是页图内容 sha256 + 模型 + 有效选项指纹(见 `ocr-page-cache.ts`),所以换了
 * 页图、换了模型、换了影响识别结果的选项,旧条目自然不再命中;坏条目当未命中重识别。
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

/** 已校验的参数。 */
interface OcrParams {
  files: string[]
  model: string | null
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
  return {
    ok: true,
    params: {
      files,
      model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : null,
    },
  }
}

/** 把识别出的页写进 `ocr_result`。抽出来是为了让 run 的循环只讲编排。 */
function persistPages(
  ctx: JobContext,
  fileId: number,
  relPath: string,
  pages: readonly OcrPageOut[],
  model: string,
): { written: number } {
  const result = writeOcrResult(ctx.db, {
    fileId,
    pages: pages.map((p) => ({ page: p.page, markdown: p.markdown, raw: p.raw })),
    replaceExistingPages: true,
    channel: 'api',
    engine: 'paddleocr',
    model,
    // 给了它,`page_rel_path` 才会按票 13 的规则(相对 PDF 路径 + 页号)算出来。
    sourceRelPath: relPath,
  })
  if (!result.ok) throw new Error(`写入 OCR 结果失败:${result.message}`)
  return { written: result.written }
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

/**
 * 多份并行识别,每份 PDF 的页图也并行;全进程 Paddle 并发由 `ocrImageFile` 的共享信号量限制。
 *
 * **一份失败不停下整批**(与 `render-pages` 同一理由):批量任务的用处正是「一次交一堆」,
 * 因为第 2 份坏了就撂下第 3–7 份,等于把「哪几份坏了」换成「任务失败」。
 * 有任意一份失败 ⇒ 状态记 `failed`,明细仍在 `result.files[]` 里。
 *
 * **取消**走 `{ cancelled: true }` 并带已完成文件的产出。一份 PDF 的页结果在内存里攒齐,
 * 每页成功时**同时**中转进 `ocr-page-cache`;只有全页齐了才在单个事务里整份替换旧结果,
 * 所以中途失败或取消**不会**在正式结果里留下半份新 OCR,而**重跑只补缺失页**
 * (成功页从中转里拿,不再发给 Paddle)。
 */
export async function runOcr(
  ctx: JobContext,
  params: Record<string, unknown>,
  config = resolveOcrConfig(),
): Promise<JobCompletion> {
  const { files, model } = params as unknown as OcrParams
  if (!config.token) {
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
  })

  const processFile = async (file: string): Promise<OcrFileOutcome | null> => {
    if (ctx.cancelled()) return null
    try {
      const fileId = findFileIdByRelPath(ctx.db, file)
      if (fileId === null) {
        throw new Error(
          `文件库里没有这个文件(先让 app 回填 stored_file:打开 /files 页,或调 list_files):${file}`,
        )
      }
      const images = await currentPageImages(ctx.filesDir, file)
      const effectiveModel = model ?? config.model
      // 命中判据里除页图内容之外的那一半:模型 + 影响识别结果的有效选项。
      const variant = ocrRequestVariant(effectiveModel)
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
          try {
            const imagePath = resolveWithinRoot(ctx.filesDir, image.relPath)
            const imageSha256 = await sha256OfFile(imagePath)
            const cacheKey = ocrPageCacheKey(imageSha256, variant)
            // 先问中转:这一页的页图 + 模型 + 选项都跟上次一样时,直接用上次那页的结果,
            // 不再花钱、也不再打一次容易被限流的提交。
            const cached = await readOcrPageCache(cacheDir, cacheKey, { imageSha256, variant })
            if (cached) {
              pageResults[index] = { page: image.page, markdown: cached.markdown, raw: cached.raw }
              apiJobIds[index] = cached.jobId
              cachedPages += 1
              continue
            }
            const out = await ocrImageFile({
              token: config.token,
              baseUrl: config.baseUrl,
              model: effectiveModel,
              pollTimeoutMs: config.pollTimeoutMs,
              filePath: imagePath,
              fileName: image.relPath.split('/').pop(),
              isCancelled: () => ctx.cancelled(),
            })
            // Paddle 没有源文档页码;这里由清单中的本地页号绑定,不从 OCR 文本猜页码。
            pageResults[index] = { ...out.page, page: image.page }
            apiJobIds[index] = out.jobId
            // 成功即中转,不等全份:整份失败/取消时这一页也不会白识别。
            await writeOcrPageCache(cacheDir, cacheKey, {
              version: OCR_PAGE_CACHE_VERSION,
              imageSha256,
              variant,
              jobId: out.jobId,
              model: out.model,
              markdown: out.page.markdown,
              raw: out.page.raw,
              createdAt: new Date().toISOString(),
            })
          } catch (error) {
            if (ctx.cancelled()) return
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
      if (ctx.cancelled()) return null

      const errors = pageErrors.filter((error): error is string => error !== undefined)
      if (errors.length) throw new Error(errors.join('；'))
      const completePages = pageResults.filter((page): page is OcrPageOut => page !== undefined)
      const completeJobIds = apiJobIds.filter((jobId): jobId is string => jobId !== undefined)
      if (completePages.length !== images.length || completeJobIds.length !== images.length) {
        throw new Error(`并发 OCR 未返回全部页(${completePages.length}/${images.length}):${file}`)
      }
      if (ctx.cancelled()) return null

      persistPages(ctx, fileId, file, completePages, effectiveModel)
      return {
        file,
        ok: true,
        fileId,
        pages: completePages.length,
        renderedPageImages: images.length,
        cachedPages,
        engine: 'paddleocr',
        model: effectiveModel,
        apiJobIds: completeJobIds,
        elapsedMs: Date.now() - startedAt,
      }
    } catch (error) {
      if (ctx.cancelled()) return null
      return { file, ok: false, error: (error as Error).message ?? String(error) }
    }
  }

  await Promise.all(
    files.map(async (file, index) => {
      const outcome = await processFile(file)
      if (!outcome) return
      outcomes[index] = outcome
      if (outcome.ok) totalPages += outcome.pages
      else failed += 1
      doneFiles += 1
      ctx.progress(doneFiles, files.length)
    }),
  )

  if (ctx.cancelled()) {
    return { result: { ...snapshot(), cancelled: true, done: doneFiles }, cancelled: true }
  }

  const result = snapshot()
  return failed
    ? { result, error: `${files.length} 份里 ${failed} 份识别失败(逐项原因见 result.files[].error)` }
    : { result }
}

export const ocrSpec: JobSpec = {
  kind: 'ocr',
  status: 'ready',
  summary:
    '先渲染并增强 PDF 页图,并发提交单页 PNG 给 PaddleOCR,按源页码完整入库到 ocr_result;' +
    '成功页中转缓存,部分失败后重跑只补缺失页',
  paramsHint:
    '{ files: string[](相对文件库根的 PDF 路径,非空;须先生成完整且至少 300 DPI 页图), model?: string }',
  parse: parseOcrParams,
  // 分母提交时就知道 —— 轮询方一上来就能看到「一共 3 份」。
  total: (params) => (params.files as string[]).length,
  prepare: () => {
    const config = resolveOcrConfig()
    return (ctx, params) => runOcr(ctx, params, config)
  },
  run: runOcr,
}
