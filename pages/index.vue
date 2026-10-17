<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { useQuery } from '@pinia/colada'
import { watchDebounced } from '@vueuse/core'
import {
  ExternalLink,
  Search,
} from '@lucide/vue'
import {
  ENTERPRISE_LIST_TITLE,
  ENTERPRISE_SORT_HINTS,
  ENTERPRISE_SORT_LABELS,
  ENTERPRISE_SORT_ORDER,
  EVENTS,
  SOURCES,
  TITLES,
  TITLE_ORDER,
  TITLE_SHORT,
} from '~~/lib/labels'
import { NINGBO_DISTRICTS, NINGBO_INDEPENDENT_ZONES } from '~~/lib/domain'
import {
  DEFAULT_SORT,
  EMPTY_LEDGER_STATE,
  LEDGER_EXPORT_LABEL,
  ledgerExportUrl,
  ledgerListQuery,
  ledgerStateFromQuery,
  ledgerYearOptions,
  type LedgerState,
} from '~~/lib/roster/ledger-view'
import { ROSTER_DIFFERENCE_FILTER_OPTIONS, rosterDifferenceFilterLabel } from '~~/lib/roster/ledger-contract'
import EnterpriseDrawer from '@/components/EnterpriseDrawer.vue'
import EnterpriseListTable, {
  type EnterpriseListRow,
} from '@/components/EnterpriseListTable.vue'
import FilterChip from '@/components/FilterChip.vue'
import MultiSelectFilter from '@/components/MultiSelectFilter.vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

/**
 * **企业列表**(RL-20)—— 一行一家企业的唯一台账表。
 *
 * ── 这一票删掉了什么(用户原话逐条对得上)────────────────────────────────
 *
 * 1. 「**只要一个表格**」 —— 原先这里按 `view` 切三种分组(按企业 / 按企业×称号 /
 *    差异与原因),三个 tab、三张表、三套筛选可见性。现在只剩**企业粒度**那一张,
 *    `view` 参数整组退役。差异不再单独成表:它的**状态**落到表里的「差异状态」列与
 *    原因摘要,**原因 → 措施**落到抽屉里。
 * 2. 「称号历史、原因用**侧边抽屉**展示,**原因也要可视化**」 —— 见 `EnterpriseDrawer`。
 * 3. 「**删掉解释小字**」 —— 上一版表格上方那一整段「共 X 家企业 · 合计 Y 个企业×称号
 *    (多称号企业在企业数里只算一家…)」、每视图的计数说明、空态里的「可放宽…再试」全部删掉。
 *    留下的只有页头的总数、筛选控件、表和页脚——**页面上没有一句解释性的话**。
 * 4. 「把原生 `<select>` 全部换成项目已有的 `Select` 组件」 —— 原先这一页同时存在两套:
 *    手写的原生 `<select>`(属地 / 总表状态 / 差异方向)与正规的 `Select`(每页条数)。
 *    现在单值筛选用 `Select`、多值筛选用 `MultiSelectFilter`,**没有一处原生 `<select>`**。
 * 5. 页面名与侧边栏入口都叫「企业列表」(`lib/labels.ts` 的 `ENTERPRISE_LIST_TITLE` 一处定义)。
 *
 * ── 状态全在地址栏(深链与「返回不丢上下文」)────────────────────────────
 * 全部筛选、排序、页码、用户打开的抽屉都回写到 URL,用 `replace`(改条件不该把历史塞满)。
 * 刷新、分享链接、从企业详情返回、前进后退,都落回同一个视图。
 */

interface Counts {
  total: number
  titlePairs: number
  titles: Record<string, number>
  differences: number
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
const state = ref<LedgerState>(ledgerStateFromQuery(route.query))
const page = ref(positiveInt(route.query.page) ?? 1)
const pageSize = ref(clampSize(positiveInt(route.query.pageSize) ?? 25))
/** 抽屉里那家;**`null` = 抽屉关着**。地址栏参数沿用旧的 `expand`(同一件事的旧写法)。 */
const selected = ref<number | null>(positiveInt(route.query.expand))
const drawerReturnFocusTarget = shallowRef<HTMLButtonElement | null>(null)

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
  const q = ledgerListQuery(state.value)
  if (page.value > 1) q.page = String(page.value)
  if (pageSize.value !== DEFAULT_PAGE_SIZE) q.pageSize = String(pageSize.value)
  if (selected.value != null) q.expand = String(selected.value)
  return q
}

