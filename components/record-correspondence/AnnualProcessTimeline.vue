<script setup lang="ts">
import { computed, shallowRef, watch } from 'vue'
import { confirmedAnnualStep, orderedAnnualSteps, type AnnualTimelineView } from '~~/lib/roster/annual-process-presentation'
import { cn } from '@/lib/utils'
import DisclosurePanel from '@/components/DisclosurePanel.vue'
import TablePagination from '@/components/TablePagination.vue'
import SourceReader from './SourceReader.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

const props = defineProps<{ view: AnnualTimelineView; back: string; pending?: boolean }>()
const emit = defineEmits<{ page: [page: number]; 'page-size': [size: number]; 'event-navigate': [eventId: number] }>()
const steps = computed(() => orderedAnnualSteps(props.view.steps))
const finalStepId = computed(() => confirmedAnnualStep(props.view))
const latest = computed(() => props.view.steps.find(step => step.id === props.view.latestStepId))
const reasons = computed(() => [...new Set([...props.view.reasons, ...(props.view.qualification?.reasons ?? [])])])
const sourceId = shallowRef<number | null>(null)
const navigateTo = shallowRef<number | null>(null)
watch(() => props.view.eventId, () => { sourceId.value = null; navigateTo.value = null })
function navigate(eventId: number) { navigateTo.value = eventId; sourceId.value = null }
function afterClose(event: Event) {
  if (navigateTo.value == null) return
  event.preventDefault()
  const id = navigateTo.value; navigateTo.value = null
  emit('event-navigate', id)
}
</script>

<template>
  <section class="min-w-0" aria-label="完整年度过程" data-testid="annual-process-timeline">
    <div class="flex flex-col gap-2">
      <h4 class="text-sm font-medium">{{ view.year == null ? '年度待核' : `${view.year} 年` }}{{ view.matter }}过程</h4>
      <p class="text-muted-foreground text-[13px]">称号：{{ view.title }} · 事项：{{ view.matter }}</p>
      <p data-annual-summary class="text-[13px] leading-5">
        <template v-if="finalStepId">已有最终结果<span v-if="latest?.status">：{{ latest.status }}</span> · 与正式结果相符，当前对应已确认。</template>
        <template v-else>尚无已确认最终结果<span v-if="latest?.status">；平台年度末态：{{ latest.status }}</span>。</template>
      </p>
      <p v-for="reason in reasons" :key="reason" class="text-muted-foreground text-[13px] leading-5">{{ reason }}</p>
    </div>
    <p class="text-muted-foreground mt-3 text-[13px] leading-5">按申报时间排列；平台状态是最新归档观察，申报时间不代表审批完成时间。</p>
    <p v-if="!steps.length" class="text-muted-foreground py-4 text-[13px]">本页尚无年度业务过程；请结合来源覆盖与待补依据核对。</p>
    <ol v-else class="mt-3 flex min-w-0 flex-col" aria-label="按申报时间排列的年度过程">
      <li v-for="step in steps" :key="step.id" class="annual-step relative min-w-0 pb-6 pl-7" :data-annual-step="step.id" :data-confirmed-final="step.id === finalStepId || undefined">
        <span aria-hidden="true" :class="cn('annual-node absolute left-0 top-2 size-2.5 rounded-full border bg-card', step.id === finalStepId && 'border-primary bg-primary ring-4 ring-accent')" />
        <div :class="cn('flex min-w-0 flex-col gap-2 rounded-md', step.id === finalStepId && 'bg-accent/40 p-3')">
          <div class="flex flex-wrap items-start justify-between gap-2">
            <p class="text-[13px] font-medium">{{ step.appliedAt ? `申报于 ${step.appliedAt}` : '申报时间未记录' }}</p>
            <div class="flex flex-wrap items-center gap-2"><Badge v-if="step.id === finalStepId" data-final-result>最终结果</Badge><Badge variant="outline">{{ step.status ?? '平台状态待核' }}</Badge></div>
          </div>
          <p class="text-muted-foreground text-[13px]">{{ step.id === finalStepId ? '年度最终业务' : '年度过程记录' }}<span v-if="step.observedAt"> · 最新归档观察于 {{ step.observedAt }}</span></p>
          <p v-for="reason in step.reasons" :key="reason" class="text-muted-foreground text-[13px] leading-5">{{ reason }}</p>
          <DisclosurePanel compact title="查看业务编号与原行" :heading-level="4">
            <div class="flex min-w-0 flex-col gap-3 text-[13px] leading-5 break-words [overflow-wrap:anywhere]">
              <p>业务编号：{{ step.businessKey ?? '未记录' }}</p>
              <section v-for="source in step.sources" :key="source.key" class="flex min-w-0 flex-col gap-2" aria-label="接口版本与观察出处">
                <p class="font-medium">{{ source.interfaceLabel }} · {{ source.recordLabel }}</p>
                <ul class="flex flex-col gap-2">
                  <li v-for="observation in source.observations" :key="observation.relationId" class="min-w-0">
                    <p>查询 #{{ observation.queryId }} · 原行 {{ observation.row }} · {{ observation.queriedAt }}</p>
                    <p class="text-muted-foreground">本观察决定：{{ observation.decision }}<span v-if="observation.revision != null"> · 修订 {{ observation.revision }}</span></p>
                    <Button variant="ghost" size="sm" @click="sourceId = observation.relationId">读取原行 {{ observation.relationId }}</Button>
                  </li>
                </ul>
              </section>
              <p v-if="!step.sources.length" class="text-muted-foreground">尚无可读取的归档出处。</p>
            </div>
          </DisclosurePanel>
        </div>
      </li>
    </ol>
    <DisclosurePanel v-if="view.coverage.length" compact title="查询来源覆盖" :heading-level="4"><ul class="flex flex-col gap-2 text-[13px] text-muted-foreground"><li v-for="line in view.coverage" :key="line">{{ line }}</li></ul></DisclosurePanel>
    <p class="text-muted-foreground mb-2 text-[13px]">过程来源第 {{ view.page }} 页</p>
    <TablePagination :page="view.page" :page-size="view.pageSize" :total="view.total" unit="笔业务" :loading="pending" @update:page="emit('page', $event)" @update:page-size="emit('page-size', $event)" />
    <Dialog :open="sourceId !== null" @update:open="value => { if (!value) sourceId = null }">
      <DialogContent class="max-h-[85dvh] overflow-y-auto" @close-auto-focus="afterClose">
        <DialogHeader><DialogTitle>平台原行与查询来源</DialogTitle><DialogDescription>保留每次观察自己的版本与决定；完整原字段可展开阅读。</DialogDescription></DialogHeader>
        <SourceReader v-if="sourceId != null" :key="sourceId" kind="relation" :id="sourceId" :return-to="back" compact read-only @event-navigate="navigate" />
      </DialogContent>
    </Dialog>
  </section>
</template>

<style scoped>
.annual-step:not(:last-child)::before { content: ''; position: absolute; left: 0.28125rem; top: 1rem; bottom: -0.5rem; width: 1px; background: var(--border); }
</style>
