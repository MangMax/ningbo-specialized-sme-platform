<script setup lang="ts">
import { useQuery } from '@pinia/colada'
import { computed, nextTick, ref, watch } from 'vue'
import { watchDebounced } from '@vueuse/core'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Search } from '@lucide/vue'
import {
  TITLES,
  TITLE_ORDER,
  TITLE_SHORT,
  SOURCES,
  SOURCE_ORDER,
  EVENTS,
  EVENT_ORDER,
} from '~~/lib/labels'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Input } from '@/components/ui/input'
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

interface Rec {
  enterpriseId: number
  name: string
  uscc: string | null
  district: string | null
  titleCode: string
  sources: string[]
  events: { type: string; year: number | null; seq: number | null; source: string }[]
}

const apiGet = $fetch as unknown as <T>(
  url: string,
  opts?: { query?: Record<string, unknown> },
) => Promise<T>

interface Bucket {
  key: string
  n: number
}
interface Stats {
  byEvent: Bucket[]
  byYear: Bucket[]
}

const route = useRoute()
const router = useRouter()
const queryStr = (v: unknown) => (typeof v === 'string' ? v : '')
/** URL 初值:多值筛选用逗号分隔承载(如 `title=little_giant,innovative_sme`)。 */
const splitCsv = (v: unknown): string[] =>
  queryStr(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

const titles = ref<string[]>(splitCsv(route.query.title))
const sources = ref<string[]>(splitCsv(route.query.source))
const eventTypes = ref<string[]>(splitCsv(route.query.eventType))
const years = ref<string[]>(splitCsv(route.query.year))
const district = ref(queryStr(route.query.district))
const search = ref(queryStr(route.query.q))
const q = ref(queryStr(route.query.q))
watchDebounced(
  search,
  (v) => {
    q.value = v.trim()
    page.value = 1
  },
  { debounce: 300 },
)

// —— 分页 ——
const PAGE_SIZE_PRESETS = [25, 50, 100, 200]
const MAX_PAGE_SIZE = 200
const page = ref(1)
const pageSize = ref(25)
const scrollRef = ref<HTMLElement | null>(null)

/** 四个多选筛选 + 区县变化时回到第一页。 */
watch([titles, sources, eventTypes, years, district], () => {
  page.value = 1
})

/**
 * 筛选条件回写到地址栏。
 * 统计页的下钻是「跳到 /?title=xxx」,所以地址必须能承载条件;顺带让刷新和
 * 分享链接都保住当前视图。用 replace 而不是 push —— 勾选不该把历史塞满,
 * 用户按返回应该离开这一页,而不是回退到上一个勾选。
 *
 * 比对用「键排序后的字符串」而不是对象,并且只比对筛选相关的几个键:
 * 对象键顺序会变,而 route.query 里还可能带着别的参数,直接比会一直判为不同,
 * 从而每轮都写一次地址,来回震荡。
 */
const FILTER_KEYS = ['title', 'source', 'eventType', 'year', 'district', 'q'] as const
const normalize = (q: Record<string, unknown>) =>
  FILTER_KEYS.map((k) => `${k}=${queryStr(q[k])}`).join('&')

const filterQuery = computed<Record<string, string>>(() => {
  const out: Record<string, string> = {}
  if (titles.value.length) out.title = titles.value.join(',')
  if (sources.value.length) out.source = sources.value.join(',')
  if (eventTypes.value.length) out.eventType = eventTypes.value.join(',')
  if (years.value.length) out.year = years.value.join(',')
  if (district.value) out.district = district.value
  if (q.value) out.q = q.value
  return out
})

watch(filterQuery, (next) => {
  if (normalize(next) === normalize(route.query)) return
  router.replace({ path: route.path, query: { ...route.query, ...next } })
})

watch(page, () => {
  nextTick(() => scrollRef.value?.scrollTo({ top: 0 }))
})

// 事件类型 / 年份的可选项来自数据(统计端点),口径与统计页一致。
const { data: stats } = useQuery({
  key: () => ['stats'],
  query: () => apiGet<Stats>('/api/stats'),
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
const titleOptions = computed(() =>
  TITLE_ORDER.map((k) => ({ value: k, label: TITLES[k] ?? k, short: TITLE_SHORT[k] })),
)
const sourceOptions = computed(() => SOURCE_ORDER.map((k) => ({ value: k, label: SOURCES[k] ?? k })))

const params = computed(() => ({
  title: titles.value.join(',') || undefined,
  source: sources.value.join(',') || undefined,
  district: district.value || undefined,
  eventType: eventTypes.value.join(',') || undefined,
  year: years.value.join(',') || undefined,
  q: q.value || undefined,
  page: page.value,
  pageSize: pageSize.value,
}))

const { data, isLoading } = useQuery({
  key: () => ['records', params.value],
  query: () => apiGet<{ rows: Rec[]; total: number }>('/api/records', { query: params.value }),
  // 换筛选/翻页时保留上一批数据,避免表体清空 → 文档高度骤变 → 页面闪一下并跳回顶部。
  placeholderData: (previous) => previous,
})

const rows = computed<Rec[]>(() => data.value?.rows ?? [])
const total = computed(() => data.value?.total ?? 0)
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)))

