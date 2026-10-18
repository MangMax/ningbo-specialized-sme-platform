<script setup lang="ts">
import { computed } from 'vue'
import { CORRESPONDENCE_ROLES, correspondenceStatusText, type CorrespondenceDetail } from '~~/lib/roster/correspondence-view'
import { EVENTS, TITLES } from '~~/lib/labels'
import SourceRowDetail from './SourceRowDetail.vue'
import { Badge } from '@/components/ui/badge'

const props = defineProps<{ edge: CorrespondenceDetail; returnTo?: string | null }>()
const targetEvent = computed(() => props.edge.event ?? props.edge.predecessorEvent)
const eventTo = computed(() => targetEvent.value ? { path: `/enterprises/${targetEvent.value.record.enterpriseId}`, query: { eventId: String(targetEvent.value.id), ...(props.returnTo ? { returnTo: props.returnTo } : {}) } } : '/comparison')
</script>

<template>
  <li class="min-w-0 rounded-sm border p-3" :data-correspondence-id="edge.id">
    <div class="flex flex-wrap items-center gap-2 text-sm">
      <strong>{{ CORRESPONDENCE_ROLES[edge.role] ?? '对应关系' }}</strong>
      <Badge :variant="edge.status === 'confirmed' && !edge.requiresRevalidation ? 'secondary' : 'outline'">{{ correspondenceStatusText(edge) }}</Badge>
      <span class="text-muted-foreground">{{ edge.type === 'later_process' ? '独立后续流程' : edge.type === 'event_export_context' || edge.type === 'process_export_context' ? '快照背景' : '记录对应' }}</span>
    </div>
    <p v-if="targetEvent" class="mt-1 text-[13px]">
      <NuxtLink :to="eventTo" class="text-primary underline underline-offset-2 hover:no-underline">查看{{ TITLES[targetEvent.record.titleCode] ?? '称号' }} {{ EVENTS[targetEvent.eventType] ?? '事件' }} {{ targetEvent.year ?? '年份待核' }} · 事件 #{{ targetEvent.id }}</NuxtLink>
    </p>
    <p class="text-muted-foreground mt-1 text-xs">规则 {{ edge.ruleId }} / {{ edge.ruleVersion }} · {{ edge.decidedAt ? `决定于 ${edge.decidedAt}` : '尚无决定时间' }}<span v-if="edge.requiresRevalidation"> · 出处变更后需重新核验</span></p>
    <div class="mt-2 flex min-w-0 flex-col gap-2">
      <SourceRowDetail v-if="edge.relation" :relation="edge.relation" />
      <SourceRowDetail v-if="edge.exportRow" :export-row="edge.exportRow" />
    </div>
  </li>
</template>
