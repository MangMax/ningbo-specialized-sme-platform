<script setup lang="ts">
import { computed, inject, nextTick, reactive, shallowRef, watch } from 'vue'
import { REVIEW_DRAFTS_KEY } from '~/composables/useReviewDrafts'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { useEnterpriseCorrespondences } from '~/composables/useEnterpriseCorrespondences'
import { useAnnualProcessReview } from '~/composables/useAnnualProcessReview'
import { confirmedAnnualStep } from '~~/lib/roster/annual-process-presentation'
import { groupEventEdges } from '~~/lib/roster/record-ledger'
import RecordEventRow from './RecordEventRow.vue'
import AnnualProcessReview from './AnnualProcessReview.vue'
import TableFailureState from '@/components/TableFailureState.vue'
import DisclosurePanel from '@/components/DisclosurePanel.vue'

interface ReviewEvent {
  id: number; recordId: number; type: string; year: number | null; seq: number | null
  decidedYear: number | null; reviewOutcome: string | null; titleCode: string; source: string; district: string | null
  evidence: { sourceFile: string; attachment: string | null; listNo: number | null; page: number | null }[]
}
const props = defineProps<{ enterpriseId: number; events: ReviewEvent[]; eventId?: number | null; back: string }>()
const emit = defineEmits<{
  select: [eventId: number | null]
  preview: [evidence: ReviewEvent['evidence'][number]]
  'event-navigate': [eventId: number]
  'page-open': [eventId: number, event: MouseEvent]
}>()
const events = computed(() => props.events.filter(event => event.source === 'jxj' && ['award', 'review'].includes(event.type)))
const selected = shallowRef<number | null>(props.eventId ?? null)
watch(() => props.eventId, value => { selected.value = value ?? null })
const annual = reactive(useAnnualProcessReview(computed(() => events.value.some(event => event.id === selected.value) ? selected.value : null)))
const annualFinal = computed(() => annual.view && ['synced', 'read-only'].includes(annual.phase) ? confirmedAnnualStep(annual.view) : null)
const { rows, ready, loading, error, reload, detailsForEvent, detailLoadingForEvent, detailErrorForEvent, loadEvent } = useEnterpriseCorrespondences(() => props.enterpriseId, selected)
const revalidationCounts = computed(() => new Map(events.value.map(event => [event.id,
  groupEventEdges(rows.value.filter(edge => edge.eventId === event.id && edge.type !== 'later_process')).revalidation.length,
])))
// Reuse the already loaded point facts for the header; this projection makes
// no source requests and does not combine decisions between observations.
const relationSummaries = computed(() => {
  const summaries: Record<number, { interface: string; status: string | null }> = {}
  for (const event of events.value) for (const edge of detailsForEvent(event.id) ?? []) {
    if (edge.relation) summaries[edge.relation.id] = { interface: edge.relation.query.interface, status: edge.relation.status }
  }
  return summaries
})
watch([selected, ready, rows], () => {
  if (selected.value != null && events.value.some(event => event.id === selected.value)) void loadEvent(selected.value)
}, { immediate: true })
watch(selected, async (eventId) => {
  await nextTick()
  if (eventId == null || selected.value !== eventId) return
  const target = document.getElementById(`review-event-${eventId}`)
  target?.scrollIntoView({ block: 'start' })
  target?.focus({ preventScroll: true })
}, { immediate: true, flush: 'post' })
const draftStore = inject(REVIEW_DRAFTS_KEY, null)
const pendingSelection = shallowRef<{ eventId: number | null } | null>(null)
function select(eventId: number, open: boolean) {
  if (draftStore?.hasDirty.value) {
    pendingSelection.value = { eventId: open ? eventId : null }
    return
  }
  selected.value = open ? eventId : null
  emit('select', selected.value)
}
function discardAndSelect() {
  if (!pendingSelection.value || draftStore?.hasLocked.value) return
  draftStore?.discardAll()
  selected.value = pendingSelection.value.eventId
  pendingSelection.value = null
  emit('select', selected.value)
}
</script>

