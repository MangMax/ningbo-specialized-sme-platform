/**
 * 平台快照读接口的**查询参数解析**(纯函数,不碰 h3)。
 *
 * 与 `server/utils/api-guard.ts` 同一个分法:判据留成可单测的纯函数,
 * 贴到路由上的那一层只负责把「非法」翻成 400。
 */

/** 把查询参数解析成**正整数列表**(逗号分隔 / 重复参数都认)。 */
export function parseIntegerList(raw: unknown): { values: number[] | undefined; invalid: string[] } {
  const items = toList(raw)
  if (!items) return { values: undefined, invalid: [] }
  const values: number[] = []
  const invalid: string[] = []
  for (const item of items) {
    const n = Number(item)
    if (Number.isInteger(n) && n > 0) values.push(n)
    else invalid.push(item)
  }
  return { values, invalid }
}

/** 单个正整数参数(如批号);不是正整数返回 null。 */
export function parsePositiveInt(raw: unknown): number | null {
  const text = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : ''
  if (!/^\d+$/.test(text)) return null
  const n = Number(text)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** 字符串列表(称号等):逗号分隔 / 重复参数,空项剔除;无有效项返回 undefined。 */
export function toList(raw: unknown): string[] | undefined {
  if (raw === null || raw === undefined) return undefined
  const parts = Array.isArray(raw) ? raw.flatMap((x) => String(x).split(',')) : String(raw).split(',')
  const list = parts.map((s) => s.trim()).filter(Boolean)
  return list.length ? list : undefined
}
