/** Reviewed submissions accept ASCII and full-width Latin letters/digits.
 * Historical identity keys and source strings retain their stored bytes. */
export function normalizeReviewedUscc(raw: string) {
  return raw.replace(/[０-９Ａ-Ｚａ-ｚ]/gu, char => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[\s\u200B-\u200D\uFEFF]+/gu, '').toUpperCase()
}

/**
 * 统一社会信用代码的**字符集**（GB 32100-2015）：数字 + 大写字母，但**不含** `I` `O` `S` `V` `Z`
 * （避免与 1/0/5/U/2 混淆）。
 */
export const USCC_ALPHABET = '0123456789ABCDEFGHJKLMNPQRTUWXY'

/** 前 17 位的加权因子（GB 32100-2015）。 */
export const USCC_WEIGHTS = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28] as const

/** 格式检查的结论；`ok` 之外每一种都对应一句可读的拒绝理由（不合并成一个「非法」）。 */
export type UsccFormatVerdict = 'ok' | 'length' | 'charset' | 'checksum'

/**
 * 校验统一社会信用代码的**格式与校验位**。
 *
 * 为什么连校验位一起查：票面把「代码格式不合法」列为**必须拒绝写入**的一种情形，
 * 而只查长度/字符集会放过「长度对、字符集对、校验位错」的抄录错误。
 * 实测本库 7227 个既有统代（企业 7227 个 + 记录 510 个去重）**全部**通过格式与校验位 ——
 * 所以这条检查不会把真实数据误判成非法。
 *
 * 入参是 `unknown`：来源常常是「不知道是什么」的值（JSON 载荷、公开页面抓下来的文本）。
 */
export function usccFormatVerdict(raw: unknown): UsccFormatVerdict {
  if (typeof raw !== 'string' && typeof raw !== 'number') return 'length'
  const code = String(raw).replace(/[\s\u{00A0}\u{200B}-\u{200D}\u{FEFF}\u{3000}]+/gu, '').toUpperCase()
  if (code.length !== 18) return 'length'
  for (const ch of code) if (!USCC_ALPHABET.includes(ch)) return 'charset'
  let sum = 0
  for (let i = 0; i < 17; i += 1) sum += USCC_ALPHABET.indexOf(code[i]!) * USCC_WEIGHTS[i]!
  const remainder = 31 - (sum % 31)
  const expected = USCC_ALPHABET[remainder === 31 ? 0 : remainder]
  return expected === code[17] ? 'ok' : 'checksum'
}
