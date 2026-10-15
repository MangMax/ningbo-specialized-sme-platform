import type { OcrResultRow } from '~~/server/utils/ocr-result'
import type { PageImageRef } from '~~/server/utils/pdf-pages'
import { normalizeMarkdownBody } from './ocr-markdown'

/**
 * OCR 清理工作台的**展示与校验规则**(纯函数,零依赖)。
 *
 * 与 `lib/page-gallery.ts`、`lib/ocr-markdown.ts` 同一个分法:**事实在服务端**
 * (`ocr_result` 表 + 票 13 的页图清单),**样式在组件里**,这里是两者之间的翻译。
 * 放 `lib/` 是为了能被单测钉住 —— 「第几页对第几页」这件事错一次就是整份结果的页码错,
 * 不能靠「打开页面看一眼」来验。
 *
 * ── 一条硬规则:页码只来自**文件页码 / 页图清单**,不从 OCR 正文里读 ──────────
 * 工作台的每一行都由「这份 PDF 的第 N 页」(源页数,或票 13 清单里的页号)确定,
 * OCR 结果只是**挂**在这个页号上。反过来做(从正文里找「第 N 页」)一旦认错,
 * 错的是一个**看起来确定**的页码 —— 而下游 pipeline 正是按 `page_no` 给
 * `record_evidence` 补页码的,错了不会报错,只会静默写错出处。
 *
 * 这与 `lib/ocr-markdown.ts` 的取舍是同一条:那里对「标记之前有正文」「页码乱序」
 * 一律报错而不是猜,理由也是「猜出来的页码比没有更坏」。
 */

/** 工作台的一行 = 一页。行由**页码**确定,页图与 OCR 结果都是挂在上面的。 */
export interface WorkbenchRow {
  /** 页号,从 1 起。行号即页码 —— 界面上不再另算一次。 */
  page: number
  /** 票 13 渲染出来的页图;没渲染过(或那一页缺图)时为 null。 */
  image: PageImageRef | null
  /** 这一页已有的 OCR 结果;没识别过时为 null。 */
  result: OcrResultRow | null
}

/**
 * 把「这份文件有哪些页」「已渲染的页图」「已有的 OCR 结果」三份数据合成行。
 *
 * 三者的**并集**按页号升序 —— 不是交集。理由:
 *  - 只渲染了一半也该能逐页校对(没图的那几页仍然可以贴/改文本);
 *  - 库里有一页 OCR 结果但页图还没渲染(或页图被清过)时,**那一页必须照常出现**,
 *    否则界面会把已有的数据藏起来 —— 而「藏着」在这类校对工具里是最坏的一种错;
 *  - `pageCount` 读不出来(源 PDF 损坏/被移走)时给 null:那时只按已存在的页图上界
 *    铺行,不编一个总页数出来。
 */
export function buildWorkbenchRows(input: {
  /** 源 PDF 的页数;读不出来时为 null。 */
  pageCount: number | null
  /** 票 13 清单里的页图(按页号升序,调用方保证;这里再排一次也不贵)。 */
  images: readonly PageImageRef[]
  /** `ocr_result` 里这个文件的行。 */
  results: readonly OcrResultRow[]
}): WorkbenchRow[] {
  const imageByPage = new Map<number, PageImageRef>()
  for (const image of input.images) imageByPage.set(image.page, image)
  const resultByPage = new Map<number, OcrResultRow>()
  for (const result of input.results) resultByPage.set(result.page, result)

  const pages = new Set<number>(imageByPage.keys())
  for (const page of resultByPage.keys()) pages.add(page)
  if (input.pageCount !== null && input.pageCount > 0) {
    for (let page = 1; page <= input.pageCount; page += 1) pages.add(page)
  }

  return [...pages]
    .sort((a, b) => a - b)
    .map((page) => ({
      page,
      image: imageByPage.get(page) ?? null,
      result: resultByPage.get(page) ?? null,
    }))
}

