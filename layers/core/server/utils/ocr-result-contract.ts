import { assembleMarkdown, MAX_PAGE_NO, normalizeMarkdownBody, pageNoOfMarker, splitMarkdown, type OcrPage } from '../../lib/ocr-markdown'
import { pageImageRelPath, isPdfPath } from '../../lib/pdf-page'

/** 一张 OCR 结果表(票 14)。导出给文档与断言用。 */
export const OCR_RESULT_TABLE = 'ocr_result'

/** 三条通路。与 `ocr_result.channel` 的枚举同源。 */
export const OCR_CHANNELS = ['api', 'upload', 'mcp'] as const
export type OcrChannel = (typeof OCR_CHANNELS)[number]

/** 上传/代理通路没明说引擎时的默认值(与 schema 的列默认一致)。 */
export const DEFAULT_OCR_ENGINE = 'paddleocr'

/** 一页的写入输入。 */
export interface OcrPageWrite {
  /** 页码,从 1 起。 */
  page: number
  /** 该页 markdown(允许空串 —— 空白页也要占一行,页号不能断)。 */
  markdown: string
  /** 原始响应(API 那一页的 JSON / 上传的原文)。 */
  raw?: unknown
  /** Known online input/remote receipt; text revisions never invent one. */
  capture?: { taskId: string | null; sourceSha256: string | null; imageSha256: string; variant: string; jobId: string; createdAt: string | null }
  /** 该页页图的相对路径;省略时按票 13 的规则从源 PDF 路径推(仅 PDF 推得出)。 */
  pageRelPath?: string | null
}

/** 一次写入。 */
export interface OcrWriteInput {
  fileId: number
  /** 要写的页。**不会被合并**:没列出的页不动,列出的页**覆盖**。 */
  pages: readonly OcrPageWrite[]
  /** 为完整 PDF OCR 使用:在同一事务内删旧页并完整替换,清掉旧结果的多余页。 */
  replaceExistingPages?: boolean
  expectedVersion?: string | null
  /** Online publication: validate exactly the actual target pages before any write. */
  expectedVersions?: Readonly<Record<number, string | null>>
  channel: OcrChannel
  engine?: string
  model?: string | null
  /**
   * 源文件在文件库内的相对路径 —— 给了才推得出 `page_rel_path`(票 13 的页图规则
   * 按「相对 PDF 路径 + 页号」算)。`.md` 这类没有页图的来源不给即可。
   */
  sourceRelPath?: string | null
}

/**
 * 写入结果。失败给**给人看的中文原因**(路由转 400、tool 转 MCP 错误)。
 *
 * `written` 是**本次落库的页数**,`pages` 是它们按升序的页号 —— 让调用方(与验收)
 * 不必再查一次库就知道写进去了什么、页码对不对。
 */
export type OcrWriteResult =
  | { ok: true; written: number; pages: number[] }
  | { ok: false; message: string; statusCode?: number }

/** 一页页图路径:只有 PDF 推得出(票 13 的规则按「相对 PDF 路径」派生)。 */
export function pageRelPathOf(sourceRelPath: string | null | undefined, pageNo: number): string | null {
  if (!sourceRelPath || !isPdfPath(sourceRelPath)) return null
  return pageImageRelPath(sourceRelPath, pageNo)
}

/**
 * 校验待写入的页(**纯函数**)。
 *
 * 校验的是「这一批页本身站不站得住」,不是「文件在不在」——
 * 后者要查库,不属于纯函数。分两层是为了让这一层能被单测穷举,
 * 而路由只需要把两层串起来。
 */
export function validateOcrPages(pages: readonly OcrPageWrite[]): OcrWriteResult {
  if (!pages.length) return { ok: false, message: '至少要有一页(空数组不写任何东西)' }
  const seen = new Set<number>()
  for (const p of pages) {
    if (!Number.isInteger(p.page) || p.page < 1 || p.page > MAX_PAGE_NO) {
      return { ok: false, message: `页号必须是 1–${MAX_PAGE_NO} 之间的整数:${p.page}` }
    }
    if (typeof p.markdown !== 'string') {
      return { ok: false, message: `第 ${p.page} 页的 markdown 必须是字符串` }
    }
    if (seen.has(p.page)) {
      // 重复页会让唯一索引抛底层错误(一句话看不懂),不如在这里说人话。
      return { ok: false, message: `页号重复:第 ${p.page} 页给了两次` }
    }
    seen.add(p.page)
  }
  return { ok: true, written: pages.length, pages: [...seen].sort((a, b) => a - b) }
}

/**
 * 把「一份 markdown + 可选的页号」翻成**要写哪些页**。上传通路(b)与 MCP 的
 * `save_ocr_result` 共用这一条 —— 两个入口对「页号怎么定」必须**完全一样**,
 * 否则同一个人从页面传和从 MCP 传,结果会不一样。
 *
 * 两种输入:
 *  - **给了 `page`** ⇒ 整段 markdown 就是**那一页**的内容(代理常见的形态:
 *    它一次只处理一页,手里没有页码标记)。正文原样归一后落库。
 *  - **没给 `page`** ⇒ markdown **必须自带页标记**,按标记切页(通路 b:人从官网
 *    导出的整份结果)。切不开就报错,不猜页号。
 */
