<script setup lang="ts">
import { useQuery, useQueryCache } from '@pinia/colada'
import { computed, nextTick, shallowRef, watch } from 'vue'
import { ChevronLeft, ChevronRight, GitCompareArrows, Search } from '@lucide/vue'
import type {
  ComparisonCounts,
  ComparisonDirection,
} from '~~/lib/comparison'
import type { CuratedRow } from '~~/lib/curation'
import type { ComparisonPlatformEvidence } from '~~/lib/comparison-platform'
import type { ReconcileEntry } from '~~/lib/reconcile'
import { useScrollEdges } from '~~/lib/scroll-edges'
import { historicalAliasNamesForDisplay } from '~~/lib/roster/enterprise-name-display'
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
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'

const COMPARISON_DIRECTIONS = Object.keys(
  COMPARISON_LABELS,
) as ComparisonDirection[]
const titles = TITLE_ORDER
const title = shallowRef('specialized_sme')
const direction = shallowRef<ComparisonDirection>('missing_in_miit')
const q = shallowRef('')
const district = shallowRef('')
const page = shallowRef(1)
const showCurated = shallowRef(false)
const queryCache = useQueryCache()
const pageSize = 25
const ALL_DISTRICTS = '__all__'
const districtOptions = [...NINGBO_DISTRICTS, ...NINGBO_INDEPENDENT_ZONES]
const districtModel = computed({
  get: () => district.value || ALL_DISTRICTS,
  set: (value: string) => { district.value = value === ALL_DISTRICTS ? '' : value },
})
watch(
  [title, direction, q, district, showCurated],
  () => {
    page.value = 1
  },
  { flush: 'sync' },
)
const params = computed(() => ({
  title: title.value,
  direction: direction.value,
  q: q.value,
  district: district.value,
  page: page.value,
  pageSize,
  showCurated: showCurated.value,
}))

/**
 * 页面标题(RL-17 收尾)。全仓原先没有一处设过 `document.title`,所以标签页/历史记录/书签
 * 一律是空白。这里按「具体 → 页面名」的同一形状写:当前称号 + 当前方向的短标签,
 * 多开几个标签时能一眼认出是哪一个。
 */
useHead({
  title: computed(
    () =>
      `两侧名录比对 · ${TITLES[title.value] ?? title.value} · ${
        COMPARISON_LABELS[direction.value] ?? direction.value
      }`,
  ),
})
const { data, isLoading, error, refetch } = useQuery({
  key: () => ['comparison', params.value],
  query: () =>
    $fetch<{
      rows: (CuratedRow & { explanation: ReconcileEntry | null; platform: ComparisonPlatformEvidence })[]
      total: number
      counts: ComparisonCounts
      curatedCounts: ComparisonCounts
      reconcile: { generatedAt: string | null; matched: number }
      platform: { withEvidence: number; withExplanation: number; withoutExplanation: number }
    }>('/api/comparison', { query: params.value }),
  placeholderData: (previous) => previous,
})
const rows = computed(() => data.value?.rows ?? [])
/** 行上**已确认**的曾用名(待核实的不算 —— 契约 §1.2:`pending` 不参与搜索/归并)。 */
function confirmedAliasNames(row: { name: string; platform: ComparisonPlatformEvidence }): string[] {
  const aliases = row.platform.aliases.filter((alias) => alias.verificationStatus === 'confirmed')
  const historicalNames = new Set(historicalAliasNamesForDisplay(
    aliases.map((alias) => alias.name),
    row.name,
  ))
  return aliases.filter((alias) => historicalNames.has(alias.name)).map((alias) => alias.name)
}
// 宽表在窄屏下保留容器内横向滚动;边缘渐隐提示还有列可读。
const scroller = shallowRef<HTMLElement | null>(null)
const { edges, bars, measure } = useScrollEdges(scroller)
// 表体从骨架/空态换成真实表格时内容宽度会变,重算一次。
watch([rows, isLoading], () => {
  void nextTick(measure)
})

