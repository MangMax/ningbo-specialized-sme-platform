<script setup lang="ts">
import { computed, ref } from 'vue'
import { FileText } from '@lucide/vue'
import type { RecordComparisonResult } from '~~/lib/roster/record-comparison-view'
import { COMPARISON_CLASSES, comparisonReasonText } from '~~/lib/roster/record-comparison-view'
import { correspondenceStatusText, CORRESPONDENCE_ROLES, eventDecisionText } from '~~/lib/roster/correspondence-view'
import { humanRecordTime } from '~~/lib/roster/record-ledger'
import { PLATFORM_INTERFACES, TITLES } from '~~/lib/labels'
import { fileNameOf } from '~~/lib/preview'
import { evidencePageState, evidencePreviewHref } from '~~/lib/roster/evidence-page'
import { rememberEvidencePreviewReturn } from '~~/lib/roster/evidence-preview-return'
import SourceReader from './SourceReader.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

const props = defineProps<{ row: RecordComparisonResult['rows'][number]; returnTo: string }>()
const sourceId = ref<number | null>(null)
const sourceKind = ref<'relation' | 'export_row'>('relation')
const navigatingToEvent = ref(false)
function closeForEvent() { navigatingToEvent.value = true; sourceId.value = null }
const enterpriseTo = computed(() => ({ path: `/enterprises/${props.row.record.enterpriseId}`, query: { eventId: String(props.row.event.id), returnTo: props.returnTo } }))
const relationRows = computed(() => props.row.platformRows.map(relation => ({
  relation,
  edges: props.row.correspondences.filter(edge => edge.relationId === relation.id),
})))
const otherEdges = computed(() => props.row.correspondences.filter(edge => !props.row.platformRows.some(relation => relation.id === edge.relationId)))
function openSource(kind: 'relation' | 'export_row', id: number) { navigatingToEvent.value = false; sourceKind.value = kind; sourceId.value = id }
function rememberReturn(event: MouseEvent) {
  if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) rememberEvidencePreviewReturn(props.returnTo, event.currentTarget)
}
const classificationVariant = computed(() => props.row.classification === 'historical_conflict'
  ? 'destructive'
  : props.row.classification === 'historical_aligned' ? 'secondary' : 'outline')
</script>

