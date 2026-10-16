<script setup lang="ts">
import { useQuery, useQueryCache } from '@pinia/colada'
import { computed, nextTick, shallowRef, watch } from 'vue'
import { ArrowLeftRight, ChevronLeft, ChevronRight, GitCompareArrows, Search } from '@lucide/vue'
import type {
  ComparisonCounts,
  ComparisonDirection,
} from '~~/lib/comparison'
import type { CuratedRow } from '~~/lib/curation'
import type { ComparisonPlatformEvidence } from '~~/lib/comparison-platform'
import type { ReconcileEntry } from '~~/lib/reconcile'
import { useScrollEdges } from '~~/lib/scroll-edges'
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
  DIFFERENCE_LEGEND_NOTE,
  DIFFERENCE_LEGEND_TITLE,
  DIFFERENCE_STATUSES,
  DIFFERENCE_STATUS_ORDER,
  DIFFERENCE_STATUS_VARIANTS,
  DIFFERENCE_COLUMN_HINT,
} from '~~/lib/labels'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
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
function confirmedAliasNames(row: { platform: ComparisonPlatformEvidence }): string[] {
  return row.platform.aliases
    .filter((alias) => alias.verificationStatus === 'confirmed')
    .map((alias) => alias.name)
}
const platformInfo = computed(() => data.value?.platform ?? null)
/**
 * 图例只列**当前结果里真出现过**的状态(按状态机顺序)。
 * 全量列六种会把图例撑成一张词表,而屏幕上可能一个都没有。
 */
const legendCodes = computed(() => {
  const seen = new Set(rows.value.map((row) => row.platform.disposition.status))
  return DIFFERENCE_STATUS_ORDER.filter((code) => seen.has(code))
})

// 宽表在窄屏下的**边缘提示**:右侧渐隐 + 一行提示,滑到最右即消失。
const scroller = shallowRef<HTMLElement | null>(null)
const { edges, bars, measure } = useScrollEdges(scroller)
const showScrollHint = computed(() => edges.value.right)
// 表体从骨架/空态换成真实表格时内容宽度会变,重算一次。
watch([rows, isLoading], () => {
  void nextTick(measure)
})

const counts = computed(
  () => data.value?.counts[title.value as keyof ComparisonCounts],
)
const curatedCount = (d: ComparisonDirection) => data.value?.curatedCounts[title.value as keyof ComparisonCounts]?.[d] ?? 0
const count = (d: ComparisonDirection) => counts.value ? counts.value[d] - (showCurated.value ? 0 : curatedCount(d)) : '—'
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
const exportUrl = computed(
  () =>
    `/api/export?${new URLSearchParams({ mode: 'comparison', title: title.value, direction: direction.value })}`,
)
</script>