/**
 * 一行（一页）的**校对状态**。三档，不是两档 —— 独立评审指出：
 * 「空结果」原先和「有文本」共用一个「已识别」徽章，徽章与它紧挨着的正文互相拆台
 * （写着「已识别」，正文却是「(空结果)」），而文件条的计数也把空结果算进了「已识别」，
 * 于是那个数字不再等于「有文本的页数」——用户按它判断进度会判断错。
 *
 * 三档对应三种**线型**（与 DESIGN.md 的「靠线型与线重分档、不靠颜色」同一套语汇）：
 *  `text` 实线加粗（已成立）· `empty` 次级实线（要留意但不是错）· `none` 虚线（还没坐实）。
 */
export type PageReviewState = 'text' | 'empty' | 'none'

/** 这一页属于哪一档。未识别（`result` 为 null）与「识别出来是空的」是两件事。 */
export function pageReviewState(result: { markdown: string } | null): PageReviewState {
  if (!result) return 'none'
  return result.markdown.trim() === '' ? 'empty' : 'text'
}

/** 一份文件的逐页校对计数。三项之和 == `rows.length`。 */
export interface WorkbenchCounts {
  /** 有文本的页数。 */
  text: number
  /** 识别出来是空的页数（页号仍占着）。 */
  empty: number
  /** 还没做（待校对）的页数 —— 这是这一页唯一要用户去动的数字。 */
  none: number
}

/** 按**页码**数一遍三档。数的是行（页面实际列出的页），不是库里的行数。 */
export function workbenchCounts(rows: readonly WorkbenchRow[]): WorkbenchCounts {
  const counts: WorkbenchCounts = { text: 0, empty: 0, none: 0 }
  for (const row of rows) counts[pageReviewState(row.result)] += 1
  return counts
}

/**
 * 「待校对」这一档的写法。它是文件条上唯一要用户**去动**的数字，所以单列一个入口；
 * 「有文本 / 空结果」是陈述，跟在它后面用次级文字说。
 *
 * 分母用 `rows.length`（这份文件一共几页），而不是别的什么 —— 「待校对 2 页」配上
 * 「共 12 页」才是用户要回答的那个问题。
 */
export function pendingLabel(counts: WorkbenchCounts): string {
  return `待校对 ${counts.none} 页`
}

/** 「有文本 / 空结果」的陈述写法。空结果为 0 时不出现（少一个恒为 0 的词）。 */
export function reviewBreakdown(counts: WorkbenchCounts): string {
  return counts.empty > 0
    ? `有文本 ${counts.text} · 空结果 ${counts.empty}`
    : `有文本 ${counts.text}`
}

/** 写入之后**读回来核对**提交的那一页。
 *
 * 「读回确认」不是仪式:`writeOcrResult` 的 `raw` 保留语义、`markdown` 的归一
 * (`lib/ocr-markdown.ts` 的 `normalizeMarkdownBody` 会去掉行尾空白与首尾空行)都可能让
 * **落库的文本与提交的文本不完全相同**。把这件事当场说清楚(归一不算失败),
 * 比让人事后对着两份文本猜「是不是没写进去」有用得多。
 *
 * 判据用**归一后**比较,与落库那一层同一份规则 —— 两处各写一份迟早会漂。
 */
export function confirmWrittenPage(
  submitted: string,
  readBack: string | null,
): { ok: boolean; message: string } {
  if (readBack === null) {
    return { ok: false, message: '读回时这一页没有结果 —— 写入可能没落库,请重试一次。' }
  }
  const same = normalizeMarkdownBody(submitted) === normalizeMarkdownBody(readBack)
  return same
    ? { ok: true, message: '已写入并读回一致。' }
    : {
        ok: false,
        message: '读回的文本与提交的不一致(可能被别的会话改过)。请刷新后重新核对这一页。',
      }
}

// ---------------------------------------------------------------------------
// 导入的页码护栏
// ---------------------------------------------------------------------------

/**
 * 导入页数与文件页数的核对结果。
 *
 * `warning` 与 `ok: false` 是**两件不同的事**,照 `server/utils/jobs/ocr.ts` 的分法:
 *  - **源页数对不上 ⇒ 拒绝**(`ok: false`)。整份 JSONL 的页号来自**行序**
 *    (`pagesFromJsonl` 的「第 i 段就是第 i 页」),行数与源页数不一致说明这份结果
 *    不是这份文件跑出来的(或文件被截断/换过)—— 那时按 1..N 落库得到的是一批
 *    **看起来确定却错的**页码,而下游会拿它去补 `record_evidence.page`。
 *    这正是不采信、不写入的情形。
 *  - **页图数对不上 ⇒ 只记一行警告**。页图是**可有可无的派生缓存**:只渲染了前 3 页
 *    也该允许把整份结果导进来(否则用户得先渲染完所有页才能干活)。所以它降级为提示,
 *    与 `jobs/ocr.ts` 里 `renderedPageCount` 的取舍一致。
 */
