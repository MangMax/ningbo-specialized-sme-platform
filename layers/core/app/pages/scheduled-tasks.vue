<script setup lang="ts">
import { CalendarClock, ChevronRight, RefreshCw } from '@lucide/vue'
import { ref } from 'vue'
import PageHeader from '#core/app/components/PageHeader.vue'
import TableFailureState from '#core/app/components/TableFailureState.vue'
import { Badge, type BadgeVariants } from '#core/app/components/ui/badge'
import { Button } from '#core/app/components/ui/button'
import { Card } from '#core/app/components/ui/card'
import { Empty, EmptyHeader, EmptyTitle } from '#core/app/components/ui/empty'
import { useTaskSnapshot } from '#core/app/composables/useTaskSnapshot'
import { TASK_STATES } from '#core/lib/task-center'
import type { JobState } from '#core/lib/job'

interface Schedule {
  id: string
  label: string
  frequency: string
  nextRunAt: number | null
  lastRun: {
    id: string
    status: string
    createdAt: number
    finishedAt: number | null
  } | null
}

interface ScheduleSnapshot {
  enabled: boolean
  items: Schedule[]
}

useHead({ title: '定时任务' })

const { data, loading, failed, refresh } = useTaskSnapshot<ScheduleSnapshot>(
  ref('scheduled-tasks'),
  signal => $fetch<ScheduleSnapshot>('/api/scheduled-tasks', { signal }),
  snapshot => Math.min(...snapshot.items.map(item => item.nextRunAt ?? Infinity)),
)

const runStates = new Map<string, { label: string, variant: BadgeVariants['variant'] }>(
  ([
    ['queued', 'info'],
    ['running', 'info'],
    ['done', 'success'],
    ['failed', 'error'],
    ['cancelled', 'quiet'],
  ] as const satisfies readonly (readonly [JobState, BadgeVariants['variant']])[])
    .map(([state, variant]) => [state, { label: TASK_STATES[state], variant }]),
)
const timestamp = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})
function formatTime(value: number) {
  return timestamp.format(value).replaceAll('/', '-')
}
</script>

<template>
  <div class="workspace-list flex min-w-0 flex-1 flex-col gap-4">
    <PageHeader title="定时任务" />
    <div class="workspace-list-body overflow-y-auto overscroll-contain">
      <Card class="gap-0 py-0">
        <div class="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 sm:px-6">
          <div class="flex min-w-0 flex-wrap items-center gap-2">
            <CalendarClock class="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
            <span class="text-sm font-medium">自动调度</span>
            <Badge v-if="data" :variant="data.enabled ? 'success' : 'quiet'">
              {{ data.enabled ? '已启用' : '已停用' }}
            </Badge>
          </div>
          <Button variant="outline" size="sm" :disabled="loading" @click="refresh()">
            <RefreshCw
              class="size-3.5"
              :class="loading && 'animate-spin motion-reduce:animate-none'"
              aria-hidden="true"
            />
            {{ loading ? '正在刷新' : '刷新' }}
          </Button>
        </div>

        <TableFailureState
          v-if="failed"
          title="定时任务加载失败"
          :compact="data !== null"
          :description="data ? undefined : '可重新加载定时任务。'"
          :pending="loading"
          @retry="refresh()"
        />
        <p v-else-if="!data" role="status" class="text-muted-foreground px-4 py-8 text-sm sm:px-6">
          正在加载定时任务…
        </p>

        <Empty v-if="data && data.items.length === 0" class="rounded-none border-0 py-10">
          <EmptyHeader>
            <EmptyTitle class="text-sm">暂无定时任务</EmptyTitle>
          </EmptyHeader>
        </Empty>
        <ul v-else-if="data" aria-label="定时任务列表" class="@container divide-y">
          <li
            v-for="task in data.items"
            :key="task.id"
            class="grid min-w-0 gap-4 px-4 py-4 sm:px-6 @min-[46rem]:grid-cols-[minmax(0,1.25fr)_minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1.2fr)_8.25rem] @min-[46rem]:items-center"
          >
            <h2 class="min-w-0 text-sm font-semibold break-words">{{ task.label }}</h2>
            <dl class="grid min-w-0 grid-cols-2 gap-x-3 gap-y-4 text-sm @min-[46rem]:col-span-3 @min-[46rem]:grid-cols-subgrid @min-[46rem]:gap-x-4">
              <div>
                <dt class="text-muted-foreground">执行频率</dt>
                <dd class="mt-1 break-words">{{ task.frequency }}</dd>
              </div>
              <div>
                <dt class="text-muted-foreground">下次执行<span class="sr-only">（北京时间）</span></dt>
                <dd class="mt-1 tabular-nums">
                  <time v-if="task.nextRunAt !== null" :datetime="new Date(task.nextRunAt).toISOString()">
                    {{ formatTime(task.nextRunAt) }}
                  </time>
                  <span v-else class="text-muted-foreground">{{ data.enabled ? '暂无安排' : '已停用' }}</span>
                </dd>
              </div>
              <div class="col-span-2 @min-[46rem]:col-span-1">
                <dt class="text-muted-foreground">最近运行<span class="sr-only">（北京时间）</span></dt>
                <dd v-if="task.lastRun" class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 tabular-nums">
                  <Badge :variant="runStates.get(task.lastRun.status)?.variant ?? 'quiet'">
                    {{ runStates.get(task.lastRun.status)?.label ?? task.lastRun.status }}
                  </Badge>
                  <time :datetime="new Date(task.lastRun.finishedAt ?? task.lastRun.createdAt).toISOString()">
                    {{ formatTime(task.lastRun.finishedAt ?? task.lastRun.createdAt) }}
                  </time>
                </dd>
                <dd v-else class="text-muted-foreground mt-1">尚未运行</dd>
              </div>
            </dl>
            <Button
              v-if="task.lastRun"
              as-child
              variant="outline"
              size="sm"
              class="min-h-10 w-fit whitespace-nowrap"
            >
              <NuxtLink
                :to="{ path: '/tasks', query: { job: task.lastRun.id } }"
                :aria-label="`查看运行详情：${task.label}`"
              >
                查看运行详情
                <ChevronRight class="size-3.5" aria-hidden="true" />
              </NuxtLink>
            </Button>
          </li>
        </ul>
      </Card>
    </div>
  </div>
</template>
