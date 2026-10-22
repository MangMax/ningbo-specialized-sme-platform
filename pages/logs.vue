<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { LogFilter, LogSummary } from '~~/lib/logging/contract'
import { logBrowserHeaders, logErrorMessage, useLogRead } from '~/composables/useLogRead'
import LogFilters from '@/components/logs/LogFilters.vue'
import LogDetail from '@/components/logs/LogDetail.vue'
import LogManagement from '@/components/logs/LogManagement.vue'
import PageHeader from '@/components/PageHeader.vue'
import TableLoadingStatus from '@/components/TableLoadingStatus.vue'
import TableFailureState from '@/components/TableFailureState.vue'
import DisclosurePanel from '@/components/DisclosurePanel.vue'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
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
const filter = computed<LogFilter>(() =>
  Object.fromEntries(
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
)
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
const provenance = computed(() =>
  source.value
    ? `保留上次结果（第 ${source.value.page} 页，筛选 ${JSON.stringify(source.value.filter)}）；当前请求第 ${page.value} 页，筛选 ${JSON.stringify(filter.value)}。`
    : '筛选已保留，可以重新加载。'
)
async function apply(value: Record<string, string>) {
  await router.push({ path: '/logs', query: value })
}
function resize(value: unknown) {
  limit.value = Number(value)
  cursors.value = [undefined]
  page.value = 1
}
function next() {
  if (!loading.value && !error.value && !stale.value && data.value?.nextCursor) {
    cursors.value[page.value] = data.value.nextCursor
    page.value++
  }
}
function previous() {
  if (!loading.value && page.value > 1) page.value--
}
function fresh() {
  const first = page.value === 1
  cursors.value = [undefined]
  page.value = 1
  if (first) void refresh()
}
/** 人们读的时间；机器值仍留在 `<time :datetime>`。日期用短横线，和任务页同一形状。 */
const dated = (iso: string) =>
  new Date(iso).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')
/** 关联标识先说清是哪一类，排查时才知道该拿它去哪一页。 */
const reference = (row: LogSummary) => row.taskId || row.requestId || row.traceId || ''
const referenceKind = (row: LogSummary) =>
  row.taskId ? '任务' : row.requestId ? '请求' : row.traceId ? '链路' : ''
const levelVariant = (level: string) =>
  level === 'error' ? 'destructive' : level === 'warn' ? 'outline' : 'secondary'
const levelClass = (level: string) => (level === 'warn' ? 'border-warning/50 text-warning' : '')
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
  <div class="flex min-w-0 flex-col gap-2 sm:gap-3">
    <PageHeader
      title="运行日志"
      description="按操作和关联标识排查运行情况。运行日志不代替业务审计或回执。"
      ><template #actions
        ><Button variant="outline" size="sm" :disabled="loading" @click="fresh"
          >刷新最新日志</Button
        ></template
      ></PageHeader
    >
    <LogFilters :filter="filter" @apply="apply" />
    <section aria-labelledby="log-list-heading" class="flex min-w-0 flex-col">
      <h2 id="log-list-heading" class="sr-only">日志列表</h2>
      <Card class="min-w-0 gap-0 overflow-hidden py-0 shadow-none">
        <CardContent class="relative p-0">
        <TableLoadingStatus :loading="loading" kind="files" label="正在读取运行日志…" />
        <!-- 存储状态属于这份列表，不属于筛选：压在卡片顶部，收起时也不单独占一段。 -->
        <p
          v-if="data?.status"
          class="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b px-4 py-2 text-[13px] leading-5"
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
        <TableFailureState
          v-if="error"
          :title="`第 ${page} 页日志读取失败`"
          :description="`${logErrorMessage(error)} ${provenance}`"
          :compact="!!data"
          :pending="loading"
          @retry="refresh"
        />
        <p
          v-else-if="stale && data"
          role="status"
          class="text-muted-foreground border-b px-4 py-2 text-[13px] leading-5 break-all"
        >
          正在读取当前筛选。{{ provenance }}
        </p>
        <!-- 读取失败且没有上次结果时，不摆一张 0 行的表：失败态自己说明范围。
             表格区按视口给预算、表头吸顶，分页留在卡片底部，一屏内够得到。 -->
        <template v-if="!error || data">
        <div
          class="data-table-scroll logs-table-budget hidden sm:block [&_[data-slot=table-container]]:overflow-visible"
        >
          <Table class="data-table min-w-[900px] table-fixed">
            <TableHeader class="sticky top-0 z-10"><TableRow class="hover:bg-transparent">
              <TableHead class="w-[224px]">时间 / 级别</TableHead>
              <TableHead class="w-[220px]">来源 / 操作</TableHead>
              <TableHead class="w-[180px]">结果 / 耗时</TableHead>
              <TableHead>关联标识</TableHead>
              <TableHead class="w-[88px]">详情</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              <TableRow v-for="row in rows" :key="row.id">
                <TableCell>
                  <div class="flex items-center gap-2">
                    <Badge
                      :variant="levelVariant(row.level)"
                      :class="levelClass(row.level)"
                      class="w-12 shrink-0 justify-center"
                      >{{ row.level }}</Badge
                    >
                    <time :datetime="row.timestamp" class="tabular-nums whitespace-nowrap">{{
                      dated(row.timestamp)
                    }}</time>
                  </div>
                </TableCell>
                <TableCell>
                  <div class="flex min-w-0 items-baseline gap-2">
                    <span class="truncate font-mono text-xs" :title="row.operation">{{
                      row.operation
                    }}</span>
                    <span class="text-muted-foreground shrink-0 text-xs">{{ row.source }}</span>
                  </div>
                </TableCell>
                <TableCell>
                  <div class="flex items-baseline gap-2 text-xs">
                    <span>{{ row.outcome }}</span>
                    <span v-if="row.durationMs !== undefined" class="text-muted-foreground tabular-nums"
                      >{{ row.durationMs }} ms</span
                    >
                    <span v-if="row.statusCode !== undefined" class="text-muted-foreground tabular-nums"
                      >HTTP {{ row.statusCode }}</span
                    >
                  </div>
                </TableCell>
                <TableCell>
                  <div v-if="reference(row)" class="flex min-w-0 items-baseline gap-1.5">
                    <span class="text-muted-foreground shrink-0 text-xs">{{
                      referenceKind(row)
                    }}</span>
                    <span class="truncate font-mono text-xs" :title="reference(row)">{{
                      reference(row)
                    }}</span>
                  </div>
                  <span v-else class="text-muted-foreground text-xs">未记录</span>
                </TableCell>
                <TableCell>
                  <Button
                    variant="outline"
                    size="sm"
                    :data-log-detail="row.id"
                    :aria-label="`查看日志 ${row.operation} ${row.id}`"
                    @click="open(row.id)"
                    >查看</Button
                  >
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
        <!-- 窄屏用同一份数据的摘要：状态、耗时和查看按钮都不必横向滚动。 -->
        <ul v-if="rows.length" class="flex flex-col divide-y sm:hidden" aria-label="运行日志列表">
          <li v-for="row in rows" :key="row.id" class="flex min-w-0 flex-col gap-2 p-3">
            <div class="flex items-start justify-between gap-3">
              <div class="flex min-w-0 flex-col gap-1">
                <div class="flex flex-wrap items-center gap-2">
                  <Badge
                    :variant="levelVariant(row.level)"
                    :class="levelClass(row.level)"
                    class="w-12 justify-center"
                    >{{ row.level }}</Badge
                  >
                  <time :datetime="row.timestamp" class="text-[13px] tabular-nums">{{
                    dated(row.timestamp)
                  }}</time>
                </div>
                <span class="font-mono text-xs break-all">{{ row.operation }}</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                class="min-h-11 shrink-0"
                :data-log-detail="row.id"
                :aria-label="`查看日志 ${row.operation} ${row.id}`"
                @click="open(row.id)"
                >查看</Button
              >
            </div>
            <div
              class="text-muted-foreground flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px]"
            >
              <span>{{ row.source }}</span>
              <span aria-hidden="true">·</span>
              <span>{{ row.outcome }}</span>
              <span v-if="row.durationMs !== undefined" class="tabular-nums"
                >· {{ row.durationMs }} ms</span
              >
              <span v-if="row.statusCode !== undefined" class="tabular-nums"
                >· HTTP {{ row.statusCode }}</span
              >
            </div>
            <p v-if="reference(row)" class="text-muted-foreground text-[13px] break-all">
              <span class="font-mono text-xs">{{ referenceKind(row) }} {{ reference(row) }}</span>
            </p>
          </li>
        </ul>
        <Empty v-if="!rows.length && !loading && !error"
          ><EmptyHeader
            ><EmptyTitle>没有符合条件的运行日志</EmptyTitle
            ><EmptyDescription class="text-balance"
              >可调整筛选。日志可能已过期或清理，不能据此判断业务是否执行。</EmptyDescription
            ></EmptyHeader
          ></Empty
        >
        <!-- 还没有任何结果时不摆分页：首次读取由顶部进度条表达，避免闪一下“0 条”。 -->
        <div v-if="data" class="border-t p-3">
          <TablePagination
          mode="cursor" :page="page" :page-size="limit" unit="条" :max-page-size="100"
          :loading="loading" :has-next="!error && !stale && !!data?.nextCursor"
          @update:page-size="resize" @previous="previous" @next="next"
        >显示第 {{ source?.page ?? page }} 页 · {{ rows.length }} 条</TablePagination>
        </div>
        </template>
        </CardContent>
      </Card>
    </section>
    <!-- 危险动作留在页面最底部、独立表面里；折叠条本身是这一区的容器。 -->
    <DisclosurePanel
      :heading-level="2"
      title="保留与清理"
      trigger-class="px-4"
      content-class="border-t p-4"
      class="bg-card overflow-hidden rounded-lg border"
      ><LogManagement :filter="filter" @changed="fresh"
    /></DisclosurePanel>
    <Sheet
      :open="!!selected"
      @update:open="
        (value) => {
          if (!value) selected = ''
        }
      "
      ><SheetContent class="w-full gap-0 sm:max-w-2xl" @close-auto-focus="restoreFocus"
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
<style scoped>
/* 表格预算：这一页比 /files 多一行高级筛选条和一条列表状态，让出 3rem，
   分页才留在首屏。其余间距仍由 .data-table-scroll 和共享组件决定。 */
.logs-table-budget {
  max-height: max(320px, calc(100dvh - 20.5rem));
}
/* 768 以下工具栏折成两行，预算把那 40px 也让出来。 */
@media (max-width: 767px) {
  .logs-table-budget {
    max-height: max(320px, calc(100dvh - 23rem));
  }
}
</style>
