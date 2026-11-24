<script setup lang="ts">
import { ChevronRight } from '@lucide/vue'
import { TASK_STATES, type TaskList, type TaskSummary } from '../../../lib/task-center'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '../ui/empty'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table'
import DataTableCard from '../DataTableCard.vue'
import TableFailureState from '../TableFailureState.vue'
import TableLoadingStatus from '../TableLoadingStatus.vue'
import TablePagination from '../TablePagination.vue'
import TaskProgress from './TaskProgress.vue'

defineProps<{
  rows: TaskSummary[]
  data?: TaskList | null
  page: number
  pageSize: number
  loading: boolean
  failed: boolean
  stale: boolean
  failureDescription: string
  dated: (iso: string | null | undefined) => string
}>()

defineEmits<{
  reload: []
  openDetail: [id: string]
  page: [page: number]
  pageSize: [size: number]
}>()

defineSlots<{ status(props: { row: TaskSummary }): unknown; toolbar?(): unknown }>()

function taskStateVariant(state: TaskSummary['state']) {
  if (state === 'done') return 'success'
  if (state === 'running' || state === 'queued') return 'info'
  if (state === 'failed') return 'error'
  return 'warning'
}
</script>

<template>
  <DataTableCard filter-scroll toolbar-label="任务列表筛选与操作">
    <template #toolbar>
      <slot name="toolbar" />
    </template>

    <TableLoadingStatus :loading="loading" kind="files" label="正在读取后台任务…" />
    <TableFailureState v-if="failed" title="任务列表加载失败" :compact="!!data" :pending="loading" :description="failureDescription" @retry="$emit('reload')" />
    <p v-if="stale && data && !failed" role="status" class="text-muted-foreground px-4 py-2 text-sm">正在切换筛选，暂时显示上次结果（第 {{ data.page }} 页）。</p>
    <!-- 桌面：表格；窄屏：同一份数据的摘要，状态与操作不必横向滚动 -->
    <div class="data-table-scroll hidden sm:block">
      <Table class="data-table">
        <TableHeader><TableRow><TableHead>类型 / 任务编号</TableHead><TableHead>状态</TableHead><TableHead>阶段进度</TableHead><TableHead>创建时间</TableHead><TableHead class="w-12 text-right"><span class="sr-only">详情</span></TableHead></TableRow></TableHeader>
        <TableBody>
          <TableRow v-for="row in rows" :key="row.id" :data-task-row="row.id">
            <TableCell><div class="flex flex-col gap-1"><button type="button" class="hover:text-primary w-fit cursor-pointer text-left font-medium hover:underline focus-visible:underline focus-visible:outline-none" @click="$emit('openDetail', row.id)">{{ row.label }}</button><span class="text-muted-foreground font-mono text-xs break-all">{{ row.id }}</span><span v-if="row.error" class="text-destructive max-w-xs text-xs">{{ row.error }}</span></div></TableCell>
            <TableCell><div class="flex flex-col items-start gap-1"><Badge :variant="taskStateVariant(row.state)" class="whitespace-nowrap">{{ TASK_STATES[row.state] ?? row.state }}</Badge><slot name="status" :row="row" /></div></TableCell>
            <TableCell><TaskProgress v-if="row.progress?.stage" :progress="row.progress" /></TableCell>
            <TableCell class="text-muted-foreground text-xs"><time v-if="row.createdAt" :datetime="row.createdAt">{{ dated(row.createdAt) }}</time></TableCell>
            <TableCell class="text-right"><Button variant="ghost" size="icon-sm" class="text-muted-foreground hover:text-foreground size-7" data-row-action :aria-label="`查看 ${row.label} ${row.id}`" @click="$emit('openDetail', row.id)"><ChevronRight class="size-4" aria-hidden="true" /></Button></TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
    <ul v-if="rows.length" class="data-table-scroll flex flex-col divide-y sm:hidden" aria-label="任务列表">
      <li v-for="row in rows" :key="row.id" :data-task-row="row.id" class="flex min-w-0 flex-col gap-2 p-3" data-testid="task-card">
        <div class="flex items-start justify-between gap-3">
          <div class="flex min-w-0 flex-col gap-1">
            <span class="font-medium break-words">{{ row.label }}</span>
            <span class="text-muted-foreground font-mono text-xs break-all">{{ row.id }}</span>
          </div>
          <Button variant="outline" size="sm" class="min-h-11 shrink-0" data-row-action :aria-label="`查看 ${row.label} ${row.id}`" @click="$emit('openDetail', row.id)">查看</Button>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <Badge :variant="taskStateVariant(row.state)" class="whitespace-nowrap">{{ TASK_STATES[row.state] ?? row.state }}</Badge>
          <slot name="status" :row="row" />
          <TaskProgress v-if="row.progress?.stage" :progress="row.progress" inline />
          <time v-if="row.createdAt" :datetime="row.createdAt" class="text-muted-foreground text-xs">{{ dated(row.createdAt) }}</time>
        </div>
        <p v-if="row.error" class="text-destructive text-xs">{{ row.error }}</p>
      </li>
    </ul>
    <Empty v-if="!loading && !failed && !rows.length"><EmptyHeader><EmptyTitle>暂无任务</EmptyTitle><EmptyDescription>当前分类和状态没有任务记录。</EmptyDescription></EmptyHeader></Empty>

    <template #footer>
      <TablePagination in-card :page="data?.page ?? page" :page-size="data?.pageSize ?? pageSize" :total="data?.total ?? 0" unit="个任务" :loading="loading || stale" @update:page="$emit('page', $event)" @update:page-size="$emit('pageSize', $event)" />
    </template>
  </DataTableCard>
</template>