/** 完整筛选串(含分页之外的一切),用于「详情页返回台账不丢上下文」。 */
const backQuery = computed(() => new URLSearchParams(toRouteQuery()).toString())

/**
 * Route writes are asynchronous. Ignore intermediate query updates from our own
 * replace() calls so a just-closed drawer cannot be reopened by its stale
 * `expand` value while the close update is still navigating.
 */
let pendingRouteQuery: string | null = null

watch(
  [state, page, pageSize, selected],
  () => {
    const next = toRouteQuery()
    const serialized = normalize(next)
    if (serialized === normalize(route.query)) return
    pendingRouteQuery = serialized
    void router.replace({ path: route.path, query: next }).then(() => {
      if (pendingRouteQuery === serialized && normalize(route.query) === serialized) {
        pendingRouteQuery = null
      }
    })
  },
  { deep: true },
)

/** 地址栏是外部入口(前进后退 / 分享链接 / 详情页返回),变了就把状态拉回来。 */
watch(
  () => route.query,
  (q) => {
    const serialized = normalize(q)
    if (pendingRouteQuery !== null) {
      if (serialized === pendingRouteQuery) pendingRouteQuery = null
      return
    }
    if (serialized === normalize(toRouteQuery())) return
    state.value = ledgerStateFromQuery(q)
    search.value = state.value.q
    page.value = positiveInt(q.page) ?? 1
    pageSize.value = clampSize(positiveInt(q.pageSize) ?? 25)
    selected.value = positiveInt(q.expand)
  },
  { deep: true },
)

function closeDrawer() {
  selected.value = null
  pendingRouteQuery = normalize(toRouteQuery())
}

/** 筛选一变就回到第一页(页码不是筛选,不参与这个信号)。 */
const filterSignature = computed(() => normalize(ledgerListQuery(state.value)))
watch(filterSignature, (next, prev) => {
  if (next === prev) return
  page.value = 1
})

// —— 取数 ——
const listQuery = computed(() => ({
  ...ledgerListQuery(state.value),
  page: page.value,
  pageSize: pageSize.value,
}))

const resultKey = computed(() => JSON.stringify({ q: listQuery.value, size: pageSize.value }))

const { data, isLoading, error, refetch } = useQuery({
  key: () => ['ledger-enterprises', listQuery.value],
  query: async () => {
    const query = { ...listQuery.value }
    const requestKey = resultKey.value
    const response = await apiGet<{ rows: EnterpriseListRow[]; counts: Counts }>(
      '/api/roster/enterprises',
      { query },
    )
    return { ...response, resultKey: requestKey }
  },
  // 换条件时**留住上一批行**:表体只轻微浮起,不清空 —— 空表会让用户以为「筛没了」。
  placeholderData: (previous) => previous,
})

const rows = computed(() => data.value?.rows ?? [])
const counts = computed<Counts>(
  () => data.value?.counts ?? { total: 0, titlePairs: 0, titles: {}, differences: 0 },
)
const total = computed(() => counts.value.total)
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)))
watch(totalPages, (max) => {
  if (page.value > max) page.value = max
})

/** 查询落定只清理已离开结果集的选择；打开抽屉始终由用户触发。 */
watch([data, resultKey], ([result, key]) => {
  if (!result || result.resultKey !== key || selected.value == null) return
  if (!result.rows.some((row) => row.enterpriseId === selected.value)) {
    selected.value = null
    drawerReturnFocusTarget.value = null
  }
}, { flush: 'post' })

function retry() {
  refetch()
}
function setPage(n: number) {
  page.value = Math.min(Math.max(1, n), totalPages.value)
}
function selectRow(id: number, trigger: HTMLButtonElement | null) {
  selected.value = id
  drawerReturnFocusTarget.value = trigger
}

