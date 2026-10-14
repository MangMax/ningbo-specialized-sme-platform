<script setup lang="ts">
import { useQuery, useQueryCache } from '@pinia/colada'
import { computed, shallowRef, watch } from 'vue'
import { ChevronLeft, ChevronRight, GitCompareArrows } from '@lucide/vue'
import type {
  ComparisonCounts,
  ComparisonDirection,
} from '~~/lib/comparison'
import type { CuratedRow } from '~~/lib/curation'
import type { ReconcileEntry } from '~~/lib/reconcile'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import {
  TITLES,
  TITLE_ORDER,
  COMPARISON_LABELS,
  COMPARISON_HINTS,
  COMPARISON_OTHER_SIDE,
  COMPARISON_NO_USCC,
  RECONCILE_HINT,
  RECONCILE_SOURCE,
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
const titles = TITLE_ORDER.filter((code) => code !== 'little_giant')
const title = shallowRef('specialized_sme')
const direction = shallowRef<ComparisonDirection>('missing_in_miit')
const page = shallowRef(1)
const showCurated = shallowRef(false)
const queryCache = useQueryCache()
const pageSize = 25
watch(
  [title, direction, showCurated],
  () => {
    page.value = 1
  },
  { flush: 'sync' },
)
const params = computed(() => ({
  title: title.value,
  direction: direction.value,
  page: page.value,
  pageSize,
  showCurated: showCurated.value,
}))
const { data, isLoading, error, refetch } = useQuery({
  key: () => ['comparison', params.value],
  query: () =>
    $fetch<{
      rows: (CuratedRow & { explanation: ReconcileEntry | null })[]
      total: number
      counts: ComparisonCounts
      curatedCounts: ComparisonCounts
      reconcile: { generatedAt: string | null; matched: number }
    }>('/api/comparison', { query: params.value }),
  placeholderData: (previous) => previous,
})
const rows = computed(() => data.value?.rows ?? [])
const reconcileInfo = computed(() => data.value?.reconcile ?? null)
const reconcileGenerated = computed(() => {
  const at = reconcileInfo.value?.generatedAt
  if (!at) return null
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? at : date.toLocaleDateString('zh-CN')
})
const counts = computed(
  () => data.value?.counts[title.value as keyof ComparisonCounts],
)
const curatedCount = (d: ComparisonDirection) => data.value?.curatedCounts[title.value as keyof ComparisonCounts]?.[d] ?? 0
const count = (d: ComparisonDirection) => counts.value ? counts.value[d] - (showCurated.value ? 0 : curatedCount(d)) : '—'
const countLabel = (d: ComparisonDirection) => {
  if (!counts.value) return '加载中…'
  const verified = curatedCount(d)
  return showCurated.value
    ? `${count(d)} 条（含 ${verified} 条已核实）`
    : `${count(d)} 条${verified ? `（另 ${verified} 条已核实）` : ''}`
}
async function refreshCuration() {
  await queryCache.invalidateQueries({ key: ['comparison'] })
  if (page.value > totalPages.value) page.value = totalPages.value
}
const totalPages = computed(() =>
  Math.max(1, Math.ceil((data.value?.total ?? 0) / pageSize)),
)
const exportUrl = computed(
  () =>
    `/api/export?${new URLSearchParams({ mode: 'comparison', title: title.value, direction: direction.value })}`,
)
const TH_CLASS =
  'bg-muted text-muted-foreground sticky top-0 z-20 h-9 text-xs font-medium'
</script>

<template>
  <div class="comparison-page flex min-w-0 flex-col gap-4">
    <PageHeader
      class="rise-in"
      title="两侧名录比对"
    >
      <template #description>
        <span class="inline-block">按统代比对,不限年份。</span>
        <span class="inline-block">小巨人无经信局名录。</span>
      </template>
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

    <Tabs v-model="title" class="min-w-0 gap-4">
      <TabsList aria-label="比对称号" class="max-w-full">
        <TabsTrigger v-for="code in titles" :key="code" :value="code">{{
          TITLES[code]
        }}</TabsTrigger>
      </TabsList>
      <!-- 复用同一个面板和滚动容器,切换只更新查询,不重建表体。 -->
      <TabsContent :value="title" class="flex min-w-0 flex-col gap-4">
        <div class="grid grid-cols-2 gap-3">
          <StatTile
            v-for="(d, i) in COMPARISON_DIRECTIONS"
            :key="d"
            :label="COMPARISON_LABELS[d]"
            :value="count(d)"
            :hint="COMPARISON_HINTS[d]"
            :index="i + 1"
            class="[&>div]:p-3 sm:[&>div]:p-5"
          />
        </div>
        <Tabs v-model="direction" class="min-w-0 gap-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <TabsList aria-label="比对方向" class="w-full sm:w-fit">
              <TabsTrigger
                v-for="d in COMPARISON_DIRECTIONS"
                :key="d"
                :value="d"
                class="sm:min-w-36"
              >
                {{ COMPARISON_LABELS[d]
                }}<Badge variant="secondary" class="min-w-[3ch] tabular-nums">{{
                  count(d)
                }}</Badge>
              </TabsTrigger>
            </TabsList>
          </div>
          <TabsContent :value="direction" class="flex min-w-0 flex-col gap-3">
            <p class="text-muted-foreground min-h-5 text-[13px] tabular-nums" aria-live="polite">
              {{ countLabel(direction) }}
            </p>
            <p class="text-muted-foreground text-xs leading-relaxed">
              {{ RECONCILE_HINT }} 平台解释取数自{{ RECONCILE_SOURCE }}<template
                v-if="reconcileGenerated"
                >({{ reconcileGenerated }})</template
              >,本次筛选 {{ reconcileInfo?.matched ?? 0 }} 行有解释。
            </p>
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
                <div
                  class="h-[max(320px,calc(100dvh-29rem))] overflow-auto [&_[data-slot=table-container]]:overflow-visible"
                  :aria-busy="isLoading"
                >
                  <Empty v-if="!isLoading && !error && !rows.length" class="h-full">
                    <EmptyHeader>
                      <EmptyMedia variant="icon"><GitCompareArrows /></EmptyMedia>
                      <EmptyTitle>{{ showCurated ? '暂无差异' : '暂无待核对企业' }}</EmptyTitle>
                      <EmptyDescription>{{ curatedCount(direction) && !showCurated ? '当前方向均已核实，可开启「显示已核实」查看。' : '当前称号与方向没有差异企业。' }}</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                  <Table v-else class="min-w-[1020px] table-fixed">
                    <TableHeader>
                      <TableRow class="hover:bg-transparent">
                        <TableHead :class="[TH_CLASS, 'w-[32%]']"
                          >企业名称</TableHead
                        >
                        <TableHead :class="[TH_CLASS, 'w-48']"
                          >统一社会信用代码</TableHead
                        >
                        <TableHead :class="[TH_CLASS, 'w-20']">区县</TableHead>
                        <TableHead :class="[TH_CLASS, 'w-36']"
                          >另一侧状态</TableHead
                        >
                        <TableHead :class="[TH_CLASS, 'w-28']">
                          <span :title="RECONCILE_HINT">平台解释</span>
                        </TableHead>
                        <TableHead :class="[TH_CLASS, 'w-48']">核实与备注</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      <template v-if="isLoading && !rows.length">
                        <TableRow v-for="i in 8" :key="i" class="h-11">
                          <TableCell v-for="j in 6" :key="j"
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
                          <ComparisonReconcile :explanation="row.explanation" />
                        </TableCell>
                        <TableCell>
                          <ComparisonCuration :row="row" @saved="refreshCuration" />
                        </TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
            <div class="flex items-center justify-between gap-2">
              <span class="text-muted-foreground text-xs tabular-nums"
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
      </TabsContent>
    </Tabs>
  </div>
</template>

<style scoped>
.comparison-page :deep(.rise-in) {
  animation-duration: 200ms;
}
</style>
