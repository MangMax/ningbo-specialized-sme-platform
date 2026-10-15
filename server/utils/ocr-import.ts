import { normalizeMarkdownBody } from '../../lib/ocr-markdown'
import { OcrApiError, pagesFromJsonl } from './ocr-api'
import { pagesFromInput, type OcrPageWrite } from './ocr-result'

/**
 * **把「人手里的一份识别结果」翻成要写哪些页** —— 通路 b 在页面上的两种形态。
 *
 * 票 14 的路由只收一种输入:**带页码标记的整份 markdown**(人在官网导出的那份)。
 * 但人真正能从 PaddleOCR 官网拿到的东西是**结果 JSONL** —— 官方 SDK 的
 * `parse_doc_parsing_result` 读的就是它(`line.result.layoutParsingResults[].markdown.text`)。
 * 所以这里补的是「同一份产物、另一种装法」:JSONL 与 markdown 都收,页号都**不猜**。
 *
 * ── 两条输入的页号从哪来(这是本文件唯一真正的判断)─────────────────────
 *
 * | 输入 | 页号来源 | 核对方式 |
 * |---|---|---|
 * | `jsonl` | **行序**:第 i 段就是第 i 页(PaddleOCR 归档结果的既有对齐方式) | 行数与**源 PDF 页数**核对,对不上不写入(见 `lib/ocr-workbench.ts` 的 `guardImportedPageCount`) |
 * | `markdown` + `page` | **调用方显式给的页号**(界面上「第 N 页」那一栏) | `page` 与源页数核对(`guardTargetPage`) |
 * | `markdown` 无 `page` | **正文里的页标记**(`<!-- page: N -->`) | 由 `splitMarkdown` 自己报错:没标记、标记前有正文、重复、乱序 |
 *
 * 三种都不从**正文内容**里读页号。理由见 `lib/ocr-workbench.ts` 顶部:猜出来的页码
 * 是「看起来确定却错」的值,而下游正是按 `page_no` 给 `record_evidence` 补出处。
 *
 * ── 与 `pagesFromInput` 的分工 ───────────────────────────────────────────
 * 那个函数是**页号语义**的唯一出口(单页 / 整份),MCP 的 `save_ocr_result` 也用它。
 * 本文件只多两件事:JSONL 那一条输入,以及「两种输入二选一」这条路由级约束 ——
 * 不再自己判一遍页号,免得和它漂。
 */

/** 这次导入用的是哪种装法。响应里回给它,让调用方(与验收)知道走的是哪条。 */
export type OcrImportSource = 'jsonl' | 'markdown'

export type OcrImportDecode =
  | { ok: true; source: OcrImportSource; pages: OcrPageWrite[] }
  | { ok: false; message: string }

/**
 * 校验并解开导入体。**只做解码与页号语义**,不碰库、不碰磁盘 ——
 * 「这份结果与这份文件对不对得上」是调用方拿源页数去核对的
 * (`guardImportedPageCount` / `guardTargetPage`)。
 *
 * `jsonl` 与 `markdown` **恰给其一**:两个都给是两种页号语义打架(一个说按行序、
 * 一个说按标记),照单全收只会得到一份来路不明的页号,不如让人明确二选一。
 */
export function decodeOcrImport(body: {
  jsonl?: unknown
  markdown?: unknown
  /** 只在 `markdown` 那一条上有效:显式页号(表示这段正文就是那一页)。 */
  page?: unknown
}): OcrImportDecode {
  const hasJsonl = typeof body.jsonl === 'string' && body.jsonl.trim().length > 0
  const jsonlGiven = body.jsonl !== undefined && body.jsonl !== null && body.jsonl !== ''
  const markdownGiven = body.markdown !== undefined && body.markdown !== null

  if (hasJsonl && markdownGiven) {
    return {
      ok: false,
      message:
        '`jsonl` 与 `markdown` 只能给一个:两者对「页号从哪来」的说法不同' +
        '(JSONL 按行序,markdown 按页标记或显式 `page`),一起给会得到一份来路不明的页号。',
    }
  }

  if (jsonlGiven) {
    if (!hasJsonl) {
      // 空串与「给了一个非字符串」(如 `jsonl: 123`)是两件事,分开说 ——
      // 都回「不能是空字符串」会让人对着一个数字找空格。
      return typeof body.jsonl === 'string'
        ? { ok: false, message: '`jsonl` 不能是空字符串(它应当是结果文件的全文)。' }
        : { ok: false, message: '`jsonl` 必须是字符串(结果文件的全文)。' }
    }
    return decodeJsonl(body.jsonl as string)
  }

  if (!markdownGiven) {
    return { ok: false, message: '缺少内容:给 `markdown`(识别结果正文)或 `jsonl`(结果文件全文)。' }
  }
  if (typeof body.markdown !== 'string') {
    return { ok: false, message: '`markdown` 必须是字符串' }
  }

  // 页号交给 `pagesFromInput` 那一套(给 page = 单页;不给 = 按标记切整份)。
  const page = body.page === undefined || body.page === null || body.page === '' ? null : Number(body.page)
  if (page !== null && (!Number.isInteger(page) || page < 1)) {
    return { ok: false, message: `page 必须是正整数:${String(body.page)}` }
  }
  const parsed = pagesFromInput(body.markdown, page)
  if (!parsed.ok) return { ok: false, message: parsed.message }
  // 与落库的归一同一份规则(`normalizeMarkdownBody`)—— `pagesFromInput` 已经归一过一次,
  // 这里不再重复,只把类型收敛到写入用的形状。
  return { ok: true, source: 'markdown', pages: parsed.pages.map(toWrite) }
}

/** JSONL 那一条:`pagesFromJsonl` 决定行序 ↔ 页码,这里只负责把它翻成人话、做归一。 */
function decodeJsonl(text: string): OcrImportDecode {
  let pages: ReturnType<typeof pagesFromJsonl>
  try {
    pages = pagesFromJsonl(text)
  } catch (error) {
    // `pagesFromJsonl` 抛的是 `OcrApiError`,消息已经写得具体(第几行、缺哪个字段、
    // 形状是什么)。原样往上传 —— 它是排查这份结果为什么读不了的**唯一线索**。
    const message = error instanceof OcrApiError ? error.message : (error as Error).message
    return { ok: false, message: `结果文件读不出来:${message}` }
  }
  if (!pages.length) {
    return { ok: false, message: '结果文件里一页都没有(JSONL 里没有任何 layoutParsingResults 项)。' }
  }
  return {
    ok: true,
    source: 'jsonl',
    // 页号用 `pagesFromJsonl` 定好的那个(行序),**不在这里重新编号** ——
    // 重新编一遍等于把「第 i 段 == 第 i 页」这条对齐规则复制成第二处实现。
    //
    // `raw` **一并带上**:JSONL 里那一段 `layoutParsingResults` 项就是**原始响应**,
    // 与通路 a 落进 `raw` 的是同一个东西(`jobs/ocr.ts` 就是这么写的)。用户要的是
    // 「API 原始响应保留」—— 在导入这条入口上同样成立,别在这一层把它丢掉。
    pages: pages.map((p) => ({
      page: p.page,
      markdown: normalizeMarkdownBody(p.markdown),
      raw: p.raw,
    })),
  }
}

/** `OcrPage` → 写入用的形状(字段同名;分开只是为了让类型是 `OcrPageWrite`)。 */
function toWrite(page: { page: number; markdown: string }): OcrPageWrite {
  return { page: page.page, markdown: page.markdown }
}
