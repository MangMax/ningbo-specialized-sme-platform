<script setup lang="ts">
import { computed, nextTick, shallowRef, watch } from 'vue'
import { confirmedAnnualStep, orderedAnnualSteps, type AnnualTimelineView } from '~~/lib/roster/annual-process-presentation'
import { humanRecordTime } from '~~/lib/roster/record-ledger'
import DisclosurePanel from '@/components/DisclosurePanel.vue'
import SourceReader from './SourceReader.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

const props = defineProps<{ view: AnnualTimelineView; back: string; pending?: boolean; hasMore?: boolean; readFailed?: boolean }>()
// Retain internal page events for existing callers, without pagination controls.
const emit = defineEmits<{ page: [page: number]; 'page-size': [size: number]; 'load-more': []; 'event-navigate': [eventId: number] }>()
const steps = computed(() => orderedAnnualSteps(props.view.steps))
const finalStepId = computed(() => confirmedAnnualStep(props.view))
const latestStatus = computed(() => props.view.latestStatus ?? props.view.steps.find(step => step.id === props.view.latestStepId)?.status)
const reasons = computed(() => [...new Set([...props.view.reasons, ...(props.view.qualification?.reasons ?? [])])])
const timeline = shallowRef<HTMLElement | null>(null)
let beforeAppend: Set<string> | null = null
function loadMore() {
  beforeAppend = new Set(steps.value.map(step => step.id))
  emit('load-more')
}
watch(() => props.pending, async pending => {
  if (pending || !beforeAppend) return
  const previous = beforeAppend; beforeAppend = null
  await nextTick()
  // Continue keyboard reading at the first newly displayed process, including
  // when the last batch removes the load button. Never steal focus from a dialog.
  const active = document.activeElement
  if (active !== document.body && !timeline.value?.contains(active)) return
  const added = [...(timeline.value?.querySelectorAll<HTMLElement>('[data-annual-step]') ?? [])]
    .find(element => !previous.has(element.dataset.annualStep!))
  added?.focus()
})
const sourceId = shallowRef<number | null>(null)
const navigateTo = shallowRef<number | null>(null)
watch(() => props.view.eventId, () => { sourceId.value = null; navigateTo.value = null; beforeAppend = null })
function navigate(eventId: number) { navigateTo.value = eventId; sourceId.value = null }
function afterClose(event: Event) {
  if (navigateTo.value == null) return
  event.preventDefault()
  const id = navigateTo.value; navigateTo.value = null
  emit('event-navigate', id)
}
</script>

