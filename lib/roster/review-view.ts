/**
 * 复核清单页的**状态 / 地址栏 / 导出地址**与展示文案(RL-09)—— 纯函数,可单测。
 *
 * 与 `lib/roster/ledger-view.ts` 同一分工:页面只负责把 state 绑到控件上,
 * 参数怎么拼、什么算「没筛」、导出与列表是不是同一个筛选,**只在这一处**决定。
 *
 * ── 为什么导出必须与列表同源 ─────────────────────────────────────────────
 * 票面 #9 的验收是「清单可导出,导出与页面筛选结果一致」。这句话靠对齐两次拼接是守不住的
 * (迟早一边多带一个参数,而多带的表现是**导出多几行**,页面上看不出来)。
 * 这里 `reviewListQuery` 与 `reviewExportUrl` 读**同一个** `state`,导出只是把
 * `page` / `pageSize` 去掉(导出的是当前筛选下的全部,不受分页截断)。
 *
 * ── 目标年份的两个边界 ───────────────────────────────────────────────────
 * 1. **默认值是「下一年」**(票面就叫「下一年度复核清单」),不是今年 ——
 *    清单是**提前一年**要办的事,默认给今年会把工作单指到已经过期的年份上。
 * 2. 年份可以超出下拉里的候选范围(深链、分享链接)。所以候选里**总是带上**
 *    当前 state 的那一年,免得地址栏里明明是 2030、控件上却显示成别的年份。
 */
import { parseCsvQuery } from '../csv'
import {
  REVIEW_PENDING_REASONS,
  REVIEW_PENDING_REASON_ORDER,
  REVIEW_STATUS_ORDER,
  TITLES,
  TITLE_ORDER,
} from '../labels'
import type { ReviewEvidence, ReviewPendingReason, ReviewStatus } from './review-list'

/** 地址栏参数名(与读接口的查询参数同名,不再翻译一次)。 */
export const YEAR_PARAM = 'year'
export const TITLE_PARAM = 'title'
export const STATUS_PARAM = 'status'
export const PAGE_PARAM = 'page'
export const PAGE_SIZE_PARAM = 'pageSize'

export const DEFAULT_REVIEW_PAGE_SIZE = 50
export const REVIEW_PAGE_SIZE_PRESETS = [25, 50, 100, 200]
export const MAX_REVIEW_PAGE_SIZE = 200

/** 页面状态。`year` 用字符串:它可能来自还没解析完的输入框。 */
export interface ReviewViewState {
  year: string
  title: string[]
  status: ReviewStatus
  page: number
  pageSize: number
}

/**
 * 默认目标年份 = **下一年**(今天 2026-10-16 ⇒ 2027)。
 * 传入 `now` 只为可测:不在用例里读系统时钟。
 */
export function defaultTargetYear(now: Date | number | string = new Date()): number {
  return new Date(now).getFullYear() + 1
}

/** 合法的目标年份:四位公历年。 */
export function parseYear(value: unknown): number | null {
  const raw = Array.isArray(value) ? value[0] : value
  const n = Number(typeof raw === 'string' ? raw.trim() : raw)
  return Number.isInteger(n) && n >= 1900 && n <= 2999 ? n : null
}

function positiveInt(value: unknown): number | null {
  const raw = Array.isArray(value) ? value[0] : value
  const n = Number(typeof raw === 'string' ? raw.trim() : raw)
  return Number.isInteger(n) && n >= 1 ? n : null
}

/** 从地址栏读回状态(刷新、分享、前进后退都靠它)。 */
export function reviewStateFromQuery(
  query: Record<string, unknown>,
  now: Date | number | string = new Date(),
): ReviewViewState {
  const year = parseYear(query[YEAR_PARAM]) ?? defaultTargetYear(now)
  // 多值参数一律走 `lib/csv.ts`(仓库里的唯一出处):逗号分隔与重复参数都认,
  // 空项剔除,一项不剩时是「没筛」。这里不再抄一遍 —— 抄的那份迟早和它分叉。
  const status = parseCsvQuery(query[STATUS_PARAM])?.[0]
  return {
    year: String(year),
    title: (parseCsvQuery(query[TITLE_PARAM]) ?? []).filter((t) => TITLE_ORDER.includes(t)),
    status: (REVIEW_STATUS_ORDER as readonly string[]).includes(status ?? '')
      ? (status as ReviewStatus)
      : 'due',
    page: positiveInt(query[PAGE_PARAM]) ?? 1,
    pageSize: Math.min(MAX_REVIEW_PAGE_SIZE, positiveInt(query[PAGE_SIZE_PARAM]) ?? DEFAULT_REVIEW_PAGE_SIZE),
  }
}

