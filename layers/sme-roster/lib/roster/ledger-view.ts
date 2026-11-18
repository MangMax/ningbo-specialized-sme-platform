/**
 * **企业列表页的筛选状态与 URL 映射**(RL-20 重写;原为 RL-17 的「三视图合并台账」)。
 *
 * ── 这一票把「三种分组」删掉了 ───────────────────────────────────────────
 * 用户原话:「**只要一个表格**」。原先 `/` 一个入口下按 `view` 切三种分组
 * (按企业 / 按企业×称号 / 差异与原因),每种分组用到的筛选还不一样 —— 于是这个模块
 * 里最早长出来的是 `LEDGER_VIEW_FILTERS`(每视图认哪些筛选)与 `filtersForView`(切视图时
 * 清掉用不到的)。这些**随三视图一起去掉**:现在只有一个企业粒度的表,筛选集合也只有一份。
 *
 * 留下的两条不变量,理由不变:
 *
 *  1. **「筛选与导出同口径」** —— 导出地址与列表请求**读同一个对象**。两处各拼一遍参数,
 *     迟早有一边漏掉新加的项,而漏掉的表现是**导出多出几行**,没人会在页面上发现。
 *  2. **「没有静默筛选」** —— 地址栏里带着、页面上却看不见的条件,用户既不知道它在生效,
 *     也清不掉。所以状态里认的每一项,要么是筛选条上的控件,要么是筛选条下面那排可撤掉的
 *     条件 chip(`source` / `eventType` / `rosterState` 走后者:它们是 `/stats`
 *     下钻带进来的,不给常驻控件,但**绝不静默丢弃**)。
 */
import { parseCsvQuery } from '../../../core/lib/csv'
import {
  DEFAULT_ROSTER_ENTERPRISE_SORT,
  ROSTER_ENTERPRISE_SORTS,
} from './ledger-contract'
import type { RosterEnterpriseSort } from './ledger-contract'

/** 排序的地址栏参数名(`sort`),以及默认值 —— 默认值不写进地址栏。 */
export const SORT_PARAM = 'sort'
export const DEFAULT_SORT: RosterEnterpriseSort = DEFAULT_ROSTER_ENTERPRISE_SORT

/** 页面上的筛选状态。字符串数组一律是「多值」,空数组 = 没筛。 */
export interface LedgerState {
  q: string
  title: string[]
  district: string
  /** 总表成员状态(派生)。`/stats` 下钻会带,页面上只以 chip 出现。 */
  rosterState: string
  source: string[]
  eventType: string[]
  year: string[]
  /** 首次正式认定年份(RL-08),与事件年份 `year` 分开保留。 */
  firstYear: string[]
  /** 首次认定状态(RL-08):confirmed / pending。 */
  firstStatus: string[]
  /** 差异状态(RL-20);`none` 表示「一条差异记录都没有」。 */
  diffStatus: string[]
  /** 排序(RL-20)。 */
  sort: RosterEnterpriseSort
}

export const EMPTY_LEDGER_STATE: LedgerState = {
  q: '',
  title: [],
  district: '',
  rosterState: '',
  source: [],
  eventType: [],
  year: [],
  firstYear: [],
  firstStatus: [],
  diffStatus: [],
  sort: DEFAULT_SORT,
}

/**
 * 页面认的全部筛选键 —— 取数、回写地址、chip 三处**只认这一张表**。
 *
 * `sort` 不在其中:它是**显示偏好**(排法),不是筛选,所以取数时单独拼、地址栏里
 * 只在非默认时才写(与 `pageSize` 同一档)。
 */
export const LEDGER_FILTER_KEYS = [
  'q',
  'title',
  'source',
  'eventType',
  'year',
  'firstYear',
  'firstStatus',
  'district',
  'rosterState',
  'diffStatus',
] as const satisfies readonly (keyof LedgerState)[]

/** 多值键(逗号分隔)。其余是单值。 */
export const LEDGER_MULTI_KEYS = ['title', 'source', 'eventType', 'year', 'firstYear', 'firstStatus', 'diffStatus'] as const

/** 从地址栏读回筛选状态(刷新、分享、前进后退都靠它)。 */
export function ledgerStateFromQuery(query: Record<string, unknown>): LedgerState {
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const csv = (v: unknown) => parseCsvQuery(v) ?? []
  return {
    q: str(query.q),
    title: csv(query.title),
    district: str(query.district),
    rosterState: str(query.rosterState),
    source: csv(query.source),
    eventType: csv(query.eventType),
    year: csv(query.year),
    firstYear: csv(query.firstYear),
    firstStatus: csv(query.firstStatus),
    diffStatus: csv(query.diffStatus),
    // 认不出的排序**退回默认**,不让它进请求。这一层是「地址栏 → 页面状态」:
    // 一个手改坏的 `?sort=…` 该把页面照常渲染出来,不该把整页打成错误;
    // 读接口那一侧仍然对未知取值给 400(`parseRosterEnterpriseQuery`),那是给
    // 程序调用者的守卫,不是给地址栏的。
    sort: sortOf(query[SORT_PARAM]),
  }
}

function sortOf(value: unknown): RosterEnterpriseSort {
  const raw = typeof value === 'string' ? value.trim() : ''
  return (ROSTER_ENTERPRISE_SORTS as readonly string[]).includes(raw)
    ? (raw as RosterEnterpriseSort)
    : DEFAULT_SORT
}

/** 「没筛」的项不写进地址;多值用逗号分隔(与全部读接口的 `parseCsvQuery` 一致)。 */
export function ledgerQueryFromState(state: LedgerState): Record<string, string> {
  const p: Record<string, string> = {}
  for (const key of LEDGER_FILTER_KEYS) {
    const value = state[key]
    if (Array.isArray(value)) {
      if (value.length) p[key] = value.join(',')
    } else if (value) {
      p[key] = value
    }
  }
  if (state.sort !== DEFAULT_SORT) p[SORT_PARAM] = state.sort
  return p
}

/** 列表请求的查询串。`page` / `pageSize` 由调用方补(它们是显示偏好,不是筛选)。 */
export function ledgerListQuery(state: LedgerState): Record<string, string> {
  return ledgerQueryFromState(state)
}

/**
 * 导出地址 —— 与列表**同源**。
 *
 * 不带分页:导的是**当前筛选下的全部**,页面只显示一页;把 `page` / `pageSize` 带上
 * 只会让「导出 = 你看到的全部」这句话不成立。
 *
 * 排序也一并带走:同一批筛选、两种排法导出来的行集合相同,但顺序不同,
 * 用户在页面上按认定年看、导出却是另一种序,会以为导错了。
 */
export function ledgerExportUrl(state: LedgerState): string {
  const p = new URLSearchParams(ledgerQueryFromState(state))
  const s = p.toString()
  return s ? `/api/roster/export?${s}` : '/api/roster/export'
}

/** 导出按钮上的文案:**写清粒度与格式**,免得把「企业」当成「企业×称号」。 */
export const LEDGER_EXPORT_LABEL = '导出当前筛选(企业,xlsx)'

/** 年份来自实际事件统计；分享链接中已选年份在统计加载期间仍可见。 */
export function ledgerYearOptions(years: readonly string[], selected: readonly string[] = []) {
  return [...new Set([...years, ...selected])]
    .filter(year => /^\d{4}$/.test(year))
    .sort((a, b) => Number(b) - Number(a))
    .map(value => ({ value, label: value }))
}
