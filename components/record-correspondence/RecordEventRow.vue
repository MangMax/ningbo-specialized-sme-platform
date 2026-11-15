<script setup lang="ts">
import { computed } from 'vue'
import type { CorrespondenceDetail, CorrespondenceSummary } from '~~/lib/roster/correspondence-view'
import type { PlatformObservationFact } from '~~/lib/platform/observation-facts'
import { eventDecisionText } from '~~/lib/roster/correspondence-view'
import { groupEventEdges } from '~~/lib/roster/record-ledger'
import { PLATFORM_INTERFACES } from '~~/lib/labels'
import { fileNameOf } from '~~/lib/preview'
import { evidencePageState } from '~~/lib/roster/evidence-page'
import RecordEventSource from './RecordEventSource.vue'
import OfficialEvidenceView from './OfficialEvidence.vue'
import EventArchiveCandidates from './EventArchiveCandidates.vue'
import { Button } from '@/components/ui/button'
import DisclosurePanel from '@/components/DisclosurePanel.vue'

interface OfficialEvidence {
  sourceFile: string
  attachment: string | null
  listNo: number | null
  page: number | null
}
interface LedgerEvent {
  id: number
  recordId: number
  type: string
  year: number | null
  seq: number | null
  decidedYear: number | null
  reviewOutcome: string | null
  titleCode: string
  source: string
  district: string | null
}

const props = defineProps<{
  event: LedgerEvent
  evidence: OfficialEvidence[]
  edges: CorrespondenceSummary[]
  fullEdges?: CorrespondenceDetail[] | null
  linksReady?: boolean
  detailsLoading?: boolean
  detailsError?: boolean
  relationSummaries?: Record<number, { interface: string; status: PlatformObservationFact['status'] }>
  back: string
  returnTo?: string | null
  open: boolean
  review?: boolean
  /** 深链定位到的行短暂高亮；不是常驻装饰。 */
  highlighted?: boolean
}>()
const emit = defineEmits<{
  'update:open': [open: boolean]
  preview: [evidence: OfficialEvidence]
  'event-navigate': [eventId: number]
  'page-open': [eventId: number, event: MouseEvent]
  'review-event': [eventId: number]
  'retry-detail': []
}>()

const groups = computed(() => groupEventEdges(props.edges.filter(edge => edge.type !== 'later_process')))
const businessYear = computed(() => props.event.type === 'review' ? props.event.decidedYear : props.event.year)

const fileLines = computed(() => props.evidence.map(item => {
  const page = evidencePageState(item.sourceFile, item.page) === 'assigned' ? `第 ${item.page} 页` : ''
  return [fileNameOf(item.sourceFile), page].filter(Boolean).join(' · ')
}))
/** 同名接口只写一次；原行定位在展开层按条列出，不合并原行。 */
const interfaceSummary = computed(() => {
  const rows = new Map<string, { count: number; statuses: Set<NonNullable<PlatformObservationFact['status']>> }>()
  for (const edge of groups.value.sources) {
    const relation = edge.relationId == null ? undefined : props.relationSummaries?.[edge.relationId]
    const key = edge.exportRowId != null ? '平台导出快照' : PLATFORM_INTERFACES[relation?.interface ?? ''] ?? (props.review ? '平台来源记录' : '平台接口记录')
    const item = rows.get(key) ?? { count: 0, statuses: new Set<NonNullable<PlatformObservationFact['status']>>() }
    item.count++
    if (relation?.status) item.statuses.add(relation.status)
    rows.set(key, item)
  }
  return [...rows].map(([interfaceName, item]) => ({
    interfaceName,
    count: item.count,
    status: item.statuses.size === 1 ? [...item.statuses][0] : null,
  }))
})
</script>

