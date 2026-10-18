<script setup lang="ts">
import { computed } from 'vue'
import { ChevronDown } from '@lucide/vue'
import type { CorrespondenceDetail } from '~~/lib/roster/correspondence-view'
import { eventDecisionText } from '~~/lib/roster/correspondence-view'
import { groupEventEdges } from '~~/lib/roster/record-ledger'
import { PLATFORM_INTERFACES } from '~~/lib/labels'
import { fileNameOf } from '~~/lib/preview'
import { evidencePageState } from '~~/lib/roster/evidence-page'
import RecordEventSource from './RecordEventSource.vue'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'

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
  edges: CorrespondenceDetail[]
  back: string
  returnTo?: string | null
  open: boolean
}>()
const emit = defineEmits<{
  'update:open': [open: boolean]
  preview: [evidence: OfficialEvidence]
  'event-navigate': [eventId: number]
  'page-open': [eventId: number, event: MouseEvent]
}>()

const groups = computed(() => groupEventEdges(props.edges.filter(edge => edge.type !== 'later_process')))
const businessYear = computed(() => props.event.type === 'review' ? props.event.decidedYear : props.event.year)

const fileLines = computed(() => props.evidence.map(item => {
  const page = evidencePageState(item.sourceFile, item.page) === 'assigned' ? `第 ${item.page} 页` : ''
  return [fileNameOf(item.sourceFile), page].filter(Boolean).join(' · ')
}))
/** 同名接口只写一次；原行定位在展开层按条列出，不合并原行。 */
const interfaceSummary = computed(() => {
  const rows = new Map<string, { count: number; statuses: Set<string> }>()
  for (const edge of groups.value.sources) {
    const key = PLATFORM_INTERFACES[edge.relation?.query.interface ?? ''] ?? '平台接口'
    const item = rows.get(key) ?? { count: 0, statuses: new Set<string>() }
    item.count++
    if (edge.relation?.status) item.statuses.add(edge.relation.status)
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
  <section :id="`record-event-${event.id}`" class="scroll-mt-20">
    <Collapsible :open="open" @update:open="emit('update:open', $event)">
      <div class="grid min-w-0 gap-x-4 gap-y-2 px-4 py-4 sm:grid-cols-[6.5rem_minmax(0,1fr)_auto] sm:items-start sm:px-5">
        <div class="flex items-center gap-2 sm:flex-col sm:items-start sm:gap-1">
          <span class="text-lg leading-none font-semibold tabular-nums">{{ businessYear ?? '待核' }}</span>
          <EventChip :type="event.type" :hide-batch="true" />
        </div>

        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <TitleBadge :code="event.titleCode" />
            <SourceChip :code="event.source" />
            <span v-if="event.district" class="text-muted-foreground text-[13px]">属地 {{ event.district }}</span>
          </div>
          <p v-if="event.type === 'review'" class="mt-1 text-[15px] leading-6 font-medium">{{ eventDecisionText({ eventType: event.type, year: event.year, decidedYear: event.decidedYear, reviewOutcome: event.reviewOutcome }) }}</p>
        </div>

        <div class="flex min-w-0 flex-col gap-1.5 text-[13px] sm:max-w-80">
          <div class="grid min-w-0 grid-cols-[6.5rem_minmax(0,1fr)] items-start gap-x-2 gap-y-1">
            <span class="text-muted-foreground">公布文件</span>
            <span class="min-w-0 break-words">
              <template v-if="fileLines.length"><span v-for="(line, index) in fileLines" :key="line" class="inline">{{ line }}<span v-if="index < fileLines.length - 1">；</span></span></template>
              <span v-else class="text-muted-foreground">未记录</span>
            </span>
            <span class="text-muted-foreground">平台接口</span>
            <span class="min-w-0 break-words">
              <template v-if="interfaceSummary.length">
                <span v-for="(item, index) in interfaceSummary" :key="item.interfaceName" class="inline-flex flex-wrap items-center gap-1">
                  <span>{{ item.interfaceName }}</span>
                  <span v-if="item.status" class="text-muted-foreground">· {{ item.status }}</span>
                  <span class="text-muted-foreground tabular-nums">×{{ item.count }}</span>
                  <span v-if="index < interfaceSummary.length - 1">、</span>
                </span>
              </template>
              <span v-else class="text-muted-foreground">尚无已确认接口出处</span>
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

        <div class="flex justify-end sm:col-span-3">
          <CollapsibleTrigger as-child>
            <Button variant="ghost" size="sm" class="h-8 gap-1 px-2 text-[13px]">
              <ChevronDown class="size-4 transition-transform duration-150 ease-snap motion-reduce:transition-none" :class="!open && '-rotate-90'" />
              {{ open ? '收起来源记录' : '查看来源记录' }}
            </Button>
          </CollapsibleTrigger>
        </div>
      </div>
      <CollapsibleContent class="duration-150 ease-snap data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-1 motion-reduce:animate-none">
        <RecordEventSource :event="event" :evidence="evidence" :edges="edges" :back="back" :return-to="returnTo" @preview="emit('preview', $event)" @event-navigate="emit('event-navigate', $event)" @page-open="(eventId: number, event: MouseEvent) => emit('page-open', eventId, event)" />
      </CollapsibleContent>
    </Collapsible>
  </section>
</template>
