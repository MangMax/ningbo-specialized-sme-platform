<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useQuery } from '@pinia/colada'
import {
  CalendarCheck,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ExternalLink,
  LoaderCircle,
} from '@lucide/vue'
import { EVENTS, SOURCES, TITLES, TITLE_ORDER } from '~~/lib/labels'
import type { ReviewPendingRow, ReviewRow, ReviewStatus } from '~~/lib/roster/review-list'
import {
  REVIEW_PAGE_SIZE_PRESETS,
  defaultTargetYear,
  reviewAnchorYearNote,
  reviewEvidenceText,
  reviewExportUrl,
  reviewListQuery,
  reviewPendingReasonLabels,
  reviewStateFromQuery,
  reviewYearOptions,
  type ReviewViewState,
} from '~~/lib/roster/review-view'
import PageHeader from '@/components/PageHeader.vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
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
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

/**
 * **复核清单**(RL-09)—— 目标年份到期要复核的 企业 × 称号。
 *
 * 一张表 + 侧边抽屉:表里是「到期年份 / 锚点 / 批次」这几个排期用的列,
 * 点开某一行,抽屉里给全**依据与出处**(锚点事件、首次认定、来源、出处到文件 / 附件 / 序号 / 页)。
 *
 * 契约 §7.4 的读接口(含 `status=pending` 待确认清单)在
 * `server/api/roster/reviews.get.ts` + `lib/roster/review-list.ts`,页面只消费它。
 *
 * 状态全在地址栏(`replace`):刷新 / 分享 / 前进后退落到同一批结果,
 * 导出地址与列表地址同源(`lib/roster/review-view.ts`,有单测)。
 */

interface Result {
  year: number
  status: ReviewStatus
  rows: ReviewRow[]
  pending: ReviewPendingRow[]
  counts: { due: number; pending: number; titles: Record<string, { due: number; pending: number }> }
  page: number
  pageSize: number
}

const apiGet = $fetch as unknown as <T>(
  url: string,
  opts?: { query?: Record<string, unknown> },
) => Promise<T>

const route = useRoute()
const router = useRouter()

const normalize = (q: Record<string, unknown>) =>
  Object.entries(q)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : String(v)}`)
    .sort()
    .join('&')

const state = ref<ReviewViewState>(reviewStateFromQuery(route.query))
const toRouteQuery = () => reviewListQuery(state.value)

watch(
  state,
  () => {
    const next = toRouteQuery()
    if (normalize(next) === normalize(route.query)) return
    router.replace({ path: route.path, query: next })
  },
  { deep: true },
)

watch(
  () => route.query,
  (q) => {
    if (normalize(q) === normalize(toRouteQuery())) return
    state.value = reviewStateFromQuery(q)
  },
  { deep: true },
)

const listQuery = computed(() => reviewListQuery(state.value))

const { data, isLoading, error, refetch } = useQuery({
  key: () => ['roster-reviews', listQuery.value],
  query: () => apiGet<Result>('/api/roster/reviews', { query: listQuery.value }),
  placeholderData: (previous) => previous,
})

const isPendingView = computed(() => state.value.status === 'pending')
const rows = computed<(ReviewRow | ReviewPendingRow)[]>(() =>
  isPendingView.value ? (data.value?.pending ?? []) : (data.value?.rows ?? []),
)
const counts = computed(() => data.value?.counts ?? { due: 0, pending: 0, titles: {} })
const total = computed(() => (isPendingView.value ? counts.value.pending : counts.value.due))
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / state.value.pageSize)))
watch(totalPages, (max) => {
  if (state.value.page > max) state.value = { ...state.value, page: max }
})

/** 目标年份 / 称号 / 清单:三处都走项目既有的 `Select` 组件。 */
const yearModel = computed({
  get: () => state.value.year,
  set: (v: string) => {
    state.value = { ...state.value, year: v, page: 1 }
  },
})
const titleModel = computed({
  get: () => state.value.title[0] ?? 'all',
  set: (v: string) => {
    state.value = { ...state.value, title: v === 'all' ? [] : [v], page: 1 }
  },
})
const statusModel = computed({
  get: () => state.value.status,
  set: (v: string) => {
    state.value = { ...state.value, status: v as ReviewStatus, page: 1 }
  },
})
const sizeModel = computed({
  get: () => String(state.value.pageSize),
  set: (v: string) => {
    state.value = { ...state.value, pageSize: Number(v), page: 1 }
  },
})

const yearOptions = computed(() => reviewYearOptions(state.value.year))
const titleOptions = computed(() => TITLE_ORDER.map((code) => ({ value: code, label: TITLES[code] ?? code })))

function setPage(n: number) {
  state.value = { ...state.value, page: Math.min(Math.max(1, n), totalPages.value) }
}

/** 点行开抽屉:依据与出处都在抽屉里,表里只留排期用的列。 */
const selected = ref<ReviewRow | ReviewPendingRow | null>(null)
watch([listQuery, () => state.value.page], () => {
  selected.value = null
})

const exportUrl = computed(() => reviewExportUrl(state.value))
const titleText = (code: string) => TITLES[code] ?? code
const sourceText = (code: string | null) => (code ? (SOURCES[code] ?? code) : '—')
const basisText = (row: ReviewRow | ReviewPendingRow) => {
  if (row.basisEventId == null) return '—'
  const kind = row.basisEventType === 'review' ? '复核通过' : (EVENTS[row.basisEventType ?? ''] ?? row.basisEventType ?? '')
  const year = row.basisDecidedYear ?? row.basisEventYear
  return year == null ? `${kind} 事件 #${row.basisEventId}` : `${kind} ${year}`
}
const dueYearOf = (row: ReviewRow | ReviewPendingRow) =>
  'dueYear' in row ? String(row.dueYear) : String(row.tentativeDueYear ?? '—')