<template>
  <section
    :data-event-id="event.id"
    :id="`${review ? 'review' : 'record'}-event-${event.id}`"
    tabindex="-1"
    class="scroll-mt-20"
    :class="highlighted ? 'locate-highlight' : ''"
    :data-highlighted="highlighted ? 'true' : undefined"
  >
    <DisclosurePanel :open="open" trigger-class="px-4 sm:px-5" @update:open="emit('update:open', $event)">
      <template #header>
        <div class="grid min-w-0 gap-x-4 gap-y-2 px-4 pt-4 sm:grid-cols-[6.5rem_minmax(0,1fr)_auto] sm:items-start sm:px-5">
          <div class="flex items-center gap-2 sm:flex-col sm:items-start sm:gap-1">
            <span class="text-lg leading-none font-semibold tabular-nums">{{ businessYear ?? '待核' }}</span>
            <EventChip :type="event.type" :hide-batch="true" />
          </div>

          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <TitleBadge :code="event.titleCode" />
              <SourceChip :code="event.source" />
              <span v-if="event.district" class="text-muted-foreground text-sm">属地 {{ event.district }}</span>
              <span v-if="review && event.seq != null" class="text-muted-foreground text-sm">第 {{ event.seq }} 批</span>
            </div>
            <p v-if="event.type === 'review'" class="mt-1 text-base leading-6 font-medium">{{ eventDecisionText({ eventType: event.type, year: event.year, decidedYear: event.decidedYear, reviewOutcome: event.reviewOutcome }) }}</p>
            <slot name="annual-summary" />
          </div>

          <div class="flex min-w-0 flex-col gap-1.5 text-sm sm:max-w-80">
            <div class="grid min-w-0 grid-cols-[6.5rem_minmax(0,1fr)] items-start gap-x-2 gap-y-1">
              <span v-if="review" class="text-muted-foreground">公布文件</span>
              <span v-if="review" class="min-w-0 break-words">
                <template v-if="fileLines.length"><span v-for="(line, index) in fileLines" :key="line" class="inline">{{ line }}<span v-if="index < fileLines.length - 1">；</span></span></template>
                <span v-else class="text-muted-foreground">未记录</span>
              </span>
              <span class="text-muted-foreground">{{ review ? '已关联平台记录' : '平台接口' }}</span>
              <span class="min-w-0 break-words">
                <template v-if="interfaceSummary.length">
                  <span v-for="(item, index) in interfaceSummary" :key="item.interfaceName" class="inline-flex flex-wrap items-center gap-1">
                    <span v-if="!review || item.interfaceName !== '平台来源记录'">{{ item.interfaceName }}</span>
                    <span v-if="item.status" class="text-muted-foreground">· {{ item.status }}</span>
                    <span class="text-muted-foreground tabular-nums">{{ review ? '已确认关联' : '原行' }} {{ item.count }} 条</span>
                    <span v-if="index < interfaceSummary.length - 1">、</span>
                  </span>
                </template>
                <span v-else-if="!linksReady" class="text-muted-foreground">{{ review ? '关联记录尚未读取' : '接口对应尚未读取' }}</span>
                <span v-else class="text-muted-foreground">{{ review ? '尚无已确认关联记录' : '尚无已确认接口出处' }}</span>
              </span>
              <template v-if="groups.candidates.length">
                <span class="text-warning">候选（未确认）</span>
                <span class="text-warning tabular-nums">{{ groups.candidates.length }} 条 · 待确认</span>
              </template>
              <template v-if="groups.revalidation.length">
                <span class="text-warning">待重新核验</span>
                <span class="text-warning tabular-nums">{{ groups.revalidation.length }} 条 · 暂不计为已确认出处</span>
              </template>
              <template v-if="groups.currentContext.length">
                <span class="text-muted-foreground">当前导出快照</span>
                <span class="text-muted-foreground tabular-nums">{{ groups.currentContext.length }} 条 · 仅核对当前名称/代码，非历史出处</span>
              </template>
            </div>
          </div>
        </div>
        <section v-if="!review" aria-label="正式公布文件" class="flex min-w-0 flex-col gap-3 px-4 pt-3 sm:px-5">
          <h4 class="text-sm font-medium">正式出处</h4>
          <p v-if="!evidence.length" class="text-muted-foreground text-sm">此事件未记录公布文件出处。</p>
          <ul v-else class="grid min-w-0 gap-3 xl:grid-cols-2">
            <li v-for="(item, index) in evidence" :key="index" class="min-w-0">
              <OfficialEvidenceView :evidence="item" :back="back" preview-in-place @preview="emit('preview', item)" @page-open="emit('page-open', event.id, $event)" />
            </li>
          </ul>
        </section>
      </template>
      <template #trigger>
        <span class="w-full text-right text-sm">{{ review ? '查看年度过程与核对' : '来源记录' }}</span>
      </template>
      <slot v-if="open" name="annual-review" />
      <p v-if="detailsLoading" role="status" class="px-4 text-sm sm:px-5">正在读取对应出处…</p>
      <DisclosurePanel title="正式文件与已登记出处" class="border-t px-4 sm:px-5" :open="detailsError || groups.revalidation.length ? true : null">
      <RecordEventSource :event="event" :evidence="evidence" :show-official="!!review" :edges="fullEdges ?? []" :edges-ready="linksReady && fullEdges !== null && fullEdges !== undefined" :edges-loading="detailsLoading" :edges-error="detailsError" :back="back" :return-to="returnTo" @preview="emit('preview', $event)" @event-navigate="emit('event-navigate', $event)" @page-open="(eventId: number, event: MouseEvent) => emit('page-open', eventId, event)" @retry-detail="emit('retry-detail')" />
      </DisclosurePanel>
      <EventArchiveCandidates v-if="review && open && event.source === 'jxj' && ['award', 'review'].includes(event.type)" :key="event.id" :event-id="event.id" :back="back" />
    </DisclosurePanel>
    <div v-if="!review && event.source === 'jxj' && ['award', 'review'].includes(event.type)" class="px-4 pb-3 sm:px-5">
      <Button variant="outline" size="sm" @click="emit('review-event', event.id)">核对这一事项</Button>
    </div>
  </section>
</template>

<style scoped>
/* 深链定位：视觉上短暂浮现后自动褪去；data-highlighted 仍标记当前定位行。 */
.locate-highlight {
  animation: locate-highlight 2.6s ease-out;
}
@keyframes locate-highlight {
  0%, 25% { background-color: var(--accent); }
  100% { background-color: transparent; }
}
@media (prefers-reduced-motion: reduce) {
  .locate-highlight { animation: none; background-color: var(--accent); }
}
</style>
