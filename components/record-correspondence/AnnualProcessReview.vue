<script setup lang="ts">
import { computed } from 'vue'
import type { AnnualReviewPhase, AnnualTimelineView } from '~~/lib/roster/annual-process-presentation'
import AnnualProcessTimeline from './AnnualProcessTimeline.vue'
import TableFailureState from '@/components/TableFailureState.vue'
import TableLoadingStatus from '@/components/TableLoadingStatus.vue'
import { Button } from '@/components/ui/button'

const props = withDefaults(defineProps<{
  view: AnnualTimelineView | null
  back: string
  phase: AnnualReviewPhase
  pending?: boolean
  readFailed?: boolean
  targetPage?: number
  canCancel?: boolean
  canRetry?: boolean
  progress?: string
  businessReasons?: string[]
}>(), { targetPage: 1, businessReasons: () => [] })
const emit = defineEmits<{
  refresh: []
  'retry-submit': []
  'retry-readback': []
  'retry-task': []
  cancel: []
  page: [page: number]
  'page-size': [size: number]
  'event-navigate': [eventId: number]
}>()
const phaseText: Record<AnnualReviewPhase, string> = {
  checking: '正在读取本事件年度过程与页面提交能力。',
  'read-only': '此页面当前只读，提交能力未开启或未能确认；仅展示归档事实与当前待核资格。',
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
const visibleView = computed(() => props.view && !['read-only', 'synced'].includes(props.phase)
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
    <TableFailureState v-if="readFailed" compact :pending="pending" :title="`年度过程第 ${targetPage} 页读取失败`" :description="view ? `保留第 ${view.page} 页年度过程及其来源；目标页面尚未更新。` : '尚未取得年度过程，不能据此判断无业务或已确认。'" @retry="emit('refresh')" />
    <AnnualProcessTimeline v-if="visibleView" :view="visibleView" :back="back" :pending="pending" @page="emit('page', $event)" @page-size="emit('page-size', $event)" @event-navigate="emit('event-navigate', $event)" />
  </section>
</template>
