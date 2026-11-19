/**
 * OCR 结果的 **markdown 契约**:页码怎么写、整份怎么拼、传进来的怎么切回按页。
 *
 * 纯规则、零依赖 —— 与 `lib/pdf-page.ts` 同一个分法(规则进 `lib/`,服务进 `server/utils/`)。
 * app 与 `../pipeline` **共用这一个文件**:pipeline 从 `../../app/lib/ocr-markdown` import,
 * 所以「什么算一个页码标记」只有一处定义,两边不会各认各的。
 *
 * ── 为什么 markdown 是首选产物 ──────────────────────────────────────────
 * 用户原话:识别率更高、**导出 markdown 便于处理**、**带页码好读取**。具体到本仓:
 *  - 页内表格在 markdown 里是**标准表格**(`| 序号 | 属地 | 企业名称 |`),pipeline 的
 *    段解析直接可切,不必重抠 `.docx` 的表格 XML(那条路已实测会丢整段);
 *  - 标题行(`### 附件1`)天然就是「按标题切段」的锚点;
 *  - 页码**写在文本里**,所以「入库(markdown 列)」与「导出(markdown 文件)」是同一份东西,
 *    导出的文件再传回来结果一模一样 —— 这正是通路 b(上传识别结果)成立的前提。
 *
 * ── 页码标记长什么样 ────────────────────────────────────────────────────
 *
 *     <!-- page: 3 -->
 *     正文…(这一页的 markdown)
 *
 * 选 HTML 注释而不是标题,有三个理由:
 *  1. **渲染时不可见** —— 人拿导出的 markdown 去别的工具里排版,不会被「第 3 页」这种
 *     我们自己造的标题割断;也**不占标题层级**(真正的 `### 附件1` 才是结构);
 *  2. **够显眼、不可能撞车** —— 正文里不会出现 `<!-- page: N -->`;而「第 3 页」这种
 *     纯文本,文件正文里是可能出现的(「见第 3 页」),拿它当分隔符会误切;
 *  3. **解析是确定的一行匹配**,正则一条,不需要词法。
 *
 * 但**上传的**结果不由我们生成:外部工具很可能写成 `## 第 3 页`。所以
 * `splitMarkdown` **两种都认**(`PAGE_HEADING_RE`),归一后一律按上面的规范形式处理 ——
 * 这叫「入口宽、出口窄」:宽容地读进来,规范地存下去。
 */

/** 一页 OCR 结果:页码 + 该页的 markdown。 */
export interface OcrPage {
  page: number
  markdown: string
}

/** 页码上限。97 页的 PDF 是实测最大;给到 2000 是挡「页号被人填成 99999」这类脏数据。 */
export const MAX_PAGE_NO = 2000

/** 规范页码标记(`<!-- page: 3 -->`)。 */
export function pageMarker(pageNo: number): string {
  return `<!-- page: ${pageNo} -->`
}

/** 规范标记的匹配(整行、大小写不敏感)。 */
export const PAGE_MARKER_RE = /^\s*<!--\s*page\s*:\s*(\d+)\s*-->\s*$/i

/**
 * **宽容**的第二形态:标题式的页码(`## 第 3 页`)。
 *
 * 只认「整行就是一个页码标题」——`### 第 3 页` 里除了页码不能有别的话,
 * 否则「第 3 页附表」这种正文标题也会被当成标记切下去。
 */
export const PAGE_HEADING_RE = /^\s{0,3}#{1,6}\s*第\s*(\d+)\s*页\s*$/

/** 上传通路失败时给的那句话(两条正则合起来说,免得调用方各写一份)。 */
export const PAGE_MARKER_HINT =
  '每页前面要有页码标记:规范形式 `<!-- page: 3 -->`(本仓导出的就是这种),' +
  '也接受 `## 第 3 页` 这样的标题。'

/**
 * 这是一行页码标记吗?是则给页号,不是给 `null`。
 *
 * 两种形态共用这一个入口 —— `splitMarkdown` 与 pipeline 的块解析都调它,
 * 「什么算标记」因此只有一处定义。
 */
export function pageNoOfMarker(line: string): number | null {
  const hit = PAGE_MARKER_RE.exec(line) ?? PAGE_HEADING_RE.exec(line)
  if (!hit) return null
  const n = Number(hit[1])
  return Number.isInteger(n) && n >= 1 && n <= MAX_PAGE_NO ? n : null
}

/**
 * 把一页拼成规范的文本段:**标记行 + 空行 + 正文**。
 *
 * 正文里的**行尾空白**与**结尾空行**去掉(它们在 markdown 里没有意义,留着只会让
 * 「导出的文件 == 再传回来的内容」这条一致性断言出现假差异)。
 */
export function formatPage(page: OcrPage): string {
  return `${pageMarker(page.page)}\n\n${normalizeMarkdownBody(page.markdown)}`
}

/**
 * 整份 markdown(导出的默认形态):**按页号升序**,页间空一行。
 *
 * 排序而不是按传入顺序:库里的行是按 `page_no` 查出来的,但拼装这一步不该假设调用方
 * 排过序 —— 顺序错了,导出的文件就与「再传回来」的结果不一致(而通路 b 正是靠这条)。
 */
