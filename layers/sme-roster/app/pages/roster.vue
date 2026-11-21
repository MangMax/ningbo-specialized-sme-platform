<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { useQuery } from '@pinia/colada'
import { shouldNuxtScrollToTop, useEvidencePreviewScrollRestore } from '#sme-roster/lib/roster/evidence-preview-return'
import { createReusableTemplate, useMediaQuery, watchDebounced } from '@vueuse/core'
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
  FIRST_RECOGNITION_STATUSES,
  FIRST_RECOGNITION_STATUS_ORDER,
  SOURCES,
  TITLES,
  TITLE_ORDER,
  TITLE_SHORT,
} from '#sme-roster/lib/labels'
import { NINGBO_DISTRICTS, NINGBO_INDEPENDENT_ZONES } from '#sme-roster/lib/domain'
import {
  DEFAULT_SORT,
  EMPTY_LEDGER_STATE,
  LEDGER_EXPORT_LABEL,
  ledgerExportUrl,
  ledgerListQuery,
  ledgerStateFromQuery,
  ledgerYearOptions,
  type LedgerState,
} from '#sme-roster/lib/roster/ledger-view'
import { ROSTER_DIFFERENCE_FILTER_OPTIONS, rosterDifferenceFilterLabel } from '#sme-roster/lib/roster/ledger-contract'
import { captureQueryRequest, useRetainedQuerySnapshot } from '#core/app/composables/useRetainedQuerySnapshot'
import type { QueryRequestSnapshot } from '#core/app/composables/useRetainedQuerySnapshot'
import RosterEnterpriseDrawer from '#sme-roster/app/components/EnterpriseDrawer.vue'
import RosterEnterpriseDifferenceRefresh from '#sme-roster/app/components/EnterpriseDifferenceRefresh.vue'
import RosterEnterpriseListTable, {
  type EnterpriseListRow,
} from '#sme-roster/app/components/EnterpriseListTable.vue'
import DisclosurePanel from '#core/app/components/DisclosurePanel.vue'
import FilterChip from '#core/app/components/FilterChip.vue'
import MultiSelectFilter from '#core/app/components/MultiSelectFilter.vue'
import { Button } from '#core/app/components/ui/button'
import { Card, CardContent } from '#core/app/components/ui/card'
import { Input } from '#core/app/components/ui/input'

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#core/app/components/ui/select'


interface Counts {
  total: number
  titlePairs: number
  titles: Record<string, number>
  recognitionPairs: number
  differences: number
}

const apiGet = $fetch as unknown as <T>(
  url: string,
  opts?: { query?: Record<string, unknown> },
) => Promise<T>

definePageMeta({ scrollToTop: (to, from) => shouldNuxtScrollToTop(to.fullPath, from.path) })

const route = useRoute()
const router = useRouter()
const isNarrow = useMediaQuery('(max-width: 639px)')
const [DefineAdvancedFilters, ReuseAdvancedFilters] = createReusableTemplate()

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
const selected = computed(() => positiveInt(route.query.expand))
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
function toRouteQuery(expand = selected.value): Record<string, string> {
  const q = ledgerListQuery(state.value)
  if (page.value > 1) q.page = String(page.value)
  if (pageSize.value !== DEFAULT_PAGE_SIZE) q.pageSize = String(pageSize.value)
  if (expand != null) q.expand = String(expand)
  return q
}

/** 完整筛选串(含分页之外的一切),用于「详情页返回台账不丢上下文」。 */
const backQuery = computed(() => new URLSearchParams(toRouteQuery()).toString())

/**
 * Route writes are asynchronous. Ignore intermediate query updates from our own
 * replace() calls so the filters reflect the latest inputs while they settle.
 */
let pendingRouteQuery: string | null = null

watch(
  [state, page, pageSize],
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
  },
  { deep: true },
)

function closeDrawer() {
  const destination = { path: route.path, query: toRouteQuery(null), hash: route.hash }
  if (router.options.history.state.rosterDrawerBack === router.resolve(destination).fullPath) {
    router.back()
  } else {
    void router.replace({ ...destination, state: { rosterDrawerBack: null } })
  }
}

/** 筛选一变就回到第一页(页码不是筛选,不参与这个信号)。 */
const filterSignature = computed(() => normalize(ledgerListQuery(state.value)))
watch(filterSignature, (next, prev) => {
  if (next === prev) return
  page.value = 1
}, { flush: 'sync' })

