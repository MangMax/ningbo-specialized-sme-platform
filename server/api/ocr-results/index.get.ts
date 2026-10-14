import { fileRefFromQuery, resolveOcrFileTarget } from '../../utils/ocr-files'
import { listOcrResults } from '../../utils/ocr-result'

/**
 * 查一个文件的 **OCR 结果清单**。`GET /api/ocr-results?file=<相对路径>|fileId=<id>[&page=3]`
 *
 * 返回**元数据**(页号、引擎、模型、通路、时间、字符数、页图路径),**不含 markdown 正文** ——
 * 正文走 `GET /api/ocr-results/markdown`。分开的理由:97 页的正文是几百 KB,
 * 而「这文件识别了没、识别了哪几页、哪条通路做的」是**每开一次就查一次**的轻量问题。
 * 一个接口既当清单又当正文,就会让轻的那个问题也得拖几百 KB。
 *
 * 只读。**不鉴权** —— 与 `/api/jobs`、`/api/files` 一致的读口口径。
 */
defineRouteMeta({
  openAPI: {
    tags: ['OCR'],
    summary: '查某文件的 OCR 结果清单(不带正文)',
    description:
      '按 `file`(相对文件库根的路径)或 `fileId`(恰给其一)查。给 `page` 时只报那一页。' +
      '正文导出见 `GET /api/ocr-results/markdown`。只读,不需要 token。',
    parameters: [
      {
        name: 'file',
        in: 'query',
        schema: { type: 'string' },
        description: '相对文件库根的文件路径(与 `record_evidence.source_file` 同口径)。',
      },
      { name: 'fileId', in: 'query', schema: { type: 'integer' }, description: '文件 id(与 `file` 恰给其一)。' },
      { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 }, description: '只报这一页。' },
    ],
    responses: {
      200: {
        description: 'OCR 结果清单(按页号升序)。',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                file: { type: 'object' },
                channels: { type: 'array', items: { type: 'string' } },
                pages: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      page: { type: 'integer' },
                      engine: { type: 'string' },
                      model: { type: 'string', nullable: true },
                      channel: { type: 'string', enum: ['api', 'upload', 'mcp'] },
                      createdAt: { type: 'string' },
                      chars: { type: 'integer' },
                      pageRelPath: { type: 'string', nullable: true },
                      url: { type: 'string', nullable: true, description: '该页页图(票 13)的预览 URL。' },
                    },
                  },
                },
                count: { type: 'integer' },
              },
            },
          },
        },
      },
      400: { description: '缺文件引用 / fileId 非法 / page 非法。' },
      404: { description: '文件不存在 / 已移出库。' },
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

  const rows = listOcrResults(target.db, target.row.id, page)
  return {
    file: {
      id: target.row.id,
      relPath: target.row.relPath,
      filename: target.row.filename,
      ext: target.row.ext,
      parseState: target.row.parseState,
    },
    channels: [...new Set(rows.map((r) => r.channel))].sort(),
    pages: rows.map((r) => ({
      page: r.page,
      engine: r.engine,
      model: r.model,
      channel: r.channel,
      createdAt: r.createdAt,
      chars: r.markdown.length,
      pageRelPath: r.pageRelPath,
      // 页图字节仍由既有的文件回吐路由给(与票 13 的 `url` 同一口径),不另开文件服务器。
      url: r.pageRelPath
        ? `/api/files/${r.pageRelPath.split('/').map(encodeURIComponent).join('/')}`
        : null,
    })),
    count: rows.length,
  }
})