// —— 筛选项 ——
const titleOptions = computed(() =>
  TITLE_ORDER.map((code) => ({ value: code, label: TITLES[code] ?? code, short: TITLE_SHORT[code] })),
)
const { data: yearStats } = useQuery({
  key: () => ['stats'],
  query: () => apiGet<{ byYear: { key: string; n: number }[] }>('/api/stats'),
})
const yearOptions = computed(() => ledgerYearOptions(
  (yearStats.value?.byYear ?? []).map(bucket => bucket.key),
  state.value.year,
))
const statusOptions = ROSTER_DIFFERENCE_FILTER_OPTIONS
const districtOptions = [...NINGBO_DISTRICTS, ...NINGBO_INDEPENDENT_ZONES]

/**
 * 「全部」在 `Select` 里必须是一个**非空**的哨兵值。
 *
 * 空字符串不行:reka-ui 的 `SelectItem` 用 `''` 表示「没有值」,给它会触发
 * 「item 的 value 不能是空串」的守卫(实测会往控制台报警告),而控制台干净是
 * `verify-ledger-ui` 的一条硬线。所以界面用哨兵、状态里仍然存 `''`(「没筛」)。
 */
const ALL_DISTRICTS = '__all__'
const districtModel = computed({
  get: () => state.value.district || ALL_DISTRICTS,
  set: (v: string) => {
    state.value = { ...state.value, district: v === ALL_DISTRICTS ? '' : v }
  },
})

const sortOptions = computed(() =>
  ENTERPRISE_SORT_ORDER.map((code) => ({
    value: code,
    label: code === 'recognition' ? '认定年排序' : (ENTERPRISE_SORT_LABELS[code] ?? code),
    hint: ENTERPRISE_SORT_HINTS[code] ?? '',
  })),
)

