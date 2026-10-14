/**
 * 附件名归一(票 17)。**纯函数**,无副作用。
 *
 * 为什么需要它:段的粒度是 `(称号, 事件, 年份, 批次, **附件**)`,而附件名在源文件里
 * **写法不一** —— 实测同一批文件里出现过「附件」「附 件 1」「附件1」「附件2」四种写法
 * (空格位置、有无编号都不统一,见 `.scratch/ingest-pipeline/issues/17-file-parts.md`)。
 * 不归一的话,同一份文件里「附 件 1」与「附件1」会被当成两个不同的附件,
 * 段的去重与「按附件归组」都会失效。
 *
 * 归一后的形状只有两种:**`附件`**(源里就没写编号)与 **`附件N`**(写了编号,N 为阿拉伯数字)。
 * 「附件」**不**补成「附件1」—— 源里没有编号,补一个编号就是**造值**,与
 * 「空值优于错误值」(data-integrity SPEC 的安全阀)相悖。145号 就是例子:它只有一个
 * 附件、源里就写「附件」,里面并置了 2021 与 2022 两段名单。
 *
 * 认不出的写法(既不是「附件」也不是「附件N」)**原样保留去掉空白后的文本** ——
 * 不丢信息,也不硬套一个形状。
 */

/**
 * 中文数字 → 阿拉伯数字。只覆盖附件编号可能出现的范围(一 ~ 九十九),
 * 覆盖不到的一律回退原字串(不猜)。
 */
const CN_DIGIT: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
}

/** 把 `一` `十` `十一` `二十` `二十三` 这类中文数字读成阿拉伯数字;读不出返回 null。 */
function cnNumber(text: string): number | null {
  if (!/^[一二三四五六七八九十]+$/.test(text)) return null
  if (text === '十') return 10
  // 十X → 1X
  if (text.startsWith('十')) {
    const rest = CN_DIGIT[text.slice(1)]
    return rest == null ? null : 10 + rest
  }
  // X十 / X十Y → X0 / XY
  const tenIdx = text.indexOf('十')
  if (tenIdx > 0) {
    const tens = CN_DIGIT[text.slice(0, tenIdx)]
    if (tens == null) return null
    const ones = text.slice(tenIdx + 1)
    if (!ones) return tens * 10
    const last = CN_DIGIT[ones]
    return last == null ? null : tens * 10 + last
  }
  return CN_DIGIT[text] ?? null
}

/**
 * 附件名归一。
 *
 * ```
 * 「附件」      → 「附件」
 * 「附 件 1」   → 「附件1」     ← 空格位置不一是实测出现最多的毛病
 * 「附件1」     → 「附件1」
 * 「附件2」     → 「附件2」
 * 「附件一」    → 「附件1」     ← 中文数字一律读成阿拉伯数字
 * 「附件０１」  → 「附件1」     ← 全角数字与前置零一并收掉
 * ```
 *
 * 空值 / 全空白 → `null`(用 null 表示「没有附件」,不用空串 —— 两者在库里语义不同)。
 * **幂等**:对已归一的文本再跑一遍,结果不变。
 */
export function normalizeAttachment(raw: string | null | undefined): string | null {
  if (raw == null) return null

  const compact = String(raw)
    // 全角数字 → 半角,再一并去掉所有空白(含全角空格 　)。
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, '')

  if (!compact) return null
  if (compact === '附件') return '附件'

  const arabic = compact.match(/^附件(\d+)$/)
  if (arabic) return `附件${Number(arabic[1])}`

  const chinese = compact.match(/^附件(.+)$/)
  if (chinese?.[1]) {
    const n = cnNumber(chinese[1])
    if (n != null) return `附件${n}`
  }

  // 认不出的写法:去掉空白后原样保留,不猜、不丢。
  return compact
}
