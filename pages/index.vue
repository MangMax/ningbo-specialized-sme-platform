<script setup lang="ts">
import { useQuery } from '@pinia/colada'
import { computed, nextTick, ref, watch } from 'vue'
import { watchDebounced } from '@vueuse/core'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { ChevronLeft, ChevronRight } from '@lucide/vue'
import { TITLES, TITLE_ORDER, SOURCES, SOURCE_ORDER, EVENTS, EVENT_ORDER } from '~~/lib/labels'

interface Rec {
  enterpriseId: number
  name: string
  uscc: string | null
  district: string | null
  titleCode: string
  sources: string[]
  events: { type: string; year: number | null; seq: number | null; source: string }[]
}

const apiGet = $fetch as unknown as <T>(url: string, opts?: { query?: Record<string, unknown> }) => Promise<T>

interface Bucket {
  key: string
  n: number
}
interface Stats {
  byEvent: Bucket[]
  byYear: Bucket[]
}

const route = useRoute()
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
const search = ref('')
const q = ref('')
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
const titleOptions = computed(() => TITLE_ORDER.map((k) => ({ value: k, label: TITLES[k] ?? k })))
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

const hasExtraFilters = computed(
  () =>
    titles.value.length > 0 ||
    sources.value.length > 0 ||
    eventTypes.value.length > 0 ||
    years.value.length > 0 ||
    !!district.value,
)
function clearFilters() {
  titles.value = []
  sources.value = []
  eventTypes.value = []
  years.value = []
  district.value = ''
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
    estimateSize: () => 56,
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

/** 事件类型 → Badge 变体(与详情页口径一致)。 */
const EVENT_VARIANT: Record<string, 'default' | 'secondary' | 'outline'> = {
  award: 'secondary',
  review: 'outline',
  maintain: 'outline',
  nurture: 'outline',
}

/** 事件标签 = 整条事件,如 `认定 2023-1` / `维护 2025-1`。 */
const eventLabel = (e: Rec['events'][number]) =>
  `${EVENTS[e.type] ?? e.type} ${e.year ?? ''}${e.seq != null ? '-' + e.seq : ''}`.trim()

/** 表头单元格:吸顶 + 不透明底色(与侧栏外壳一致的沉稳表头)。 */
const TH_CLASS = 'text-muted-foreground bg-card border-b sticky top-0 z-20'

/** 台账格子内联展示的事件上限,超出折叠为 +N,悬浮展开完整卡片。 */
const MAX_VISIBLE_EVENTS = 2
function setPage(n: number) {
  page.value = Math.min(Math.max(1, n), totalPages.value)
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div>
      <h1 class="text-xl font-semibold">记录台账</h1>
    </div>

    <div class="flex flex-wrap items-center gap-3">
      <MultiSelectFilter v-model="titles" :options="titleOptions" placeholder="全部称号" summary-prefix="称号" class="w-40" />
      <MultiSelectFilter v-model="sources" :options="sourceOptions" placeholder="全部来源" summary-prefix="来源" class="w-36" />
      <MultiSelectFilter v-model="eventTypes" :options="eventOptions" placeholder="全部事件" summary-prefix="事件" class="w-36" />
      <MultiSelectFilter v-model="years" :options="yearOptions" placeholder="全部年份" summary-prefix="年份" class="w-32" />

      <Badge v-if="district" variant="secondary">区县:{{ district }}</Badge>
      <Button v-if="hasExtraFilters" variant="ghost" size="sm" @click="clearFilters">清除筛选</Button>

      <Input v-model="search" placeholder="搜索企业名称或统一社会信用代码" class="w-72" />

      <Button as-child variant="outline" size="sm" class="ml-auto">
        <a :href="exportUrl">导出当前结果</a>
      </Button>
    </div>

    <Card class="gap-0 overflow-hidden py-0">
      <CardContent class="p-0">
        <div ref="scrollRef" class="max-h-[68vh] overflow-auto [&_[data-slot=table-container]]:overflow-visible">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead :class="TH_CLASS">企业名称</TableHead>
                <TableHead :class="TH_CLASS">统一社会信用代码</TableHead>
                <TableHead :class="TH_CLASS">区县</TableHead>
                <TableHead :class="TH_CLASS">称号</TableHead>
                <TableHead :class="TH_CLASS">来源</TableHead>
                <TableHead :class="TH_CLASS">事件</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-if="isLoading && rows.length === 0">
                <TableCell :colspan="6"><Skeleton class="h-5 w-full" /></TableCell>
              </TableRow>

              <template v-else-if="rows.length">
                <TableRow aria-hidden class="hover:bg-transparent border-0">
                  <TableCell :colspan="6" :style="{ height: `${paddingTop}px`, padding: 0 }" />
                </TableRow>

                <TableRow v-for="item in visibleRows" :key="rowKey(item.row)" class="h-14">
                  <TableCell class="max-w-[320px] truncate font-medium">
                    <NuxtLink :to="`/enterprises/${item.row.enterpriseId}`" class="hover:underline">
                      {{ item.row.name }}
                    </NuxtLink>
                  </TableCell>
                  <TableCell class="text-muted-foreground font-mono text-xs">
                    {{ item.row.uscc ?? '—' }}
                  </TableCell>
                  <TableCell>{{ item.row.district ?? '—' }}</TableCell>
                  <TableCell>{{ TITLES[item.row.titleCode] ?? item.row.titleCode }}</TableCell>
                  <TableCell>
                    <div class="flex flex-wrap items-center gap-1">
                      <Badge
                        v-for="s in item.row.sources"
                        :key="s"
                        :variant="s === 'jxj' ? 'secondary' : 'outline'"
                      >
                        {{ SOURCES[s] ?? s }}
                      </Badge>
                    </div>
                  </TableCell>
                  <TableCell>
                    <HoverCard :open-delay="100" :close-delay="120">
                      <HoverCardTrigger class="flex flex-wrap items-center gap-1">
                        <Badge
                          v-for="(e, i) in item.row.events.slice(0, MAX_VISIBLE_EVENTS)"
                          :key="i"
                          :variant="EVENT_VARIANT[e.type] ?? 'outline'"
                        >
                          {{ eventLabel(e) }}
                        </Badge>
                        <Badge
                          v-if="item.row.events.length > MAX_VISIBLE_EVENTS"
                          variant="secondary"
                        >
                          +{{ item.row.events.length - MAX_VISIBLE_EVENTS }}
                        </Badge>
                        <span v-if="item.row.events.length === 0" class="text-muted-foreground text-xs">
                          —
                        </span>
                      </HoverCardTrigger>
                      <HoverCardContent v-if="item.row.events.length" align="start" class="w-80 p-0">
                        <Card class="gap-0 border-0 py-0 shadow-none">
                          <CardHeader class="gap-1 p-4 pb-2">
                            <CardTitle class="text-sm">全部事件 · {{ item.row.events.length }} 个</CardTitle>
                            <CardDescription class="truncate">
                              {{ item.row.name }} · {{ TITLES[item.row.titleCode] ?? item.row.titleCode }}
                            </CardDescription>
                          </CardHeader>
                          <CardContent class="p-4 pt-0">
                            <ul class="flex flex-col gap-1.5">
                              <li
                                v-for="(e, i) in item.row.events"
                                :key="i"
                                class="flex items-center gap-2"
                              >
                                <Badge :variant="EVENT_VARIANT[e.type] ?? 'outline'">
                                  {{ eventLabel(e) }}
                                </Badge>
                                <Badge variant="outline" class="text-muted-foreground font-normal">
                                  {{ SOURCES[e.source] ?? e.source }}
                                </Badge>
                              </li>
                            </ul>
                          </CardContent>
                        </Card>
                      </HoverCardContent>
                    </HoverCard>
                  </TableCell>
                </TableRow>

                <TableRow aria-hidden class="hover:bg-transparent border-0">
                  <TableCell :colspan="6" :style="{ height: `${paddingBottom}px`, padding: 0 }" />
                </TableRow>
              </template>

              <TableRow v-else>
                <TableCell :colspan="6" class="text-muted-foreground h-24 text-center">
                  没有匹配的记录
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>

    <div class="flex flex-wrap items-center gap-x-4 gap-y-3">
      <div class="flex items-center gap-2">
        <span class="text-muted-foreground text-sm">每页</span>
        <Select v-model="sizeModel">
          <SelectTrigger class="h-8 w-24">
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
          class="h-8 w-24"
          @change="onSizeInput"
        />
        <span class="text-muted-foreground text-sm">条</span>
      </div>

      <span class="text-muted-foreground text-sm">
        共 {{ total }} 条 · 第 {{ page }} / {{ totalPages }} 页
      </span>

      <Pagination
        v-if="total > 0"
        class="mx-0 ml-auto w-auto justify-end"
        v-slot="{ page: current }"
        :page="page"
        :items-per-page="pageSize"
        :total="total"
        :sibling-count="1"
        :show-edges="totalPages > 5"
        @update:page="setPage"
      >
        <PaginationContent v-slot="{ items }">
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
        </PaginationContent>
      </Pagination>
    </div>
  </div>
</template>
