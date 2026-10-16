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
import { DIFFERENCE_REASONS, DIFFERENCE_STATUSES, EVENT_ORDER, SOURCE_ORDER, TITLE_ORDER } from '../../lib/labels'
import {
  DEFAULT_ROSTER_ENTERPRISE_SORT,
  DIFF_STATUS_NONE,
  ROSTER_ENTERPRISE_SORTS,
  ROSTER_STATES,
  type RosterDifferenceFilter,
  type RosterEnterpriseFilter,
  type RosterEnterpriseSort,
  type RosterState,
} from '../../lib/roster/enterprise-roster'

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

/** `diffStatus` 的合法取值:六个差异状态 **∪** 伪状态 `none`(当前无差异)。 */
const DIFF_STATUS_VALUES: string[] = [...Object.keys(DIFFERENCE_STATUSES), DIFF_STATUS_NONE]

/**
 * 排序参数。**非法取值给 400,不静默退回默认** —— 与「取值说不清就不猜」同一规矩:
 * 静默退回默认会让使用者以为自己在看「按认定年」的序,实际拿到的是另一种,
 * 而这种错在页面上完全看不出来(列表总有顺序)。
 */
function sortParam(value: unknown): RosterEnterpriseSort {
  const raw = strParam(value)
  if (raw == null) return DEFAULT_ROSTER_ENTERPRISE_SORT
  if (!(ROSTER_ENTERPRISE_SORTS as readonly string[]).includes(raw)) {
    throw createError({
      statusCode: 400,
      statusMessage: `Unknown sort; expected ${ROSTER_ENTERPRISE_SORTS.join(', ')}`,
    })
  }
  return raw as RosterEnterpriseSort
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
    // RL-20:台账页「差异状态」与「排序」两个筛选项。
    diffStatus: knownOrThrow(parseCsvQuery(query.diffStatus), DIFF_STATUS_VALUES, 'diffStatus'),
    sort: sortParam(query.sort),
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
