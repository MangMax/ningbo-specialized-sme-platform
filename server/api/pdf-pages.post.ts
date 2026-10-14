import { stat } from 'node:fs/promises'
import { isPdfPath, normalizeDpi } from '~~/lib/pdf-page'
import { renderPdfPages, resolveWithinRoot } from '../utils/pdf-pages'

/**
 * 把一份 PDF 逐页渲染成 PNG。`POST /api/pdf-pages`
 *
 * body:`{ "file": "jxj/announcement/2024/1/….pdf", "dpi": 200, "force": false }`
 *
 * 返回与 `GET /api/pdf-pages` 同形的 JSON(外加本次 `written / skipped / removed / elapsedMs`)。
 * **幂等**:源内容与 `dpi` 都没变时 `written: 0`,不写任何文件(判据见
 * `server/utils/pdf-pages.ts` 的清单)。
 *
 * 同步跑完再返回 —— 一份 97 页的 PDF 实测 **3.3 s**(见票 13),远没到要排队/轮询的规模。
 * **要批量、要异步**走 `POST /api/jobs {kind:"render-pages"}`(票 19):一次提交 N 份,
 * 拿 jobId 轮询,而不是 N 个请求各等 N 秒。两条路走的是**同一份渲染代码**,
 * 产物一致(幂等判据是同一个)。
 */
defineRouteMeta({
  openAPI: {
    tags: ['页图'],
    summary: '渲染一份 PDF 的页图(POST)',
    description: '同步渲染、幂等(源内容与 dpi 未变时 `written: 0`)。批量与异步见 `POST /api/jobs`。',
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['file'],
            properties: {
              file: { type: 'string', description: '相对文件库根的 PDF 路径。' },
              dpi: { type: 'integer', minimum: 72, maximum: 600, default: 200 },
              force: { type: 'boolean', default: false, description: '忽略清单与已有页图,无条件重渲染。' },
            },
          },
        },
      },
    },
    responses: {
      200: { description: '与 `GET /api/pdf-pages` 同形,外加 `written` / `skipped` / `removed` / `elapsedMs`。' },
      400: { description: '缺 `file` 字段 / 分辨率越界。' },
      403: { description: '路径越界。' },
      404: { description: '文件不存在。' },
      415: { description: '不是 PDF。' },
      422: { description: '渲染失败(加密 / 损坏),消息带原因。' },
    },
  },
})

export default defineEventHandler(async (event) => {
  const root = useRuntimeConfig().filesDir
  const body = (await readBody(event).catch(() => null)) as
    | { file?: unknown; dpi?: unknown; force?: unknown }
    | null

  const file = typeof body?.file === 'string' ? body.file.trim() : ''
  if (!file) {
    throw createError({ statusCode: 400, message: '缺少 file 字段(相对文件库根的 PDF 路径)' })
  }
  if (!isPdfPath(file)) {
    throw createError({ statusCode: 415, message: `不是 PDF:${file}` })
  }

  let dpi
  try {
    dpi = normalizeDpi(body?.dpi)
  } catch (error) {
    throw createError({ statusCode: 400, message: (error as Error).message })
  }

  let abs
  try {
    abs = resolveWithinRoot(root, file)
  } catch {
    throw createError({ statusCode: 403, message: '路径越界' })
  }

  try {
    const info = await stat(abs)
    if (!info.isFile()) throw new Error('not a file')
  } catch {
    throw createError({ statusCode: 404, message: `文件不存在:${file}` })
  }

  try {
    return await renderPdfPages(root, file, { dpi, force: body?.force === true })
  } catch (error) {
    // 渲染失败(加密 / 损坏 / 裁切异常)不吞:400 带上原因,让页面能显示给人看。
    throw createError({ statusCode: 422, message: `渲染失败:${(error as Error).message}` })
  }
})