/** 生效中的筛选条件摊平成一行,每项可单独撤掉。 */
const activeFilters = computed(() => {
  const out: { key: string; label: string; clear: () => void }[] = []
  for (const v of titles.value) {
    out.push({
      key: `title:${v}`,
      label: `称号 · ${TITLES[v] ?? v}`,
      clear: () => (titles.value = titles.value.filter((x) => x !== v)),
    })
  }
  for (const v of sources.value) {
    out.push({
      key: `source:${v}`,
      label: `来源 · ${SOURCES[v] ?? v}`,
      clear: () => (sources.value = sources.value.filter((x) => x !== v)),
    })
  }
  for (const v of eventTypes.value) {
    out.push({
      key: `event:${v}`,
      label: `事件 · ${EVENTS[v] ?? v}`,
      clear: () => (eventTypes.value = eventTypes.value.filter((x) => x !== v)),
    })
  }
  for (const v of years.value) {
    out.push({
      key: `year:${v}`,
      label: `年份 · ${v}`,
      clear: () => (years.value = years.value.filter((x) => x !== v)),
    })
  }
  if (district.value) {
    out.push({ key: 'district', label: `区县 · ${district.value}`, clear: () => (district.value = '') })
  }
  if (q.value) {
    out.push({
      key: 'q',
      label: `搜索 · ${q.value}`,
      clear: () => {
        search.value = ''
        q.value = ''
      },
    })
  }
  return out
})

function clearFilters() {
  titles.value = []
  sources.value = []
  eventTypes.value = []
  years.value = []
  district.value = ''
  search.value = ''
  q.value = ''
}

const exportUrl = computed(() => {
  const p = new URLSearchParams()
  if (titles.value.length) p.set('title', titles.value.join(','))
  if (sources.value.length) p.set('source', sources.value.join(','))
  if (district.value) p.set('district', district.value)
  if (eventTypes.value.length) p.set('eventType', eventTypes.value.join(','))
  if (years.value.length) p.set('year', years.value.join(','))
  if (q.value) p.set('q', q.value)
  return `/api/export?${p.toString()}`
})

/** 每页条数:选预设,或选「自定义」后在输入框手动填。 */
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
  pageSize.value = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(n) || 25))
  page.value = 1
}
function onSizeInput(e: Event) {
  const value = Number((e.target as HTMLInputElement).value)
  if (Number.isFinite(value) && value > 0) setPageSize(value)
}

// —— 行虚拟化(表体大时只渲染可视行)——
const rowVirtualizer = useVirtualizer(
  computed(() => ({
    count: rows.value.length,
    getScrollElement: () => scrollRef.value,
    estimateSize: () => 44,
    overscan: 8,
  })),
)
const virtualRows = computed(() => rowVirtualizer.value.getVirtualItems())
const usingVirtual = computed(() => virtualRows.value.length > 0)
/** 可视行(表体未测量完成时回退为整页渲染,避免空白)。 */
const visibleRows = computed(() =>
  usingVirtual.value
    ? virtualRows.value.map((vi) => ({ index: vi.index, row: rows.value[vi.index]! }))
    : rows.value.map((row, index) => ({ index, row })),
)
const totalSize = computed(() => rowVirtualizer.value.getTotalSize())
const paddingTop = computed(() => (usingVirtual.value ? (virtualRows.value[0]?.start ?? 0) : 0))
const paddingBottom = computed(() => {
  const last = virtualRows.value[virtualRows.value.length - 1]
  return usingVirtual.value && last ? Math.max(0, totalSize.value - last.end) : 0
})

const rowKey = (r: Rec) => `${r.enterpriseId}-${r.titleCode}`

/** 整行可点,但拖选文字时不该跳走。 */
function openRow(id: number) {
  if (typeof window !== 'undefined' && window.getSelection()?.toString()) return
  router.push(`/enterprises/${id}`)
}

/**
 * 表头:吸顶 + 不透明底色。整页白底,表头用浅蓝灰分成一条带,
 * 滚动时和表体不会叠在一起像半透明。
 */
