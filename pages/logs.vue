<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { LogFilter, LogSummary } from '~~/lib/logging/contract'
import { logBrowserHeaders, logErrorMessage, useLogRead } from '~/composables/useLogRead'
import { describeLogRow, sourceLabel, outcomeLabel } from '@/components/logs/logPresentation'
import LogFilters from '@/components/logs/LogFilters.vue'
import LogDetail from '@/components/logs/LogDetail.vue'
import LogManagement from '@/components/logs/LogManagement.vue'
import PageHeader from '@/components/PageHeader.vue'
import TableLoadingStatus from '@/components/TableLoadingStatus.vue'
import TableFailureState from '@/components/TableFailureState.vue'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import TablePagination from '@/components/TablePagination.vue'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription
} from '@/components/ui/sheet'
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '@/components/ui/empty'
useHead({ title: '运行日志' })
const route = useRoute(),
  router = useRouter()
const activeTab = computed({
  get: () => route.query.tab === 'settings' ? 'settings' : 'logs',
  set: (value: string | number) => {
    selected.value = ''
    void router.replace({ path: '/logs', query: { ...route.query, tab: value === 'settings' ? 'settings' : undefined } })
  }
})
const settingsVisited = ref(false)
watch(activeTab, value => { if (value === 'settings') settingsVisited.value = true }, { immediate: true })
const filter = computed<LogFilter>((previous) => {
  const current: LogFilter = Object.fromEntries(
    [
      'from',
      'to',
      'level',
      'source',
      'operation',
      'outcome',
      'requestId',
      'traceId',
      'taskId',
      'fileId',
      'batchId',
      'resourceId'
    ].flatMap((key) =>
      typeof route.query[key] === 'string' && route.query[key] ? [[key, route.query[key]]] : []
    )
  )
  return previous && JSON.stringify(previous) === JSON.stringify(current) ? previous : current
})
const limit = ref(25),
  cursors = ref<(string | undefined)[]>([undefined]),
  page = ref(1),
  selected = ref('')
watch(
  filter,
  () => {
    cursors.value = [undefined]
    page.value = 1
    selected.value = ''
  },
  { flush: 'sync' }
)
const key = computed(() =>
  JSON.stringify({
    filter: filter.value,
    limit: limit.value,
    cursor: cursors.value[page.value - 1],
    page: page.value
  })
)
type ListView = {
  rows: LogSummary[]
  nextCursor: string | null
  status: { dropped: number; unavailable: boolean; since: string }
}
const { data, sourceKey, loading, error, refresh } = useLogRead(key, (target, signal) => {
  const request = JSON.parse(target)
  return $fetch<ListView>('/api/logs', {
    headers: logBrowserHeaders,
    retry: 0,
    query: { ...request.filter, limit: request.limit, cursor: request.cursor },
    signal
  })
})
const source = computed(() =>
  sourceKey.value
    ? (JSON.parse(sourceKey.value) as { filter: LogFilter; page: number; limit: number })
    : null
)
const stale = computed(() => sourceKey.value !== key.value)
const rows = computed(() => data.value?.rows ?? [])
// Only pages with a known cursor boundary can be selected. A changed boundary
// invalidates later page numbers instead of reusing a different result range.
watch([data, sourceKey, loading], () => {
  if (loading.value || error.value || sourceKey.value !== key.value || !data.value) return
  const boundary = data.value.nextCursor
  if (!boundary) cursors.value = cursors.value.slice(0, page.value)
  else if (cursors.value[page.value] !== boundary)
    cursors.value = [...cursors.value.slice(0, page.value), boundary]
}, { flush: 'post' })
/** 每行只派生一次：来源/操作/目标/结果/耗时/状态/关联都由 presentation 模块决定。 */
const described = computed(() => rows.value.map((row) => ({ row, view: describeLogRow(row) })))
/** 首次读取（还没有任何结果）才铺骨架；刷新/换页保留旧结果。 */
const firstLoad = computed(() => loading.value && !data.value && !error.value)

