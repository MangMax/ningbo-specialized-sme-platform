<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useQuery } from '@pinia/colada'
import { watchDebounced } from '@vueuse/core'
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ExternalLink,
  LoaderCircle,
  Search,
} from '@lucide/vue'
import {
  comparisonDirectionLabel,
  comparisonDirectionNote,
  DIFFERENCE_REASONS,
  DIFFERENCE_REASON_ORDER,
  DIFFERENCE_STATUSES,
  DIFFERENCE_STATUS_ORDER,
  EVENTS,
  EVENT_ORDER,
  FIRST_RECOGNITION_STATUSES,
  FIRST_RECOGNITION_STATUS_ORDER,
  SOURCES,
  SOURCE_ORDER,
  TITLES,
  TITLE_ORDER,
  TITLE_SHORT,
} from '~~/lib/labels'
import { NINGBO_DISTRICTS, NINGBO_INDEPENDENT_ZONES } from '~~/lib/domain'
import {
  shouldNuxtScrollToTop,
  useEvidencePreviewScrollRestore,
} from '~~/lib/roster/evidence-preview-return'
import {
  EMPTY_LEDGER_STATE,
  ledgerExportLabel,
  ledgerExportUrl,
  ledgerListQuery,
  filtersForView,
  ledgerStateFromQuery,
  parseLedgerView,
  VIEW_PARAM,
  type LedgerState,
  type LedgerView,
} from '~~/lib/roster/ledger-view'
import FilterChip from '@/components/FilterChip.vue'
import MultiSelectFilter from '@/components/MultiSelectFilter.vue'
import RosterDifferenceTable, { type DifferenceRow } from '@/components/RosterDifferenceTable.vue'
import RosterEnterpriseTable, { type EnterpriseRow } from '@/components/RosterEnterpriseTable.vue'
import RosterTitleTable, { type TitleRow } from '@/components/RosterTitleTable.vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationFirst,
  PaginationItem,
  PaginationLast,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'

// A roster return is restored after its filtered rows (and expanded row) render. Use route origin
// to avoid Nuxt's later top reset even if that hook consumes the saved offset first.
definePageMeta({ scrollToTop: (to, from) => shouldNuxtScrollToTop(to.fullPath, from.path) })

/**
 * **名录台账** —— 合并后的唯一台账入口(RL-17)。
 *
 * 原先 `/`(记录台账)与 `/roster`(企业总表)是两个入口讲同一件事:`/api/records` 的一行
 * 本来就是**企业 × 称号**(它的 `total` 数的是「企业 × 称号」组合数),与企业总表的
 * `counts.titlePairs` 是同一个数字。所以这里不是把两个页面拼起来,而是把**同一份数据的
 * 两种分组**收进一个工具栏:一个筛选条、一个导出按钮、一个搜索框。
 *
 * 三个视图(映射全在 `lib/roster/ledger-view.ts`,有单测):
 *  - `enterprise`(默认)—— 一企一行,展开见全部称号 / 批次 / 事件 / 出处;
 *  - `title`             —— 一行一个企业 × 称号,来源与事件列在行内;
 *  - `difference`        —— 差异与原因,每 (企业 × 称号 × 方向) 一条当前解释。
 *
 * ── 口径(页面上说清,导出里也写)────────────────────────────────────────
 * **企业数** ≠ **企业 × 称号**数。多称号企业在企业数里只算一家,在每个称号桶里各计一次。
 * `按企业` 报前者,`按企业×称号` 报后者;计数行把两个数字并排写出来。
 *
 * ── 状态全在地址栏(深链与「返回不丢上下文」)────────────────────────────
 * 视图、全部筛选、页码、展开的行都回写到 URL,用 `replace`(勾选不该把历史塞满)。
 * 刷新、分享链接、从企业详情返回、前进后退,都落回同一个视图。
 */

interface Counts {
  total: number
  titlePairs: number
  titles: Record<string, number>
  /** 符合本次筛选的「企业 × 称号」**首次认定**数(RL-08)。 */
  recognitionPairs: number
}

const apiGet = $fetch as unknown as <T>(
  url: string,
  opts?: { query?: Record<string, unknown> },
) => Promise<T>

const route = useRoute()
const router = useRouter()