// —— 取数 ——
const listQuery = computed(() => ({
  ...ledgerListQuery(state.value),
  page: page.value,
  pageSize: pageSize.value,
}))
type LedgerListQueryParams = typeof listQuery.value
type LedgerListQueryResult = {
  rows: EnterpriseListRow[]
  counts: Counts
  request: QueryRequestSnapshot<LedgerListQueryParams>
}

const activeRequest = computed(() => captureQueryRequest('ledger-enterprises', listQuery.value))
const activeRequestKey = computed(() => activeRequest.value.key)

const { data, isLoading, error, refetch } = useQuery<LedgerListQueryResult>({
  key: () => ['ledger-enterprises', listQuery.value],
  query: async ({ entry }) => {
    // Read the immutable params belonging to this cache entry. Reactive page or
    // filter refs may already have moved by the time this async query executes.
    const request = captureQueryRequest('ledger-enterprises', entry.key[1] as typeof listQuery.value)
    const response = await apiGet<{ rows: EnterpriseListRow[]; counts: Counts }>(
      '/api/roster/enterprises',
      { query: request.params },
    )
    return { ...response, request }
  },
  // 换条件时**留住上一批行**:表体只轻微浮起,不清空 —— 空表会让用户以为「筛没了」。
  placeholderData: (previous) => previous,
})

const {
  displayed: displayedResult,
  paginationDisabled,
  failureDescription,
} = useRetainedQuerySnapshot<LedgerListQueryParams, LedgerListQueryResult>(data, isLoading, error, activeRequest)
const rows = computed<EnterpriseListRow[]>(() => displayedResult.value?.rows ?? [])
const displayedEnterpriseIds = computed(() => rows.value.map(row => row.enterpriseId))
const returnRowsReady = computed(() => !isLoading.value && (displayedResult.value?.request.key === activeRequestKey.value || error.value != null))
useEvidencePreviewScrollRestore(returnRowsReady)
const total = computed(() => displayedResult.value?.counts.total ?? 0)
const displayedPage = computed(() => displayedResult.value?.request.page ?? page.value)
const displayedPageSize = computed(() => displayedResult.value?.request.pageSize ?? pageSize.value)
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / displayedPageSize.value)))

/** 只在成功响应结算后纠正页码并清理已离开结果集的选择。失败响应不能把页码退回 1。 */
watch([data, activeRequestKey, isLoading, error], ([result, key, loading, failure]) => {
  if (!result || result.request.key !== key || loading || failure) return
  const maxPage = Math.max(1, Math.ceil(result.counts.total / result.request.pageSize))
  if (page.value > maxPage) {
    page.value = maxPage
    return
  }
  if (selected.value == null) return
  if (!result.rows.some((row) => row.enterpriseId === selected.value)) {
    drawerReturnFocusTarget.value = null
    closeDrawer()
  }
}, { flush: 'post' })

function retry() {
  refetch()
}
function setPage(n: number) {
  page.value = Math.min(Math.max(1, n), totalPages.value)
}
async function selectRow(id: number, trigger: HTMLButtonElement | null) {
  if (id === selected.value) return
  drawerReturnFocusTarget.value = trigger
  const base = { path: route.path, query: toRouteQuery(null), hash: route.hash }
  const destination = { ...base, query: toRouteQuery(id) }
  if (selected.value != null) {
    await router.replace(destination)
    return
  }
  if (normalize(base.query) !== normalize(route.query)) await router.replace(base)
  await router.push({ ...destination, state: { rosterDrawerBack: router.resolve(base).fullPath } })
}

// —— 筛选项 ——
const titleOptions = computed(() =>
  TITLE_ORDER.map((code) => ({ value: code, label: TITLES[code] ?? code, short: TITLE_SHORT[code] })),
)
const { data: ledgerYears } = useQuery({
  key: () => ['roster-ledger-years'],
  query: () => apiGet<{ eventYears: number[]; firstRecognitionYears: number[] }>('/api/roster/ledger-years'),
})
const yearOptions = computed(() => ledgerYearOptions(
  (ledgerYears.value?.eventYears ?? []).map(String),
  state.value.year,
))
const firstYearOptions = computed(() => ledgerYearOptions(
  (ledgerYears.value?.firstRecognitionYears ?? []).map(String),
  state.value.firstYear,
))
const firstStatusOptions = computed(() =>
  FIRST_RECOGNITION_STATUS_ORDER.map(code => ({
    value: code,
    label: FIRST_RECOGNITION_STATUSES[code] ?? code,
  })),
)
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
    key: 'title' | 'source' | 'eventType' | 'year' | 'firstYear' | 'firstStatus' | 'diffStatus',
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
    ...s.firstYear.map((v) => ({
      key: `firstYear:${v}`,
      label: `首次认定年 · ${v}`,
      clear: () => without('firstYear', v),
    })),
    ...s.firstStatus.map((v) => ({
      key: `firstStatus:${v}`,
      label: `首次认定 · ${FIRST_RECOGNITION_STATUSES[v] ?? v}`,
      clear: () => without('firstStatus', v),
    })),
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

