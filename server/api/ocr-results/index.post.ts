import { isPdfPath } from '~~/lib/pdf-page'
import { guardImportedPageCount, guardTargetPage } from '~~/lib/ocr-workbench'
import { resolveOcrFileTarget } from '../../utils/ocr-files'
import { decodeOcrImport } from '../../utils/ocr-import'
import { DEFAULT_OCR_ENGINE, writeOcrResult } from '../../utils/ocr-result'
import { listPdfPages } from '../../utils/pdf-pages'

/**
 * **通路 b:人把识别结果交进来**。`POST /api/ocr-results`
 *
 * 三种装法,**页号一律不从正文里猜**:
 *
 * | body | 页号来源 | 用途 |
 * |---|---|---|
 * | `{ relPath, markdown }` | 正文里的页标记(`<!-- page: N -->`) | 官网导出的整份 markdown(票 14 原有的入口) |
 * | `{ relPath, markdown, page }` | 显式 `page` | **只贴一页的正文**(工作台逐页校对时最常见) |
 * | `{ relPath, jsonl }` | **行序**(第 i 行 = 第 i 页) | 官网下载的**结果文件全文**(PaddleOCR SDK 读的就是它) |
 *
 * (`relPath` 也可以写作 `file`;`fileId` 与路径恰给其一。可带 `engine` / `model`。)
 *
 * ── 页码护栏(2026-10-15 补)───────────────────────────────────────────────
 * 上表里**只有 `jsonl` 那一条会自己定页码**,所以也只有它需要与文件核对:
 * 行数与源 PDF 页数对不上就整批拒收(见 `lib/ocr-workbench.ts` 的 `guardImportedPageCount`)。
 * 显式 `page` 那一条核对「页号有没有越出这份 PDF」(`guardTargetPage`)。
 * 带页标记的整份那条**保持不变** —— 页号是正文自己写着的,核对它的页数会对
 * 「只导一部分页」这种既有用法产生无谓的拦截。
 *
 * ── 幂等 ────────────────────────────────────────────────────────────────
 * 同一份内容传两次 == 传一次:`(file_id, page_no)` 有唯一索引,写的是覆盖
 * (见 `writeOcrResult`)。所以「传失败了重传」是安全的,不必先删后写。
 *
 * ── 为什么这一条是**写口却没有 token** ──────────────────────────────────
 * 与 `PATCH /api/files/:id`(分类回写)**同一档**:它们是**页面背后**的文件域写口
 * (票 10/12 的页面按钮就是调它们),不是给代理的接口。代理的写口在 MCP 那一侧
 * (`save_ocr_result`,票 18 已带鉴权)。三档分法(页面直调 / 代理走 MCP / 代理走
 * 任务面)在 `server/utils/api-auth.ts` 顶部写清了 —— 这里落在第一档。
 */
defineRouteMeta({
  openAPI: {
    tags: ['OCR'],
    summary: '写入识别结果(通路 b:整份 markdown / 单页 markdown / 结果 JSONL)',
    description:
      '把已在别处跑好的识别结果按页入库。页标记见 `lib/ocr-markdown.ts`' +
      '(`<!-- page: N -->` 规范形式,也接受 `## 第 N 页`)。`jsonl` 是 PaddleOCR 结果文件的' +
      '全文,页号按**行序**对齐并与源 PDF 页数核对。同内容重传幂等。**不需要外网与凭证。**',
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              relPath: { type: 'string', description: '相对文件库根的路径(与 `fileId` 恰给其一)。' },
              file: { type: 'string', description: '`relPath` 的别名(与 `GET` 那两条路由同一写法)。' },
              fileId: { type: 'integer', description: '文件 id(与路径恰给其一)。' },
              markdown: { type: 'string', description: '识别结果正文。自带页标记即整份;配 `page` 即单页。' },
              jsonl: {
                type: 'string',
                description: 'PaddleOCR 结果文件全文(JSONL)。与 `markdown` 恰给其一,页号按行序。',
              },
              page: {
                type: 'integer',
                minimum: 1,
                description: '页号;给了就表示 `markdown` 是**这一页**的内容(此时正文不该再带页标记)。',
              },
              engine: { type: 'string', description: `识别引擎;默认 \`${DEFAULT_OCR_ENGINE}\`。` },
              model: { type: 'string', description: '模型名(可空)。' },
            },
          },
        },
      },
    },
    responses: {
      200: {
        description: '写入结果。',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                file: { type: 'object' },
                channel: { type: 'string', enum: ['upload'] },
                source: { type: 'string', enum: ['jsonl', 'markdown'], description: '这次的输入装法。' },
                written: { type: 'integer', description: '本次落库的页数。' },
                pages: { type: 'array', items: { type: 'integer' }, description: '落库的页号(升序)。' },
                pageCount: {
                  type: 'integer',
                  nullable: true,
                  description: '源 PDF 的页数(核对结果的依据);读不出来时为 null。',
                },
                renderedPageImages: {
                  type: 'integer',
                  nullable: true,
                  description: '票 13 已渲染的页图数;探测不出时为 null。',
                },
                warning: { type: 'string', nullable: true, description: '核对里不影响写入的提示。' },
              },
            },
          },
        },
      },
      400: {
        description:
          '缺内容 / 两种输入一起给 / 引用写法混用 / 没有页码标记 / 页码重复或乱序 / 页号越界 / ' +
          '结果行数与源 PDF 页数不符。',
      },
      404: { description: '文件不存在 / 已移出库。' },
      415: { description: '目标不是 PDF(OCR 结果只挂 PDF —— 见实现里的说明)。' },
    },
  },
})

export default defineEventHandler(async (event) => {
  const body = (await readBody(event).catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw createError({ statusCode: 400, message: '请求体必须是 JSON 对象' })
  }

  // `file` 是 `relPath` 的别名:GET 那两条用 `file`,这里也认,免得同一个词在两个方法上
  // 写成两样。两个都给时不合并 —— 交给 `resolveFileRef` 报「只能给一个」。
  const relPath =
    typeof body.relPath === 'string' && body.relPath.trim()
      ? body.relPath.trim()
      : typeof body.file === 'string' && body.file.trim()
        ? body.file.trim()
        : null
  const rawId = body.fileId
  const fileId = rawId === undefined || rawId === null || rawId === '' ? null : Number(rawId)

  const target = await resolveOcrFileTarget({ fileId, relPath })
  if (!target.ok) throw createError({ statusCode: target.statusCode, message: target.message })

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

  const written = writeOcrResult(target.db, {
    fileId: target.row.id,
    pages: pages.map((p) => ({ page: p.page, markdown: p.markdown })),
    channel: 'upload',
    ...(typeof body.engine === 'string' && body.engine.trim() ? { engine: body.engine.trim() } : {}),
    model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null,
    sourceRelPath: target.row.relPath,
  })
  if (!written.ok) throw createError({ statusCode: 400, message: written.message })

  return {
    file: { id: target.row.id, relPath: target.row.relPath, filename: target.row.filename },
    channel: 'upload',
    source,
    written: written.written,
    pages: written.pages,
    pageCount,
    renderedPageImages,
    warning,
  }
})
