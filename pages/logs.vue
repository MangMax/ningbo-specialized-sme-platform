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
const dated = (iso: string) => new Date(iso).toLocaleString('zh-CN', { hour12: false })
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
  <div class="flex min-w-0 flex-col gap-4">
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
    <section aria-labelledby="log-list-heading" class="flex min-w-0 flex-col gap-3">
      <h2 id="log-list-heading" class="sr-only">日志列表</h2>
      <p v-if="data?.status" class="text-muted-foreground text-sm">
        {{ data.status.unavailable ? '日志存储不可用' : '日志存储可用' }}；本进程已丢弃
        {{ data.status.dropped }} 条。日志缺失不代表业务未执行。
      </p>
      <div class="relative min-w-0 overflow-hidden rounded-lg border bg-card">
        <TableLoadingStatus :loading="loading" kind="files" label="正在读取运行日志…" />
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
          class="text-muted-foreground break-all px-4 py-3 text-sm"
        >
          正在读取当前筛选。{{ provenance }}
        </p>
        <div class="hidden overflow-x-auto sm:block">
          <Table class="data-table"
            ><TableHeader
              ><TableRow
                ><TableHead>时间 / 级别</TableHead><TableHead>来源 / 操作</TableHead
                ><TableHead>结果 / 耗时</TableHead><TableHead>关联标识</TableHead
                ><TableHead>详情</TableHead></TableRow
              ></TableHeader
            ><TableBody>
              <TableRow v-for="row in rows" :key="row.id"
                ><TableCell
                  ><div class="flex flex-col items-start gap-1">
                    <time :datetime="row.timestamp">{{ dated(row.timestamp) }}</time
                    ><Badge :variant="row.level === 'error' ? 'destructive' : 'secondary'">{{
                      row.level
                    }}</Badge>
                  </div></TableCell
                ><TableCell
                  ><div class="flex flex-col gap-1">
                    <span>{{ row.source }}</span
                    ><span class="break-all font-mono text-xs">{{ row.operation }}</span>
                  </div></TableCell
                ><TableCell
                  ><div class="flex flex-col gap-1">
                    <span>{{ row.outcome }}</span
                    ><span v-if="row.durationMs !== undefined">{{ row.durationMs }} ms</span
                    ><span v-if="row.statusCode !== undefined">HTTP {{ row.statusCode }}</span>
                  </div></TableCell
                ><TableCell
                  ><span class="break-all font-mono text-xs">{{
                    row.taskId || row.requestId || row.traceId || '未记录'
                  }}</span></TableCell
                ><TableCell
                  ><Button
                    variant="outline"
                    size="sm"
                    :data-log-detail="row.id"
                    :aria-label="`查看日志 ${row.operation} ${row.id}`"
                    @click="open(row.id)"
                    >查看</Button
                  ></TableCell
                ></TableRow
              >
            </TableBody></Table
          >
        </div>
        <ul v-if="rows.length" aria-label="日志列表" class="flex flex-col divide-y sm:hidden">
          <li v-for="row in rows" :key="row.id" class="flex min-w-0 flex-col gap-2 p-3">
            <div class="flex items-start justify-between gap-3">
              <div class="flex min-w-0 flex-col items-start gap-1">
                <Badge :variant="row.level === 'error' ? 'destructive' : 'secondary'"
                  >{{ row.level }} · {{ row.outcome }}</Badge
                ><span class="break-all font-mono text-xs"
                  >{{ row.source }} / {{ row.operation }}</span
                >
              </div>
              <Button
                variant="outline"
                class="min-h-11 shrink-0"
                :data-log-detail="row.id"
                :aria-label="`查看日志 ${row.operation} ${row.id}`"
                @click="open(row.id)"
                >查看</Button
              >
            </div>
            <time class="text-muted-foreground text-xs" :datetime="row.timestamp">{{
              dated(row.timestamp)
            }}</time
            ><span v-if="row.durationMs !== undefined" class="text-sm">{{ row.durationMs }} ms</span
            ><span class="break-all font-mono text-xs">{{
              row.taskId || row.requestId || row.traceId || '关联标识未记录'
            }}</span>
          </li>
        </ul>
        <Empty v-if="!rows.length && !loading && !error"
          ><EmptyHeader
            ><EmptyTitle>没有符合条件的运行日志</EmptyTitle
            ><EmptyDescription
              >可调整筛选。日志可能已过期或清理，不能据此判断业务是否执行。</EmptyDescription
            ></EmptyHeader
          ></Empty
        >
        <p v-if="!data && loading" class="px-4 py-8 text-sm" role="status">正在加载日志列表…</p>
        <TablePagination
          mode="cursor" :page="page" :page-size="limit" unit="条" :max-page-size="100"
          :loading="loading" :has-next="!error && !stale && !!data?.nextCursor"
          class="border-t p-3" @update:page-size="resize" @previous="previous" @next="next"
        >显示第 {{ source?.page ?? page }} 页 · {{ rows.length }} 条</TablePagination>
      </div>
    </section>
    <DisclosurePanel :heading-level="2"
      ><template #trigger><span class="text-sm">管理日志保留与清理</span></template
      ><LogManagement :filter="filter" @changed="fresh"
    /></DisclosurePanel>
    <Sheet
      :open="!!selected"
      @update:open="
        (value) => {
          if (!value) selected = ''
        }
      "
      ><SheetContent class="w-full overflow-y-auto sm:max-w-xl" @close-auto-focus="restoreFocus"
        ><SheetHeader
          ><SheetTitle>运行日志详情</SheetTitle
          ><SheetDescription
            >按需读取脱敏字段；审计与回执标识仅为引用。</SheetDescription
          ></SheetHeader
        >
        <div class="px-4 pb-6"><LogDetail v-if="selected" :id="selected" /></div></SheetContent
    ></Sheet>
  </div>
</template>