<template>
  <section ref="timeline" class="min-w-0 text-base leading-6" aria-label="完整年度过程" data-testid="annual-process-timeline">
    <div class="flex flex-col gap-2">
      <h4 class="text-base font-semibold">{{ view.year == null ? '年度待核' : `${view.year} 年` }}{{ view.matter }}过程</h4>
      <p class="text-sm text-muted-foreground">称号：{{ view.title }} · 事项：{{ view.matter }}</p>
      <p data-annual-summary class="text-base leading-6">
        <template v-if="finalStepId">已有最终结果<span v-if="latestStatus">：{{ latestStatus }}</span> · 与正式结果相符，当前对应已确认。</template>
        <template v-else>尚无已确认最终结果<span v-if="latestStatus">；平台年度末态：{{ latestStatus }}</span>。</template>
      </p>
      <p v-for="reason in reasons" :key="reason" class="text-base leading-6">{{ reason }}</p>
    </div>
    <p class="mt-3 text-sm text-muted-foreground">按申报时间排列；平台状态是最新归档观察，申报时间不代表审批完成时间。</p>
    <p v-if="!steps.length" class="py-4">尚无可展示的年度业务过程；请结合来源覆盖与待补依据核对。</p>
    <ol v-else class="mt-3 flex min-w-0 flex-col" aria-label="按申报时间排列的年度过程">
      <li v-for="(step, index) in steps" :key="step.id" tabindex="-1" class="relative min-w-0 pb-6 pl-7 last:pb-0" :data-annual-step="step.id" :data-confirmed-final="step.id === finalStepId || undefined">
        <span v-if="index < steps.length - 1" aria-hidden="true" data-timeline-connector class="absolute -bottom-3 left-1.5 top-3 w-px -translate-x-1/2 bg-primary/30" />
        <span aria-hidden="true" data-timeline-node class="absolute left-0 top-1.5 size-3 rounded-full border-2 border-primary bg-background" />
        <div class="flex min-w-0 flex-col gap-2">
          <div class="flex flex-wrap items-start justify-between gap-2">
            <p class="font-medium">{{ step.appliedAt ? `申报于 ${step.appliedAt}` : '申报时间未记录' }}</p>
            <div class="flex flex-wrap items-center gap-2"><Badge v-if="step.id === finalStepId" data-final-result>最终结果</Badge><Badge variant="outline">{{ step.status ?? '平台状态待核' }}</Badge></div>
          </div>
          <p v-if="step.observedAt" class="text-sm text-muted-foreground">最新采集于 {{ humanRecordTime(step.observedAt) }}</p>
          <p v-for="reason in step.reasons" :key="reason" class="text-base leading-6">{{ reason }}</p>
          <DisclosurePanel title="平台业务详情与来源记录" :heading-level="4">
            <div class="flex min-w-0 flex-col gap-4 text-base leading-6 break-words [overflow-wrap:anywhere]">
              <section v-for="source in step.sources" :key="source.key" class="flex min-w-0 flex-col gap-2" aria-label="接口版本与观察出处">
                <p class="font-medium">{{ source.interfaceLabel }}</p>
                <ul class="flex flex-col gap-3">
                  <li v-for="(observation, index) in source.observations" :key="observation.relationId" class="min-w-0">
                    <div class="flex flex-wrap items-center justify-between gap-2">
                      <p class="text-sm text-muted-foreground">来源记录 {{ index + 1 }} · 采集于 {{ humanRecordTime(observation.queriedAt) }}</p>
                      <Button variant="outline" size="sm" @click="sourceId = observation.relationId">查看平台业务详情</Button>
                    </div>
                    <DisclosurePanel compact title="技术定位与本次观察决定" :heading-level="4">
                      <div class="flex flex-col gap-1 text-sm">
                        <p>业务编号：{{ step.businessKey ?? '未记录' }}</p>
                        <p>{{ source.recordLabel }}</p>
                        <p>查询 #{{ observation.queryId }} · 原行 {{ observation.row }} · {{ observation.queriedAt }}</p>
                        <p>本观察决定：{{ observation.decision }}<span v-if="observation.revision != null"> · 修订 {{ observation.revision }}</span></p>
                      </div>
                    </DisclosurePanel>
                  </li>
                </ul>
              </section>
              <p v-if="!step.sources.length">尚无可读取的归档出处。</p>
            </div>
          </DisclosurePanel>
        </div>
      </li>
    </ol>
    <DisclosurePanel v-if="view.coverage.length" compact title="查询来源覆盖" :heading-level="4"><ul class="flex flex-col gap-2 text-sm text-muted-foreground"><li v-for="line in view.coverage" :key="line">{{ line }}</li></ul></DisclosurePanel>
    <div v-if="hasMore" class="mt-3 flex flex-wrap items-center gap-3">
      <Button variant="outline" :disabled="pending || readFailed" @click="loadMore">加载更多过程</Button>
      <p role="status" aria-live="polite" class="text-sm text-muted-foreground">已加载 {{ steps.length }} 笔过程<span v-if="pending">，正在读取…</span></p>
    </div>
    <Dialog :open="sourceId !== null" @update:open="value => { if (!value) sourceId = null }">
      <DialogContent class="max-h-[85dvh] overflow-y-auto" @close-auto-focus="afterClose">
        <DialogHeader><DialogTitle>平台业务详情</DialogTitle><DialogDescription>查看本次来源记录的业务信息；技术出处与完整原文可展开。</DialogDescription></DialogHeader>
        <SourceReader v-if="sourceId != null" :key="sourceId" kind="relation" :id="sourceId" :return-to="back" presentation="business" compact read-only @event-navigate="navigate" />
      </DialogContent>
    </Dialog>
  </section>
</template>
