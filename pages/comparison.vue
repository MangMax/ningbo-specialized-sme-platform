<script setup lang="ts">
import { useQuery } from '@pinia/colada'
import { computed, shallowRef, watch } from 'vue'
import { ChevronLeft, ChevronRight, GitCompareArrows } from '@lucide/vue'
import type {
  ComparisonCounts,
  ComparisonRow,
  ComparisonDirection,
} from '~~/lib/comparison'
import {
  TITLES,
  TITLE_ORDER,
  TITLE_SHORT,
  COMPARISON_LABELS,
  COMPARISON_HINTS,
  COMPARISON_OTHER_SIDE,
  COMPARISON_NO_USCC,
  EVENTS,
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
const pageSize = 25
watch(
  [title, direction],
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
}))
const { data, isLoading, error, refetch } = useQuery({
  key: () => ['comparison', params.value],
  query: () =>
    $fetch<{ rows: ComparisonRow[]; total: number; counts: ComparisonCounts }>(
      '/api/comparison',
      { query: params.value },
    ),
  placeholderData: (previous) => previous,
})
const rows = computed(() => data.value?.rows ?? [])
const counts = computed(
  () => data.value?.counts[title.value as keyof ComparisonCounts],
)
const count = (d: ComparisonDirection) => counts.value?.[d] ?? '—'
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
  <div class="flex min-w-0 flex-col gap-4">
    <PageHeader
      class="rise-in"
      title="两侧名录比对"
      :description="`按统代比对,不限年份,含 2021 ${EVENTS.nurture};${TITLE_SHORT.little_giant}无经信局来源。`"
    >
      <template #actions>
        <Button as-child variant="outline" size="sm"
          ><a :href="exportUrl">导出当前方向</a></Button
        >
      </template>
    </PageHeader>

    <Tabs v-model="title" class="min-w-0 gap-4">
      <TabsList aria-label="比对称号">
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
          />
        </div>
        <Tabs v-model="direction" class="min-w-0 gap-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <TabsList aria-label="比对方向">
              <TabsTrigger
                v-for="d in COMPARISON_DIRECTIONS"
                :key="d"
                :value="d"
              >
                {{ COMPARISON_LABELS[d]
                }}<Badge variant="secondary" class="tabular-nums">{{
                  count(d)
                }}</Badge>
              </TabsTrigger>
            </TabsList>
            <TitleBadge :code="title" />
          </div>
          <TabsContent :value="direction" class="flex min-w-0 flex-col gap-3">
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
                  class="h-[max(320px,calc(100dvh-27rem))] overflow-auto [&_[data-slot=table-container]]:overflow-visible"
                  :aria-busy="isLoading"
                >
                  <Table class="min-w-[1000px] table-fixed">
                    <TableHeader>
                      <TableRow class="hover:bg-transparent">
                        <TableHead :class="[TH_CLASS, 'w-[30%]']"
                          >企业名称</TableHead
                        >
                        <TableHead :class="[TH_CLASS, 'w-48']"
                          >统一社会信用代码</TableHead
                        >
                        <TableHead :class="[TH_CLASS, 'w-20']">区县</TableHead>
                        <TableHead :class="[TH_CLASS, 'w-44']"
                          >另一侧状态</TableHead
                        >
                        <TableHead :class="TH_CLASS">备注</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      <template v-if="isLoading && !rows.length">
                        <TableRow v-for="i in 8" :key="i" class="h-11">
                          <TableCell v-for="j in 5" :key="j"
                            ><Skeleton class="h-4 w-full"
                          /></TableCell>
                        </TableRow>
                      </template>
                      <TableRow
                        v-for="row in rows"
                        v-else
                        :key="`${row.enterpriseId}-${row.titleCode}-${row.direction}`"
                        class="h-11"
                      >
                        <TableCell class="truncate font-medium">
                          <NuxtLink
                            :to="`/enterprises/${row.enterpriseId}`"
                            :title="row.name"
                            class="hover:text-primary hover:underline"
                            >{{ row.name }}</NuxtLink
                          >
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
                          <div class="flex flex-wrap items-center gap-1">
                            <Badge
                              v-if="
                                row.evidence.currentCity &&
                                row.evidence.currentCity !== '宁波市'
                              "
                              variant="outline"
                              >{{ row.evidence.currentCity }}</Badge
                            >
                            <Badge
                              v-if="
                                /注销|吊销/.test(row.evidence.regStatus ?? '')
                              "
                              variant="destructive"
                              >{{ row.evidence.regStatus }}</Badge
                            >
                            <span
                              v-if="!row.uscc"
                              class="text-muted-foreground text-xs"
                              >{{ COMPARISON_NO_USCC }}</span
                            >
                          </div>
                        </TableCell>
                      </TableRow>
                      <TableRow v-if="!isLoading && !error && !rows.length">
                        <TableCell :colspan="5">
                          <Empty
                            ><EmptyHeader
                              ><EmptyMedia variant="icon"
                                ><GitCompareArrows /></EmptyMedia
                              ><EmptyTitle>暂无差异</EmptyTitle
                              ><EmptyDescription
                                >当前称号与方向没有待核对企业。</EmptyDescription
                              ></EmptyHeader
                            ></Empty
                          >
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
