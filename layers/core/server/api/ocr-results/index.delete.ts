import { requestLogContext } from '../../../lib/logging'
import { MAX_PAGE_NO } from '../../../lib/ocr-markdown'
import { deleteOcrFilePage, fileRefFromQuery, resolveOcrFileTarget } from '../../utils/ocr-files'

/**
 * **删掉某一页的 OCR 结果**。`DELETE /api/ocr-results?file=…|fileId=…&page=3`
 *
 * ── 为什么 `page` 是**必填**的 ───────────────────────────────────────────
 * 这条路由**只删一页**。不带 `page` 的删除请求一律 400,不给「顺手清空整份文件」留后门:
 * 一份 12 页的识别结果重做要花 API 额度与分钟级时间,而工作台的每一次删除都是
 * 「这一页我认得不对,重来」—— 一次误点不该是整份的结果。
 *
 * 要做整份清空的是**编排面**(`removeOcrResults`,在发现「识别页数 ≠ 源页数」时
 * 回滚自己刚写错的那一批),那是内部自清,不对外开接口。这里不给它开口子。
 *
 * ── 幂等 ────────────────────────────────────────────────────────────────
 * 那一页本来就没有结果时删 0 行、仍回 200:`deleted` 就是**实际删掉的行数**。
 * 「删一个已经不在的东西」不该失败 —— 两个人同时删同一页时,第二个得到的不是报错。
 *
 * ── 边界 ────────────────────────────────────────────────────────────────
 * **只删 `ocr_result` 里那一行。** 不碰页图(票 13 的派生缓存)、不碰 `stored_file`、
 * 不碰台账(`record` / `enterprise`)。删除的语义窄到这里是有意的:页图重渲染一次就有了,
 * 而文件的分类/段、台账记录都不是这一页文本的事。
 */
defineRouteMeta({
  openAPI: {
    tags: ['OCR'],
    summary: '删掉某一页的 OCR 结果',
    description:
      '**`page` 必填** —— 这条路由只删一页,避免一次误点清空整份文件的识别结果。' +
      '只删 `ocr_result` 里那一行,不动页图、文件与台账。幂等:那一页没有结果时 `deleted: 0`。',
    parameters: [
      {
        name: 'file',
        in: 'query',
        // 不是 required:`file` 与 `fileId` **恰给其一**(与 GET 那两条同一写法,
        // 判据在 `fileRefFromQuery`)。标成必填会让按 spec 生成的客户端以为必须带路径。
        schema: { type: 'string' },
        description: '相对文件库根的路径(与 `fileId` 恰给其一)。',
      },
      { name: 'fileId', in: 'query', schema: { type: 'integer' }, description: '文件 id(与 `file` 恰给其一)。' },
      { name: 'mode', in: 'query', schema: { type: 'string', enum: ['versioned'] }, description: '显式现代命令模式;须同时给 expectedVersion。' },
      { name: 'expectedVersion', in: 'query', schema: { type: 'string' }, description: '预期页版本;省略=无条件。版本不符拒绝删除。' },
      { name: 'page', in: 'query', required: true, schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE_NO } },
    ],
    responses: {
      200: {
        description: '删除结果。',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                file: { type: 'object' },
                page: { type: 'integer' },
                deleted: { type: 'integer', description: '实际删掉的行数(0 或 1)。' },
                remaining: { type: 'integer', description: '删完之后这个文件还有几页结果。' },
              },
            },
          },
        },
      },
      400: { description: '缺文件引用 / 缺 `page` / `page` 非法。' },
      409: { description: '预期页版本不符;重新读取后再提交。' },
      404: { description: '文件不存在 / 已移出库。' },
    },
  },
})

export default defineEventHandler(async (event) => {
  const q = getQuery(event) as Record<string, unknown>

  const ref = fileRefFromQuery(q)
  if (!ref.ok) throw createError({ statusCode: ref.statusCode, message: ref.message })

  /**
   * `page` 必填。与 `GET` 那两条路由的「可选 page」**刻意不同** —— 读的时候省略 `page`
   * 是「给我整份」,写/删的时候省略必须是「说清你要动哪一页」,否则就是范围失控。
   * 这里的 400 消息要说得像一个**缺失的参数**,不是「页号非法」—— 前者用户知道去补。
   */
  if (q.mode !== undefined && (q.mode !== 'versioned' || q.expectedVersion === undefined)) {
    throw createError({ statusCode: 400, message: '现代版本命令不完整:mode=versioned 必须提供 expectedVersion' })
  }
  const rawPage = q.page
  if (rawPage === undefined || rawPage === null || rawPage === '') {
    throw createError({
      statusCode: 400,
      message: '缺少 page 参数:这条路由只删一页,必须指明是哪一页(整份清空不在页面能力内)。',
    })
  }
  const page = Number(rawPage)
  if ((typeof rawPage !== 'string' && typeof rawPage !== 'number') || !Number.isInteger(page) || page < 1 || page > MAX_PAGE_NO) {
    throw createError({ statusCode: 400, message: `page 必须是正整数:${String(rawPage)}` })
  }

  const target = await resolveOcrFileTarget(ref.ref)
  if (!target.ok) throw createError({ statusCode: target.statusCode, message: target.message })

  const out = await deleteOcrFilePage(target, page, q.expectedVersion as string | undefined, requestLogContext(event))
  if (!out.ok) throw createError({ statusCode: out.statusCode, message: out.message })

  return {
    file: { id: target.row.id, relPath: target.row.relPath, filename: target.row.filename },
    page,
    deleted: out.deleted,
    // 删完之后还剩几页结果 —— 界面用它更新覆盖率,不必再发一次清单请求。
    remaining: out.remaining,
  }
})