export function assembleMarkdown(pages: readonly OcrPage[]): string {
  return [...pages]
    .sort((a, b) => a.page - b.page)
    .map(formatPage)
    .join('\n\n')
}

/**
 * 正文的**归一**:统一换行、去掉每行行尾空白与首尾空行。
 *
 * 导出与导入都走它,所以「导出的文件再传回来」逐字节相同 —— 若只有一侧归一回,
 * 那条闭环就会出现「只是空白不一样」的假差异,让人怀疑是不是真丢内容了。
 *
 * **不改行内空白** —— markdown 表格的对齐空格是要留着的(它影响渲染时的列宽)。
 */
export function normalizeMarkdownBody(markdown: string | null | undefined): string {
  return String(markdown ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '')
}

/** 切分结果:成功给**按页升序**的页,失败给一句中文原因(路由/tool 直接当文案)。 */
export type SplitResult =
  | { ok: true; pages: OcrPage[] }
  | { ok: false; message: string }

/**
 * 把一份(带页码的)markdown 切回按页 —— **通路 b(上传)的入口**。
 *
 * 规则:
 *  - 只在**整行**的标记处切(`pageNoOfMarker`);
 *  - 标记**之前**有正文 ⇒ 报错:那段文字属于哪一页无从判断,猜一个页号就是「错误值」,
 *    与 SPEC 的「空值优于错误值」相悖,不如让人把标记补上;
 *  - 页号重复、越界 ⇒ 报错(重复会让「同页一行」的唯一索引抛底层错误,不如在这里说人话);
 *  - 页号**乱序** ⇒ 报错(见下);
 *  - **空页也保留**(正文为空串):页号必须与源 PDF 逐页对应,丢掉空页就断号,
 *    而「按 page_no 回填页码」正是靠这个号。
 *
 * ── 为什么乱序要报错,而不是「反正是按页挂的,排一下就好」─────────────────
 * 因为**页内正文的顺序是文件里的物理顺序**,不是页号顺序。
 * `assembleMarkdown` 导出时按页号升序重排 —— 于是「第 2 页的标记写在第 1 页之前」
 * 这样一份输入会被入库成 `{1: 甲, 2: 乙}`,导出时却变回文件里的「2 在前」。
 * 更坏的一层:下游按页号升序摊平块(见 `pipeline/src/ocr-markdown.ts`),
 * 于是**甲会被标成第 1 页**,而它明明是第 2 页 —— 页码是这票唯一要保住的东西,
 * 静默接受乱序等于让它无声地错。
 *
 * 不自动重排的理由:重排等于替调用方**猜**页序。一份真的乱序的文件往往是导出工具
 * 出了问题,报出来让人看一眼,比我们悄悄改一遍更有用。
 */
export function splitMarkdown(text: string): SplitResult {
  const lines = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')

  const pages: OcrPage[] = []
  let current: { page: number; body: string[] } | null = null
  const preamble: string[] = []

  for (const line of lines) {
    const pageNo = pageNoOfMarker(line)
    if (pageNo === null) {
      if (current) current.body.push(line)
      else preamble.push(line)
      continue
    }
    if (current) pages.push({ page: current.page, markdown: normalizeMarkdownBody(current.body.join('\n')) })
    current = { page: pageNo, body: [] }
  }
  if (current) pages.push({ page: current.page, markdown: normalizeMarkdownBody(current.body.join('\n')) })

  if (!pages.length) {
    return { ok: false, message: `这份 markdown 里没有页码标记。${PAGE_MARKER_HINT}` }
  }
  if (preamble.join('\n').trim()) {
    return {
      ok: false,
      message:
        '第一个页码标记**之前**还有正文,无法判断它属于哪一页。' +
        `把那段文字挪到对应的页码标记之下(或在最前面补一个页码标记)。${PAGE_MARKER_HINT}`,
    }
  }

  const seen = new Set<number>()
  for (let i = 0; i < pages.length; i += 1) {
    const p = pages[i]!
    if (seen.has(p.page)) return { ok: false, message: `页码重复:第 ${p.page} 页出现了两次` }
    seen.add(p.page)
    // 乱序:标记出现的次序必须是页号递增的。理由见上面的函数说明。
    if (i > 0 && p.page < pages[i - 1]!.page) {
      return {
        ok: false,
        message:
          `页码乱序:第 ${p.page} 页的标记出现在第 ${pages[i - 1]!.page} 页之后。` +
          '导出文件一律按页号升序(`<!-- page: 1 -->` 在最前),乱序多半是导出工具出了问题;' +
          '**不自动重排** —— 重排会替调用方猜页序,而页序错了页码就全错。请把标记按页号排好再传。',
      }
    }
  }

  // 到这里顺序已是升序(乱序在上面就报错了),原样返回 —— 不再 sort,
  // 免得掩盖掉「输入本来就乱」这件事。
  return { ok: true, pages }
}