<template>
  <section class="bg-card min-w-0 overflow-hidden rounded-lg border" aria-label="公布事件与平台对应">
    <header class="flex flex-col gap-1 border-b px-4 py-3">
      <h2 class="text-base font-semibold">公布事件与平台对应</h2>
      <p class="text-base leading-6">选择正式事项，查看平台对应、年度过程与最终结果。</p>
    </header>
    <TableFailureState v-if="error" compact title="已登记对应读取失败" description="公布事实保留；请重试读取已有决定。" :pending="loading" @retry="reload" />
    <p v-if="!events.length" class="px-4 py-6 text-base">尚无可核对平台对应的正式公布事件。</p>
    <ul v-else class="divide-y">
      <li v-for="event in events" :key="event.id">
        <section v-if="selected !== event.id" :id="`review-event-${event.id}`" tabindex="-1">
          <DisclosurePanel :open="false" trigger-class="px-4 sm:px-5" @update:open="select(event.id, $event)">
            <template #trigger>
              <span class="flex min-w-0 flex-wrap items-center gap-2 text-base leading-6">
                <TitleBadge :code="event.titleCode" />
                <span>{{ (event.type === 'review' ? event.decidedYear : event.year) ?? '年份待核' }}</span>
                <EventChip :type="event.type" :hide-batch="true" />
                <span v-if="event.seq != null">第 {{ event.seq }} 批</span>
                <span v-if="event.type === 'review'">原认定 {{ event.year ?? '年份待核' }}</span>
                <span class="text-muted-foreground text-sm">事项 #{{ event.id }}</span>
                <span v-if="revalidationCounts.get(event.id)" class="text-warning">{{ revalidationCounts.get(event.id) }} 条对应待重新核验</span>
              </span>
            </template>
          </DisclosurePanel>
        </section>
        <RecordEventRow
          v-else
          :event="event" :evidence="event.evidence" :edges="rows.filter(edge => edge.eventId === event.id)"
          :full-edges="detailsForEvent(event.id)" :links-ready="ready"
          :relation-summaries="relationSummaries" :details-loading="detailLoadingForEvent(event.id)" :details-error="detailErrorForEvent(event.id)"
          :back="back" :open="selected === event.id" :highlighted="selected === event.id" review
          @update:open="select(event.id, $event)" @preview="emit('preview', $event)"
          @event-navigate="emit('event-navigate', $event)" @page-open="(id, mouse) => emit('page-open', id, mouse)"
          @retry-detail="loadEvent(event.id, true)"
        >
          <template #annual-summary>
            <p v-if="selected === event.id && annual.view?.eventId === event.id && annual.view.latestStatus" class="mt-2 text-base leading-6" data-testid="event-annual-summary">
              最新办理状态：{{ annual.view.latestStatus }}<span v-if="annualFinal"> · 已确认最终结果</span>
            </p>
          </template>
          <template #annual-review>
            <AnnualProcessReview v-if="selected === event.id" :view="annual.view" :back="back" :phase="annual.phase" :pending="annual.pending"
              :read-failed="annual.readFailed" :has-more="annual.hasMore" :target-page="annual.target.page" :can-cancel="annual.canCancel" :can-retry="annual.canRetry"
              :progress="annual.progress" :business-reasons="annual.businessReasons" :task-read-failed="annual.taskReadFailed" :action-error="annual.actionError" :audit-readback="annual.auditReadback"
              @refresh="annual.refresh()" @retry-submit="annual.retrySubmit" @retry-readback="annual.retryReadback" @retry-task="annual.retryTask" @cancel="annual.cancel"
              @load-more="annual.loadMore" @retry-read="annual.retryRead" @retry-task-read="annual.retryTaskRead" @page="annual.refresh({ page: $event })" @page-size="annual.refresh({ page: 1, pageSize: $event })" @event-navigate="emit('event-navigate', $event)" />
          </template>
        </RecordEventRow>
      </li>
    </ul>
    <Dialog :open="pendingSelection !== null" @update:open="!$event && (pendingSelection = null)">
      <DialogContent>
        <DialogHeader><DialogTitle>切换会丢弃未提交内容</DialogTitle><DialogDescription>当前事项的核对依据还未保存。</DialogDescription></DialogHeader>
        <p v-if="draftStore?.hasLocked.value" role="status">决定仍在提交或尚未确认结果，请先完成读回。</p>
        <DialogFooter><Button variant="outline" @click="pendingSelection = null">继续填写</Button><Button :disabled="draftStore?.hasLocked.value" @click="discardAndSelect">切换并丢弃</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </section>
</template>
