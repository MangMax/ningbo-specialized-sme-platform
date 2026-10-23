<script setup lang="ts">
import { computed } from 'vue'
import { correspondenceStatusText, eventDecisionText, type CorrespondenceDetail } from '~~/lib/roster/correspondence-view'
import { PLATFORM_INTERFACES, TITLES } from '~~/lib/labels'
import { humanRecordTime, isCurrentContextEdge } from '~~/lib/roster/record-ledger'
import EventCorrespondenceDecision from './EventCorrespondenceDecision.vue'
import DisclosurePanel from '@/components/DisclosurePanel.vue'
import { Badge } from '@/components/ui/badge'

/**
 * 一条对应关系。
 *
 * 只保留「对上了什么、现在是什么状态、去哪核对」三层；规则、审计时间与整份原行字段
 * 不再逐条铺开 —— 原行字段与查询条件在需要时从原行入口读取。
 */
const props = defineProps<{ edge: CorrespondenceDetail; returnTo?: string | null }>()
const emit = defineEmits<{ 'event-navigate': [eventId: number] }>()

const targetEvent = computed(() => props.edge.event ?? props.edge.predecessorEvent)
const eventTo = computed(() => targetEvent.value
  ? { path: `/enterprises/${targetEvent.value.record.enterpriseId}`, query: { eventId: String(targetEvent.value.id), ...(props.returnTo ? { returnTo: props.returnTo } : {}) } }
  : '/comparison')

const locator = computed(() => {
  const relation = props.edge.relation
  if (relation) {
    const source = PLATFORM_INTERFACES[relation.query.interface] ?? '平台接口'
    return `${source} · 原行 ${relation.sequenceNo} · 查询 #${relation.query.id} · ${humanRecordTime(relation.query.queriedAt)}`
  }
  const exportRow = props.edge.exportRow
  if (exportRow) {
    return `平台导出快照 · ${exportRow.batch.year} 年 · 源行 ${exportRow.sourceRowNo} · ${exportRow.batch.collectedOn}`
  }
  return '未绑定平台原行'
})

function onEventClick(event: MouseEvent) {
  const target = (event.currentTarget as HTMLAnchorElement).getAttribute('target')
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || (target && target !== '_self')) return
  // NuxtLink still owns navigation, including duplicate (same-URL) navigation.
  if (targetEvent.value) emit('event-navigate', targetEvent.value.id)
}
</script>

<template>
  <li class="min-w-0 border-t py-2" :data-correspondence-id="edge.id">
    <div class="flex flex-wrap items-center gap-2 text-sm">
      <span class="text-muted-foreground">{{ isCurrentContextEdge(edge) ? '快照与本记录的关联' : '匹配' }}</span>
      <Badge :variant="edge.status === 'confirmed' && !edge.requiresRevalidation ? 'secondary' : 'outline'">{{ correspondenceStatusText(edge) }}</Badge>
    </div>
    <p v-if="targetEvent" class="mt-1 text-[13px]">
      <NuxtLink :to="eventTo" class="text-primary underline underline-offset-2 hover:no-underline" @click="onEventClick">查看{{ TITLES[targetEvent.record.titleCode] ?? '称号' }} · {{ eventDecisionText(targetEvent) }}</NuxtLink>
    </p>
    <EventCorrespondenceDecision v-if="edge.eventId && edge.relationId && ['event_process', 'event_recognized'].includes(edge.type)" :edge="{ type: edge.type, eventId: edge.eventId, relationId: edge.relationId, role: edge.role }" :existing="edge" />
    <DisclosurePanel compact content-class="pb-0" class="text-muted-foreground mt-1 text-[13px]">
      <template #trigger><span>来源定位</span></template>
      <p>{{ locator }}</p>
    </DisclosurePanel>
    <p v-if="edge.requiresRevalidation" class="text-warning mt-1 text-[13px]">出处变更后需重新核验；当前不按已确认出处计。</p>
  </li>
</template>
