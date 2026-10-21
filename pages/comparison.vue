<script setup lang="ts">
import { parseComparisonRouteFilters } from '~~/lib/comparison-route'
import ComparisonRowDetails from '@/components/ComparisonRowDetails.vue'
import ComparisonSummaryAssessment from '@/components/ComparisonSummaryAssessment.vue'
import type { ComparisonSummaryRow } from '~~/lib/comparison-summary'
import EvidenceReviewList from '@/components/evidence-review/EvidenceReviewList.vue'
import { useQuery, useQueryCache } from '@pinia/colada'
import { computed, nextTick, provide, shallowRef, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router'
import { GitCompareArrows, Search } from '@lucide/vue'
import type {
  ComparisonCounts,
  ComparisonDirection,
} from '~~/lib/comparison'
import { useScrollEdges } from '~~/lib/scroll-edges'
import { captureQueryRequest, useRetainedQuerySnapshot } from '~/composables/useRetainedQuerySnapshot'
import { rememberEvidencePreviewReturn, useEvidencePreviewScrollRestore, shouldNuxtScrollToTop } from '~~/lib/roster/evidence-preview-return'
import type { QueryRequestSnapshot } from '~/composables/useRetainedQuerySnapshot'
import { NINGBO_DISTRICTS, NINGBO_INDEPENDENT_ZONES } from '~~/lib/domain'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import {
  TITLES,
  TITLE_ORDER,
  COMPARISON_LABELS,
  COMPARISON_OTHER_SIDE,
  COMPARISON_NO_USCC,
} from '~~/lib/labels'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import RecordComparisonPanel from '@/components/record-correspondence/RecordComparisonPanel.vue'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { REVIEW_DRAFTS_KEY, useReviewDrafts } from '~/composables/useReviewDrafts'

definePageMeta({
  // 同一页内的分类 / 翻页是「换结果」而不是「换页面」：保留滚动位置，
  // 由记录级面板把视口落到结果标题，筛选后不会被重置到页顶。
  scrollToTop: (to, from) => to.path === '/comparison' && from.path === '/comparison'
    ? false
    : shouldNuxtScrollToTop(to.fullPath, from.path),
})

const route = useRoute()
const router = useRouter()
const mode = computed(() => route.query.mode === 'review' ? 'review' : route.query.mode === 'legacy' ? 'legacy' : 'record')
function setMode(value: string) { void router.push({ path: '/comparison', query: { ...route.query, mode: value } }) }

/**
 * 待复核队列的未提交草稿由本页（route 组件）持有：队列卸载时草稿仍能按
 * 条目保存；只有本页整体离开或同页切走 review 才需要确认。
 *
 * `onBeforeRouteLeave` 必须注册在 route 组件这一层：嵌套普通组件里的同名
 * hook 依赖 RouterView 注入的 matched record，跨层时可能根本注册不上。
 */
const reviewDrafts = useReviewDrafts()
provide(REVIEW_DRAFTS_KEY, reviewDrafts)
const pendingLeave = shallowRef<string | null>(null)
/** 子级（收起/换条目/筛选…）已有确认框时，路由守卫只取消导航，不再叠第二个 dialog。 */
const childDraftGuardOpen = shallowRef(false)
const bypassLeaveGuard = shallowRef(false)

function requestReviewLeave(target: string): boolean {
  if (bypassLeaveGuard.value || !reviewDrafts.hasDirty.value) return true
  if (pendingLeave.value || childDraftGuardOpen.value) return false
  pendingLeave.value = target
  return false
}
onBeforeRouteLeave(to => requestReviewLeave(to.fullPath))
onBeforeRouteUpdate((to) => {
  // 同页筛选/翻页会写回 query，但 review 仍挂载，草稿不会丢：不拦。
  if (mode.value !== 'review' || to.query.mode === 'review') return true
  return requestReviewLeave(to.fullPath)
})
function continueReviewDraft() {
  pendingLeave.value = null
}
function discardReviewDraftAndLeave() {
  const target = pendingLeave.value
  pendingLeave.value = null
  if (!target) return
  // 明确丢弃才执行原导航；业务草稿随内存删除，不写 Web Storage。
  reviewDrafts.discardAll()
  bypassLeaveGuard.value = true
  void router.push(target).finally(() => { bypassLeaveGuard.value = false })
}

const COMPARISON_DIRECTIONS = Object.keys(
  COMPARISON_LABELS,
) as ComparisonDirection[]
const titles = TITLE_ORDER
const initialFilters = parseComparisonRouteFilters(route.query)
const title = shallowRef(initialFilters.title)
const direction = shallowRef(initialFilters.direction)
const q = shallowRef(initialFilters.q)
const district = shallowRef(initialFilters.district)
const page = shallowRef(initialFilters.page)
const showCurated = shallowRef(initialFilters.showCurated)
const queryCache = useQueryCache()
const pageSize = shallowRef(initialFilters.pageSize)
const ALL_DISTRICTS = '__all__'
const districtOptions = [...NINGBO_DISTRICTS, ...NINGBO_INDEPENDENT_ZONES]
const districtModel = computed({
  get: () => district.value || ALL_DISTRICTS,
  set: (value: string) => { district.value = value === ALL_DISTRICTS ? '' : value },
})
let restoringRoute = false
watch(
  [title, direction, q, district, showCurated],
  () => {
    if (!restoringRoute) page.value = 1
  },
  { flush: 'sync' },
)
const params = computed(() => ({
  view: 'summary' as const,
  title: title.value,
  direction: direction.value,
  q: q.value,
  district: district.value,
  page: page.value,
  pageSize: pageSize.value,
  showCurated: showCurated.value,
}))
// Persist the legacy result coordinate for enterprise/source return navigation.
watch(params, (value) => {
  if (mode.value !== 'legacy' || restoringRoute) return
  const { view: _view, ...filters } = value
  const query = { ...route.query, mode: 'legacy', ...Object.fromEntries(Object.entries(filters).map(([key, entry]) => [key, String(entry)])) }
  if (Object.entries(query).every(([key, entry]) => route.query[key] === entry)) return
  void router.replace({ path: '/comparison', query })
})
watch(() => route.query, () => {
  if (mode.value !== 'legacy') return
  restoringRoute = true
  const filters = parseComparisonRouteFilters(route.query)
  title.value = filters.title
  direction.value = filters.direction
  q.value = filters.q
  district.value = filters.district
  showCurated.value = filters.showCurated
  pageSize.value = filters.pageSize
  page.value = filters.page
  restoringRoute = false
})
type ComparisonQueryParams = typeof params.value
type ComparisonApiResponse = {
  rows: ComparisonSummaryRow[]
  total: number
  counts: ComparisonCounts
  curatedCounts: ComparisonCounts
  reconcile: { generatedAt: string | null; matched: number }
  platform: { withEvidence: number; withExplanation: number; withoutExplanation: number }
}
type ComparisonQueryResult = ComparisonApiResponse & {
  request: QueryRequestSnapshot<ComparisonQueryParams>
}
const activeRequest = computed(() => captureQueryRequest('comparison', params.value))

/**
 * 页面标题(RL-17 收尾)。全仓原先没有一处设过 `document.title`,所以标签页/历史记录/书签
 * 一律是空白。这里按「具体 → 页面名」的同一形状写:当前称号 + 当前方向的短标签,
 * 多开几个标签时能一眼认出是哪一个。
 */
useHead({
  title: computed(
    () =>
      mode.value === 'review' ? '待复核队列' : mode.value === 'record' ? '记录级对比 · 正式事件与平台原行' : `旧版比对 · ${TITLES[title.value] ?? title.value} · ${
        COMPARISON_LABELS[direction.value] ?? direction.value
      }`,
  ),
})
const { data, isLoading, error, refetch } = useQuery<ComparisonQueryResult>({
  enabled: () => mode.value === 'legacy',
  key: () => ['comparison', params.value],
  query: async ({ entry }) => {
    const request = captureQueryRequest('comparison', entry.key[1] as typeof params.value)
    const response = await $fetch<ComparisonApiResponse>('/api/comparison', { query: request.params })
    return { ...response, request }
  },
  placeholderData: (previous) => previous,
})
const {
  displayed: displayedResult,
  hasCurrentSnapshot,
  paginationDisabled,
  failureDescription,
} = useRetainedQuerySnapshot<ComparisonQueryParams, ComparisonQueryResult>(data, isLoading, error, activeRequest)
const rows = computed<ComparisonApiResponse['rows']>(() => displayedResult.value?.rows ?? [])
const selectedRow = shallowRef<ComparisonSummaryRow | null>(null)
// 宽表在窄屏下保留容器内横向滚动;边缘渐隐提示还有列可读。
const scroller = shallowRef<HTMLElement | null>(null)
const { edges, bars, measure } = useScrollEdges(scroller)
useEvidencePreviewScrollRestore(computed(() => mode.value === 'legacy' && hasCurrentSnapshot.value && !isLoading.value))
// 表体从骨架/空态换成真实表格时内容宽度会变,重算一次。
watch([rows, isLoading], () => {
  void nextTick(measure)
})

async function refreshCuration() {
  await queryCache.invalidateQueries({ key: ['comparison'] })
  if (error.value || !hasCurrentSnapshot.value) return
  if (page.value > totalPages.value) page.value = totalPages.value
}
const totalPages = computed(() =>
  Math.max(1, Math.ceil((displayedResult.value?.total ?? 0) / (displayedResult.value?.request.pageSize ?? pageSize.value))),
)
const displayedPage = computed(() => displayedResult.value?.request.page ?? page.value)
const displayedPageSize = computed(() => displayedResult.value?.request.pageSize ?? pageSize.value)
const activeFilters = computed(() => [
  ...(q.value.trim() ? [{ key: 'q', label: `搜索：${q.value.trim()}` }] : []),
  ...(district.value ? [{ key: 'district', label: district.value }] : []),
])
function clearFilter(key: string) {
  if (key === 'q') q.value = ''
  if (key === 'district') district.value = ''
}
function clearAllFilters() {
  q.value = ''
  district.value = ''
}
function setPage(value: number) {
  page.value = Math.min(totalPages.value, Math.max(1, value))
  scroller.value?.scrollIntoView({ block: 'start', behavior: 'instant' })
}
function setPageSize(value: number) {
  pageSize.value = Math.min(200, Math.max(1, Math.trunc(value) || 25))
  page.value = 1
  scroller.value?.scrollIntoView({ block: 'start', behavior: 'instant' })
}
const TH_CLASS =
  'bg-muted text-muted-foreground sticky top-0 z-20 h-9 text-xs font-medium'
const exportUrl = computed(() => {
  const params = new URLSearchParams({
    mode: 'comparison',
    title: title.value,
    direction: direction.value,
    showCurated: showCurated.value ? 'true' : 'false',
  })
  if (q.value.trim()) params.set('q', q.value.trim())
  if (district.value) params.set('district', district.value)
  return `/api/export?${params}`
})
</script>

<template>
  <div class="flex min-w-0 flex-col gap-3">
    <Tabs :model-value="mode" @update:model-value="setMode(String($event))"><TabsList class="h-auto w-full flex-wrap justify-start gap-1" aria-label="比对口径"><TabsTrigger value="record">记录级对比</TabsTrigger><TabsTrigger value="legacy">旧版比对</TabsTrigger><TabsTrigger value="review">待复核队列</TabsTrigger></TabsList></Tabs>
    <RecordComparisonPanel v-if="mode === 'record'" />
    <EvidenceReviewList v-else-if="mode === 'review'" sync-query @guard-open="childDraftGuardOpen = $event" />
  <div v-else class="comparison-page flex min-w-0 flex-col gap-2 sm:gap-3">
    <PageHeader
      title="旧版比对 · 两侧名录对照"
    >
      <template #description>按企业 × 称号对照公布文件与平台导出；保留原核实与备注，不作为记录级事件结论。</template>
      <template #actions>
        <div class="flex items-center gap-2">
          <Switch id="show-curated" v-model="showCurated" class="shadow-none" />
          <Label for="show-curated">显示已核实</Label>
        </div>
        <Button as-child variant="outline" size="sm"
          ><a :href="exportUrl">导出当前方向</a></Button
        >
      </template>
    </PageHeader>

    <div
      data-testid="comparison-filters"
      class="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-8 lg:grid-cols-[minmax(16rem,1fr)_14rem_12rem_14rem]"
    >
      <div class="relative col-span-2 min-w-0 sm:col-span-8 lg:col-span-1">
        <Search class="text-muted-foreground absolute top-2 left-2.5 size-3.5" />
        <Input
          v-model="q"
          aria-label="搜索企业名称、已确认曾用名或统一社会信用代码"
          placeholder="搜索企业名称、曾用名或统一社会信用代码"
          class="bg-card h-8 pl-8 shadow-none"
        />
      </div>
      <Select v-model="title">
        <SelectTrigger size="sm" class="bg-card col-span-1 w-full min-w-0 shadow-none transition-transform duration-150 ease-snap active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100 sm:col-span-2 lg:col-span-1" aria-label="按称号筛选">
          <SelectValue class="min-w-0 flex-1" />
        </SelectTrigger>
        <SelectContent class="shadow-none">
          <SelectItem v-for="code in titles" :key="code" :value="code">{{ TITLES[code] }}</SelectItem>
        </SelectContent>
      </Select>
      <Select v-model="districtModel">
        <SelectTrigger size="sm" class="bg-card col-span-1 w-full min-w-0 px-2 shadow-none transition-transform duration-150 ease-snap active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100 sm:col-span-2 lg:col-span-1" aria-label="按区县筛选">
          <SelectValue class="min-w-0 flex-1" />
        </SelectTrigger>
        <SelectContent class="shadow-none">
          <SelectItem :value="ALL_DISTRICTS">全部区县</SelectItem>
          <SelectItem v-for="item in districtOptions" :key="item" :value="item">{{ item }}</SelectItem>
        </SelectContent>
      </Select>
      <div class="col-span-2 min-w-0 sm:col-span-4 lg:col-span-1" data-testid="comparison-direction-filter">
        <Select v-model="direction">
          <SelectTrigger
            size="sm"
            class="bg-card w-full min-w-0 px-2 shadow-none transition-transform duration-150 ease-snap active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100"
            aria-label="按比对方向筛选"
          >
            <SelectValue class="min-w-0 flex-1 text-left" />
          </SelectTrigger>
          <SelectContent class="shadow-none">
            <SelectItem v-for="d in COMPARISON_DIRECTIONS" :key="d" :value="d">
              {{ COMPARISON_LABELS[d] }}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>

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
      <Button
        v-for="filter in activeFilters"
        :key="filter.key"
        variant="secondary"
        size="sm"
        class="h-6 max-w-full gap-1 px-2 text-xs active:scale-[0.98] transition-transform duration-150 ease-snap"
        :aria-label="`移除筛选：${filter.label}`"
        @click="clearFilter(filter.key)"
      >
        <span class="truncate">{{ filter.label }}</span><span aria-hidden="true">×</span>
      </Button>
      <Button
        key="clear"
        variant="ghost"
        size="sm"
        class="h-6 px-1.5 text-xs"
        @click="clearAllFilters"
      >清除全部</Button>
    </TransitionGroup>

    <div class="flex min-w-0 flex-col gap-2">
      <div class="flex min-w-0 flex-col gap-2" data-testid="comparison-results">
            <Card class="min-w-0 gap-0 overflow-hidden py-0 shadow-none">
              <CardContent class="relative p-0">
                <TableLoadingStatus kind="comparison" :loading="isLoading" label="正在搜索与加载比对结果…" />
                <TableFailureState v-if="error" title="比对结果暂时无法加载" :compact="rows.length > 0" :pending="isLoading" :description="failureDescription" @retry="refetch()" />
                <!-- 宽表在容器内横向滚动,窄屏收在当前视口中。 -->
                <div v-if="!error || rows.length > 0" class="relative min-w-0">
                  <div
                    ref="scroller"
                    data-evidence-return-scroll-container
                    tabindex="0"
                    role="region"
                    aria-label="比对结果表格(可横向滚动)"
                    data-testid="comparison-table-scroll"
                    class="data-table-scroll scroll-mt-16 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/30 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar]:h-1.5 [&_[data-slot=table-container]]:overflow-visible"
                    :aria-busy="isLoading"
                  >
                  <Empty v-if="!isLoading && !error && !rows.length" class="h-full">
                    <EmptyHeader>
                      <EmptyMedia variant="icon"><GitCompareArrows /></EmptyMedia>
                      <EmptyTitle>没有匹配的企业</EmptyTitle>
                      <EmptyDescription>当前筛选条件下没有匹配结果。</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                  <Table v-else class="data-table w-full min-w-0 table-fixed sm:min-w-[1090px]">
                    <TableHeader>
                      <TableRow class="hover:bg-transparent">
                        <TableHead :class="[TH_CLASS, 'w-[38%] sm:w-[320px] md:w-[28%]']"
                          >企业名称</TableHead
                        >
                        <TableHead :class="[TH_CLASS, 'hidden w-[165px] sm:table-cell']"
                          >统一社会信用代码</TableHead
                        >
                        <TableHead :class="[TH_CLASS, 'hidden w-[72px] sm:table-cell']">区县</TableHead>
                        <TableHead :class="[TH_CLASS, 'hidden w-[108px] sm:table-cell']"
                          >另一侧状态</TableHead
                        >
                        <TableHead :class="[TH_CLASS, 'hidden w-[200px] sm:table-cell']">
                          平台解释
                        </TableHead>
                        <TableHead :class="[TH_CLASS, 'hidden w-[230px] sm:table-cell']">
                          平台记录
                        </TableHead>
                        <TableHead :class="[TH_CLASS, 'hidden w-[190px] sm:table-cell']">核实与备注</TableHead>
                        <TableHead colspan="6" :class="[TH_CLASS, 'w-[62%] sm:hidden']">比对、原因与证据</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody
                      class="transition-transform duration-200 ease-snap will-change-transform motion-reduce:transition-none"
                      :class="isLoading ? '-translate-y-0.5' : 'translate-y-0'"
                      :data-loading="isLoading ? 'true' : 'false'"
                    >
                      <template v-if="isLoading && !rows.length">
                        <TableRow v-for="i in 8" :key="i" class="h-11">
                          <TableCell><Skeleton class="h-4 w-full" /></TableCell>
                          <TableCell colspan="6" class="sm:hidden"><Skeleton class="h-4 w-full" /></TableCell>
                          <TableCell v-for="j in 6" :key="j" class="hidden sm:table-cell"><Skeleton class="h-4 w-full" /></TableCell>
                        </TableRow>
                      </template>
                      <TableRow
                        v-for="row in rows"
                        v-else
                        :key="`${row.enterpriseId}-${row.titleCode}-${row.direction}`"
                        data-testid="comparison-record-row"
                        class="min-h-9 border-b-2 border-border sm:border-b [&>td]:py-1 [&>td]:align-top"
                      >
                        <TableCell class="font-medium">
                          <NuxtLink
                            :to="`/enterprises/${row.enterpriseId}?returnTo=${encodeURIComponent(route.fullPath)}`"
                            @click="rememberEvidencePreviewReturn(route.fullPath, $event.currentTarget)"
                            :title="row.name"
                            data-testid="comparison-enterprise-name"
                            class="block whitespace-normal break-words text-[13px] leading-4 hover:text-primary hover:underline"
                            >{{ row.name }}</NuxtLink
                          >
                          <Badge v-if="row.platform.confirmedAliasCount" variant="quiet" class="mt-1 max-w-full whitespace-normal font-normal">已确认曾用名 {{ row.platform.confirmedAliasCount }} 个 · 展开查看</Badge>
                          <span v-if="!row.uscc" class="text-muted-foreground block whitespace-normal break-words text-[13px]">{{ COMPARISON_NO_USCC }}</span>
                        </TableCell>
                        <TableCell
                          class="text-muted-foreground hidden font-mono text-xs sm:table-cell"
                          >{{ row.uscc ?? '—' }}</TableCell
                        >
                        <TableCell class="text-muted-foreground hidden text-xs sm:table-cell">{{
                          row.district ?? '—'
                        }}</TableCell>
                        <TableCell class="text-muted-foreground hidden whitespace-normal break-words text-[13px] leading-4 sm:table-cell [overflow-wrap:anywhere]">{{
                          COMPARISON_OTHER_SIDE[row.direction]
                        }}</TableCell>
                        <TableCell class="hidden sm:table-cell">
                          <ComparisonSummaryAssessment :assessment="row.assessment" :disposition="row.platform.disposition" />
                        </TableCell>
                        <TableCell class="hidden sm:table-cell">
                          <p class="text-muted-foreground text-[13px] leading-5">{{ row.platform.queryCount }} 次查询 · {{ row.platform.sourceRelationCount }} 条来源行</p>
                        </TableCell>
                        <TableCell class="hidden sm:table-cell">
                          <div class="flex flex-col items-start gap-1"><span class="text-muted-foreground text-[13px]">{{ row.curated ? '已核实' : '待核实' }}</span><Button variant="link" size="sm" @click="selectedRow = row">展开原因、记录与备注</Button></div>
                        </TableCell>
                        <TableCell colspan="6" class="whitespace-normal sm:hidden">
                          <div class="flex min-w-0 flex-col gap-1" data-testid="comparison-mobile-details">
                            <div class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-border/50 pb-1 text-[13px] leading-5" data-testid="comparison-mobile-status-divider">
                              <span class="text-muted-foreground">{{ COMPARISON_OTHER_SIDE[row.direction] }}</span>
                              <ComparisonSummaryAssessment :assessment="row.assessment" :disposition="row.platform.disposition" />
                            </div>
                            <p class="text-muted-foreground text-[13px] leading-5">{{ row.platform.queryCount }} 次查询 · {{ row.platform.sourceRelationCount }} 条来源行</p>
                            <span class="text-muted-foreground text-[13px]">{{ row.curated ? '已核实' : '待核实' }}</span>
                            <Button variant="link" size="sm" class="h-auto justify-start whitespace-normal p-0 text-left" @click="selectedRow = row">展开原因、记录与备注</Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                  </div>
                  <!-- 用窄边线提示表格容器内仍可横向滚动，不覆盖或淡化数据文字。 -->
                  <div
                    v-show="edges.right"
                    data-testid="scroll-fade-right"
                    aria-hidden="true"
                    class="pointer-events-none absolute top-9 z-10 w-px bg-border"
                    :style="{ right: `${bars.vertical}px`, bottom: `${bars.horizontal}px` }"
                  />
                  <div
                    v-show="edges.left"
                    data-testid="scroll-fade-left"
                    aria-hidden="true"
                    class="pointer-events-none absolute top-9 left-0 z-10 w-px bg-border"
                    :style="{ bottom: `${bars.horizontal}px` }"
                  />
                </div>
              </CardContent>
            </Card>
            <TablePagination v-if="!error || rows.length > 0" data-testid="comparison-pagination" :page="displayedPage" :page-size="displayedPageSize" :total="displayedResult?.total ?? 0" unit="条" :loading="paginationDisabled" @update:page="setPage" @update:page-size="setPageSize" />

      </div>
    </div>
  </div>

  <ComparisonRowDetails @navigate="rememberEvidencePreviewReturn(route.fullPath, scroller)" :row="selectedRow" :return-to="route.fullPath" @close="selectedRow = null" @saved="refreshCuration" />
  <Dialog :open="pendingLeave !== null" @update:open="value => { if (!value) pendingLeave = null }">
    <DialogContent data-testid="comparison-draft-leave-dialog" class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>离开会丢弃未提交内容</DialogTitle>
        <DialogDescription>复核依据或更正内容还没提交；离开这一页会丢失。</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" @click="continueReviewDraft">继续填写</Button>
        <Button @click="discardReviewDraftAndLeave">离开并丢弃</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
  </div>
</template>

<style scoped>
.comparison-page :deep([data-slot='button']) {
  box-shadow: none;
}

.comparison-page :deep(.text-xs) {
  font-size: 13px;
  line-height: 1.5;
}

</style>
