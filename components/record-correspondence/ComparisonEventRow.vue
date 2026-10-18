<script setup lang="ts">
import { computed, ref } from 'vue'
import type { RecordComparisonResult } from '~~/lib/roster/record-comparison-view'
import { COMPARISON_CLASSES, comparisonReasonText } from '~~/lib/roster/record-comparison-view'
import { correspondenceStatusText, CORRESPONDENCE_ROLES, eventDecisionText } from '~~/lib/roster/correspondence-view'
import { PLATFORM_INTERFACES, TITLES } from '~~/lib/labels'
import { evidencePageState, evidencePreviewHref } from '~~/lib/roster/evidence-page'
import { rememberEvidencePreviewReturn } from '~~/lib/roster/evidence-preview-return'
import SourceReader from './SourceReader.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

const props = defineProps<{ row: RecordComparisonResult['rows'][number]; returnTo: string }>()
const navigatingToEvent = ref(false)
function closeForEvent() { navigatingToEvent.value = true; sourceId.value = null }
const sourceId = ref<number | null>(null)
const sourceKind = ref<'relation' | 'export_row'>('relation')
const enterpriseTo = computed(() => ({ path: `/enterprises/${props.row.record.enterpriseId}`, query: { eventId: String(props.row.event.id), returnTo: props.returnTo } }))
function openSource(kind: 'relation' | 'export_row', id: number) { navigatingToEvent.value = false; sourceKind.value = kind; sourceId.value = id }
function rememberReturn(event: MouseEvent) {
  if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) rememberEvidencePreviewReturn(props.returnTo, event.currentTarget)
}
</script>

<template>
  <article class="min-w-0 rounded-sm border bg-card p-4" :data-event-id="row.event.id" data-testid="record-comparison-event">
    <header class="flex flex-wrap items-start justify-between gap-2">
      <div class="min-w-0">
        <NuxtLink :to="enterpriseTo" class="font-medium text-primary underline-offset-2 hover:underline" @click="rememberReturn">{{ row.record.nameRaw ?? '企业名称未提供' }}</NuxtLink>
        <p class="text-muted-foreground mt-1 text-[13px]">{{ TITLES[row.record.titleCode] ?? row.record.titleCode }} · {{ eventDecisionText(row.event) }}</p>
      </div>
      <Badge :variant="row.classification === 'historical_conflict' ? 'destructive' : row.classification === 'historical_aligned' ? 'secondary' : 'outline'">{{ COMPARISON_CLASSES[row.classification] ?? '待核' }}</Badge>
    </header>
    <p v-if="row.reasons.length" class="text-muted-foreground mt-2 text-[13px]">{{ row.reasons.map(comparisonReasonText).join('；') }}</p>
    <div class="mt-3 grid min-w-0 gap-3 lg:grid-cols-2">
      <section class="min-w-0"><h4 class="text-sm font-medium">正式文件出处</h4>
        <ul v-if="row.evidence.length" class="mt-1 flex flex-col gap-1 text-[13px]">
          <li v-for="evidence in row.evidence" :key="evidence.id" class="break-words [overflow-wrap:anywhere]">{{ evidence.sourceFile }}<span v-if="evidence.attachment"> · {{ evidence.attachment }}</span><span v-if="evidence.listNo != null"> · 名单序号 {{ evidence.listNo }}</span> · <NuxtLink v-if="evidencePageState(evidence.sourceFile, evidence.page) === 'assigned'" :to="evidencePreviewHref({ sourceFile: evidence.sourceFile, page: evidence.page, back: returnTo })" class="text-primary underline underline-offset-2" @click="rememberReturn">第 {{ evidence.page }} 页</NuxtLink><span v-else>页码未确定</span><span v-if="!evidence.inSelectedSource" class="text-muted-foreground"> · 文件未选入本次范围</span></li>
        </ul><p v-else class="text-muted-foreground mt-1 text-[13px]">未记录文件出处。</p>
      </section>
      <section class="min-w-0"><h4 class="text-sm font-medium">已登记关系的接口原行</h4>
        <ul v-if="row.platformRows.length" class="mt-1 flex flex-col gap-1.5 text-[13px]">
          <li v-for="relation in row.platformRows" :key="relation.id" class="flex flex-wrap items-center gap-1.5"><span>{{ PLATFORM_INTERFACES[relation.interface] ?? '平台接口' }} · {{ relation.nameRaw ?? '原名未知' }} · {{ relation.status ?? '状态未提供' }}</span><span class="text-muted-foreground">{{ relation.queriedAt }}</span><Button variant="ghost" size="sm" class="h-6 px-1.5" @click="openSource('relation', relation.id)">查看原行与查询范围</Button></li>
        </ul><p v-else class="text-muted-foreground mt-1 text-[13px]">所选来源中无已登记的事件对应原行；覆盖与候选状态见下方。</p>
        <ul v-if="row.correspondences.length" class="mt-2 flex flex-wrap gap-1.5"><li v-for="edge in row.correspondences" :key="edge.id"><Badge variant="outline">{{ CORRESPONDENCE_ROLES[edge.role] ?? '对应' }} · {{ correspondenceStatusText(edge) }}</Badge></li></ul>
      </section>
    </div>
    <section v-if="row.laterProcesses.length" class="mt-3 border-t pt-3"><h4 class="text-sm font-medium">独立后续流程</h4><ul class="mt-1 flex flex-col gap-1 text-[13px]"><li v-for="process in row.laterProcesses" :key="process.correspondence.id" class="flex flex-wrap items-center gap-1.5"><span>{{ PLATFORM_INTERFACES[process.relation.interface] ?? '平台接口' }} · {{ process.relation.status ?? '状态未提供' }} · {{ process.relation.appliedAt ?? '申报时间未知' }}</span><Badge variant="outline">{{ CORRESPONDENCE_ROLES[process.correspondence.role] ?? '后续流程' }}</Badge><Button variant="ghost" size="sm" class="h-6 px-1.5" @click="openSource('relation', process.relation.id)">查看原行</Button></li></ul></section>
    <Dialog :open="sourceId !== null" @update:open="!$event && (sourceId = null)"><DialogContent @close-auto-focus="navigatingToEvent && $event.preventDefault()" class="max-h-[85dvh] min-w-0 overflow-y-auto sm:max-w-3xl"><DialogHeader><DialogTitle>来源原行与反向对应</DialogTitle><DialogDescription>查看具体行的原查询条件、状态和事件关系。</DialogDescription></DialogHeader><SourceReader v-if="sourceId !== null" :kind="sourceKind" :id="sourceId" :return-to="returnTo" @event-navigate="closeForEvent" /></DialogContent></Dialog>
  </article>
</template>