useHead({ title: ENTERPRISE_LIST_TITLE })
</script>

<template>
  <div class="workspace-list ledger-page flex min-w-0 flex-col gap-2 sm:gap-3">
    <DefineAdvancedFilters>
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
      <MultiSelectFilter
        v-model="state.firstYear"
        :options="firstYearOptions"
        placeholder="首次认定年份"
        summary-prefix="首次认定"
        class="w-32 shadow-none"
      />
      <MultiSelectFilter
        v-model="state.firstStatus"
        :options="firstStatusOptions"
        placeholder="首次认定状态"
        summary-prefix="首次认定"
        class="w-32 shadow-none"
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
    </DefineAdvancedFilters>
    <PageHeader :title="ENTERPRISE_LIST_TITLE" />

    <Card class="paginated-table-card min-w-0 gap-0 overflow-hidden py-0 shadow-none">
      <div role="region" aria-label="企业列表筛选" tabindex="0" class="table-toolbar workspace-list-filter flex flex-col gap-3">
        <div class="flex min-w-0 flex-wrap items-start gap-2">
          <div data-testid="ledger-filters" class="flex min-w-0 flex-wrap items-center gap-2">
            <div class="relative w-full sm:w-72">
              <Search
                class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
                aria-hidden="true"
              />
              <Input
                v-model="search"
                class="bg-card h-8 pl-8 shadow-none"
                placeholder="企业名称、曾用名或信用代码"
                aria-label="按企业名称、已确认曾用名或统一社会信用代码搜索"
              />
            </div>
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
            <ReuseAdvancedFilters v-if="!isNarrow" />
          </div>
          <div class="ml-auto flex flex-wrap items-center justify-end gap-2" role="group" aria-label="企业列表操作">
            <RosterEnterpriseDifferenceRefresh :enterprise-ids="displayedEnterpriseIds" :disabled="isLoading || !!error" @refreshed="refetch()" />
            <Button as-child variant="outline" size="sm">
              <a :href="exportUrl"><ExternalLink class="size-3.5" aria-hidden="true" />{{ LEDGER_EXPORT_LABEL }}</a>
            </Button>
          </div>
        </div>
        <DisclosurePanel v-if="isNarrow" compact :heading-level="2" title="更多筛选与排序">
          <div class="flex flex-wrap items-center gap-2"><ReuseAdvancedFilters /></div>
        </DisclosurePanel>

        <TransitionGroup
          v-if="activeFilters.length"
          tag="div"
          class="flex flex-wrap items-center gap-1.5"
          enter-active-class="transition duration-150 ease-snap motion-reduce:transition-none"
          enter-from-class="scale-90 opacity-0"
          leave-active-class="transition duration-100 ease-snap motion-reduce:transition-none"
          leave-to-class="scale-90 opacity-0"
          move-class="transition duration-150 ease-snap motion-reduce:transition-none"
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
      <CardContent class="paginated-table-body relative flex min-h-0 flex-col p-0">
        <TableLoadingStatus kind="ledger" :loading="isLoading" label="正在搜索…" />
        <TableFailureState v-if="error" title="企业列表暂时无法加载" :compact="!!displayedResult" :pending="isLoading" :description="failureDescription" @retry="retry" />
        <RosterEnterpriseListTable
          v-if="!error || displayedResult"
          :rows="rows"
          :loading="isLoading"
          :has-error="!!error && !displayedResult"
          :selected-id="selected"
          :filtered="filtered"
          @select="selectRow"
          @clear-filters="clearFilters"
        />
      </CardContent>
      <TablePagination in-card v-if="displayedResult" :page="displayedPage" :page-size="displayedPageSize" :total="total" :loading="paginationDisabled" unit="家" @update:page="setPage" @update:page-size="setPageSize" />
    </Card>

    <!--
      抽屉(三处基本动效之三:滑出)。**非模态**:开着它照样能看表、能接着点别的行
      —— 设计稿里被选中的那一行是亮着的,表格没有变暗。
    -->
    <RosterEnterpriseDrawer
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