/**
 * 生效中的条件摊平成一行,每项可单独撤掉。
 *
 * `source` / `eventType` / `rosterState` **没有常驻控件**(它们来自 `/stats` 的下钻),
 * 但一直在 state 里生效 —— 所以必须出现在这一行里。不出现在这里,它们就是**静默筛选**:
 * 地址栏里带着、页面上看不见、也清不掉。
 */
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
    key: 'title' | 'source' | 'eventType' | 'year' | 'diffStatus',
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
    ...s.diffStatus.map((v) => ({
      key: `diffStatus:${v}`,
      label: `差异状态 · ${rosterDifferenceFilterLabel(v)}`,
      clear: () => without('diffStatus', v),
    })),
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
    ...(s.rosterState
      ? [
          {
            key: 'rosterState',
            label: `总表状态 · ${s.rosterState === 'current' ? '当前总表' : '仅平台引入(已移除)'}`,
            clear: () => patch('rosterState', ''),
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

const filtered = computed(() => activeFilters.value.length > 0)

function clearFilters() {
  search.value = ''
  state.value = { ...EMPTY_LEDGER_STATE }
}

const exportUrl = computed(() => ledgerExportUrl(state.value))

// —— 排序 / 每页条数(都是显示偏好,不是筛选)——
const sortModel = computed({
  get: () => state.value.sort,
  set: (v: string) => {
    state.value = { ...state.value, sort: v as LedgerState['sort'] }
  },
})

function setPageSize(n: number) {
  pageSize.value = clampSize(Math.trunc(n) || DEFAULT_PAGE_SIZE)
  page.value = 1
}

useHead({
  title: computed(() => {
    const n = total.value ? `${total.value.toLocaleString('zh-CN')} 家企业` : '加载中'
    return `${ENTERPRISE_LIST_TITLE} · ${n}`
  }),
})
</script>

<template>
  <div class="ledger-page flex min-w-0 flex-col gap-2 sm:gap-3">
    <!-- 页头:页面名 + 总数(左)· 搜索(右)。设计稿的第 1 行。 -->
    <div class="flex flex-wrap items-center justify-start gap-x-4 gap-y-2">
      <h1 class="flex items-baseline gap-2 text-[15px] leading-6 font-semibold">
        {{ ENTERPRISE_LIST_TITLE }}
        <span class="text-muted-foreground text-xs font-normal tabular-nums" aria-live="polite">
          {{ total ? total.toLocaleString('zh-CN') : '—' }}
        </span>
      </h1>
      <div class="relative w-full sm:w-72">
        <Search
          class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
        />
        <Input
          v-model="search"
          class="bg-card h-8 pl-8 shadow-none"
          placeholder="搜索企业名称或统一社会信用代码"
          aria-label="按企业名称、已确认曾用名或统一社会信用代码搜索"
        />
      </div>
    </div>

    <!-- 筛选:压成一行。设计稿的第 2 行。 -->
    <div class="flex flex-wrap items-center gap-2">
      <MultiSelectFilter
        v-model="state.title"
        :options="titleOptions"
        placeholder="全部称号"
        summary-prefix="称号"
        class="w-28 shadow-none"
      />
      <Select v-model="districtModel">
        <SelectTrigger
          size="sm"
          class="bg-card data-[active=true]:border-primary/45 data-[active=true]:bg-accent data-[active=true]:text-accent-foreground w-28 shadow-none active:scale-[0.98] transition-transform duration-150 ease-snap motion-reduce:transition-none motion-reduce:active:scale-100"
          :data-active="state.district !== ''"
          aria-label="按属地筛选"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent class="shadow-none">
          <SelectItem :value="ALL_DISTRICTS">全部属地</SelectItem>
          <SelectItem v-for="d in districtOptions" :key="d" :value="d">{{ d }}</SelectItem>
        </SelectContent>
      </Select>
      <MultiSelectFilter
        v-model="state.diffStatus"
        :options="statusOptions"
        placeholder="全部差异状态"
        summary-prefix="差异"
        class="w-32 shadow-none"
      />
      <MultiSelectFilter
        v-model="state.year"
        :options="yearOptions"
        placeholder="全部年份"
        summary-prefix="年份"
        class="w-28 shadow-none"
      />
      <Select v-model="sortModel">
        <SelectTrigger
          size="sm"
          class="bg-card data-[active=true]:border-primary/45 data-[active=true]:bg-accent data-[active=true]:text-accent-foreground w-32 shadow-none active:scale-[0.98] transition-transform duration-150 ease-snap motion-reduce:transition-none motion-reduce:active:scale-100"
          :data-active="state.sort !== DEFAULT_SORT"
          aria-label="排序方式"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent class="shadow-none">
          <SelectItem v-for="opt in sortOptions" :key="opt.value" :value="opt.value" :title="opt.hint">
            {{ opt.label }}
          </SelectItem>
        </SelectContent>
      </Select>

      <Button as-child variant="outline" size="sm" class="ml-auto">
        <a :href="exportUrl"><ExternalLink class="size-3.5" />{{ LEDGER_EXPORT_LABEL }}</a>
      </Button>
    </div>

    <!-- 生效中的条件:一个都不许藏着(见 `activeFilters` 的注释)。 -->
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


    <Alert v-if="error" variant="destructive">
      <AlertTitle>企业列表加载失败</AlertTitle>
      <AlertDescription
        ><Button variant="outline" size="sm" @click="retry()">重试</Button></AlertDescription
      >
    </Alert>

    <Card class="gap-0 overflow-hidden py-0 shadow-none">
      <CardContent class="relative p-0">
        <TableLoadingStatus kind="ledger" :loading="isLoading" label="正在搜索…" />
        <EnterpriseListTable
          :rows="rows"
          :loading="isLoading"
          :has-error="!!error"
          :selected-id="selected"
          :filtered="filtered"
          @select="selectRow"
          @clear-filters="clearFilters"
        />
      </CardContent>
    </Card>

    <TablePagination :page="page" :page-size="pageSize" :total="total" unit="家企业" @update:page="setPage" @update:page-size="setPageSize">
      共 {{ total.toLocaleString('zh-CN') }} 家 · 差异 {{ counts.differences.toLocaleString('zh-CN') }} 条
    </TablePagination>

    <!--
      抽屉(三处基本动效之三:滑出)。**非模态**:开着它照样能看表、能接着点别的行
      —— 设计稿里被选中的那一行是亮着的,表格没有变暗。
    -->
    <EnterpriseDrawer
      :enterprise-id="selected"
      :back-query="backQuery"
      :return-focus-target="drawerReturnFocusTarget"
      @close="closeDrawer"
    />
  </div>
</template>

<style scoped>
.ledger-page :deep([data-slot='button']) {
  box-shadow: none;
}

.ledger-page :deep(.text-xs) {
  font-size: 13px;
  line-height: 1.5;
}

</style>
