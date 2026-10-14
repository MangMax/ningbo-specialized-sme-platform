import { DEFAULT_DPI, isPdfPath } from '../../../lib/pdf-page'
import type { JobCompletion, JobContext, JobParseResult, JobSpec } from '../job-runner'
import { findFileIdByRelPath } from '../mcp-files'
import { ocrPdfFile, resolveOcrConfig, type OcrPageOut } from '../ocr-api'
import { writeOcrResult, removeOcrResults } from '../ocr-result'
import { listPdfPages, resolveWithinRoot } from '../pdf-pages'

/**
 * `ocr` —— **批量**把扫描 PDF 识别成文本(通路 a:在线 API)。
 *
 * 票 19 把 `ocr` 登记成 `todo` 时给的理由很具体:「结果无处可放」。票 14 把
 * `ocr_result` 表建起来之后,这里就是那句话的答案 —— **`todo` → `ready`**,
 * 注册表(`job-specs.ts`)与提交路由一行都不用改。
 *
 * ── 为什么提交**整份 PDF**,不是逐页页图 ─────────────────────────────────
 * 理由写在全处:`server/utils/ocr-api.ts` 顶部(页码天然对齐 / 一次调用一份文件 /
 * 版式上下文更全)。这里只说**页图仍然被核对**:每份文件跑完都去问一次票 13 的
 * `listPdfPages` —— 已渲染的页图数与识别出的页数对不上就在产出里**报出来**
 * (不是失败:页图没渲染过是常态,渲染了才对得上是有用的信号)。
 *
 * ── 逐份之间的取消检查 ──────────────────────────────────────────────────
 * 与 `render-pages` 同一粒度:**一份文件**之前问一次。一份 97 页的 PDF 识别是分钟级,
 * 页级取消要往 `ocrPdfFile` 的轮询里插回调 —— 那条路已经有了(`isCancelled`),
 * 这里只用「份」这一层,因为「停下来时哪几份做完了」才是调用方要的。
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
      /** 页数与页图数对不上时的提醒(不是失败)。 */
      warning?: string
      engine: string
      model: string
      /** 服务端报的总页数(拿不到时为 null)。 */
      apiTotalPages: number | null
      /** API 那侧的任务号,便于对账。 */
      apiJobId: string
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
    channel: 'api',
    engine: 'paddleocr',
    model,
    // 给了它,`page_rel_path` 才会按票 13 的规则(相对 PDF 路径 + 页号)算出来。
    sourceRelPath: relPath,
  })
  if (!result.ok) throw new Error(`写入 OCR 结果失败:${result.message}`)
  return { written: result.written }
}

/**
 * 票 13 已渲染的页图数;**探测本身失败时给 `null`**(不是 0)。
 *
 * 「没渲染过」与「探测不了」是两件事:前者是 `0`(正常的、不报警),
 * 后者是「我不知道」——把后者当 0 会让一份真出了问题的文件看起来完全正常。
 * 所以这里吞掉异常并回 `null`,调用方据此决定要不要报警。
 */
async function renderedPageCount(filesDir: string, relPath: string): Promise<number | null> {
  try {
    return (await listPdfPages(filesDir, relPath, DEFAULT_DPI)).rendered
  } catch {
    return null
  }
}

/**
 * **源 PDF 的实际页数**(不看页图,任何时候都问得到)。读不出来时给 `null`。
 *
 * 与 `renderedPageCount` 分工:那个答「渲染过没、渲染了几页」(可选缓存),
 * 这个答「这份文件到底有多少页」(事实)。页码对不对只取决于后者。
 */
async function sourcePageCount(filesDir: string, relPath: string): Promise<number | null> {
  try {
    return (await listPdfPages(filesDir, relPath, DEFAULT_DPI)).pageCount
  } catch {
    return null
  }
}

/**
 * 逐份识别。
 *
 * **一份失败不停下整批**(与 `render-pages` 同一理由):批量任务的用处正是「一次交一堆」,
 * 因为第 2 份坏了就撂下第 3–7 份,等于把「哪几份坏了」换成「任务失败」。
 * 有任意一份失败 ⇒ 状态记 `failed`,明细仍在 `result.files[]` 里。
 *
 * **取消**走 `{ cancelled: true }` 并**带着部分产出收尾** —— 调用方最想知道的是
 * 「停在哪、做完了哪些」。正在跑的那一份**会先跑完**(尽力而为:取消在下一次的检查点生效),
 * 它已写入的结果**保留**(写库发生在 `ocrPdfFile` 返回之后;被取消时会有半份文件缺页,
 * 重跑那一份即可 —— `(file_id, page_no)` 唯一索引让它幂等)。
 */
