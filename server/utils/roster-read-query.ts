/**
 * 名录读接口的**查询参数解析**(RL-04)——总表 / 差异 / 导出三条路由共用一处。
 *
 * 为什么抽出来:同一个筛选集(`title` / `district` / `rosterState` / `q` / 分页)要在
 * 总表与导出上**逐字一致** —— 验收里「筛选和导出使用同一口径」如果靠两处各解析一遍,
 * 迟早会漂移(一边把 `title` 当单值、另一边当多值)。这里只有一份。
 *
 * 取值的合法性**不静默放过**:`title` / `rosterState` / `direction` / `status` / `reason`
 * 只认字典里有的值,别的给 400。静默忽略会让筛选悄悄失效,使用者只会看到空结果
 * 而不知道为什么。
 */
import { parseCsvQuery } from '../../lib/csv'
import { COMPARISON_DIRECTIONS, type ComparisonDirection } from '../../lib/comparison'
import {
  DIFFERENCE_REASONS,
  DIFFERENCE_STATUSES,
  EVENT_ORDER,
  REVIEW_STATUS_ORDER,
  SOURCE_ORDER,
  TITLE_ORDER,
} from '../../lib/labels'
import {
  ROSTER_STATES,
  type RosterDifferenceFilter,
  type RosterEnterpriseFilter,
  type RosterState,
} from '../../lib/roster/enterprise-roster'
import { type ReviewStatus, type RosterReviewFilter } from '../../lib/roster/review-list'

/** 取单值字符串参数(数组取第一个),空串当「没给」。 */
export function strParam(value: unknown): string | undefined {
  const s = typeof value === 'string' ? value.trim() : Array.isArray(value) ? String(value[0] ?? '').trim() : ''
  return s || undefined
}

/** 取正整数参数;非法/缺省退回 `fallback`(分页参数不该把请求打成 400)。 */
export function intParam(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback
}

/** 合法取值必须是**字典里有的**。 */
function knownOrThrow(
  values: string[] | undefined,
  allowed: readonly string[],
  field: string,
): string[] | undefined {
  if (!values) return undefined
  if (values.some((v) => !allowed.includes(v))) {
    throw createError({ statusCode: 400, statusMessage: `Unknown ${field}; expected ${allowed.join(', ')}` })
  }
  return values
}

/**
 * 事件年份(多值)。**非数字项剔除**而不是给 400:年份是自由文本输入里最容易带进
 * 杂字符的一类(粘贴、手输),剔除后仍按剩下的年份筛,比整条请求打回 400 更有用;
 * 全被剔除时等于没筛(与 `parseCsvQuery` 的「没筛」语义一致)。
 */
function yearsParam(value: unknown): number[] | undefined {
  const list = parseCsvQuery(value)
    ?.map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0)
  return list?.length ? list : undefined
}

/** §7.1 总表的筛选参数。 */
export function parseRosterEnterpriseQuery(query: Record<string, unknown>): RosterEnterpriseFilter {
  const title = knownOrThrow(parseCsvQuery(query.title), TITLE_ORDER, 'title')
  const rosterState = strParam(query.rosterState)
  if (rosterState != null && !(ROSTER_STATES as readonly string[]).includes(rosterState)) {
    throw createError({
      statusCode: 400,
      statusMessage: `Unknown rosterState; expected ${ROSTER_STATES.join(', ')}`,
    })
  }
  return {
    q: strParam(query.q),
    title,
    district: strParam(query.district),
    rosterState: rosterState as RosterState | undefined,
    // RL-17:合并台账后 `/stats` 的下钻会带这三项进企业粒度,缺一就静默变成不筛。
    source: knownOrThrow(parseCsvQuery(query.source), SOURCE_ORDER, 'source'),
    eventType: knownOrThrow(parseCsvQuery(query.eventType), EVENT_ORDER, 'eventType'),
    year: yearsParam(query.year),
    page: intParam(query.page, 1),
    pageSize: intParam(query.pageSize, 50),
  }
}

/** §7.3 差异的筛选参数。 */
export function parseRosterDifferenceQuery(query: Record<string, unknown>): RosterDifferenceFilter {
  return {
    // RL-17:合并台账的搜索框对三个视图都生效,差异视图也必须读 `q`
    // —— 否则切到「差异与原因」再搜是静默不筛。
    q: strParam(query.q),
    title: knownOrThrow(parseCsvQuery(query.title), TITLE_ORDER, 'title'),
    direction: knownOrThrow(
      parseCsvQuery(query.direction),
      COMPARISON_DIRECTIONS,
      'direction',
    ) as ComparisonDirection[] | undefined,
    status: knownOrThrow(parseCsvQuery(query.status), Object.keys(DIFFERENCE_STATUSES), 'status'),
    reason: knownOrThrow(parseCsvQuery(query.reason), Object.keys(DIFFERENCE_REASONS), 'reason'),
    page: intParam(query.page, 1),
    pageSize: intParam(query.pageSize, 50),
  }
}

/**
 * §7.4 复核清单的查询参数(RL-09)。
 *
 * `year` 是**到期年份**(不是事件年份),且**必填** —— 契约 §7.4 就是这么定的。
 * 缺了它就给 400,不退回「今年」:清单的整个含义都挂在目标年份上,
 * 静默用一个默认年会让用户拿到一份**不是他要的那一年**的清单,而页面看不出来。
 *
 * `status` 缺省为 `due`(到期清单),也可给 `pending`(待确认清单)。
 */
export function parseRosterReviewQuery(
  query: Record<string, unknown>,
): RosterReviewFilter & { status?: ReviewStatus; page: number; pageSize: number } {
  const raw = strParam(query.year)
  const year = raw != null ? Number(raw) : Number.NaN
  // 年份是四位公历年:太小的值(如把 2027 打成 27)会静默给出空清单,不如直接打回。
  if (!Number.isInteger(year) || year < 1900 || year > 2999) {
    throw createError({ statusCode: 400, statusMessage: 'year is required and must be a 4-digit year' })
  }
  const status = strParam(query.status)
  if (status != null && !(REVIEW_STATUS_ORDER as readonly string[]).includes(status)) {
    throw createError({
      statusCode: 400,
      statusMessage: `Unknown status; expected ${REVIEW_STATUS_ORDER.join(', ')}`,
    })
  }
  return {
    year,
    title: knownOrThrow(parseCsvQuery(query.title), TITLE_ORDER, 'title'),
    status: status as ReviewStatus | undefined,
    page: intParam(query.page, 1),
    pageSize: intParam(query.pageSize, 50),
  }
}
