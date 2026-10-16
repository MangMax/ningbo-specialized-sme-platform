/**
 * **合并台账的视图与筛选映射**(RL-17)—— 纯函数,可单测。
 *
 * 合并后 `/` 一个入口下有三种视图,共用一条筛选条:
 *
 *  - `enterprise` —— 按企业(RL-04):一行一家企业,展开见全部称号与出处;
 *  - `title`      —— 按企业×称号(原 `/` 台账:一行一个企业×称号,来源与事件列在行内);
 *  - `difference` —— 差异与原因(RL-04 §7.3)。
 *
 * ── 为什么把它抽出来 ───────────────────────────────────────────────────
 * 这一票最容易悄悄坏掉的是**两句话**,而它们都不是能靠肉眼盯住的:
 *
 *  1. 「筛选与导出同口径」—— 如果导出 URL 与列表请求各拼一遍参数,
 *     迟早有一边漏掉新加的 `source` / `eventType` / `year`,而漏掉的表现是
 *     **导出多出几行**,没人会在页面上发现。这里列表与导出**读同一个对象**。
 *  2. 「切换分组不换人」—— 两种分组共用同一个 URL,`按企业` 与 `按企业×称号`
 *     必须拿到同一批筛选。这里两个视图的查询由**同一份 state** 派生,
 *     记录侧判据(`source` / `eventType` / `year`)两边逐字一致。
 *
 * 页面只负责把 state 绑到控件上,不再自己拼参数。
 */
import { parseCsvQuery } from '../csv'

export const LEDGER_VIEWS = ['enterprise', 'title', 'difference'] as const
export type LedgerView = (typeof LEDGER_VIEWS)[number]

/** 默认视图 = 企业粒度(RL-04 的一企一行)。 */
export const DEFAULT_LEDGER_VIEW: LedgerView = 'enterprise'

/** 视图在地址栏里的参数名。 */
export const VIEW_PARAM = 'view'

export function parseLedgerView(value: unknown): LedgerView {
  const raw = typeof value === 'string' ? value.trim() : ''
  return (LEDGER_VIEWS as readonly string[]).includes(raw) ? (raw as LedgerView) : DEFAULT_LEDGER_VIEW
}

/** 页面上的筛选状态。字符串数组一律是「多值」,空数组 = 没筛。 */
export interface LedgerState {
  q: string
  title: string[]
  district: string
  rosterState: string
  source: string[]
  eventType: string[]
  year: string[]
  direction: string
  status: string[]
  reason: string[]
}

export const EMPTY_LEDGER_STATE: LedgerState = {
  q: '',
  title: [],
  district: '',
  rosterState: '',
  source: [],
  eventType: [],
  year: [],
  direction: '',
  status: [],
  reason: [],
}

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
    direction: str(query.direction),
    status: csv(query.status),
    reason: csv(query.reason),
  }
}

/**
 * **每个视图认哪些筛选项** —— 取数、回写地址、切换视图时清理,都只认这一张表。
 *
 * 为什么必须是一张表:这三件事以前各写一遍 `if (view === 'enterprise')` 分支,
 * 结果「切走时该清哪些」与「这一视图实际用哪些」必然漂移 —— 实测就漏了一项:
 * 切到「按企业×称号」时清了 `rosterState`,却把**该视图根本不发**的 `district` 留在
 * state 里,于是它是**看不见的**:地址栏里没有它、重置也清不掉,但切回「按企业」时
 * 会突然生效。
 *
 * 记录侧判据(`source` / `eventType` / `year`)在两种分组下**逐字一致** ——
 * 这是「切换分组不换人」的那一半,所以两个视图都列上,谁也不许只改一边。
 */
export const LEDGER_VIEW_FILTERS: Record<LedgerView, readonly (keyof LedgerState)[]> = {
  enterprise: ['q', 'title', 'source', 'eventType', 'year', 'district', 'rosterState'],
  title: ['q', 'title', 'source', 'eventType', 'year'],
  difference: ['q', 'title', 'direction', 'status', 'reason'],
}

/**
 * 「没筛」的项不写进地址;多值用逗号分隔(与全部读接口的 `parseCsvQuery` 一致)。
 */
export function ledgerQueryFromState(view: LedgerView, state: LedgerState): Record<string, string> {
  const p: Record<string, string> = {}
  if (view !== DEFAULT_LEDGER_VIEW) p[VIEW_PARAM] = view
  for (const key of LEDGER_VIEW_FILTERS[view]) {
    const value = state[key]
    if (Array.isArray(value)) {
      if (value.length) p[key] = value.join(',')
    } else if (value) {
      p[key] = value
    }
  }
  return p
}

/**
 * 切到某视图时,把**该视图用不到的**筛选清掉,其余原样留下。
 *
 * 清而不是留:留在 state 里的条件地址栏不体现,用户看不见、也清不掉,
 * 切回来却会生效 —— 那是静默筛选,和「失败 ≠ 无记录」是同一类错误。
 */
export function filtersForView(view: LedgerView, state: LedgerState): LedgerState {
  const keep = new Set<keyof LedgerState>(LEDGER_VIEW_FILTERS[view])
  const out = { ...EMPTY_LEDGER_STATE }
  for (const key of keep) {
    // 逐字段搬,`keep` 已按视图裁过,类型上仍是同一张表。
    ;(out as Record<string, unknown>)[key] = state[key]
  }
  return out
}

/**
 * 列表请求的查询串:直接喂给该视图的读接口。
 *
 * `pageSize` 由调用方补(它是「每页条数」这个显示偏好,不是筛选)。
 */
export function ledgerListQuery(
  view: LedgerView,
  state: LedgerState,
): Record<string, string> {
  return ledgerQueryFromState(view, state)
}

/**
 * 导出地址 —— 与列表**同源**。
 *
 * 不带分页:`/api/roster/export` 与 `/api/export` 导的都是**当前筛选下的全部**,
 * 页面只显示一页;把 `page` / `pageSize` 带上只会让「导出 = 你看到的全部」这句话不成立。
 *
 * `difference` 视图返回 `null`:RL-04 与既有台账都没有「导出差异」,
 * 这一票不新增导出面,所以宁可不给按钮,也不给一个口径说不清的导出。
 */
export function ledgerExportUrl(view: LedgerView, state: LedgerState): string | null {
  if (view === 'difference') return null
  const query = ledgerQueryFromState(view, state)
  // `view` 只是页面上的视图选择,导出端点靠**路径**区分粒度,不读它;
  // 带上只会让「导出参数 = 筛选参数」这句话不再逐字成立。
  delete query[VIEW_PARAM]
  const p = new URLSearchParams(query)
  const s = p.toString()
  const base = view === 'enterprise' ? '/api/roster/export' : '/api/export'
  return s ? `${base}?${s}` : base
}

/** 导出按钮上的文案:说明导的是哪个粒度,免得把「企业」当成「企业×称号」。 */
export function ledgerExportLabel(view: LedgerView): string {
  return view === 'title' ? '导出当前筛选(企业×称号)' : '导出当前筛选(企业,xlsx)'
}