export async function runOcr(
  ctx: JobContext,
  params: Record<string, unknown>,
): Promise<JobCompletion> {
  const { files, model } = params as unknown as OcrParams
  const config = resolveOcrConfig()
  if (!config.token) {
    // 配置错**在动手之前**就报出来 —— 逐份失败会得到 N 条一模一样的错,而它一次就说清了。
    throw new Error(
      '缺少 OCR token:设 `NUXT_OCR_TOKEN`(或 `PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN`)再提交。' +
        '凭证不入库;页面通路(b 上传结果)不需要 token。',
    )
  }

  const outcomes: OcrFileOutcome[] = []
  let totalPages = 0
  let failed = 0

  const snapshot = (): OcrJobResult => ({
    files: outcomes,
    total: files.length,
    ok: outcomes.filter((o) => o.ok).length,
    failed,
    pages: totalPages,
    channel: 'api',
  })

  for (let i = 0; i < files.length; i += 1) {
    // 每份之前看一眼取消标记 —— 「尽力而为」唯一的检查点。
    if (ctx.cancelled()) {
      return { result: { ...snapshot(), cancelled: true, done: i }, cancelled: true }
    }
    const file = files[i]!

    try {
      const fileId = findFileIdByRelPath(ctx.db, file)
      if (fileId === null) {
        throw new Error(
          `文件库里没有这个文件(先让 app 回填 stored_file:打开 /files 页,或调 list_files):${file}`,
        )
      }
      const abs = resolveWithinRoot(ctx.filesDir, file)

      const out = await ocrPdfFile({
        token: config.token,
        baseUrl: config.baseUrl,
        model: model ?? config.model,
        pollTimeoutMs: config.pollTimeoutMs,
        filePath: abs,
        fileName: file.split('/').pop(),
        isCancelled: () => ctx.cancelled(),
      })

      persistPages(ctx, fileId, file, out.pages, out.model)
      totalPages += out.pages.length

      // 与**源 PDF 的实际页数**核对 —— 这是「页码没被写错」的护栏。
      //
      // 为什么不用票 13 的页图数:页图是**可有可无的派生缓存**(没渲染过就是 0),
      // 而源页数是这份文件的**事实**,任何时候都问得到。页图数与 OCR 页数的一致性
      // 走另一个判据(见下),两件事分开说。
      const sourcePages = await sourcePageCount(ctx.filesDir, file)
      if (sourcePages !== null && sourcePages > 0 && out.pages.length !== sourcePages) {
        // **落到这里说明页码已经不可信了** —— 我们按 1..N 落的库,而源文件有 M 页。
        // 刚写进去的那些行按页号是错的,**删掉**(留着比没有更坏:它看起来像真的)。
        // 这不是「提醒一下」的情形,所以这一项记 `failed`。
        removeOcrResults(ctx.db, fileId)
        totalPages -= out.pages.length
        failed += 1
        outcomes.push({
          file,
          ok: false,
          error:
            `识别出的页数(${out.pages.length})与源 PDF 的页数(${sourcePages})不一致 —— ` +
            '按页回填的页码会因此错位,本项不采信、已回滚写入。请确认文件是否被截断/加密,或重跑一次。',
        })
        ctx.progress(i + 1, files.length)
        continue
      }

      // 页图数是**另一个**信号:它说明「OCR 与渲染说的是不是同一份文件」。
      // 拿不到(没渲染过)或探测失败都不算问题,只记一行。
      const rendered = await renderedPageCount(ctx.filesDir, file)
      const warning =
        rendered !== null && rendered > 0 && rendered !== out.pages.length
          ? `页图数与 OCR 页数不一致:OCR 出 ${out.pages.length} 页,票 13 的页图有 ${rendered} 页 —— 请确认源 PDF 是否是同一份`
          : undefined

      outcomes.push({
        file,
        ok: true,
        fileId,
        pages: out.pages.length,
        renderedPageImages: rendered ?? 0,
        ...(warning ? { warning } : {}),
        engine: 'paddleocr',
        model: out.model,
        apiTotalPages: out.totalPages,
        apiJobId: out.jobId,
        elapsedMs: out.elapsedMs,
      })
    } catch (error) {
      failed += 1
      outcomes.push({ file, ok: false, error: (error as Error).message ?? String(error) })
    }

    ctx.progress(i + 1, files.length)
  }

  const result = snapshot()
  return failed
    ? { result, error: `${files.length} 份里 ${failed} 份识别失败(逐项原因见 result.files[].error)` }
    : { result }
}

export const ocrSpec: JobSpec = {
  kind: 'ocr',
  status: 'ready',
  summary: '批量 OCR(走 PaddleOCR API,结果按页码入库到 ocr_result)',
  paramsHint:
    '{ files: string[](相对文件库根的 PDF 路径,非空), model?: string, pageRanges?: string }',
  parse: parseOcrParams,
  // 分母提交时就知道 —— 轮询方一上来就能看到「一共 3 份」。
  total: (params) => (params.files as string[]).length,
  run: runOcr,
}