<template>
  <div class="comparison-page flex min-w-0 flex-col gap-4">
    <PageHeader
      class="rise-in"
      title="两侧名录比对"
    >
      <template #actions>
        <div class="flex items-center gap-2">
          <Switch id="show-curated" v-model="showCurated" />
          <Label for="show-curated">显示已核实</Label>
        </div>
        <Button as-child variant="outline" size="sm"
          ><a :href="exportUrl">导出当前方向</a></Button
        >
      </template>
    </PageHeader>

    <div class="grid min-w-0 gap-2 sm:grid-cols-[minmax(16rem,1fr)_14rem_12rem]">
      <div class="relative min-w-0">
        <Search class="text-muted-foreground absolute top-2 left-2.5 size-3.5" />
        <Input
          v-model="q"
          aria-label="搜索企业名称、已确认曾用名或统一社会信用代码"
          placeholder="搜索企业名称、曾用名或统一社会信用代码"
          class="bg-card h-8 pl-8"
        />
      </div>
      <Select v-model="title">
        <SelectTrigger size="sm" class="bg-card w-full shadow-none active:scale-[0.98] transition-transform duration-150 ease-snap" aria-label="按称号筛选">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="code in titles" :key="code" :value="code">{{ TITLES[code] }}</SelectItem>
        </SelectContent>
      </Select>
      <Select v-model="districtModel">
        <SelectTrigger size="sm" class="bg-card w-full shadow-none active:scale-[0.98] transition-transform duration-150 ease-snap" aria-label="按区县筛选">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem :value="ALL_DISTRICTS">全部区县</SelectItem>
          <SelectItem v-for="item in districtOptions" :key="item" :value="item">{{ item }}</SelectItem>
        </SelectContent>
      </Select>
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

    <Tabs v-model="direction" class="min-w-0 gap-3">
      <TabsList aria-label="比对方向" class="w-full sm:w-fit">
        <TabsTrigger
          v-for="d in COMPARISON_DIRECTIONS"
          :key="d"
          :value="d"
          class="sm:min-w-36 active:scale-[0.98] transition-transform duration-150 ease-snap"
        >
          {{ COMPARISON_LABELS[d] }}<Badge variant="secondary" class="min-w-[3ch] tabular-nums">{{ count(d) }}</Badge>
        </TabsTrigger>
      </TabsList>
      <TabsContent :value="direction" class="flex min-w-0 flex-col gap-3">
            <div class="relative h-6 shrink-0" aria-live="polite" data-testid="comparison-loading-status">
              <span v-if="isLoading" class="text-muted-foreground absolute top-0.5 left-0 text-[13px]">正在搜索与加载比对结果…</span>
              <span v-else class="text-muted-foreground absolute top-0.5 left-0 text-[13px] tabular-nums">共 {{ data?.total ?? 0 }} 条</span>
              <span v-if="isLoading" class="bg-muted absolute inset-x-0 bottom-0 block h-0.5 rounded-full">
                <span class="comparison-progress bg-primary block h-0.5 w-1/3 rounded-full" />
              </span>
            </div>
            <div v-if="platformInfo" class="text-muted-foreground flex flex-wrap gap-x-3 text-[13px] tabular-nums" data-testid="comparison-evidence-counts">
              <span>有原因 {{ platformInfo.withExplanation }}</span>
              <span>未查询 {{ platformInfo.withoutExplanation }}</span>
            </div>
            <!-- 图例:徽章是库内解释记录里的差异状态;只列当前结果里出现过的取值。 -->
            <div
              v-if="legendCodes.length"
              data-testid="platform-legend"
              class="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
            >
              <span>{{ DIFFERENCE_LEGEND_TITLE }}:</span>
              <Badge
                v-for="code in legendCodes"
                :key="code"
                :variant="DIFFERENCE_STATUS_VARIANTS[code] ?? 'quiet'"
                class="font-normal"
                >{{ DIFFERENCE_STATUSES[code] ?? code }}</Badge
              >
              <span class="basis-full sm:basis-auto">{{ DIFFERENCE_LEGEND_NOTE }}</span>
            </div>
            <Alert v-if="error" variant="destructive">
              <AlertTitle>比对数据加载失败</AlertTitle>
              <AlertDescription
                ><Button variant="outline" size="sm" @click="refetch()"
                  >重试</Button
                ></AlertDescription
              >
            </Alert>
            <Card class="min-w-0 gap-0 overflow-hidden py-0">
              <CardContent class="p-0">
                <!-- 宽表 + 容器内横向滚动(与台账一致,不做移动卡片列表)。
                     窄屏首屏给可见提示:右侧渐隐 + 一行字;滑到最右两者都消失。 -->
                <p
                  v-if="showScrollHint"
                  data-testid="scroll-hint"
                  class="text-muted-foreground flex items-center gap-1 px-3 py-1.5 text-[13px]"
                >
                  <ArrowLeftRight class="size-3.5 shrink-0" />表格较宽,可左右滑动查看全部列
                </p>
                <div class="relative min-w-0">
                  <div
                    ref="scroller"
                    tabindex="0"
                    role="region"
                    aria-label="比对结果表格(可横向滚动)"
                    class="h-[max(320px,calc(100dvh-29rem))] overflow-auto [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/30 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar]:w-1.5 [&_[data-slot=table-container]]:overflow-visible"
                    :aria-busy="isLoading"
                  >
                  <Empty v-if="!isLoading && !error && !rows.length" class="h-full">
                    <EmptyHeader>
                      <EmptyMedia variant="icon"><GitCompareArrows /></EmptyMedia>
                      <EmptyTitle>{{ showCurated ? '暂无差异' : '暂无待核对企业' }}</EmptyTitle>
                      <EmptyDescription>{{ curatedCount(direction) && !showCurated ? '当前方向均已核实，可开启「显示已核实」查看。' : '当前称号与方向没有差异企业。' }}</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                  <!-- `min-w` 要 ≥ Σ 固定列宽 ÷ (1 − 企业名称列的 28%)，否则 table-fixed
                       会把亏空全压到名称列上(实测 1180 时名称列只剩 236px,
                       核实/备注也一起被挤)。平台证据列加宽到 w-64 后该阈值是 ≈1312px。 -->
                  <Table v-else class="min-w-[1320px] table-fixed">
                    <TableHeader>
                      <TableRow class="hover:bg-transparent">
                        <TableHead :class="[TH_CLASS, 'w-[28%]']"
                          >企业名称</TableHead
                        >
                        <TableHead :class="[TH_CLASS, 'w-44']"
                          >统一社会信用代码</TableHead
                        >
                        <TableHead :class="[TH_CLASS, 'w-20']">区县</TableHead>
                        <TableHead :class="[TH_CLASS, 'w-32']"
                          >另一侧状态</TableHead
                        >
                        <TableHead :class="[TH_CLASS, 'w-28']">
                          <span :title="DIFFERENCE_COLUMN_HINT">平台解释</span>
                        </TableHead>
                        <TableHead :class="[TH_CLASS, 'w-64']">
                          <span title="库内平台证据:曾用名、平台查询与逐条原始关系">平台证据</span>
                        </TableHead>
                        <TableHead :class="[TH_CLASS, 'w-48']">核实与备注</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody
                      class="transition-transform duration-200 ease-snap will-change-transform motion-reduce:transition-none"
                      :class="isLoading ? '-translate-y-0.5' : 'translate-y-0'"
                      :data-loading="isLoading ? 'true' : 'false'"
                    >
                      <template v-if="isLoading && !rows.length">
                        <TableRow v-for="i in 8" :key="i" class="h-11">
                          <TableCell v-for="j in 7" :key="j"
                            ><Skeleton class="h-4 w-full"
                          /></TableCell>
                        </TableRow>
                      </template>
                      <TableRow
                        v-for="row in rows"
                        v-else
                        :key="`${row.enterpriseId}-${row.titleCode}-${row.direction}`"
                        class="h-11 [&>td]:py-1.5"
                      >
                        <TableCell class="font-medium">
                          <div class="truncate">
                          <NuxtLink
                            :to="`/enterprises/${row.enterpriseId}`"
                            :title="row.name"
                            class="hover:text-primary hover:underline"
                            >{{ row.name }}</NuxtLink
                          >
                          </div>
                          <!-- 曾用名(已确认)在行内直接可见 —— 现名与曾用名都能核对到同一行。 -->
                          <div v-if="confirmedAliasNames(row).length" class="mt-1 flex flex-wrap gap-1" data-testid="comparison-aliases">
                            <Badge
                              v-for="alias in confirmedAliasNames(row)"
                              :key="alias"
                              variant="quiet"
                              class="font-normal"
                              >曾用名 {{ alias }}</Badge
                            >
                          </div>
                          <div v-if="(row.evidence.currentCity && row.evidence.currentCity !== '宁波市') || /注销|吊销/.test(row.evidence.regStatus ?? '') || !row.uscc" class="mt-1 flex flex-wrap gap-1">
                            <Badge v-if="row.evidence.currentCity && row.evidence.currentCity !== '宁波市'" variant="outline">{{ row.evidence.currentCity }}</Badge>
                            <Badge v-if="/注销|吊销/.test(row.evidence.regStatus ?? '')" variant="destructive">{{ row.evidence.regStatus }}</Badge>
                            <Badge v-if="!row.uscc" variant="outline">{{ COMPARISON_NO_USCC }}</Badge>
                          </div>
                        </TableCell>
                        <TableCell
                          class="text-muted-foreground font-mono text-xs"
                          >{{ row.uscc ?? '—' }}</TableCell
                        >
                        <TableCell class="text-muted-foreground text-xs">{{
                          row.district ?? '—'
                        }}</TableCell>
                        <TableCell class="text-muted-foreground text-xs">{{
                          COMPARISON_OTHER_SIDE[row.direction]
                        }}</TableCell>
                        <TableCell>
                          <ComparisonReconcile :disposition="row.platform.disposition" :explanation="row.explanation" />
                        </TableCell>
                        <TableCell>
                          <ComparisonPlatformEvidence :evidence="row.platform" :enterprise-id="row.enterpriseId" />
                        </TableCell>
                        <TableCell>
                          <ComparisonCuration :row="row" @saved="refreshCuration" />
                        </TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                  </div>
                  <!-- 边缘阴影(不是不透明遮罩):该侧还有内容时才出现。
                       两轮评审的教训 —— 用 `from-card` 铺到不透明会(a)看起来像硬遮罩、
                       (b)在滚动条/卡边处留 1px 接缝、(c)暗色下压出一条更深的色带。
                       改成**半透明阴影**(永远不到不透明),并只覆盖**表头以下**的数据区
                       (`top-9`),绝不会给表头文字上色。`pointer-events-none` 不吃事件。 -->
                  <div
                    v-show="edges.right"
                    data-testid="scroll-fade-right"
                    aria-hidden="true"
                    class="from-foreground/14 pointer-events-none absolute top-9 z-10 w-8 bg-gradient-to-l to-transparent dark:from-black/40"
                    :style="{ right: `${bars.vertical}px`, bottom: `${bars.horizontal}px` }"
                  />
                  <div
                    v-show="edges.left"
                    data-testid="scroll-fade-left"
                    aria-hidden="true"
                    class="from-foreground/14 pointer-events-none absolute top-9 left-0 z-10 w-8 bg-gradient-to-r to-transparent dark:from-black/40"
                    :style="{ bottom: `${bars.horizontal}px` }"
                  />
                </div>
              </CardContent>
            </Card>
            <div class="flex items-center justify-between gap-2">
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
      </TabsContent>
    </Tabs>
  </div>
</template>

<style scoped>
.comparison-page :deep(.rise-in) {
  animation-duration: 200ms;
}

.comparison-page :deep(.text-xs) {
  font-size: 13px;
  line-height: 1.5;
}

.comparison-progress {
  animation: comparison-progress 1100ms ease-in-out infinite;
}

@keyframes comparison-progress {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(300%); }
}

@media (prefers-reduced-motion: reduce) {
  .comparison-progress { animation: none; }
}
</style>
