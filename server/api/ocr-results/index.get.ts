import { MAX_PAGE_NO } from '../../../lib/ocr-markdown'
import { fileRefFromQuery, resolveOcrFileTarget } from '../../utils/ocr-files'
import { listOcrResults } from '../../utils/ocr-result'

/**
 * 查一个文件的 **OCR 结果清单**。`GET /api/ocr-results?file=<相对路径>|fileId=<id>[&page=3][&markdown=1]`
 *
 * 返回**元数据**(页号、引擎、模型、通路、时间、字符数、页图路径),`markdown=1` 时**另带
 * 每页正文**。默认不带正文的理由:97 页的正文是几百 KB,而「这文件识别了没、识别了哪几页、
 * 哪条通路做的」是**每开一次就查一次**的轻量问题。一个接口既当清单又当正文,就会让轻的那个
 * 问题也得拖几百 KB。
 *
 * ── `markdown=1` 是给页面校对用的,而且它读的是**逐页那一行** ────────────
 * 页面要「一页图对着一页文本」,必须拿到**逐页**正文。原先页面走的是
 * `GET /api/ocr-results/markdown`(整份拼接)再按页标记反切 —— 那条路在页体**自带整行页标记**
 * 时会失效或串页(独立代码审核 B2:页体含 `## 第 1 页` 会让整份反切报「页码重复」,
 * 含 `<!-- page: 4 -->` 会把第 3 页的正文挂到第 4 页)。而页体自带这种行是**真会发生的**:
 * 通路 a 直写模型返回的 markdown,模型完全可能把「第 N 页」当标题输出。
 * 所以这里直接回**库里那一行**,不再经过「拼起来再切开」。
 *
 * 只读。**不鉴权** —— 与 `/api/jobs`、`/api/files` 一致的读口口径。
 */
defineRouteMeta({
  openAPI: {
    tags: ['OCR'],
    summary: '查某文件的 OCR 结果清单(可选带逐页正文)',
    description:
      '按 `file`(相对文件库根的路径)或 `fileId`(恰给其一)查。给 `page` 时只报那一页。' +
      '默认只给元数据;`markdown=1` 时每页附 `markdown` 正文(页面校对用,取自库里那一行,不经整份拼接)。' +
      '整份导出见 `GET /api/ocr-results/markdown`。只读,不需要 token。',
    parameters: [
      {
        name: 'file',
        in: 'query',
        schema: { type: 'string' },
        description: '相对文件库根的文件路径(与 `record_evidence.source_file` 同口径)。',
      },
      { name: 'fileId', in: 'query', schema: { type: 'integer' }, description: '文件 id(与 `file` 恰给其一)。' },
      { name: 'includeVersion', in: 'query', schema: { type: 'string', enum: ['1', 'true'] }, description: '显式请求页版本;省略保留原响应形状。' },
      { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE_NO }, description: '只报这一页。' },
      {
        name: 'markdown',
        in: 'query',
        schema: { type: 'string', enum: ['1', 'true'] },
        description: '带上每页正文(`pages[].markdown`)。默认不带。',
      },
    ],
    responses: {
      200: {
        description: 'OCR 结果清单(按页号升序);`markdown=1` 时每页附正文。',
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
                      version: { type: 'string', description: '不透明页版本;用于 expectedVersion' },
                      page: { type: 'integer' },
                      engine: { type: 'string' },
                      model: { type: 'string', nullable: true },
                      channel: { type: 'string', enum: ['api', 'upload', 'mcp'] },
                      createdAt: { type: 'string' },
                      chars: { type: 'integer' },
                      markdown: { type: 'string', description: '仅 `markdown=1` 时出现。' },
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
    if ((typeof pageRaw !== 'string' && typeof pageRaw !== 'number') || !Number.isInteger(page) || page < 1 || page > MAX_PAGE_NO) {
      throw createError({ statusCode: 400, message: `page 必须是正整数:${String(pageRaw)}` })
    }
  }

  const target = await resolveOcrFileTarget(ref.ref, { allowRemoved: true })
  if (!target.ok) throw createError({ statusCode: target.statusCode, message: target.message })

  // `markdown=1` 才带正文 —— 轻的那个问题(识别了没、哪几页、哪条通路)不该拖几百 KB。
  const withMarkdown = q.markdown === '1' || q.markdown === 'true'

  const withVersion = q.includeVersion === '1' || q.includeVersion === 'true'
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
      ...(withVersion ? { version: r.version } : {}),
      engine: r.engine,
      model: r.model,
      channel: r.channel,
      createdAt: r.createdAt,
      chars: r.markdown.length,
      // 逐页正文**取自库里那一行**,不是把整份拼起来再切开 —— 见本文件顶部 B2 那段。
      ...(withMarkdown ? { markdown: r.markdown } : {}),
      pageRelPath: r.pageRelPath,
      // 页图字节仍由既有的文件回吐路由给(与票 13 的 `url` 同一口径),不另开文件服务器。
      url: r.pageRelPath
        ? `/api/files/${r.pageRelPath.split('/').map(encodeURIComponent).join('/')}`
        : null,
    })),
    count: rows.length,
  }
})