const FILTER_LABELS: Record<string, string> = {
  from: '开始时间',
  to: '结束时间',
  level: '级别',
  source: '来源',
  outcome: '结果',
  operation: '操作',
  requestId: '请求标识',
  traceId: '链路标识',
  taskId: '任务标识',
  fileId: '文件编号',
  batchId: '批次标识',
  resourceId: '资源标识'
}
const localStamp = (iso: string) => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')
}
/** 失败说明只用人能读的筛选摘要；不再序列化筛选对象，也不泄露内部键名。 */
function filterSummary(value: LogFilter) {
  const parts: string[] = []
  for (const [key, label] of Object.entries(FILTER_LABELS)) {
    const raw = value[key as keyof LogFilter]
    if (raw === undefined || raw === null || raw === '') continue
    const display = key === 'from' || key === 'to' ? localStamp(String(raw))
      : key === 'source' ? sourceLabel(String(raw))
      : key === 'outcome' ? outcomeLabel(String(raw)) : String(raw)
    parts.push(`${label} ${display}`)
  }
  return parts.length ? parts.join(' · ') : '未设筛选'
}
/** 旧结果还在时，先说清“看到的是哪一页、哪组条件”。 */
const retainedSummary = computed(() =>
  data.value && source.value
    ? `已保留第 ${source.value.page} 页的 ${rows.value.length} 条旧结果（${filterSummary(source.value.filter)}）`
    : ''
)
const failureDescription = computed(() => {
  const asked = filterSummary(filter.value)
  if (!data.value || !source.value)
    return `筛选已保留（${asked}），可以重新加载。`
  return `${retainedSummary.value}；当前筛选（${asked}）未能读取。`
})
async function apply(value: Record<string, string>) {
  requestReset()
  await router.push({ path: '/logs', query: value })
}
function resize(value: unknown) {
  requestReset(true)
  limit.value = Number(value)
  cursors.value = [undefined]
  page.value = 1
}
function next() {
  if (!loading.value && !error.value && !stale.value && data.value?.nextCursor) {
    cursors.value[page.value] = data.value.nextCursor
    goToPage(page.value + 1)
  }
}
function goToPage(value: number) {
  if (loading.value || !Number.isInteger(value) || value < 1 || value > cursors.value.length) return
  if (value > 1 && !cursors.value[value - 1]) return
  if (value === page.value) {
    if (error.value) { requestReset(true); void refresh() }
    return
  }
  requestReset(true)
  page.value = value
}
function previous() {
  goToPage(page.value - 1)
}
function fresh() {
  requestReset()
  const first = page.value === 1
  cursors.value = [undefined]
  page.value = 1
  if (first) void refresh()
}
/** 人们读的时间；机器值仍留在 `<time :datetime>`。日期用短横线，和任务页同一形状。 */
const dated = (iso: string) =>
  new Date(iso).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')

// —— 换页/换筛选后回到结果顶部；失败时保持原位置和原结果 ——
const resultsRef = ref<HTMLElement | null>(null)
const tableScrollRef = ref<HTMLElement | null>(null)
const pendingReset = ref(false)
const pendingFocus = ref(false)
const tableOverflows = ref(false)
const tableAtBottom = ref(true)
/** 换页要把位置和焦点带回结果顶部；筛选只复位滚动，不把焦点从输入框抢走。 */
function requestReset(focus = false) {
  pendingReset.value = true
  pendingFocus.value = focus
}
function syncTableScroll() {
  const element = tableScrollRef.value
  if (!element) {
    tableOverflows.value = false
    tableAtBottom.value = true
    return
  }
  tableOverflows.value = element.scrollHeight > element.clientHeight + 1
  tableAtBottom.value = element.scrollTop + element.clientHeight >= element.scrollHeight - 2
}
const onTableScroll = () => syncTableScroll()
let tableObserver: ResizeObserver | undefined
watch(tableScrollRef, (element, previousElement) => {
  if (previousElement) tableObserver?.unobserve(previousElement)
  if (element) tableObserver?.observe(element)
  void nextTick(syncTableScroll)
})
onMounted(() => {
  if (typeof ResizeObserver !== 'undefined') {
    tableObserver = new ResizeObserver(() => syncTableScroll())
    if (tableScrollRef.value) tableObserver.observe(tableScrollRef.value)
  }
  void nextTick(syncTableScroll)
})
onBeforeUnmount(() => tableObserver?.disconnect())
watch([rows, loading, error, limit], () => void nextTick(syncTableScroll))
watch([loading, error, data], () => {
  if (!pendingReset.value || loading.value) return
  if (error.value || !data.value) {
    // 失败保留旧结果和原位置；下一次成功的读取才复位。
    if (error.value) pendingReset.value = false
    return
  }
  pendingReset.value = false
  const focusResults = pendingFocus.value
  pendingFocus.value = false
  void nextTick(() => {
    if (tableScrollRef.value) tableScrollRef.value.scrollTop = 0
    const section = resultsRef.value
    if (!section) return
    const top = section.getBoundingClientRect().top + window.scrollY - 72
    if (window.scrollY > top) window.scrollTo({ top, behavior: 'auto' })
    if (focusResults) section.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true })
  })
})

