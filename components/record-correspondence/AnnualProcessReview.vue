<script setup lang="ts">
import { computed } from 'vue'
import type { AnnualReviewPhase, AnnualTimelineView } from '~~/lib/roster/annual-process-presentation'
import AnnualProcessTimeline from './AnnualProcessTimeline.vue'
import TableFailureState from '@/components/TableFailureState.vue'
import TableLoadingStatus from '@/components/TableLoadingStatus.vue'
import DisclosurePanel from '@/components/DisclosurePanel.vue'
import { Button } from '@/components/ui/button'

const props = withDefaults(defineProps<{
  view: AnnualTimelineView | null
  back: string
  phase: AnnualReviewPhase
  pending?: boolean
  readFailed?: boolean
  hasMore?: boolean
  targetPage?: number
  canCancel?: boolean
  canRetry?: boolean
  progress?: string
  businessReasons?: string[]
  taskReadFailed?: boolean
  actionError?: string
  auditReadback?: { id: number; revision: number; status: string }[]
}>(), { targetPage: 1, businessReasons: () => [], auditReadback: () => [] })
const emit = defineEmits<{
  refresh: []
  'load-more': []
  'retry-read': []
  'retry-submit': []
  'retry-readback': []
  'retry-task': []
  cancel: []
  page: [page: number]
  'page-size': [size: number]
  'event-navigate': [eventId: number]
  'retry-task-read': []
}>()
const phaseText: Record<AnnualReviewPhase, string> = {
  checking: '正在读取本事件年度过程与页面提交能力。',
  'read-only': '此页面当前只读，提交能力未开启或未能确认；仅展示归档事实与当前核对资格。',
  submitting: '正在提交本事件年度核对。',
  unknown: '提交结果尚未确认；保留同一请求，可重试确认结果。',
  running: '正在核对本事件年度过程。',
  syncing: '正在读回年度过程、对应与审计。',
  synced: '已读回当前年度过程、对应与审计；最终结果以当前资格为准。',
  'sync-failed': '已提交，但同步读回失败；保留原任务，重试读回不会重复提交。',
  failed: '年度核对失败；已读取的过程和来源页保留。',
  cancelled: '年度核对已取消；已读取的过程和历史决定保留。',
  blocked: '来源已变化，旧任务不能确认本次最终结果；需按当前来源重新核对。',
}
// The task may have finished while its current-source readback is still in
// flight. Preserve process facts, but publish final success only after the
// coordinator has awaited every mounted correspondence/audit read surface.
const visibleView = computed(() => props.view && (props.readFailed || !['read-only', 'synced'].includes(props.phase))
  ? { ...props.view, qualification: null } : props.view)
</script>

<template>
  <section class="relative flex min-w-0 flex-col gap-3 border-t p-4 sm:px-5" aria-label="年度过程核对" data-testid="annual-process-review">
    <TableLoadingStatus :loading="!!pending" kind="ledger" label="正在读取年度过程…" />
    <div class="flex flex-wrap items-start justify-between gap-2">
      <div class="flex min-w-0 flex-col gap-1 text-[13px] leading-5" role="status" aria-live="polite">
        <p>{{ phaseText[phase] }}</p><p v-if="progress" class="text-muted-foreground">{{ progress }}</p>
      </div>
      <Button variant="ghost" size="sm" :disabled="pending" @click="emit('refresh')">刷新年度过程</Button>
    </div>
    <div v-if="phase === 'unknown' || phase === 'sync-failed' || canCancel || canRetry" class="flex flex-wrap gap-2">
      <Button v-if="phase === 'unknown'" variant="outline" size="sm" :disabled="pending" @click="emit('retry-submit')">重试同一请求</Button>
      <Button v-if="phase === 'sync-failed'" variant="outline" size="sm" :disabled="pending" @click="emit('retry-readback')">重试读回</Button>
      <Button v-if="canRetry" variant="outline" size="sm" :disabled="pending" @click="emit('retry-task')">重试任务</Button>
      <Button v-if="canCancel" variant="outline" size="sm" :disabled="pending" @click="emit('cancel')">取消任务</Button>
    </div>
    <p v-for="reason in businessReasons" :key="reason" class="text-muted-foreground text-[13px] leading-5">{{ reason }}</p>
    <p v-if="actionError" role="status" class="text-[13px]">{{ actionError }}</p>
    <TableFailureState v-if="taskReadFailed" compact title="年度任务状态读取失败" description="原任务和请求保留，尚不能判断任务已完成。" @retry="emit('retry-task-read')" />
    <TableFailureState v-if="readFailed" compact :pending="pending" title="年度过程读取失败" :description="view ? '保留已加载的年度过程及其来源；重试继续读取本次失败的过程。' : '尚未取得年度过程，不能据此判断无业务或已确认。'" @retry="emit('retry-read')" />
    <AnnualProcessTimeline v-if="visibleView" :view="visibleView" :back="back" :pending="pending" :has-more="hasMore" :read-failed="readFailed" @load-more="emit('load-more')" @page="emit('page', $event)" @page-size="emit('page-size', $event)" @event-navigate="emit('event-navigate', $event)" />
    <DisclosurePanel v-if="auditReadback.length" compact title="本次读回的对应与审计" :heading-level="4">
      <ul class="flex flex-col gap-1 text-[13px] text-muted-foreground"><li v-for="point in auditReadback" :key="point.id">对应 #{{ point.id }} · 读回修订 {{ point.revision }} · 已读回该修订审计</li></ul>
    </DisclosurePanel>
  </section>
</template>