<template>
  <article class="min-w-0 border-b py-4 last:border-b-0" :data-event-id="row.event.id" data-testid="record-comparison-event">
    <header class="flex flex-wrap items-start justify-between gap-2">
      <div class="min-w-0">
        <NuxtLink :to="enterpriseTo" class="text-[15px] font-medium text-primary underline-offset-2 hover:underline" @click="rememberReturn">{{ row.record.nameRaw ?? '企业名称未提供' }}</NuxtLink>
        <p class="mt-0.5 text-[13px] leading-5">
          <span class="text-muted-foreground">{{ TITLES[row.record.titleCode] ?? row.record.titleCode }}</span>
          <span class="mx-1.5 text-muted-foreground">·</span>
          {{ eventDecisionText(row.event) }}
        </p>
        <p v-if="row.reasons.length" class="text-muted-foreground mt-1 text-[13px]">{{ row.reasons.map(comparisonReasonText).join('；') }}</p>
      </div>
      <Badge :variant="classificationVariant">{{ COMPARISON_CLASSES[row.classification] ?? '待核' }}</Badge>
    </header>

    <div class="mt-3 grid min-w-0 gap-3 lg:grid-cols-2">
      <section class="min-w-0" aria-label="正式文件">
        <h4 class="text-muted-foreground mb-1.5 text-xs font-medium">正式文件</h4>
        <ul v-if="row.evidence.length" class="flex flex-col gap-1.5 text-[13px]">
          <li v-for="evidence in row.evidence" :key="evidence.id" class="flex min-w-0 items-start gap-2">
            <FileText class="text-muted-foreground mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <div class="min-w-0">
              <p class="font-medium break-words">{{ fileNameOf(evidence.sourceFile) }}</p>
              <p class="text-muted-foreground">
                <span v-if="evidence.listNo != null">序号 {{ evidence.listNo }} · </span>
                <NuxtLink v-if="evidencePageState(evidence.sourceFile, evidence.page) === 'assigned'" :to="evidencePreviewHref({ sourceFile: evidence.sourceFile, page: evidence.page, back: returnTo })" class="text-primary tabular-nums underline underline-offset-2" @click="rememberReturn">第 {{ evidence.page }} 页</NuxtLink>
                <span v-else-if="evidencePageState(evidence.sourceFile, evidence.page) === 'pending'">页码待核</span>
                <span v-else>这类文件没有可复核页</span>
                <span v-if="evidence.attachment"> · {{ evidence.attachment }}</span>
                <span v-if="!evidence.inSelectedSource"> · 未选入本次范围</span>
              </p>
            </div>
          </li>
        </ul>
        <p v-else class="text-muted-foreground text-[13px]">未记录文件出处。</p>
      </section>

      <section class="min-w-0" aria-label="平台接口原行">
        <h4 class="text-muted-foreground mb-1.5 text-xs font-medium">平台接口原行</h4>
        <ul v-if="row.platformRows.length" class="flex flex-col gap-1.5 text-[13px]">
          <li v-for="{ relation, edges } in relationRows" :key="relation.id" class="min-w-0 border-t pt-1.5" :data-relation-id="relation.id">
            <p class="break-words">{{ PLATFORM_INTERFACES[relation.interface] ?? '平台接口' }} · {{ relation.status ?? '状态未提供' }}</p>
            <div class="mt-0.5 flex flex-wrap items-center gap-1.5">
              <Badge v-for="edge in edges" :key="edge.id" variant="outline">{{ CORRESPONDENCE_ROLES[edge.role] ?? '对应' }} · {{ correspondenceStatusText(edge) }}</Badge>
            </div>
            <details class="text-muted-foreground mt-1"><summary class="cursor-pointer">查询信息</summary><p>查询 #{{ relation.queryId }} · 原行 {{ relation.sequenceNo }} · 记录 #{{ relation.id }}</p><p>{{ relation.nameRaw ?? '原名未知' }} · {{ humanRecordTime(relation.queriedAt) }}</p></details>
            <Button variant="ghost" size="sm" class="mt-1 h-7 px-1.5 text-[13px]" @click="openSource('relation', relation.id)">查看原行与查询范围</Button>
          </li>
        </ul>
        <p v-else class="text-muted-foreground text-[13px]">尚未匹配到这条记录的接口出处。</p>
        <ul v-if="otherEdges.length" class="mt-2 flex flex-col gap-1.5 text-[13px]">
          <li v-for="edge in otherEdges" :key="edge.id" class="flex flex-wrap items-center gap-1.5">
            <span class="text-muted-foreground">对应 #{{ edge.id }} · 接口原行 {{ edge.relationId == null ? '未提供' : `#${edge.relationId}` }}</span>
            <Badge variant="outline">{{ CORRESPONDENCE_ROLES[edge.role] ?? '对应' }} · {{ correspondenceStatusText(edge) }}</Badge>
          </li>
        </ul>
      </section>
    </div>

    <Dialog :open="sourceId !== null" @update:open="!$event && (sourceId = null)">
      <DialogContent class="max-h-[85dvh] min-w-0 overflow-y-auto sm:max-w-3xl" @close-auto-focus="navigatingToEvent && $event.preventDefault()">
        <DialogHeader><DialogTitle>来源原行与反向对应</DialogTitle><DialogDescription>查看具体行的原查询条件、状态和事件关系。</DialogDescription></DialogHeader>
        <SourceReader v-if="sourceId !== null" :kind="sourceKind" :id="sourceId" :return-to="returnTo" @event-navigate="closeForEvent" />
      </DialogContent>
    </Dialog>
  </article>
</template>
