import { fileRefFromQuery, resolveOcrFileTarget } from '../../utils/ocr-files'
import { ocrMarkdown } from '../../utils/ocr-result'

/**
 * **导出 OCR 结果 markdown**。`GET /api/ocr-results/markdown?file=…|fileId=…[&page=3]`
 *
 * - 不带 `page` → **整份**:按页号升序,页前一行 `<!-- page: N -->`(规则见 `lib/ocr-markdown.ts`);
 * - 带 `page` → **单页**的 markdown(同样带那一行页标记 —— 「带页码好读取」是用户的原始要求,
 *   单页导出少了自己的页码,人拿着那份文件就不知道它出自第几页)。
 *
 * 响应的 `content-type` 是 `text/markdown; charset=utf-8`,`content-disposition` 给个
 * 带页码线索的文件名,**浏览器点一下就存下来** —— 这个端点存在的意义就是「导出便于处理」。
 *
 * 导出与**回传**必须闭环:拿这份文件再 `POST /api/ocr-results` 传回来,
 * `splitMarkdown` 切出的页与导出前**逐字节相同**(测试里钉死了这条)。
 *
 * 只读,不鉴权。
 */
defineRouteMeta({
  openAPI: {
    tags: ['OCR'],
    summary: '导出 OCR 结果 markdown(整份 / 单页)',
    description:
      '按 `file` 或 `fileId`(恰给其一)导出。不带 `page` 导整份(按页升序、每页一行 `<!-- page: N -->` 页标记);' +
      '带 `page` 导那一页。响应是 `text/markdown`。只读,不需要 token。',
    parameters: [
      { name: 'file', in: 'query', schema: { type: 'string' } },
      { name: 'fileId', in: 'query', schema: { type: 'integer' } },
      { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } },
    ],
    responses: {
      200: {
        description: 'markdown 正文。',
        content: { 'text/markdown': { schema: { type: 'string' } } },
      },
      400: { description: '缺文件引用 / fileId 或 page 非法。' },
      404: { description: '文件不存在;或这个文件/这一页还没有 OCR 结果(消息里说明该走哪条通路)。' },
    },
  },
})

export default defineEventHandler(async (event) => {
  const q = getQuery(event) as Record<string, unknown>
  const ref = fileRefFromQuery(q)
  if (!ref.ok) throw createError({ statusCode: ref.statusCode, message: ref.message })

  const pageRaw = q.page
  let page: number | null = null
  if (pageRaw !== undefined && pageRaw !== null && pageRaw !== '') {
    page = Number(pageRaw)
    if (!Number.isInteger(page) || page < 1) {
      throw createError({ statusCode: 400, message: `page 必须是正整数:${String(pageRaw)}` })
    }
  }

  const target = await resolveOcrFileTarget(ref.ref, { allowRemoved: true })
  if (!target.ok) throw createError({ statusCode: target.statusCode, message: target.message })

  const out = ocrMarkdown(target.db, target.row.id, page)
  if (!out.ok) throw createError({ statusCode: 404, message: out.message })

  // 文件名带页码线索:`p003` 那种单页导出与整份导出一眼分得开。
  const suffix = page === null ? 'ocr.md' : `p${String(page).padStart(3, '0')}.ocr.md`
  // 只保留基名,去掉路径分隔符 —— content-disposition 里的文件名不该带目录。
  const base = target.row.filename.replace(/[/\\]/g, '_').replace(/\.[^.]+$/, '')
  setHeader(event, 'content-type', 'text/markdown; charset=utf-8')
  setHeader(
    event,
    'content-disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(`${base}.${suffix}`)}`,
  )
  // 顺带把「这份导出覆盖了哪几页」放进头里,便于脚本核对(不必解析正文)。
  setHeader(event, 'x-ocr-pages', out.pages.join(','))
  return out.markdown
})