/**
 * 状态 → 查询参数。只写**有值**的东西,免得分享出一串空参数;
 * `due` 是默认分层,不写进地址(否则每个链接都拖着一个没用的 `status=due`)。
 */
export function reviewQueryFromState(state: ReviewViewState): Record<string, string> {
  const p: Record<string, string> = {}
  if (state.year) p[YEAR_PARAM] = state.year
  if (state.title.length) p[TITLE_PARAM] = state.title.join(',')
  if (state.status !== 'due') p[STATUS_PARAM] = state.status
  if (state.page > 1) p[PAGE_PARAM] = String(state.page)
  if (state.pageSize !== DEFAULT_REVIEW_PAGE_SIZE) p[PAGE_SIZE_PARAM] = String(state.pageSize)
  return p
}

/** 列表请求的查询串:直接喂给 `GET /api/roster/reviews`。 */
export function reviewListQuery(state: ReviewViewState): Record<string, string> {
  return reviewQueryFromState(state)
}

/**
 * 导出地址 —— 与列表**同源**。
 *
 * 不带分页(导的是当前筛选下的**全部**),且**一定带上 `status`** ——
 * 这一条是审核抓出来的:**接口把「没给 `status`」当成「两个工作表都写」**,
 * 所以列表在「到期清单」时若沿用「默认分层不写进地址」的规则导出,下载回来的文件里
 * 会**多出一个页面上根本没有的「待确认清单」工作表**,和「导出与页面筛选结果一致」正好相反。
 * 页面地址栏可以省掉默认值,导出地址不行。
 */
export function reviewExportUrl(state: ReviewViewState): string {
  const query: Record<string, string> = { ...reviewQueryFromState(state), [STATUS_PARAM]: state.status }
  delete query[PAGE_PARAM]
  delete query[PAGE_SIZE_PARAM]
  const s = new URLSearchParams(query).toString()
  return s ? `/api/roster/reviews/export?${s}` : '/api/roster/reviews/export'
}

/**
 * 目标年份下拉的候选:默认年所在的一段(±5 / +10),外加**当前 state 的那一年**
 * —— 深链到范围外的年份时,控件不会显示成另一个年份。
 *
 * 默认那一年(下一年)在候选里**标出「下一年」**:票面写的是「用户可选择『下一年』
 * 或指定年份」,而只列一串年份时,使用者得自己心算哪一年才是下一年。
 */
export function reviewYearOptions(
  current: string,
  now: Date | number | string = new Date(),
): { value: number; label: string }[] {
  const base = defaultTargetYear(now)
  const years = new Set<number>()
  for (let y = base - 5; y <= base + 10; y++) years.add(y)
  const picked = parseYear(current)
  if (picked != null) years.add(picked)
  return [...years]
    .sort((a, b) => a - b)
    .map((y) => ({ value: y, label: y === base ? `${y} 年(下一年)` : `${y} 年` }))
}

/** 称号下拉的候选。 */
export function reviewTitleOptions(): { value: string; label: string }[] {
  return TITLE_ORDER.map((code) => ({ value: code, label: TITLES[code] ?? code }))
}

/**
 * 待确认原因的文案。**按字典顺序输出**(不按传入顺序)—— 同一批行在两轮导出 / 两次截屏里
 * 逐行可比;`REVIEW_PENDING_REASON_ORDER` 因此有了生产消费者,不只是对齐用例的陪衬。
 */
export function reviewPendingReasonLabels(reasons: readonly ReviewPendingReason[]): string[] {
  const rank = (code: string) => {
    const i = REVIEW_PENDING_REASON_ORDER.indexOf(code)
    return i === -1 ? REVIEW_PENDING_REASON_ORDER.length : i
  }
  return [...reasons]
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((code) => REVIEW_PENDING_REASONS[code] ?? code)
}

/** 出处一行 → 可读文本:`文件 / 附件 / 序号N / 第N页`。缺哪项就不写哪项(不猜)。 */
export function reviewEvidenceText(evidence: ReviewEvidence): string {
  const parts = [evidence.sourceFile]
  if (evidence.attachment) parts.push(evidence.attachment)
  if (evidence.listNo != null) parts.push(`序号${evidence.listNo}`)
  if (evidence.page != null) parts.push(`第${evidence.page}页`)
  return parts.join(' / ')
}

/**
 * 锚点年份的来历说明。`event_year` 表示该事件的**结论年份没有单独记**,
 * 用的是事件所涉年份 —— 对认定事件它与结论年同年,对复核事件**不是**(所以复核那条
 * 压根不会出现在到期清单里,而是进待确认)。这里如实写出来,不把它藏成一个「看起来确定」的数。
 */
export function reviewAnchorYearNote(source: string | null): string {
  return source === 'decided_year' ? '按结论年份' : '按事件所涉年份'
}
