/**
 * 平台取数时间的**纯函数**(票 16 UI 收口 B1)。
 *
 * 为什么单独一个文件:`lib/reconcile.ts` 顶部 import 了 `node:fs`,是**服务端**模块
 * (读缓存文件)。页面与行内徽章要在**浏览器**里用「取数时间」,一旦从那个文件里取
 * 运行时的值,node 内建就会被拖进客户端包 —— 实测直接 500
 * (`__vite-browser-external:node:fs` 没有 `existsSync`)。所以纯格式化逻辑放这里,
 * 两端共用**同一份实现**,而不是各写一遍。
 */

/** 解释条目里与时间有关的部分(只依赖 `fetchedAt`,便于两端复用与测试)。 */
export interface FetchTimeEntry {
  fetchedAt?: string | null
}

/**
 * 这批解释里**最近一次真实取数**的时间;一条都没有(全部未查询 / 没有 `fetchedAt`)
 * 就返回 `null`。
 *
 * 这是页脚与行内 tooltip **共用的唯一时间来源** —— 都用行自己的 `fetchedAt`
 * (平台请求回来的时刻),**不用**文件级的 `generatedAt`(那是「缓存文件何时写出」,
 * 与「这家企业何时取的数」不是一回事,两者并排显示会互相矛盾)。
 *
 * **样本/离线缓存同样走这条规则**:样本条目若没有 `fetchedAt`,这里就是 `null`,
 * 页面**不会**凭空显示一个取数日期。
 */
export function platformFetchTime(
  entries: (FetchTimeEntry | null | undefined)[],
): string | null {
  let latest: number | null = null
  let raw: string | null = null
  for (const entry of entries) {
    const at = entry?.fetchedAt
    if (!at) continue
    const time = new Date(at).getTime()
    if (Number.isNaN(time)) continue
    if (latest === null || time > latest) {
      latest = time
      raw = at
    }
  }
  return raw
}

/**
 * 取数时间的展示格式(**页脚与 tooltip 共用**,保证同一时刻在两处字面一致)。
 * 非法/缺失一律返回 `null` —— 不显示半截时间,也不显示 `Invalid Date`。
 */
export function formatFetchTime(at: string | null | undefined): string | null {
  if (!at) return null
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return null
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

/** 页脚用:这批行的最近取数时间(格式化后);没有就是 `null`,页面据此不写日期。 */
export function latestFetchLabel(entries: (FetchTimeEntry | null | undefined)[]): string | null {
  return formatFetchTime(platformFetchTime(entries))
}
