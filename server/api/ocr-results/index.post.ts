import { isPdfPath } from '~~/lib/pdf-page'
import { resolveOcrFileTarget } from '../../utils/ocr-files'
import { DEFAULT_OCR_ENGINE, pagesFromInput, writeOcrResult } from '../../utils/ocr-result'

/**
 * **通路 b:上传识别结果**。`POST /api/ocr-results`
 *
 * body:`{ "relPath": "jxj/announcement/2024/1/….pdf", "markdown": "<!-- page: 1 -->\n…" }`
 * (`relPath` 也可以写作 `file`;`fileId` 与路径恰给其一。可带 `engine` / `model`。)
 *
 * 用户在 PaddleOCR 官网(或别的工具)已经跑完了识别,把**带页码的 markdown** 传进来,
 * 直接按页入库 —— **不经过任何外网、不需要任何凭证**。这是三条通路里唯一一条
 * 「一定能跑通」的,也是验收里那条端到端用例走的路。
 *
 * ── 页码从哪来 ──────────────────────────────────────────────────────────
 * 从 markdown 的页标记来(`lib/ocr-markdown.ts` 的 `splitMarkdown`),**不猜**:
 * 没有标记、标记前有正文、页号重复,都是 400 带一句中文原因,而不是「当第 1 页存了」。
 * 猜出来的页码会让「按 `page_no` 给 `record_evidence` 补页码」这条整条失真。
 *
 * ── 幂等 ────────────────────────────────────────────────────────────────
 * 同一份 markdown 传两次 == 传一次:`(file_id, page_no)` 有唯一索引,写的是覆盖
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
    summary: '上传识别结果(通路 b,带页码的 markdown)',
    description:
      '把已在别处跑好的、**带页码标记**的 markdown 按页入库。页标记见 `lib/ocr-markdown.ts`' +
      '(`<!-- page: N -->` 规范形式,也接受 `## 第 N 页`)。同内容重传幂等。**不需要外网与凭证。**',
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['markdown'],
            properties: {
              relPath: { type: 'string', description: '相对文件库根的路径(与 `fileId` 恰给其一)。' },
              file: { type: 'string', description: '`relPath` 的别名(与 `GET` 那两条路由同一写法)。' },
              fileId: { type: 'integer', description: '文件 id(与路径恰给其一)。' },
              markdown: { type: 'string', description: '带页码标记的 markdown 全文。' },
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
                written: { type: 'integer', description: '本次落库的页数。' },
                pages: { type: 'array', items: { type: 'integer' }, description: '落库的页号(升序)。' },
              },
            },
          },
        },
      },
      400: {
        description: '缺文件引用 / 引用写法混用 / 没有页码标记 / 页码重复或乱序 / 页号越界 / markdown 不是字符串。',
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

  const markdown = body.markdown
  if (typeof markdown !== 'string') {
    throw createError({ statusCode: 400, message: '缺少 markdown 字段(带页码标记的全文)' })
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

  // 这条路由**只认带页标记的整份结果** —— 它是「上传官网跑好的结果」那条通路,
  // 传进来的必须是完整的按页结果。单页写入(没有页标记)走 MCP 的 `save_ocr_result`,
  // 那里能显式给 `page`。两个入口对「页号从哪来」的差别是有意的:
  // 这里的调用方是**人**,他看到的就是一份带页码的文件;那里的调用方是**代理**,
  // 它一次只拿一页,手里没有页码标记。
  const parsed = pagesFromInput(markdown, null)
  if (!parsed.ok) throw createError({ statusCode: 400, message: parsed.message })

  const written = writeOcrResult(target.db, {
    fileId: target.row.id,
    pages: parsed.pages.map((p) => ({ page: p.page, markdown: p.markdown })),
    channel: 'upload',
    ...(typeof body.engine === 'string' && body.engine.trim() ? { engine: body.engine.trim() } : {}),
    model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null,
    sourceRelPath: target.row.relPath,
  })
  if (!written.ok) throw createError({ statusCode: 400, message: written.message })

  return {
    file: { id: target.row.id, relPath: target.row.relPath, filename: target.row.filename },
    channel: 'upload',
    written: written.written,
    pages: written.pages,
  }
})