const anchor = ref('')
function open(id: string) {
  anchor.value = id
  selected.value = id
}
function restoreFocus(event: Event) {
  event.preventDefault()
  const buttons = Array.from(document.querySelectorAll<HTMLElement>('[data-log-detail]'))
  buttons
    .find((b) => b.dataset.logDetail === anchor.value && b.getClientRects().length)
    ?.focus({ preventScroll: true })
}
</script>
<template>
  <div class="flex min-w-0 flex-col gap-2 sm:h-[calc(100dvh-6rem)] sm:min-h-0 sm:gap-3">
    <PageHeader
      class="shrink-0"
      title="运行日志"
      description="按操作和关联标识排查运行情况。运行日志不代替业务审计或回执。"
      ><template #actions
        ><Button v-if="activeTab === 'logs'" variant="outline" size="sm" :disabled="loading" @click="fresh"
          >刷新最新日志</Button
        ></template
      ></PageHeader
    >
    <Tabs v-model="activeTab" class="min-h-0 flex-1 gap-3">
      <TabsList class="shrink-0" aria-label="日志功能">
        <TabsTrigger value="logs" class="min-h-11 sm:min-h-0">运行日志</TabsTrigger>
        <TabsTrigger value="settings" class="min-h-11 sm:min-h-0">保留与清理</TabsTrigger>
      </TabsList>
      <TabsContent value="logs" force-mount v-show="activeTab === 'logs'" class="flex min-h-0 flex-col gap-3">
    <!-- 快速筛选与高级筛选共用这一张卡：筛选只有一层表面。 -->
    <Card class="min-w-0 shrink-0 gap-0 py-0 shadow-none"
      ><CardContent class="p-3"><LogFilters :filter="filter" @apply="apply" /></CardContent></Card
    >
    <section
      ref="resultsRef"
      aria-labelledby="log-list-heading"
      class="flex min-w-0 flex-col sm:min-h-[320px] sm:flex-1"
    >
      <h2 id="log-list-heading" class="sr-only scroll-mt-16" tabindex="-1">日志列表</h2>
      <Card
        class="flex min-w-0 flex-col gap-0 overflow-hidden py-0 shadow-none sm:min-h-[320px] sm:flex-1"
      >
        <CardContent class="relative flex min-h-0 flex-1 flex-col p-0">
        <TableLoadingStatus :loading="loading" kind="files" label="正在读取运行日志…" />
        <!-- 存储状态属于这份列表，不属于筛选：压在卡片顶部，收起时也不单独占一段。 -->
        <p
          v-if="data?.status"
          class="text-muted-foreground flex shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5 border-b px-4 py-2 text-[13px] leading-5"
        >
          <span :class="data.status.unavailable ? 'text-destructive' : ''">{{
            data.status.unavailable ? '日志存储不可用' : '日志存储可用'
          }}</span>
          <span aria-hidden="true">·</span>
          <span class="tabular-nums">本进程已丢弃 {{ data.status.dropped }} 条</span>
          <template v-if="data.status.unavailable || data.status.dropped > 0">
            <span aria-hidden="true">·</span>
            <span>日志缺失不代表业务未执行</span>
          </template>
        </p>
        <!-- 首次读取时状态条先占住同样的高度，结果区不会因为少这一行而跳。 -->
        <div v-else-if="firstLoad" class="flex shrink-0 items-center border-b px-4 py-2">
          <Skeleton class="h-5 w-56" aria-hidden="true" />
        </div>
        <TableFailureState
          v-if="error"
          class="shrink-0"
          :title="`第 ${page} 页日志读取失败`"
          :description="`${logErrorMessage(error)} ${failureDescription}`"
          :compact="!!data"
          :pending="loading"
          @retry="refresh"
        />
        <p
          v-else-if="stale && data"
          role="status"
          class="text-muted-foreground shrink-0 border-b px-4 py-2 text-[13px] leading-5 break-all"
        >
          正在读取当前筛选。{{ retainedSummary }}。
        </p>
        <template v-if="!error || data">
          <div class="relative flex min-h-0 flex-1 flex-col">
            <!-- 结果区只有这一层纵向滚动：表头吸顶，分页始终留在卡的底部。
                 行尾留一点渐隐，提示下面还有行，不让裁切读成渲染错误。 -->
            <div
              ref="tableScrollRef"
              data-testid="log-table-scroll"
              class="hidden min-h-0 flex-1 overflow-auto sm:block [&_[data-slot=table-container]]:overflow-visible"
              @scroll.passive="onTableScroll"
            >
              <Table class="data-table w-full min-w-[940px] table-fixed">
                <TableHeader class="sticky top-0 z-10"><TableRow class="hover:bg-transparent">
                  <TableHead class="w-[12%]">时间</TableHead>
                  <TableHead class="w-[8%]">级别</TableHead>
                  <TableHead class="w-[9%]">来源</TableHead>
                  <TableHead class="w-[13%]">操作</TableHead>
                  <TableHead class="w-[15%]">目标</TableHead>
                  <TableHead class="w-[9.5%]">结果</TableHead>
                  <TableHead class="w-[11%]">失败码</TableHead>
                  <TableHead class="w-[8%]">耗时</TableHead>
                  <TableHead class="w-[6.5%] whitespace-normal leading-4">HTTP 状态</TableHead>
                  <TableHead class="w-[8%]">详情</TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  <TableRow
                    v-for="n in firstLoad ? limit : 0"
                    :key="`skeleton-${n}`"
                    data-testid="log-row-skeleton"
                    aria-hidden="true"
                  >
                    <TableCell><Skeleton class="h-4 w-28" /></TableCell>
                    <TableCell><Skeleton class="h-5 w-12" /></TableCell>
                    <TableCell>
                      <div class="flex flex-col gap-1">
                        <Skeleton class="h-3 w-16" /><Skeleton class="h-3 w-10" />
                      </div>
                    </TableCell>
                    <TableCell>
                      <div class="flex flex-col gap-1">
                        <Skeleton class="h-3 w-24" /><Skeleton class="h-3 w-20" />
                      </div>
                    </TableCell>
                    <TableCell><Skeleton class="h-4 w-40" /></TableCell>
                    <TableCell><Skeleton class="h-5 w-12" /></TableCell>
                    <TableCell><Skeleton class="h-4 w-24" /></TableCell>
                    <TableCell><Skeleton class="h-4 w-16" /></TableCell>
                    <TableCell><Skeleton class="h-4 w-12" /></TableCell>
                    <TableCell><Skeleton class="h-8 w-14" /></TableCell>
                  </TableRow>
                  <TableRow v-for="item in described" :key="item.row.id">
                    <TableCell class="overflow-hidden">
                      <time
                        :datetime="item.row.timestamp"
                        :title="item.row.timestamp"
                        class="block text-[13px] tabular-nums whitespace-normal"
                        >{{ dated(item.row.timestamp) }}</time
                      >
                    </TableCell>
                    <TableCell class="overflow-hidden">
                      <Badge
                        :variant="item.view.levelVariant"
                        :class="item.view.levelClass"
                        class="w-12 shrink-0 justify-center"
                        >{{ item.row.level }}</Badge
                      >
                    </TableCell>
                    <TableCell class="overflow-hidden">
                      <div class="flex min-w-0 flex-col leading-4">
                        <span class="truncate text-[13px]" :title="item.view.sourceLabel">{{
                          item.view.sourceLabel
                        }}</span>
                        <span
                          class="text-muted-foreground truncate font-mono text-xs"
                          :title="item.view.sourceCode"
                          >{{ item.view.sourceCode }}</span
                        >
                      </div>
                    </TableCell>
                    <TableCell class="overflow-hidden">
                      <div class="flex min-w-0 flex-col leading-4">
                        <span
                          v-if="item.view.operationLabel"
                          class="truncate text-[13px]"
                          :title="item.view.operationLabel"
                          >{{ item.view.operationLabel }}</span
                        >
                        <span
                          class="truncate font-mono"
                          :class="
                            item.view.operationLabel
                              ? 'text-muted-foreground text-xs'
                              : 'text-[13px]'
                          "
                          :title="item.view.operationCode"
                          >{{ item.view.operationCode }}</span
                        >
                      </div>
                    </TableCell>
                    <TableCell class="overflow-hidden">
                      <span
                        class="block min-w-0 truncate text-[13px]"
                        :class="item.view.target.missing ? 'text-muted-foreground' : ''"
                        :title="item.view.target.text"
                        >{{ item.view.target.text }}</span
                      >
                      <span
                        v-if="item.view.target.untrusted"
                        class="text-muted-foreground block truncate text-xs"
                        >UNTRUSTED</span
                      >
                    </TableCell>
                    <TableCell class="overflow-hidden">
                      <Badge
                        :variant="item.view.outcomeVariant"
                        :class="item.view.outcomeClass"
                        :title="item.view.outcomeCode"
                        >{{ item.view.outcomeLabel }}</Badge
                      >
                    </TableCell>
                    <TableCell class="overflow-hidden">
                      <span
                        class="block truncate font-mono text-xs"
                        :class="item.view.errorCodePresent ? '' : 'font-sans text-muted-foreground'"
                        :title="item.view.errorCodeText"
                        >{{ item.view.errorCodeText }}</span
                      >
                    </TableCell>
                    <TableCell class="overflow-hidden">
                      <span
                        class="block truncate text-[13px] tabular-nums"
                        :class="item.view.durationMissing ? 'text-muted-foreground' : ''"
                        :title="item.view.durationText"
                        >{{ item.view.durationText }}</span
                      >
                    </TableCell>
                    <TableCell class="overflow-hidden">
                      <span
                        class="block truncate text-[13px] tabular-nums"
                        :class="
                          item.view.statusMissing || !item.view.statusApplicable
                            ? 'text-muted-foreground'
                            : ''
                        "
                        :title="item.view.statusText"
                        >{{ item.view.statusText }}</span
                      >
                    </TableCell>
                    <TableCell class="overflow-hidden">
                      <Button
                        variant="outline"
                        size="sm"
                        :data-log-detail="item.row.id"
                        :aria-label="`查看日志 ${item.row.operation} ${item.row.id}`"
                        @click="open(item.row.id)"
                        >查看</Button
                      >
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
              <Empty v-if="!rows.length && !loading" class="border-0 py-12"
                ><EmptyHeader
                  ><EmptyTitle>没有符合条件的运行日志</EmptyTitle
                  ><EmptyDescription class="text-balance"
                    >可调整筛选。日志可能已过期或清理，不能据此判断业务是否执行。</EmptyDescription
                  ></EmptyHeader
                ></Empty
              >
            </div>
            <!-- 窄屏用同一份数据的摘要：来源与操作各自带词，不必横向滚动。 -->
            <ul
              v-if="rows.length || firstLoad"
              data-testid="log-card-list"
              class="flex min-w-0 flex-col divide-y sm:hidden"
              aria-label="运行日志列表"
            >
              <template v-if="firstLoad">
                <li
                  v-for="n in limit"
                  :key="`skeleton-${n}`"
                  data-testid="log-card-skeleton"
                  class="flex min-w-0 flex-col gap-2 p-3"
                  aria-hidden="true"
                >
                  <div class="flex items-start justify-between gap-3">
                    <div class="flex min-w-0 flex-col gap-1">
                      <div class="flex flex-wrap items-center gap-2">
                        <Skeleton class="h-5 w-12" /><Skeleton class="h-5 w-32" />
                      </div>
                      <div class="flex min-w-0 items-baseline gap-1.5">
                        <Skeleton class="h-3 w-8 shrink-0" /><Skeleton class="h-5 w-40" />
                      </div>
                    </div>
                    <Skeleton class="h-11 w-14" />
                  </div>
                  <div class="flex min-w-0 flex-col gap-1">
                    <div
                      v-for="row in 6"
                      :key="row"
                      class="flex min-w-0 items-baseline gap-1.5"
                      data-skeleton-row
                    >
                      <Skeleton class="h-3 w-10 shrink-0" />
                      <Skeleton class="h-5 max-w-full" :class="row === 3 ? 'w-56' : 'w-40'" />
                    </div>
                  </div>
                </li>
              </template>
              <li
                v-for="item in described"
                :key="item.row.id"
                class="flex min-w-0 flex-col gap-2 p-3"
              >
                <div class="flex items-start justify-between gap-3">
                  <div class="flex min-w-0 flex-col gap-1">
                    <div class="flex flex-wrap items-center gap-2">
                      <Badge
                        :variant="item.view.levelVariant"
                        :class="item.view.levelClass"
                        class="w-12 justify-center"
                        >{{ item.row.level }}</Badge
                      >
                      <time
                        :datetime="item.row.timestamp"
                        :title="item.row.timestamp"
                        class="text-[13px] tabular-nums"
                        >{{ dated(item.row.timestamp) }}</time
                      >
                    </div>
                    <div class="flex min-w-0 items-baseline gap-1.5">
                      <span class="text-muted-foreground shrink-0 text-xs">操作</span>
                      <span class="min-w-0 break-all text-[13px]"
                        ><template v-if="item.view.operationLabel"
                          >{{ item.view.operationLabel }}<span class="text-muted-foreground">
                            · </span
                          ></template
                        ><span class="font-mono text-xs">{{ item.view.operationCode }}</span></span
                      >
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    class="min-h-11 shrink-0"
                    :data-log-detail="item.row.id"
                    :aria-label="`查看日志 ${item.row.operation} ${item.row.id}`"
                    @click="open(item.row.id)"
                    >查看</Button
                  >
                </div>
                <div class="flex min-w-0 flex-col gap-1 text-[13px]">
                  <div class="flex min-w-0 items-baseline gap-1.5">
                    <span class="text-muted-foreground shrink-0 text-xs">来源</span>
                    <span class="min-w-0 break-all"
                      >{{ item.view.sourceLabel }}
                      <span class="text-muted-foreground font-mono text-xs">{{
                        item.view.sourceCode
                      }}</span></span
                    >
                  </div>
                  <div class="flex min-w-0 items-baseline gap-1.5">
                    <span class="text-muted-foreground shrink-0 text-xs">结果</span>
                    <Badge
                      :variant="item.view.outcomeVariant"
                      :class="item.view.outcomeClass"
                      :title="item.view.outcomeCode"
                      >{{ item.view.outcomeLabel }}</Badge
                    >
                  </div>
                  <div class="flex min-w-0 items-baseline gap-1.5" data-log-field="errorCode">
                    <span class="text-muted-foreground shrink-0 text-xs">失败码</span>
                    <span
                      class="min-w-0 break-all font-mono text-xs"
                      :class="item.view.errorCodePresent ? '' : 'font-sans text-muted-foreground'"
                      >{{ item.view.errorCodeText }}</span
                    >
                  </div>
                  <div class="flex min-w-0 items-baseline gap-1.5">
                    <span class="text-muted-foreground shrink-0 text-xs">目标</span>
                    <span
                      class="min-w-0 break-all"
                      :class="item.view.target.missing ? 'text-muted-foreground' : ''"
                      >{{ item.view.target.text }}<template v-if="item.view.target.untrusted"
                        >&nbsp;· UNTRUSTED</template
                      ></span
                    >
                  </div>
                  <div v-if="item.view.statusApplicable" class="flex min-w-0 items-baseline gap-1.5">
                    <span class="text-muted-foreground shrink-0 text-xs">HTTP 状态</span>
                    <span
                      class="min-w-0 tabular-nums"
                      :class="item.view.statusMissing ? 'text-muted-foreground' : ''"
                      >{{ item.view.statusText }}</span
                    >
                  </div>
                  <div class="flex min-w-0 items-baseline gap-1.5">
                    <span class="text-muted-foreground shrink-0 text-xs">耗时</span>
                    <span
                      class="min-w-0 tabular-nums"
                      :class="item.view.durationMissing ? 'text-muted-foreground' : ''"
                      >{{ item.view.durationText }}</span
                    >
                  </div>
                  <div class="flex min-w-0 items-baseline gap-1.5">
                    <span class="text-muted-foreground shrink-0 text-xs">关联</span>
                    <span
                      v-if="item.view.primaryReference"
                      class="min-w-0 break-all font-mono text-xs"
                      >{{ item.view.primaryReference.kind }}
                      {{ item.view.primaryReference.value }}<template
                        v-if="item.view.extraReferenceCount"
                        >&nbsp;· +{{ item.view.extraReferenceCount }}</template
                      ></span
                    >
                    <span v-else class="text-muted-foreground">未记录</span>
                  </div>
                </div>
              </li>
            </ul>
            <Empty v-if="!rows.length && !loading" class="border-0 sm:hidden"
              ><EmptyHeader
                ><EmptyTitle>没有符合条件的运行日志</EmptyTitle
                ><EmptyDescription class="text-balance"
                  >可调整筛选。日志可能已过期或清理，不能据此判断业务是否执行。</EmptyDescription
                ></EmptyHeader
              ></Empty
            >
            <div
              v-if="tableOverflows && !tableAtBottom"
              class="from-card pointer-events-none absolute inset-x-0 bottom-0 hidden h-8 bg-gradient-to-t to-transparent sm:block"
              aria-hidden="true"
            />
          </div>
          <!-- 分页：复用 cursor 表达与它自己的尺寸所有权；接口没有 total，不编造总页数。 -->
          <div class="shrink-0 border-t p-3">
            <TablePagination
              mode="cursor"
              :page="source?.page ?? page"
              :page-size="limit"
              unit="条"
              :max-page-size="100"
              :loading="loading"
              :has-next="!error && !stale && !!data?.nextCursor"
              :known-page-count="cursors.length"
              @update:page-size="resize"
              @previous="previous"
              @next="next"
              @update:page="goToPage"
              >{{ firstLoad ? '正在读取…' : `本页 ${rows.length} 条 · 第 ${source?.page ?? page} 页` }}</TablePagination
            >
          </div>
        </template>
        </CardContent>
      </Card>
    </section>
      </TabsContent>
      <TabsContent value="settings" force-mount v-show="activeTab === 'settings'" class="min-h-0 overflow-y-auto">
        <Card class="max-w-3xl shadow-none">
          <CardHeader>
            <CardTitle>日志配置</CardTitle>
            <CardDescription>清理范围沿用运行日志中已应用的筛选；修改筛选后可返回本页核对。</CardDescription>
          </CardHeader>
          <CardContent><LogManagement v-if="settingsVisited" :filter="filter" @changed="fresh" /></CardContent>
        </Card>
      </TabsContent>
    </Tabs>
    <Sheet
      :open="!!selected"
      @update:open="
        (value) => {
          if (!value) selected = ''
        }
      "
      ><SheetContent class="w-full gap-0 sm:max-w-lg" @close-auto-focus="restoreFocus"
        ><SheetHeader class="shrink-0 border-b px-6 py-5 pr-12"
          ><SheetTitle>运行日志详情</SheetTitle
          ><SheetDescription
            >按需读取脱敏字段；审计与回执标识仅为引用。</SheetDescription
          ></SheetHeader
        >
        <div
          class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pt-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]"
        ><LogDetail v-if="selected" :id="selected" /></div></SheetContent
    ></Sheet>
  </div>
</template>
