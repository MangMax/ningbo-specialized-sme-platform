import { resolveOcrFileTarget } from '../../utils/ocr-files'
import { DEFAULT_OCR_ENGINE } from '../../utils/ocr-result'
import { saveOcrImport } from '../../utils/ocr-page-lifecycle'

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
 * ── `raw`(原始响应)────────────────────────────────────────────────────
 * JSONL 那条**会**把每页的原始项一起落进 `raw`(那就是官网结果文件里的原文);
 * markdown 那两条没有原始响应,不传 —— `writeOcrResult` 在「本次没给」时保留上一次的值,
 * 所以通路 a(在线 API 花过钱的那份)的 `raw` 不会被一次重传抹掉。
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
              expectedVersion: { type: 'string', nullable: true, description: '显式 page 的预期版本;null=预期不存在;省略=兼容无条件覆盖。读回见 pages[].version。' },
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
      409: { description: '页版本冲突;重新读取后再提交。' },
      415: { description: '目标不是 PDF(OCR 结果只挂 PDF —— 见实现里的说明)。' },
    },
  },
})

export default defineEventHandler(async (event) => {
  const body = (await readBody(event).catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw createError({ statusCode: 400, message: '请求体必须是 JSON 对象' })
  }

  if ((body.relPath !== undefined && typeof body.relPath !== 'string') ||
      (body.file !== undefined && typeof body.file !== 'string') ||
      (body.fileId !== undefined && body.fileId !== null && typeof body.fileId !== 'string' && typeof body.fileId !== 'number') ||
      (body.relPath !== undefined && body.file !== undefined)) {
    throw createError({ statusCode: 400, message: '文件引用非法;file/relPath 是二选一的路径别名,不得混用' })
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

  return saveOcrImport(target, body, 'upload')
})
