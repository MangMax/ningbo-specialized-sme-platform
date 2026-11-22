import { appLog, type LogContext } from '../../lib/logging'
import { z } from 'zod'
import { assembleMarkdown, MAX_PAGE_NO } from '../../lib/ocr-markdown'
import { createError } from 'h3'
import { isPdfPath } from '../../lib/pdf-page'
import { guardImportedPageCount, guardTargetPage } from '../../lib/ocr-workbench'
import { decodeOcrImport } from './ocr-import'
import { validOcrExpectedVersion, type OcrChannel } from './ocr-result-contract'
import { listPdfPages } from './pdf-pages'
import { describeOcrFile, readOcrFileResults, writeOcrFileResults, type OcrFileTarget } from './ocr-files'

/** 页面上传、代理 REST 与 MCP 共用同一解码、PDF/页数校验和写事务。 */
async function saveOcrImportUnlogged(
  target: OcrFileTarget,
  body: Record<string, unknown>,
  channel: OcrChannel,
) {
  if (body.mode !== undefined && (body.mode !== 'versioned' || body.expectedVersion === undefined)) {
    throw createError({ statusCode: 400, message: '现代版本命令不完整:mode=versioned 必须提供 expectedVersion' })
  }
  if (!validOcrExpectedVersion(body.expectedVersion)) throw createError({ statusCode: 400, message: 'expectedVersion 非法' })
  if (body.expectedVersion !== undefined && (typeof body.page !== 'number' || !Number.isInteger(body.page))) {
    throw createError({ statusCode: 400, message: 'expectedVersion 需要显式 page;不能作用于隐式整份范围' })
  }
  /**
   * **只收 PDF** —— 与 `ocr` 任务面(`parseOcrParams` 的 `isPdfPath`)**同一条判据**。
   *
   * 为什么不能放行:下游 pipeline 把「库里有 OCR 结果」当作「这份文件该走 markdown 读法」的
   * 依据(`pipeline/src/inputs.ts` 的 `rank()` 把它排到最前,并跳过 `.docx` 解析器)。
   * 于是往一份 `.docx` 上挂 OCR 结果,等于**悄悄换掉那份文件的解析来源** ——
   * 而 `.docx` 的文本与扫描件的文本不是一回事。要换就该换得明明白白(改分类/换文件),
   * 不是从 OCR 表侧捅进去。
   */
  if (!isPdfPath(target.row.relPath)) {
    throw createError({
      statusCode: 415,
      message: `OCR 结果只能挂在 PDF 上(扫描件走这条路):${target.row.relPath}`,
    })
  }

  // 解码(含页号语义)。jsonl 与 markdown 恰给其一 —— 见 `decodeOcrImport` 的说明。
  const decoded = decodeOcrImport({ jsonl: body.jsonl, markdown: body.markdown, page: body.page })
  if (!decoded.ok) throw createError({ statusCode: 400, message: decoded.message })
  const { pages, source } = decoded

  /**
   * 页码护栏。**只在需要的时候读源页数**:整份 markdown 那条不核对(理由写在路由顶部),
   * 也就没必要为它去开一次 PDF(`listPdfPages` 要载入 pdfium 并解析文件)。
   */
  let pageCount: number | null = null
  let renderedPageImages: number | null = null
  let warning: string | null = null

  if (source === 'jsonl') {
    const state = await listPdfPages(target.root, target.row.relPath)
    pageCount = state.pageCount
    // `rendered` 探测不出来与「没渲染过」在 `listPdfPages` 里已经是两回事(0 vs 抛错),
    // 这里照实传 —— `guardImportedPageCount` 只把 > 0 的不一致当提示。
    renderedPageImages = state.rendered
    const guard = guardImportedPageCount({
      imported: pages.length,
      pageCount,
      rendered: renderedPageImages,
    })
    if (!guard.ok) throw createError({ statusCode: 400, message: guard.message })
    warning = guard.warning
  } else if (pages.length === 1 && typeof body.page !== 'undefined' && body.page !== null && body.page !== '') {
    // 显式给了 `page` 的单页写入:核对页号有没有越出这份 PDF。
    const state = await listPdfPages(target.root, target.row.relPath)
    pageCount = state.pageCount
    renderedPageImages = state.rendered
    const guard = guardTargetPage(pages[0]!.page, pageCount)
    if (!guard.ok) throw createError({ statusCode: 400, message: guard.message })
  }

  const written = await writeOcrFileResults(target, {
    fileId: target.row.id,
    // `raw` **有就带上**:JSONL 导入那条会带 —— 那份 `layoutParsingResults` 项就是
    // 原始响应,与通路 a 落的 `raw` 是同一个东西(用户要求保留 API 原始响应)。
    // 没有就不传,`writeOcrResult` 在「本次没给」时**保留上一次的值** ——
    // 所以普通的 markdown 重传不会抹掉通路 a 花过钱的那份原文。
    pages: pages.map((p) => ({
      page: p.page,
      markdown: p.markdown,
      ...(p.raw === undefined ? {} : { raw: p.raw }),
    })),
    expectedVersion: body.expectedVersion as string | null | undefined,
    channel,
    ...(typeof body.engine === 'string' && body.engine.trim() ? { engine: body.engine.trim() } : {}),
    model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null,
    sourceRelPath: target.row.relPath,
  })
  if (!written.ok) throw createError({ statusCode: written.statusCode ?? 400, message: written.message })

  return {
    file: { id: target.row.id, relPath: target.row.relPath, filename: target.row.filename },
    channel,
    source,
    written: written.written,
    pages: written.pages,
    pageCount,
    renderedPageImages,
    warning,
  }
}