export type ImportGuard = { ok: true; warning: string | null } | { ok: false; message: string }

/** 导入的页数与「这份文件到底是几页」的核对。 */
export function guardImportedPageCount(input: {
  /** 这次要写进去的页数(JSONL 的行数 / 切出的页数)。 */
  imported: number
  /** 源 PDF 的页数;读不出来时为 null。 */
  pageCount: number | null
  /** 票 13 已渲染的页图数;没渲染过是 0,探测不出是 null。 */
  rendered: number | null
}): ImportGuard {
  if (input.imported <= 0) {
    return { ok: false, message: '这份结果里一页都没有(没有任何可写入的页)。' }
  }
  if (input.pageCount === null || input.pageCount <= 0) {
    // 读不出源页数就**没法核对页码**,而页码正是这次导入唯一要保住的东西。
    // 与「空值优于错误值」一致:宁可不导,也不写一批无从核对的页号。
    return {
      ok: false,
      message:
        '读不出这份 PDF 的页数(文件可能已损坏或被移走),无法核对页码,因此不导入。' +
        '请先在「页图」里确认这份文件能正常打开。',
    }
  }
  if (input.imported !== input.pageCount) {
    return {
      ok: false,
      message:
        `这份结果有 ${input.imported} 页,而源 PDF 有 ${input.pageCount} 页 —— ` +
        '整份结果的页号按行序对齐(第 i 段就是第 i 页),行数对不上会让页码整体错位,' +
        '所以不写入。请确认结果是这份文件跑出来的;只识别了部分页时,请按页单独导入。',
    }
  }
  if (input.rendered !== null && input.rendered > 0 && input.rendered !== input.imported) {
    return {
      ok: true,
      warning:
        `页图数与结果页数不一致:已渲染 ${input.rendered} 张页图,这次写入 ${input.imported} 页。` +
        '页图是派生缓存(可能只渲染了一部分),不影响本次写入;若对不上,请确认源 PDF 是不是同一份。',
    }
  }
  return { ok: true, warning: null }
}

/**
 * 单页写入的目标页号核对(页号来自界面上的**页码**,不是从文本里读的)。
 *
 * 源页数读不出来时**不拦**:那时没有可核对的依据,而页号是调用方显式给的
 * (不给就没有这次写入),拦下来只会让人没法干活。读得出来才核对 —— 这是「能核对就核对」,
 * 不是「猜一个」。
 */
export function guardTargetPage(
  page: number,
  pageCount: number | null,
): { ok: true } | { ok: false; message: string } {
  if (!Number.isInteger(page) || page < 1) {
    return { ok: false, message: `页号必须是正整数:${String(page)}` }
  }
  if (pageCount !== null && pageCount > 0 && page > pageCount) {
    return {
      ok: false,
      message: `第 ${page} 页超出了这份 PDF 的页数(${pageCount} 页)—— 页号来自页图清单,不该越界。`,
    }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// 文案
// ---------------------------------------------------------------------------

/**
 * 导入入口的输入提示。**两条通路怎么给页号**在这里一次说清 ——
 * 用户最容易错的就是「整份结果当成一页贴进来」,而那种错写出来的页码是错的。
 *
 * 页数核对那句**不写在这里**:它在弹窗下方单独一行(`scopeHint`),带着这份文件
 * 的实际页数。两处都写就成了同一件事说两遍(独立评审点了这条)。
 */
export const JSONL_IMPORT_HINT =
  '用文本编辑器打开从 PaddleOCR 官网下载的结果文件,全选复制后粘到下面。' +
  '页号按行序对齐 —— 第 1 行是第 1 页,第 2 行是第 2 页。'

export const MARKDOWN_IMPORT_HINT =
  '整份结果要自带页码标记(`<!-- page: 1 -->`,也认 `## 第 1 页`);' +
  '只贴一页的正文时,请在下面填上它的页码。'