/** 参数集合的规范串:比对「地址栏 ⇄ 页面状态」是否已经一致,避免来回写地址。 */
const normalize = (q: Record<string, unknown>) =>
  Object.entries(q)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : String(v)}`)
    .sort()
    .join('&')

const positiveInt = (v: unknown): number | null => {
  const n = Number(Array.isArray(v) ? v[0] : v)
  return Number.isInteger(n) && n >= 1 ? n : null
}
const clampSize = (n: number) => Math.min(200, Math.max(1, n))

// —— 页面状态:唯一写入方是下面的 watcher,唯一读取方是模板与取数 ——
const view = ref<LedgerView>(parseLedgerView(route.query[VIEW_PARAM]))
const state = ref<LedgerState>(ledgerStateFromQuery(route.query))
const page = ref(positiveInt(route.query.page) ?? 1)
const pageSize = ref(clampSize(positiveInt(route.query.pageSize) ?? 25))
const expanded = ref<number | null>(positiveInt(route.query.expand))
const expandedDetailReadyId = ref<number | null>(null)

/** 搜索框本地值(防抖后写进 `state.q`)。 */
const search = ref(state.value.q)
watchDebounced(
  search,
  (v) => {
    state.value = { ...state.value, q: v.trim() }
  },
  { debounce: 300 },
)

const DEFAULT_PAGE_SIZE = 25

/** 页面状态 → 地址栏。只写**有值**的东西,免得分享出一串空参数。 */
function toRouteQuery(): Record<string, string> {
  // `view` 由 `ledgerListQuery` 自己写(非默认视图才写),这里不再补一次 ——
  // 补的那行是 no-op,却让人以为「view 由这里负责」。
  const q = ledgerListQuery(view.value, state.value)
  if (page.value > 1) q.page = String(page.value)
  if (pageSize.value !== DEFAULT_PAGE_SIZE) q.pageSize = String(pageSize.value)
  if (view.value === 'enterprise' && expanded.value != null) q.expand = String(expanded.value)
  return q
}

/** 完整台账的筛选串(含 `view`),企业详情页靠它「返回台账」落回同一批筛选。 */
const backQuery = computed(() => {
  const p = new URLSearchParams({ ...toRouteQuery() })
  if (!p.has(VIEW_PARAM)) p.set(VIEW_PARAM, view.value)
  return p.toString()
})

watch(
  [view, state, page, pageSize, expanded],
  () => {
    const next = toRouteQuery()
    if (normalize(next) === normalize(route.query)) return
    router.replace({ path: route.path, query: next })
  },
  { deep: true },
)

/** 地址栏是外部入口(前进后退 / 分享链接 / 详情页返回),变了就把状态拉回来。 */
watch(
  () => route.query,
  (q) => {
    if (normalize(q) === normalize(toRouteQuery())) return
    view.value = parseLedgerView(q[VIEW_PARAM])
    state.value = ledgerStateFromQuery(q)
    search.value = state.value.q
    page.value = positiveInt(q.page) ?? 1
    pageSize.value = clampSize(positiveInt(q.pageSize) ?? 25)
    expanded.value = positiveInt(q.expand)
  },
  { deep: true },
)

/** 筛选一变就回到第一页、并收起展开行(页码不是筛选,不参与这个信号)。 */
const filterSignature = computed(() => normalize(ledgerListQuery(view.value, state.value)))
watch(filterSignature, (next, prev) => {
  if (next === prev) return
  page.value = 1
  expanded.value = null
})

/** 视图切换:把该视图用不到的筛选**清掉** —— 留在 URL 里会变成看不见、切回来又突然生效的条件。 */
function setView(next: LedgerView) {
  if (next === view.value) return
  // 清哪些、留哪些由 `LEDGER_VIEW_FILTERS` 一处说了算:留一个该视图不发的条件,
  // 地址栏不体现、用户清不掉,切回来却会生效。
  state.value = filtersForView(next, state.value)
  view.value = next
  page.value = 1
  expanded.value = null
}

// —— 取数:只取当前视图,不预取另外两个 ——
const listQuery = computed(() => ({
  ...ledgerListQuery(view.value, state.value),
  page: page.value,
  pageSize: pageSize.value,
}))

const {
  data: enterpriseData,
  isLoading: loadingEnterprises,
  asyncStatus: enterprisesStatus,
  error: enterprisesError,
  refetch: refetchEnterprises,
} = useQuery({
  key: () => ['ledger-enterprises', listQuery.value],
  query: () =>
    apiGet<{ rows: EnterpriseRow[]; counts: Counts }>('/api/roster/enterprises', {
      query: listQuery.value,
    }),
  enabled: () => view.value === 'enterprise',
  placeholderData: (previous) => previous,
})

const {
  data: titleData,
  isLoading: loadingTitles,
  asyncStatus: titlesStatus,
  error: titlesError,
  refetch: refetchTitles,
} = useQuery({
  key: () => ['ledger-titles', listQuery.value],
  query: () => apiGet<{ rows: TitleRow[]; total: number }>('/api/records', { query: listQuery.value }),
  enabled: () => view.value === 'title',
  placeholderData: (previous) => previous,
})

const {
  data: differenceData,
  isLoading: loadingDifferences,
  asyncStatus: differencesStatus,
  error: differencesError,
  refetch: refetchDifferences,
} = useQuery({
  key: () => ['ledger-differences', listQuery.value],
  query: () =>
    apiGet<{ rows: DifferenceRow[]; total: number }>('/api/roster/differences', {
      query: listQuery.value,
    }),
  enabled: () => view.value === 'difference',
  placeholderData: (previous) => previous,
})

const enterpriseRows = computed(() => enterpriseData.value?.rows ?? [])
const titleRows = computed(() => titleData.value?.rows ?? [])
const differenceRows = computed(() => differenceData.value?.rows ?? [])
const counts = computed<Counts>(
  () => enterpriseData.value?.counts ?? { total: 0, titlePairs: 0, titles: {}, recognitionPairs: 0 },
)

/**
 * 当前视图**正在取数**(含改筛选后的后台重取)。
 *
 * 为什么需要它:`placeholderData` 让上一批结果留在屏上(这是对的,不该闪成空白),
 * 但那样一来「改了筛选,数还没回来」就**完全看不出来** —— 用户会以为新条件筛出来就是
 * 这一屏。`isLoading` 只覆盖「第一次加载」,所以这里看 `asyncStatus`。
 */
const listLoading = computed(() =>
  view.value === 'enterprise'
    ? enterprisesStatus.value === 'loading'
    : view.value === 'title'
      ? titlesStatus.value === 'loading'
      : differencesStatus.value === 'loading',
)

/** The active list has returned data (or a settled error) and is no longer refetching. */
const listRendered = computed(() => {
  if (listLoading.value) return false
  return view.value === 'enterprise'
    ? enterpriseData.value != null || enterprisesError.value != null
    : view.value === 'title'
      ? titleData.value != null || titlesError.value != null
      : differenceData.value != null || differencesError.value != null
})
watch(expanded, () => {
  expandedDetailReadyId.value = null
})
const returnTargetRendered = computed(() => {
  if (!listRendered.value) return false
  if (view.value !== 'enterprise' || expanded.value === null) return true
  const expandedRowIsVisible = enterpriseRows.value.some((row) => row.enterpriseId === expanded.value)
  return !expandedRowIsVisible || expandedDetailReadyId.value === expanded.value
})
function onExpandedDetailSettled(enterpriseId: number) {
  if (expanded.value === enterpriseId) expandedDetailReadyId.value = enterpriseId
}
useEvidencePreviewScrollRestore(returnTargetRendered)

const total = computed(() =>
  view.value === 'enterprise'
    ? counts.value.total
    : view.value === 'title'
      ? (titleData.value?.total ?? 0)
      : (differenceData.value?.total ?? 0),
)
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)))
watch(totalPages, (max) => {
  if (page.value > max) page.value = max
})

/** 屏上当前有多少行(用来区分「第一次加载」与「旧结果还在、新的在路上」)。 */
const rowsOnScreen = computed(() =>
  view.value === 'enterprise'
    ? enterpriseRows.value.length
    : view.value === 'title'
      ? titleRows.value.length
      : differenceRows.value.length,
)

/**
 * 屏上**已有结果**、但当前条件的那一批还在路上。
 *
 * 为什么要单独说一句:`placeholderData` 会把上一批结果留在屏上(对的,不该闪成空白),
 * 于是「改了筛选、数还没回来」看上去和「已经筛好了」一模一样 —— 用户会照着**旧条件的数字**
 * 下判断。`isLoading` 在 colada 里就是 `asyncStatus === 'loading'`(重取时同样为真),
 * 没有「第几次」的信息,所以这里用「屏上有没有行」来区分:第一次加载时屏上是骨架屏,
 * 不该再叠一个「加载中」。
 */
const listRefetching = computed(() => listLoading.value && rowsOnScreen.value > 0)

const activeError = computed(() =>
  view.value === 'enterprise'
    ? enterprisesError.value
    : view.value === 'title'
      ? titlesError.value
      : differencesError.value,
)
function retry() {
  if (view.value === 'enterprise') refetchEnterprises()
  else if (view.value === 'title') refetchTitles()
  else refetchDifferences()
}

// —— 筛选项 ——
const titleOptions = computed(() =>
  TITLE_ORDER.map((code) => ({ value: code, label: TITLES[code] ?? code, short: TITLE_SHORT[code] })),
)
const sourceOptions = computed(() => SOURCE_ORDER.map((code) => ({ value: code, label: SOURCES[code] ?? code })))
const statusOptions = computed(() =>
  DIFFERENCE_STATUS_ORDER.map((code) => ({ value: code, label: DIFFERENCE_STATUSES[code] ?? code })),
)
const reasonOptions = computed(() =>
  DIFFERENCE_REASON_ORDER.map((code) => ({ value: code, label: DIFFERENCE_REASONS[code] ?? code })),
)
/** 首次认定状态(RL-08):两态,标签取自 `lib/labels.ts` 的单一出处。 */
const firstStatusOptions = computed(() =>
  FIRST_RECOGNITION_STATUS_ORDER.map((code) => ({
    value: code,
    label: FIRST_RECOGNITION_STATUSES[code] ?? code,
  })),
)
const districtOptions = [...NINGBO_DISTRICTS, ...NINGBO_INDEPENDENT_ZONES]

/** 事件年份与首次认定年份分别取各自的统计桶,不混用 `record_event.year` 与生命周期年份。 */
const { data: stats } = useQuery({
  key: () => ['stats'],
  query: () =>
    apiGet<{
      byEvent: { key: string; n: number }[]
      byYear: { key: string; n: number }[]
      byFirstRecognitionYear: { key: string; n: number }[]
    }>('/api/stats'),
})
const eventOptions = computed(() => {
  const present = new Set((stats.value?.byEvent ?? []).map((b) => b.key))
  const known = EVENT_ORDER.filter((k) => present.has(k))
  const list = known.length ? known : EVENT_ORDER
  return list.map((k) => ({ value: k, label: EVENTS[k] ?? k }))
})
const yearOptions = computed(() =>
  (stats.value?.byYear ?? [])
    .map((b) => b.key)
    .filter((k) => /^\d{4}$/.test(k))
    .sort((a, b) => b.localeCompare(a))
    .map((y) => ({ value: y, label: y })),
)
const firstYearOptions = computed(() =>
  (stats.value?.byFirstRecognitionYear ?? [])
    .map((b) => b.key)
    .filter((k) => /^\d{4}$/.test(k))
    .sort((a, b) => b.localeCompare(a))
    .map((y) => ({ value: y, label: y })),
)

// —— 生效中的条件:摊平成一行,每项可单独撤掉 ——
interface ActiveFilter {
  key: string
  label: string
  clear: () => void
}

const activeFilters = computed<ActiveFilter[]>(() => {
  const s = state.value
  const patch = (key: keyof LedgerState, value: unknown) => {
    state.value = { ...state.value, [key]: value }
  }
  const without = (
    key: 'title' | 'source' | 'eventType' | 'year' | 'firstYear' | 'firstStatus' | 'status' | 'reason',
    drop: string,
  ) =>
    patch(
      key,
      s[key].filter((x) => x !== drop),
    )

  return [
    ...s.title.map((v) => ({
      key: `title:${v}`,
      label: `称号 · ${TITLES[v] ?? v}`,
      clear: () => without('title', v),
    })),
    ...(s.district
      ? [{ key: 'district', label: `属地 · ${s.district}`, clear: () => patch('district', '') }]
      : []),
    ...(s.rosterState
      ? [
          {
            key: 'rosterState',
            label: `总表状态 · ${s.rosterState === 'current' ? '当前总表' : '仅平台引入(已移除)'}`,
            clear: () => patch('rosterState', ''),
          },
        ]
      : []),
    ...s.source.map((v) => ({
      key: `source:${v}`,
      label: `来源 · ${SOURCES[v] ?? v}`,
      clear: () => without('source', v),
    })),
    ...s.eventType.map((v) => ({
      key: `event:${v}`,
      label: `事件 · ${EVENTS[v] ?? v}`,
      clear: () => without('eventType', v),
    })),
    ...s.year.map((v) => ({ key: `year:${v}`, label: `年份 · ${v}`, clear: () => without('year', v) })),
    ...s.firstYear.map((v) => ({
      key: `firstYear:${v}`,
      label: `首次认定 · ${v}`,
      clear: () => without('firstYear', v),
    })),
    ...s.firstStatus.map((v) => ({
      key: `firstStatus:${v}`,
      label: `首次认定 · ${FIRST_RECOGNITION_STATUSES[v] ?? v}`,
      clear: () => without('firstStatus', v),
    })),
    ...s.status.map((v) => ({
      key: `status:${v}`,
      label: `状态 · ${DIFFERENCE_STATUSES[v] ?? v}`,
      clear: () => without('status', v),
    })),
    ...s.reason.map((v) => ({
      key: `reason:${v}`,
      label: `原因 · ${DIFFERENCE_REASONS[v] ?? v}`,
      clear: () => without('reason', v),
    })),
    ...(s.direction
      ? [
          {
            key: 'direction',
            label: `方向 · ${comparisonDirectionLabel(s.direction)}`,
            clear: () => patch('direction', ''),
          },
        ]
      : []),
    ...(s.q
      ? [
          {
            key: 'q',
            label: `搜索 · ${s.q}`,
            clear: () => {
              search.value = ''
              patch('q', '')
            },
          },
        ]
      : []),
  ]
})

function clearFilters() {
  search.value = ''
  state.value = { ...EMPTY_LEDGER_STATE }
}

const exportUrl = computed(() => ledgerExportUrl(view.value, state.value))

// —— 每页条数 ——
const PAGE_SIZE_PRESETS = [25, 50, 100, 200]
const customSize = ref(false)
const sizeModel = computed({
  get: () => (customSize.value ? 'custom' : String(pageSize.value)),
  set: (v: string) => {
    if (v === 'custom') {
      customSize.value = true
      return
    }
    customSize.value = false
    setPageSize(Number(v))
  },
})
const isCustomSize = computed(() => customSize.value)
function setPageSize(n: number) {
  pageSize.value = clampSize(Math.trunc(n) || DEFAULT_PAGE_SIZE)
  page.value = 1
}
function onSizeInput(e: Event) {
  const value = Number((e.target as HTMLInputElement).value)
  if (Number.isFinite(value) && value > 0) setPageSize(value)
}
function setPage(n: number) {
  page.value = Math.min(Math.max(1, n), totalPages.value)
}

function toggle(id: number) {
  expanded.value = expanded.value === id ? null : id
}
function openEnterprise(path: string) {
  router.push(path)
}

const VIEW_TABS: { value: LedgerView; label: string; hint: string }[] = [
  { value: 'enterprise', label: '按企业', hint: '一行一家企业,跨称号去重;称号与事件在展开里' },
  { value: 'title', label: '按企业×称号', hint: '一行一个企业×称号,来源与事件直接列在行内' },
  { value: 'difference', label: '差异与原因', hint: '每(企业 × 称号 × 方向)一条当前解释' },
]

const UNIT = computed(() =>
  view.value === 'enterprise' ? '家企业' : view.value === 'title' ? '行(企业×称号)' : '项差异',
)

/**
 * 页面标题(浏览器标签 / 历史记录 / 书签)。
 *
 * 全仓没有一处设过 `document.title`(实测为空字符串),所以这里顺手给台账页补上 ——
 * 一个三视图、且视图与筛选都写在地址栏里的页面,标签页上只显示空白就完全认不出来。
 * 带上视图名与当前条数:多开几个标签、或从历史里找回来时,一眼能看出是哪一个。
 */
const VIEW_TITLE: Record<LedgerView, string> = {
  enterprise: '按企业',
  title: '按企业×称号',
  difference: '差异与原因',
}
const UNIT_SHORT = computed(() =>
  view.value === 'enterprise' ? '家企业' : view.value === 'title' ? '行' : '项差异',
)
useHead({
  title: computed(() => {
    const n = total.value ? `${total.value.toLocaleString('zh-CN')} ${UNIT_SHORT.value}` : '加载中'
    return `${VIEW_TITLE[view.value]} · ${n} · 名录台账`
  }),
})

</script>

<template>
  <div class="flex min-w-0 flex-col gap-4">
    <PageHeader class="rise-in" style="--rise-index: 0" title="名录台账">
      <template #description>
        <span class="inline-block">
          公布文件是唯一权威来源,平台只作对照。同一份数据两种分组:<strong>按企业</strong>一企一行,
          <strong>按企业×称号</strong>一行一个称号并列出来源与事件。
        </span>
      </template>
      <template #actions>
        <Button v-if="exportUrl" as-child variant="outline" size="sm">
          <a :href="exportUrl"><ExternalLink class="size-3.5" />{{ ledgerExportLabel(view) }}</a>
        </Button>
      </template>
    </PageHeader>

    <!-- 分组 + 筛选条:三个视图共用。 -->
    <div class="rise-in flex flex-col gap-2" style="--rise-index: 1">
      <div class="flex flex-wrap items-center gap-2">
        <div class="bg-muted inline-flex rounded-md p-0.5" role="tablist" aria-label="台账分组">
          <button
            v-for="t in VIEW_TABS"
            :key="t.value"
            type="button"
            role="tab"
            :aria-selected="view === t.value"
            :title="t.hint"
            class="rounded-sm px-3 py-1 text-xs transition-colors"
            :class="
              view === t.value
                ? 'bg-background text-foreground font-medium shadow-xs'
                : 'text-muted-foreground hover:text-foreground'
            "
            @click="setView(t.value)"
          >
            {{ t.label }}
          </button>
        </div>

        <div class="relative min-w-48 flex-1 sm:max-w-56">
          <Search
            class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
          />
          <Input
            v-model="search"
            class="bg-card h-8 pl-8"
            placeholder="企业名 / 曾用名 / 统一社会信用代码"
            aria-label="按企业名称、已确认曾用名或统一社会信用代码搜索"
          />
        </div>

        <Separator orientation="vertical" class="hidden h-5 sm:block" />

        <MultiSelectFilter
          v-model="state.title"
          :options="titleOptions"
          placeholder="全部称号"
          summary-prefix="称号"
          class="w-28"
        />
        <template v-if="view !== 'difference'">
          <MultiSelectFilter
            v-model="state.source"
            :options="sourceOptions"
            placeholder="全部来源"
            summary-prefix="来源"
            class="w-24"
          />
          <MultiSelectFilter
            v-model="state.eventType"
            :options="eventOptions"
            placeholder="全部事件"
            summary-prefix="事件"
            class="w-24"
          />
          <MultiSelectFilter
            v-model="state.year"
            :options="yearOptions"
            placeholder="全部年份"
            summary-prefix="年份"
            class="w-24"
          />
        </template>
        <template v-if="view === 'enterprise'">
          <!-- RL-08:首次认定两个判据(年份 / 状态)。与上面的「年份」是两回事:
               那个筛**事件**年份,这两个筛该称号**首次认定**的年份与状态。 -->
          <MultiSelectFilter
            v-model="state.firstYear"
            :options="firstYearOptions"
            placeholder="首次认定年份"
            summary-prefix="首次认定"
            class="w-32"
          />
          <MultiSelectFilter
            v-model="state.firstStatus"
            :options="firstStatusOptions"
            placeholder="首次认定状态"
            summary-prefix="首次认定"
            class="w-32"
          />
          <select
            v-model="state.district"
            class="border-input bg-background h-8 rounded-md border px-2 text-sm"
            aria-label="按属地筛选"
          >
            <option value="">全部属地</option>
            <option v-for="d in districtOptions" :key="d" :value="d">{{ d }}</option>
          </select>
          <select
            v-model="state.rosterState"
            class="border-input bg-background h-8 rounded-md border px-2 text-sm"
            aria-label="按总表状态筛选"
          >
            <option value="">全部总表状态</option>
            <option value="current">当前总表</option>
            <option value="removed_platform_only">仅平台引入(已从当前总表移除)</option>
          </select>
        </template>
        <template v-if="view === 'difference'">
          <select
            v-model="state.direction"
            class="border-input bg-background h-8 rounded-md border px-2 text-sm"
            aria-label="按差异方向筛选"
          >
            <option value="">两个方向</option>
            <option value="missing_in_miit">{{ comparisonDirectionLabel('missing_in_miit') }}({{ comparisonDirectionNote('missing_in_miit') }})</option>
            <option value="extra_in_miit">{{ comparisonDirectionLabel('extra_in_miit') }}({{ comparisonDirectionNote('extra_in_miit') }})</option>
          </select>
          <MultiSelectFilter
            v-model="state.status"
            :options="statusOptions"
            placeholder="全部状态"
            summary-prefix="状态"
            class="w-24"
          />
          <MultiSelectFilter
            v-model="state.reason"
            :options="reasonOptions"
            placeholder="全部原因"
            summary-prefix="原因"
            class="w-24"
          />
        </template>
      </div>

      <!-- 生效中的条件摊开写出来:光看下拉按钮看不出年份里到底勾了哪几年 -->
      <TransitionGroup
        v-if="activeFilters.length"
        tag="div"
        class="flex flex-wrap items-center gap-1.5"
        enter-active-class="transition duration-150 ease-snap"
        enter-from-class="scale-90 opacity-0"
        leave-active-class="transition duration-100 ease-snap"
        leave-to-class="scale-90 opacity-0"
        move-class="transition duration-150 ease-snap"
      >
        <FilterChip v-for="f in activeFilters" :key="f.key" :label="f.label" @remove="f.clear()" />
        <Button
          variant="ghost"
          size="sm"
          class="text-muted-foreground h-6 px-1.5 text-xs"
          @click="clearFilters"
        >
          清除全部
        </Button>
      </TransitionGroup>
    </div>

    <!-- ── 计数行:两个口径并排说清 ─────────────────────────────────────── -->
    <p
      class="rise-in text-muted-foreground text-[13px] leading-relaxed tabular-nums"
      style="--rise-index: 2"
      aria-live="polite"
      :aria-busy="listRefetching"
      data-testid="ledger-counts"
    >
      <!-- 改筛选后正在重取:旧数字还在,但必须让人知道它已经过期。 -->
      <span
        v-if="listRefetching"
        class="text-muted-foreground mr-2 inline-flex items-center gap-1"
        data-testid="ledger-loading"
      >
        <LoaderCircle class="size-3 animate-spin" aria-hidden="true" />加载中
      </span>
      <template v-if="view === 'enterprise'">
        共 <span class="text-foreground font-medium">{{ counts.total.toLocaleString('zh-CN') }}</span>
        <strong>家企业</strong> · 合计
        <span class="text-foreground font-medium">{{ counts.titlePairs.toLocaleString('zh-CN') }}</span>
        个 <strong>企业 × 称号</strong>(多称号企业在企业数里只算一家,在每个称号里各计一次;导出与本页同筛选、同口径),
        其中 <span class="text-foreground font-medium">{{ counts.recognitionPairs.toLocaleString('zh-CN') }}</span>
        个有<strong>首次认定</strong>
      </template>
      <template v-else-if="view === 'title'">
        符合条件 <span class="text-foreground font-medium">{{ total.toLocaleString('zh-CN') }}</span> 行
        <strong>企业 × 称号</strong>(本视图按企业×称号分行;切到「按企业」把同一批企业去重成一行一家)
      </template>
      <template v-else>
        本筛选下 <span class="text-foreground font-medium">{{ total.toLocaleString('zh-CN') }}</span> 项差异
        (一行 = 一个企业 × 称号 × 方向的<strong>当前</strong>解释;状态只从已存下的解释记录取,没有的显示状态机的「未查询」)
      </template>
    </p>

    <!--
      称号桶只在「按企业」下有意义:它是**企业数**按称号分的桶,来自企业读模型的 `counts`。
      「按企业×称号」的分行数(10,501)按定义就等于这些桶之和,再列一遍是重复;
      而记录读接口只给一个合计,拿不到分称号的企业数 —— 与其显示一排 0,不如不显示。
    -->
    <div
      v-if="view === 'enterprise'"
      class="rise-in flex flex-wrap gap-x-4 gap-y-1 text-xs"
      style="--rise-index: 2"
    >
      <span v-for="code in TITLE_ORDER" :key="code" class="text-muted-foreground tabular-nums">
        {{ TITLES[code] }}
        <span class="text-foreground font-medium">{{ counts.titles[code] ?? 0 }}</span> 家
      </span>
    </div>

    <Alert v-if="activeError" variant="destructive">
      <AlertTitle>台账加载失败</AlertTitle>
      <AlertDescription
        ><Button variant="outline" size="sm" @click="retry()">重试</Button></AlertDescription
      >
    </Alert>

    <Card class="rise-in gap-0 overflow-hidden py-0" style="--rise-index: 3">
      <CardContent class="p-0">
        <div>
          <RosterEnterpriseTable
            v-if="view === 'enterprise'"
            :rows="enterpriseRows"
            :loading="loadingEnterprises"
            :has-error="!!enterprisesError"
            :expanded-id="expanded"
            :back-query="backQuery"
            @toggle="toggle"
            @detail-ready="onExpandedDetailSettled"
          />
          <RosterTitleTable
            v-else-if="view === 'title'"
            :rows="titleRows"
            :loading="loadingTitles"
            :has-error="!!titlesError"
            :back-query="backQuery"
            @open="openEnterprise"
          />
          <RosterDifferenceTable
            v-else
            :rows="differenceRows"
            :loading="loadingDifferences"
            :has-error="!!differencesError"
          />
        </div>
      </CardContent>
    </Card>

    <div class="rise-in flex flex-wrap items-center gap-x-4 gap-y-3" style="--rise-index: 4">
      <div class="flex items-center gap-2">
        <span class="text-muted-foreground text-xs">每页</span>
        <Select v-model="sizeModel">
          <SelectTrigger class="bg-card h-8 w-20" aria-label="每页条数">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="n in PAGE_SIZE_PRESETS" :key="n" :value="String(n)">{{ n }}</SelectItem>
            <SelectItem value="custom">自定义…</SelectItem>
          </SelectContent>
        </Select>
        <Input
          v-if="isCustomSize"
          :model-value="pageSize"
          type="number"
          min="1"
          :max="200"
          class="bg-card h-8 w-20"
          aria-label="自定义每页条数"
          @change="onSizeInput"
        />
        <span class="text-muted-foreground text-xs">{{ UNIT }}</span>
      </div>

      <span class="text-muted-foreground text-xs tabular-nums">第 {{ page }} / {{ totalPages }} 页</span>

      <Pagination
        v-if="total > 0"
        v-slot="{ page: current }"
        class="mx-0 w-full justify-center sm:ml-auto sm:w-auto sm:justify-end"
        :page="page"
        :items-per-page="pageSize"
        :total="total"
        :sibling-count="1"
        :show-edges="totalPages > 5"
        @update:page="setPage"
      >
        <!-- 窄屏必须允许换行:`PaginationContent` 的基础类是 `flex-row`(不换行),
             而 `sibling-count=1` + `show-edges` 在几百页时会有 11 个条目(实测 452px)。
             不换行就会**撑破页面**并且横向溢出(实测 390 视口下 documentElement
             scrollWidth 468 / clientWidth 390,溢出 78px)—— 表格自己有滚动容器,
             分页条没有。 -->
        <PaginationContent v-slot="{ items }" class="flex-wrap justify-center sm:justify-end">
          <!-- 首/末/上/下一页的禁用态与页码变更由 reka-ui 的 Pagination 自己管,
               这里只给图标和中文文案。 -->
          <PaginationFirst class="hidden sm:flex">
            <ChevronsLeft class="size-4" />
            <span class="sr-only">第一页</span>
          </PaginationFirst>
          <PaginationPrevious>
            <ChevronLeft class="size-4" />
            <span class="hidden sm:block">上一页</span>
          </PaginationPrevious>
          <template v-for="(item, index) in items" :key="index">
            <PaginationItem
              v-if="item.type === 'page'"
              :value="item.value"
              :is-active="item.value === current"
            >
              {{ item.value }}
            </PaginationItem>
            <PaginationEllipsis v-else :index="index" />
          </template>
          <PaginationNext>
            <span class="hidden sm:block">下一页</span>
            <ChevronRight class="size-4" />
          </PaginationNext>
          <PaginationLast class="hidden sm:flex">
            <ChevronsRight class="size-4" />
            <span class="sr-only">最后一页</span>
          </PaginationLast>
        </PaginationContent>
      </Pagination>
    </div>
  </div>
</template>