export const ocrPageSchema = z.number().int().min(1).max(MAX_PAGE_NO)
export const ocrExpectedVersionSchema = z.string().regex(/^[1-9]\d*:[1-9]\d*$/).max(64).nullable().optional().describe('预期不透明页版本;null=预期不存在;省略=兼容无条件。冲突409,显式单页适用。')
/** 一次按文件/页定位的显式投影;从不读取 raw,不重复加载正文。 */
export async function getOcrResultForFile(target: OcrFileTarget, page?: number, includeVersion = true) {
  const { row } = target
  const results = await readOcrFileResults(target, page)
  if (!results.length) throw createError({ statusCode: 404, message: page === undefined ? '这个文件还没有 OCR 结果' : `第 ${page} 页还没有 OCR 结果` })
  return {
    file: { id: row.id, relPath: row.relPath, filename: row.filename },
    ...(includeVersion ? { contentIdentity: await describeOcrFile(target) } : {}),
    page: page ?? null,
    pages: results.map(result => result.page),
    markdown: assembleMarkdown(results),
    results: results.map(r => ({ page: r.page, ...(includeVersion ? { version: r.version, historicalBinding: r.historicalBinding } : {}), engine: r.engine, model: r.model, channel: r.channel, createdAt: r.createdAt, chars: r.markdown.length, pageRelPath: r.pageRelPath, url: r.pageRelPath ? `/api/files/${r.pageRelPath.split('/').map(encodeURIComponent).join('/')}` : null })),
  }
}

/** Edits describe a derived page revision, separately from online recognition and request completion. */
export async function saveOcrImport(
  target: OcrFileTarget, body: Record<string, unknown>,
  channel: OcrChannel, context: LogContext = {},
) {
  const startedAt = Date.now()
  try {
    const result = await saveOcrImportUnlogged(target, body, channel)
    for (const page of result.pages) appLog({ module: 'core', source: 'ocr', operation: 'ocr.page.revise', outcome: 'success', fileId: target.row.id, page, durationMs: Date.now() - startedAt }, context)
    return result
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode ?? 500
    const page = ocrPageSchema.safeParse(body.page)
    appLog({ module: 'core', source: 'ocr', operation: 'ocr.page.revise', outcome: status < 500 ? 'denied' : 'failure', level: 'error', fileId: target.row.id, ...(page.success ? { page: page.data } : {}), errorCode: status === 409 ? 'ocr_page_conflict' : 'ocr_revision_failed', durationMs: Date.now() - startedAt }, context)
    throw error
  }
}