async function refreshCuration() {
  await queryCache.invalidateQueries({ key: ['comparison'] })
  if (page.value > totalPages.value) page.value = totalPages.value
}
const totalPages = computed(() =>
  Math.max(1, Math.ceil((data.value?.total ?? 0) / pageSize)),
)
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
  <div class="comparison-page flex min-w-0 flex-col gap-2">
    <PageHeader
      class="rise-in"
      title="两侧名录比对"
    >
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
      class="grid min-w-0 grid-cols-12 gap-2 lg:grid-cols-[minmax(16rem,1fr)_14rem_12rem_14rem]"
    >
      <div class="relative col-span-12 min-w-0 lg:col-span-1">
        <Search class="text-muted-foreground absolute top-2 left-2.5 size-3.5" />
        <Input
          v-model="q"
          aria-label="搜索企业名称、已确认曾用名或统一社会信用代码"
          placeholder="搜索企业名称、曾用名或统一社会信用代码"
          class="bg-card h-8 pl-8 shadow-none"
        />
      </div>
      <Select v-model="title">
        <SelectTrigger size="sm" class="bg-card col-span-5 w-full min-w-0 shadow-none transition-transform duration-150 ease-snap active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100 lg:col-span-1" aria-label="按称号筛选">
          <SelectValue />
        </SelectTrigger>
        <SelectContent class="shadow-none">
          <SelectItem v-for="code in titles" :key="code" :value="code">{{ TITLES[code] }}</SelectItem>
        </SelectContent>
      </Select>
      <Select v-model="districtModel">
        <SelectTrigger size="sm" class="bg-card col-span-3 w-full px-2 shadow-none transition-transform duration-150 ease-snap active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100 lg:col-span-1" aria-label="按区县筛选">
          <SelectValue />
        </SelectTrigger>
        <SelectContent class="shadow-none">
          <SelectItem :value="ALL_DISTRICTS">全部区县</SelectItem>
          <SelectItem v-for="item in districtOptions" :key="item" :value="item">{{ item }}</SelectItem>
        </SelectContent>
      </Select>
      <div class="col-span-4 min-w-0 lg:col-span-1" data-testid="comparison-direction-filter">
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
            <div class="relative h-5 shrink-0" aria-live="polite" data-testid="comparison-loading-status">
              <span v-if="isLoading" class="text-muted-foreground absolute top-0.5 left-0 text-[13px]">正在搜索与加载比对结果…</span>
              <span v-else class="text-muted-foreground absolute top-0.5 left-0 text-[13px] tabular-nums">共 {{ data?.total ?? 0 }} 条</span>
              <span v-if="isLoading" class="bg-muted absolute inset-x-0 bottom-0 block h-0.5 rounded-full">
                <span class="comparison-progress bg-primary block h-0.5 w-1/3 rounded-full" />
              </span>
            </div>
            <Alert v-if="error" variant="destructive">
              <AlertTitle>比对数据加载失败</AlertTitle>
              <AlertDescription
                ><Button variant="outline" size="sm" @click="refetch()"
                  >重试</Button
                ></AlertDescription
              >
            </Alert>
            <Card class="min-w-0 gap-0 overflow-hidden py-0 shadow-none">
              <CardContent class="p-0">
                <!-- 宽表在容器内横向滚动,窄屏收在当前视口中。 -->
                <div class="relative min-w-0">
                  <div
                    ref="scroller"
                    tabindex="0"
                    role="region"
                    aria-label="比对结果表格(可横向滚动)"
                    data-testid="comparison-table-scroll"
                    class="overflow-x-auto overflow-y-visible [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/30 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar]:h-1.5 [&_[data-slot=table-container]]:overflow-visible"
                    :aria-busy="isLoading"
                  >
                  <Empty v-if="!isLoading && !error && !rows.length" class="h-full">
                    <EmptyHeader>
                      <EmptyMedia variant="icon"><GitCompareArrows /></EmptyMedia>
                      <EmptyTitle>没有匹配的企业</EmptyTitle>
                      <EmptyDescription>当前筛选条件下没有匹配结果。</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                  <Table v-else class="w-full min-w-0 table-fixed sm:min-w-[1090px]">
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
                        <TableHead :class="[TH_CLASS, 'hidden w-[140px] sm:table-cell']">
                          平台解释
                        </TableHead>
                        <TableHead :class="[TH_CLASS, 'hidden w-[250px] sm:table-cell']">
                          平台证据
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
                        class="min-h-9 [&>td]:py-1 [&>td]:align-top"
                      >
                        <TableCell class="font-medium">
                          <NuxtLink
                            :to="`/enterprises/${row.enterpriseId}`"
                            :title="row.name"
                            data-testid="comparison-enterprise-name"
                            class="block whitespace-normal break-words text-[13px] leading-4 hover:text-primary hover:underline"
                            >{{ row.name }}</NuxtLink
                          >
                          <!-- 已确认曾用名压成单行,避免别名把比对行撑高。 -->
                          <div v-if="confirmedAliasNames(row).length" class="mt-1 hidden min-w-0 flex-nowrap gap-1 overflow-hidden sm:flex" data-testid="comparison-aliases">
                            <Badge variant="quiet" class="max-w-full truncate font-normal" :title="confirmedAliasNames(row)[0]">
                              曾用名 {{ confirmedAliasNames(row)[0] }}
                            </Badge>
                            <Badge v-if="confirmedAliasNames(row).length > 1" variant="quiet" class="shrink-0 font-normal">
                              +{{ confirmedAliasNames(row).length - 1 }}
                            </Badge>
                          </div>
                          <div v-if="(row.evidence.currentCity && row.evidence.currentCity !== '宁波市') || /注销|吊销/.test(row.evidence.regStatus ?? '') || !row.uscc" class="mt-1 flex flex-wrap gap-1">
                            <span v-if="row.evidence.currentCity && row.evidence.currentCity !== '宁波市'" class="text-muted-foreground text-[13px]">{{ row.evidence.currentCity }}</span>
                            <span v-if="/注销|吊销/.test(row.evidence.regStatus ?? '')" class="text-destructive text-[13px]">{{ row.evidence.regStatus }}</span>
                            <span v-if="!row.uscc" class="text-muted-foreground text-[13px]">{{ COMPARISON_NO_USCC }}</span>
                          </div>
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
                          <ComparisonReconcile :disposition="row.platform.disposition" :explanation="row.explanation" />
                        </TableCell>
                        <TableCell class="hidden sm:table-cell">
                          <ComparisonPlatformEvidence :evidence="row.platform" :enterprise-id="row.enterpriseId" :current-name="row.name" />
                        </TableCell>
                        <TableCell class="hidden sm:table-cell">
                          <ComparisonCuration :row="row" @saved="refreshCuration" />
                        </TableCell>
                        <TableCell colspan="6" class="whitespace-normal sm:hidden">
                          <div class="flex min-w-0 flex-col gap-1.5" data-testid="comparison-mobile-details">
                            <div class="border-b pb-1 text-[13px] leading-5">
                              <span class="text-muted-foreground">{{ COMPARISON_OTHER_SIDE[row.direction] }}</span>
                              <span class="text-muted-foreground px-1">·</span>
                              <ComparisonReconcile :disposition="row.platform.disposition" :explanation="row.explanation" />
                            </div>
                            <ComparisonPlatformEvidence :evidence="row.platform" :enterprise-id="row.enterpriseId" :current-name="row.name" />
                            <ComparisonCuration :row="row" :compact="true" @saved="refreshCuration" />
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
            <div data-testid="comparison-pagination" class="flex items-center justify-between gap-2">
              <span class="text-muted-foreground text-[13px] tabular-nums"
                >第 {{ page }} / {{ totalPages }} 页 · 每页
                {{ pageSize }} 条</span
              >
              <div class="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  :disabled="page <= 1 || isLoading"
                  aria-label="上一页"
                  @click="page--"
                  ><ChevronLeft />上一页</Button
                >
                <Button
                  variant="outline"
                  size="sm"
                  :disabled="page >= totalPages || isLoading"
                  aria-label="下一页"
                  @click="page++"
                  >下一页<ChevronRight
                /></Button>
              </div>
            </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.comparison-page :deep(h1) {
  font-size: 1rem;
  line-height: 1.5rem;
}

.comparison-page :deep([data-slot='button']) {
  box-shadow: none;
}

.comparison-page :deep(.rise-in) {
  animation-duration: 200ms;
}

.comparison-page :deep(.text-xs) {
  font-size: 13px;
  line-height: 1.5;
}

.comparison-progress {
  animation: comparison-progress 1100ms var(--ease-snap) infinite;
}

@keyframes comparison-progress {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(300%); }
}

@media (prefers-reduced-motion: reduce) {
  .comparison-progress { animation: none; }
}
</style>