export function pagesFromInput(
  markdown: string,
  page?: number | null,
): { ok: true; pages: OcrPage[] } | { ok: false; message: string } {
  if (page !== undefined && page !== null) {
    if (!Number.isInteger(page) || page < 1 || page > MAX_PAGE_NO) {
      return { ok: false, message: `页号必须是 1–${MAX_PAGE_NO} 之间的整数:${String(page)}` }
    }
    /**
     * 给了 `page` 就是「这段 markdown 是**一页**的内容」—— 所以它自己**不该再带页标记**。
     *
     * 带了就是两种意思打架:标记说「这里有好几页」,`page` 说「只有这一页」。
     * 照单全收的后果很具体:标记会被当成**正文**存进那一页,于是导出的文件里
     * 嵌着别的页的标记,再拿去 `POST /api/ocr-results` 会得到「页码重复」——
     * **一份从我们这儿导出的文件传不回我们自己的上传口**。
     * 与其留下这种自相矛盾的数据,不如让调用方明确二选一。
     *
     * 逐行问 `pageNoOfMarker`(而不是拿两个正则各判一次)—— 判据只有一处定义,
     * 「行内提到第 3 页」这类正文不会被误判(它必须**整行**才是标记)。
     */
    if (markdown.split('\n').some((line) => pageNoOfMarker(line) !== null)) {
      return {
        ok: false,
        message:
          '给了 `page` 就表示这段 markdown 是**这一页**的内容,它不该再带页标记。' +
          '要么去掉 `page`(让 markdown 自己带页标记、按标记切页),要么把那一页的标记从正文里去掉。',
      }
    }
    return { ok: true, pages: [{ page, markdown: normalizeMarkdownBody(markdown) }] }
  }
  const split = splitMarkdown(markdown)
  if (!split.ok) {
    return {
      ok: false,
      message: `${split.message}(若这次的 markdown 只是**一页**、没有页码标记,请显式给 \`page\`。)`,
    }
  }
  return { ok: true, pages: split.pages }
}

export function ocrVersionExpectations(input: OcrWriteInput): Extract<OcrWriteResult, { ok: false }> | { ok: true; pages: [number, string | null][] } {
  const versions: [number, string | null][] = []
  if (input.expectedVersions) {
    if (input.expectedVersion !== undefined || input.replaceExistingPages || Object.keys(input.expectedVersions).length !== input.pages.length) return { ok: false, statusCode: 400, message: '批量页版本必须精确对应实际目标页' }
    for (const page of input.pages) {
      const expected = input.expectedVersions[page.page]
      if (expected === undefined || !validOcrExpectedVersion(expected)) return { ok: false, statusCode: 400, message: '缺少目标页版本' }
      versions.push([page.page, expected])
    }
  }
  if (input.expectedVersion !== undefined) {
    if (input.pages.length !== 1 || input.replaceExistingPages) return { ok: false, statusCode: 400, message: 'expectedVersion 只用于显式单页写入' }
    versions.push([input.pages[0]!.page, input.expectedVersion])
  }
  return { ok: true, pages: versions }
}

/** 一行结果(投影成给人看/给 tool 用的形状)。 */
export interface OcrResultRow {
  /** 旧客户端可在本地构造无版本的临时行;所有服务端读回均带版本。 */
  version?: string
  historicalBinding?: { status: 'unknown' } | { status: 'captured'; input: NonNullable<OcrPageWrite['capture']> }
  page: number
  markdown: string
  pageRelPath: string | null
  engine: string
  model: string | null
  channel: string
  createdAt: string
}

export function ocrHistoricalBinding(provenance: {
  revision?: { capture?: number; channel?: string; markdown?: string }
  capture?: { markdown?: string; input?: OcrPageWrite['capture'] }
} | null, markdown: string): NonNullable<OcrResultRow['historicalBinding']> {
  const revision = provenance?.revision
  const capture = Number.isInteger(revision?.capture) ? provenance?.capture : null
  if (revision?.channel === 'api' && revision.markdown === markdown && capture?.markdown === markdown
    && capture.input?.taskId && /^[a-f0-9]{64}$/i.test(capture.input.sourceSha256 ?? '')) {
    return { status: 'captured', input: capture.input }
  }
  return { status: 'unknown' }
}

/** 取某文件的 OCR 结果;**给了 `pageNo` 就只取那一页**。按页号升序。 */

export function formatOcrMarkdown(
  rows: readonly OcrResultRow[], fileId: number, pageNo?: number | null,
): { ok: true; markdown: string; pages: number[] } | { ok: false; message: string } {
  if (!rows.length) {
    return {
      ok: false,
      message:
        pageNo === undefined || pageNo === null
          ? `这个文件还没有 OCR 结果(file_id=${fileId})。先走一条通路:POST /api/jobs {kind:"ocr"} / POST /api/ocr-results / MCP save_ocr_result。`
          : `第 ${pageNo} 页还没有 OCR 结果(file_id=${fileId})。`,
    }
  }
  const pages: OcrPage[] = rows.map((r) => ({ page: r.page, markdown: r.markdown }))
  return { ok: true, markdown: assembleMarkdown(pages), pages: pages.map((p) => p.page) }
}

export function compareOcrPageVersion(page: number, current: string | null, expected: string | null) {
  return current === expected ? null : { ok: false as const, statusCode: 409, message: `OCR 第 ${page} 页版本冲突;请重新读取后再提交` }
}

export function validOcrExpectedVersion(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || (typeof value === 'string' && /^[1-9]\d*:[1-9]\d*$/.test(value) && value.length <= 64)
}