const TH_CLASS = 'bg-muted text-muted-foreground sticky top-0 z-20 h-9 text-xs font-medium'

/** 台账格子内联展示的事件上限,超出折叠为 +N,悬浮展开完整卡片。 */
const MAX_VISIBLE_EVENTS = 2
function setPage(n: number) {
  page.value = Math.min(Math.max(1, n), totalPages.value)
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <PageHeader
      class="rise-in"
      style="--rise-index: 0"
      title="记录台账"
      description="每条记录 = 一个企业 × 一个称号 × 一个来源,点任意一行看该企业的全部记录与出处。"
    >
      <template #actions>
        <Button as-child variant="outline" size="sm">
          <a :href="exportUrl">导出当前结果</a>
        </Button>
      </template>
    </PageHeader>

    <!-- 工具栏:搜索 + 四个多选筛选。左侧筛,右侧只报当前条数。 -->
    <div class="rise-in flex flex-wrap items-center gap-2" style="--rise-index: 1">
      <div class="relative min-w-56 flex-1 sm:max-w-xs">
        <Search
          class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
        />
        <Input v-model="search" class="bg-card h-8 pl-8" placeholder="搜索企业名称或统一社会信用代码" />
      </div>

      <Separator orientation="vertical" class="hidden h-5 sm:block" />

      <MultiSelectFilter
        v-model="titles"
        :options="titleOptions"
        placeholder="全部称号"
        summary-prefix="称号"
        class="w-32"
      />
      <MultiSelectFilter
        v-model="sources"
        :options="sourceOptions"
        placeholder="全部来源"
        summary-prefix="来源"
        class="w-28"
      />
      <MultiSelectFilter
        v-model="eventTypes"
        :options="eventOptions"
        placeholder="全部事件"
        summary-prefix="事件"
        class="w-28"
      />
      <MultiSelectFilter
        v-model="years"
        :options="yearOptions"
        placeholder="全部年份"
        summary-prefix="年份"
        class="w-28"
      />

      <span class="text-muted-foreground ml-auto text-xs tabular-nums">
        符合条件
        <span class="text-foreground font-medium">{{ total.toLocaleString('zh-CN') }}</span> 条
      </span>
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
      <FilterChip
        v-for="f in activeFilters"
        :key="f.key"
        :label="f.label"
        @remove="f.clear()"
      />
      <Button
        v-if="activeFilters.length > 1"
        variant="ghost"
        size="sm"
        class="text-muted-foreground h-6 px-1.5 text-xs"
        @click="clearFilters"
      >
        清除全部
      </Button>
    </TransitionGroup>

    <Card class="rise-in gap-0 overflow-hidden py-0" style="--rise-index: 2">
      <CardContent class="p-0">
        <div
          ref="scrollRef"
          class="max-h-[max(320px,calc(100dvh-17rem))] overflow-auto [&_[data-slot=table-container]]:overflow-visible"
        >
          <!-- 6 列在窄屏放不下:给表格一个下限宽度,让它横向滚动,
               而不是把「企业名称」挤到只剩两个字。 -->
          <Table class="min-w-[1100px]">
            <TableHeader>
              <TableRow class="hover:bg-transparent">
                <TableHead :class="TH_CLASS">企业名称</TableHead>
                <TableHead :class="[TH_CLASS, 'w-40']">统一社会信用代码</TableHead>
                <TableHead :class="[TH_CLASS, 'w-20']">区县</TableHead>
                <TableHead :class="[TH_CLASS, 'w-40']">称号</TableHead>
                <TableHead :class="[TH_CLASS, 'w-40']">来源</TableHead>
                <TableHead :class="[TH_CLASS, 'w-60']">事件</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-if="isLoading && rows.length === 0" class="hover:bg-transparent">
                <TableCell :colspan="6" class="p-0">
                  <div class="flex flex-col">
                    <div
                      v-for="i in 8"
                      :key="i"
                      class="flex h-11 items-center gap-3 border-b px-3 last:border-b-0"
                    >
                      <Skeleton class="h-4 flex-1" />
                      <Skeleton class="h-4 w-40" />
                      <Skeleton class="h-4 w-16" />
                      <Skeleton class="h-5 w-28 rounded-sm" />
                    </div>
                  </div>
                </TableCell>
              </TableRow>

              <template v-else-if="rows.length">
                <TableRow aria-hidden class="hover:bg-transparent border-0">
                  <TableCell :colspan="6" :style="{ height: `${paddingTop}px`, padding: 0 }" />
                </TableRow>

                <TableRow
                  v-for="item in visibleRows"
                  :key="rowKey(item.row)"
                  class="hover:bg-accent/70 h-11 cursor-pointer"
                  @click="openRow(item.row.enterpriseId)"
                >
                  <TableCell class="max-w-0 truncate font-medium">
                    <NuxtLink
                      :to="`/enterprises/${item.row.enterpriseId}`"
                      :title="item.row.name"
                      class="hover:text-primary hover:underline"
                      @click.stop
                    >
                      {{ item.row.name }}
                    </NuxtLink>
                  </TableCell>
                  <TableCell class="text-muted-foreground font-mono text-xs">
                    {{ item.row.uscc ?? '—' }}
                  </TableCell>
                  <TableCell class="text-muted-foreground text-xs">
                    {{ item.row.district ?? '—' }}
                  </TableCell>
                  <TableCell>
                    <TitleBadge :code="item.row.titleCode" />
                  </TableCell>
                  <TableCell>
                    <div class="flex flex-wrap items-center gap-1">
                      <SourceChip v-for="s in item.row.sources" :key="s" :code="s" />
                    </div>
                  </TableCell>
                  <TableCell @click.stop>
                    <HoverCard :open-delay="100" :close-delay="120">
                      <HoverCardTrigger class="flex flex-wrap items-center gap-1">
                        <EventChip
                          v-for="(e, i) in item.row.events.slice(0, MAX_VISIBLE_EVENTS)"
                          :key="i"
                          :type="e.type"
                          :year="e.year"
                          :seq="e.seq"
                        />
                        <Badge
                          v-if="item.row.events.length > MAX_VISIBLE_EVENTS"
                          variant="quiet"
                          class="tabular-nums"
                        >
                          +{{ item.row.events.length - MAX_VISIBLE_EVENTS }}
                        </Badge>
                        <span
                          v-if="item.row.events.length === 0"
                          class="text-muted-foreground text-xs"
                        >
                          —
                        </span>
                      </HoverCardTrigger>
                      <HoverCardContent v-if="item.row.events.length" align="start" class="w-80 p-3">
                        <div class="flex items-baseline justify-between gap-2">
                          <span class="text-sm font-medium">全部事件</span>
                          <span class="text-muted-foreground text-xs tabular-nums">
                            {{ item.row.events.length }} 个
                          </span>
                        </div>
                        <ul class="mt-2.5 flex flex-col gap-1.5 border-t pt-2.5">
                          <li
                            v-for="(e, i) in item.row.events"
                            :key="i"
                            class="flex items-center gap-1.5"
                          >
                            <EventChip :type="e.type" :year="e.year" :seq="e.seq" />
                            <SourceChip :code="e.source" />
                          </li>
                        </ul>
                      </HoverCardContent>
                    </HoverCard>
                  </TableCell>
                </TableRow>

                <TableRow aria-hidden class="hover:bg-transparent border-0">
                  <TableCell :colspan="6" :style="{ height: `${paddingBottom}px`, padding: 0 }" />
                </TableRow>
              </template>

              <TableRow v-else class="hover:bg-transparent">
                <TableCell :colspan="6" class="p-0">
                  <Empty class="border-0">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <Search />
                      </EmptyMedia>
                      <EmptyTitle>没有匹配的记录</EmptyTitle>
                      <EmptyDescription>
                        去掉一两个筛选条件,或换个关键词再试。
                      </EmptyDescription>
                    </EmptyHeader>
                    <Button v-if="activeFilters.length" variant="outline" size="sm" @click="clearFilters">
                      清除全部筛选
                    </Button>
                  </Empty>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>

    <div class="rise-in flex flex-wrap items-center gap-x-4 gap-y-3" style="--rise-index: 3">
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
          :max="MAX_PAGE_SIZE"
          class="bg-card h-8 w-20"
          aria-label="自定义每页条数"
          @change="onSizeInput"
        />
        <span class="text-muted-foreground text-xs">条</span>
      </div>

      <span class="text-muted-foreground text-xs tabular-nums">
        第 {{ page }} / {{ totalPages }} 页
      </span>

      <Pagination
        v-if="total > 0"
        v-slot="{ page: current }"
        class="mx-0 ml-auto w-auto justify-end"
        :page="page"
        :items-per-page="pageSize"
        :total="total"
        :sibling-count="1"
        :show-edges="totalPages > 5"
        @update:page="setPage"
      >
        <PaginationContent v-slot="{ items }">
          <!-- 首/末/上/下一页的禁用态与页码变更由 reka-ui 的 Pagination 自己管,
               这里只给图标和中文文案。 -->
          <PaginationFirst>
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
          <PaginationLast>
            <ChevronsRight class="size-4" />
            <span class="sr-only">最后一页</span>
          </PaginationLast>
        </PaginationContent>
      </Pagination>
    </div>
  </div>
</template>