/** 到期行没有 `reasons`(它证据齐全)—— 两张清单共用一个表格,读它要过这道窄化。 */
const reasonsOf = (row: ReviewRow | ReviewPendingRow) => ('reasons' in row ? row.reasons : [])

useHead({
  title: computed(() => {
    const year = state.value.year || String(defaultTargetYear())
    const kind = isPendingView.value ? '待确认' : '复核'
    return `${year} 年 · ${kind}清单 · ${total.value ? `${total.value.toLocaleString('zh-CN')} 项` : '加载中'} · 名录台账`
  }),
})
</script>

<template>
  <div class="flex min-w-0 flex-col gap-4">
    <PageHeader class="rise-in" style="--rise-index: 0" title="复核清单">
      <template #actions>
        <Button as-child variant="outline" size="sm">
          <a :href="exportUrl" data-testid="review-export">
            <ExternalLink class="size-3.5" />导出(Excel)
          </a>
        </Button>
      </template>
    </PageHeader>

    <div class="rise-in flex flex-wrap items-center gap-2" style="--rise-index: 1">
      <Select v-model="statusModel">
        <SelectTrigger class="bg-card h-8 w-32" aria-label="清单">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="due">到期清单</SelectItem>
          <SelectItem value="pending">待确认清单</SelectItem>
        </SelectContent>
      </Select>

      <Select v-model="yearModel">
        <SelectTrigger class="bg-card h-8 w-28" aria-label="目标年份" data-testid="review-year">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="y in yearOptions" :key="y.value" :value="String(y.value)">
            {{ y.label }}
          </SelectItem>
        </SelectContent>
      </Select>

      <Select v-model="titleModel">
        <SelectTrigger class="bg-card h-8 w-40" aria-label="称号" data-testid="review-title">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">全部称号</SelectItem>
          <SelectItem v-for="o in titleOptions" :key="o.value" :value="o.value">{{ o.label }}</SelectItem>
        </SelectContent>
      </Select>

      <span
        v-if="isLoading"
        class="text-muted-foreground flex items-center gap-1.5 text-xs"
        data-testid="review-loading"
        aria-live="polite"
      >
        <LoaderCircle class="size-3.5 animate-spin" />正在加载…
      </span>
      <span v-else class="text-muted-foreground text-xs tabular-nums" data-testid="review-counts">
        {{ total.toLocaleString('zh-CN') }} 项
      </span>
    </div>

    <Alert v-if="error" variant="destructive">
      <AlertTitle>加载失败</AlertTitle>
      <AlertDescription>
        <button class="text-primary underline" @click="refetch()">重试</button>
      </AlertDescription>
    </Alert>

    <Card v-if="isLoading && !rows.length" class="gap-0 py-0">
      <CardContent class="flex flex-col gap-2 p-5">
        <Skeleton class="h-5 w-56" /><Skeleton class="h-32 w-full" />
      </CardContent>
    </Card>

    <Empty v-else-if="!error && !rows.length">
      <EmptyHeader>
        <EmptyMedia variant="icon"><CalendarCheck /></EmptyMedia>
        <EmptyTitle>{{ isPendingView ? '没有待确认项' : '没有到期项' }}</EmptyTitle>
        <EmptyDescription>
          <template v-if="isPendingView">当前称号下没有到期年不确定的事项。</template>
          <template v-else>换一个目标年份试试。</template>
        </EmptyDescription>
      </EmptyHeader>
    </Empty>

    <Card
      v-if="!error && rows.length"
      class="rise-in min-w-0 gap-0 overflow-hidden py-0"
      style="--rise-index: 2"
      :aria-busy="isLoading"
      :class="isLoading ? 'opacity-60' : ''"
    >
      <CardContent class="p-0">
        <Table class="min-w-[640px]" data-testid="review-table">
            <TableHeader>
              <TableRow>
                <TableHead class="w-72">企业名称</TableHead>
                <TableHead class="w-40">称号</TableHead>
                <TableHead class="w-24">{{ isPendingView ? '暂定到期年份' : '到期年份' }}</TableHead>
                <TableHead class="w-40">{{ isPendingView ? '待确认原因' : '锚点(依据)' }}</TableHead>
                <TableHead class="w-20">批次</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow
                v-for="row in rows"
                :key="`${row.enterpriseId}-${row.titleCode}`"
                class="cursor-pointer"
                data-testid="review-row"
                @click="selected = row"
              >
                <TableCell>
                  <span class="font-medium">{{ row.name }}</span>
                  <span v-if="row.district" class="text-muted-foreground ml-1 text-xs">{{ row.district }}</span>
                </TableCell>
                <TableCell class="text-xs">{{ titleText(row.titleCode) }}</TableCell>
                <TableCell class="text-xs font-medium tabular-nums">{{ dueYearOf(row) }}</TableCell>
                <TableCell class="text-xs">
                  <template v-if="isPendingView">
                    <Badge
                      v-for="(reason, i) in reviewPendingReasonLabels(reasonsOf(row))"
                      :key="i"
                      variant="quiet"
                      class="mr-1 mb-1 font-normal"
                    >
                      {{ reason }}
                    </Badge>
                  </template>
                  <template v-else>{{ basisText(row) }}</template>
                </TableCell>
                <TableCell class="text-muted-foreground text-xs tabular-nums">{{ row.batchSeq ?? '—' }}</TableCell>
              </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>

    <div
      v-if="!error && rows.length"
      class="rise-in flex flex-wrap items-center gap-x-4 gap-y-3"
      style="--rise-index: 3"
    >
      <div class="flex items-center gap-2">
        <Select v-model="sizeModel">
          <SelectTrigger class="bg-card h-8 w-20" aria-label="每页条数">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="n in REVIEW_PAGE_SIZE_PRESETS" :key="n" :value="String(n)">{{ n }}</SelectItem>
          </SelectContent>
        </Select>
        <span class="text-muted-foreground text-xs tabular-nums">第 {{ state.page }} / {{ totalPages }} 页</span>
      </div>

      <Pagination
        v-if="total > 0"
        v-slot="{ page: current }"
        class="mx-0 w-full justify-center sm:ml-auto sm:w-auto sm:justify-end"
        :page="state.page"
        :items-per-page="state.pageSize"
        :total="total"
        :sibling-count="1"
        :show-edges="totalPages > 5"
        @update:page="setPage"
      >
        <PaginationContent v-slot="{ items }" class="flex-wrap justify-center sm:justify-end">
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

    <!-- 侧边抽屉:依据与出处。表里放不下的那几列在这里铺开。 -->
    <Sheet :open="selected != null" @update:open="(v: boolean) => { if (!v) selected = null }">
      <SheetContent side="right" class="w-full overflow-y-auto sm:max-w-lg" data-testid="review-detail">
        <SheetHeader>
          <SheetTitle>{{ selected?.name }}</SheetTitle>
        </SheetHeader>

        <dl v-if="selected" class="flex flex-col gap-3 px-4 text-sm">
          <div class="flex gap-3">
            <dt class="text-muted-foreground w-28 shrink-0 text-xs">称号</dt>
            <dd class="text-xs">{{ titleText(selected.titleCode) }}</dd>
          </div>
          <div class="flex gap-3">
            <dt class="text-muted-foreground w-28 shrink-0 text-xs">到期年份</dt>
            <dd class="text-xs tabular-nums">{{ dueYearOf(selected) }}</dd>
          </div>
          <div class="flex gap-3">
            <dt class="text-muted-foreground w-28 shrink-0 text-xs">锚点年份</dt>
            <dd class="text-xs">
              <span class="tabular-nums">{{ selected.anchorYear ?? '—' }}</span>
              <span class="text-muted-foreground">
                ({{ reviewAnchorYearNote(selected.anchorYearSource) }})
              </span>
            </dd>
          </div>
          <div class="flex gap-3">
            <dt class="text-muted-foreground w-28 shrink-0 text-xs">锚点依据</dt>
            <dd class="text-xs">{{ basisText(selected) }}</dd>
          </div>
          <div class="flex gap-3">
            <dt class="text-muted-foreground w-28 shrink-0 text-xs">首次认定</dt>
            <dd class="text-xs tabular-nums">{{ selected.firstYear ?? '—' }}</dd>
          </div>
          <div class="flex gap-3">
            <dt class="text-muted-foreground w-28 shrink-0 text-xs">批次</dt>
            <dd class="text-xs tabular-nums">{{ selected.batchSeq ?? '—' }}</dd>
          </div>
          <div class="flex gap-3">
            <dt class="text-muted-foreground w-28 shrink-0 text-xs">来源</dt>
            <dd class="text-xs">{{ sourceText(selected.source) }}</dd>
          </div>
          <div class="flex gap-3">
            <dt class="text-muted-foreground w-28 shrink-0 text-xs">统一社会信用代码</dt>
            <dd class="font-mono text-xs">{{ selected.uscc ?? '—' }}</dd>
          </div>
          <div class="flex gap-3">
            <dt class="text-muted-foreground w-28 shrink-0 text-xs">区县</dt>
            <dd class="text-xs">{{ selected.district ?? '—' }}</dd>
          </div>
          <div v-if="isPendingView" class="flex gap-3">
            <dt class="text-muted-foreground w-28 shrink-0 text-xs">待确认原因</dt>
            <dd class="text-xs">
              <Badge
                v-for="(reason, i) in reviewPendingReasonLabels(reasonsOf(selected))"
                :key="i"
                variant="quiet"
                class="mr-1 mb-1 font-normal"
              >
                {{ reason }}
              </Badge>
            </dd>
          </div>
          <div class="flex gap-3">
            <dt class="text-muted-foreground w-28 shrink-0 text-xs">出处</dt>
            <dd class="flex min-w-0 flex-col gap-1 text-xs" data-testid="review-detail-evidence">
              <span v-for="(v, i) in selected.evidence" :key="i" class="break-all">
                {{ reviewEvidenceText(v) }}
              </span>
              <span v-if="!selected.evidence.length">—</span>
            </dd>
          </div>
          <div class="flex gap-3">
            <dt class="text-muted-foreground w-28 shrink-0 text-xs">企业档案</dt>
            <dd class="text-xs">
              <NuxtLink
                :to="`/enterprises/${selected.enterpriseId}`"
                class="text-primary hover:underline"
              >
                打开 #{{ selected.enterpriseId }}
              </NuxtLink>
            </dd>
          </div>
        </dl>
      </SheetContent>
    </Sheet>
  </div>
</template>
