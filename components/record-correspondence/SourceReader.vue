<script setup lang="ts">
import { computed } from 'vue'
import { useRecordSource } from '~/composables/useRecordSource'
import { eventDecisionText, type EventSource, type ExportRowSource, type RelationSource, type SourceKind } from '~~/lib/roster/correspondence-view'
import { isCurrentContextEdge } from '~~/lib/roster/record-ledger'
import { TITLES } from '~~/lib/labels'
import CorrespondenceItem from './CorrespondenceItem.vue'
import SourceRowDetail from './SourceRowDetail.vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

const props = defineProps<{ kind: SourceKind; id: number; returnTo?: string | null }>()
const emit = defineEmits<{ 'event-navigate': [eventId: number] }>()
const { displayed, displayedKey, requestedKey, loading, error, retry } = useRecordSource(() => props.kind, () => props.id)
const current = computed(() => displayedKey.value === requestedKey() ? displayed.value : null)
const visible = computed(() => current.value ?? displayed.value)
const event = computed(() => displayedKey.value.startsWith('event:') ? visible.value?.source as EventSource | undefined : undefined)
const relation = computed(() => displayedKey.value.startsWith('relation:') ? visible.value?.source as RelationSource | undefined : undefined)
const exportRow = computed(() => displayedKey.value.startsWith('export_row:') ? visible.value?.source as ExportRowSource | undefined : undefined)

/**
 * 事件视图只列**这条事件自己的**对应：已确认与候选都保留，候选不并进已确认；
 * 导出快照单独标「当前导出快照（非历史出处）」。
 */
const eventSections = computed(() => {
  const links = (visible.value?.correspondences ?? []).filter(link => link.eventId === event.value?.id)
  return {
    sources: links.filter(link => !isCurrentContextEdge(link) && link.type !== 'later_process'),
    current: links.filter(isCurrentContextEdge),
  }
})
</script>

<template>
  <div class="flex min-w-0 flex-col gap-3" data-testid="record-source-reader" :aria-busy="loading">
    <div v-if="loading && !displayed" class="flex flex-col gap-2" aria-label="正在读取对应出处"><Skeleton class="h-5 w-40" /><Skeleton class="h-20 w-full" /></div>
    <Alert v-if="error" variant="destructive">
      <AlertTitle>未能读取{{ kind === 'event' ? '事件' : '来源行' }}出处</AlertTitle>
      <AlertDescription class="flex flex-wrap items-center gap-2">当前来源未更新；{{ displayed ? '上次成功读取的出处保留在下方。' : '请重试。' }}<Button variant="outline" size="sm" :disabled="loading" @click="retry">重试读取</Button></AlertDescription>
    </Alert>
    <p v-if="displayed && !current" class="text-muted-foreground text-[13px]">正在读取目标来源；下方保留上次成功的出处。</p>
    <template v-if="current || displayed">
      <template v-if="event">
        <p class="text-sm font-medium">{{ TITLES[event.record.titleCode] ?? event.record.titleCode }} · {{ eventDecisionText(event) }}</p>
        <p v-if="!event.evidence.length" class="text-muted-foreground text-[13px]">此事件未记录正式文件出处。</p>
        <section aria-label="事件对应平台行">
          <h4 class="mb-2 text-sm font-medium">事件对应关系（含候选）</h4>
          <ul v-if="eventSections.sources.length" class="flex flex-col gap-2"><CorrespondenceItem v-for="edge in eventSections.sources" :key="edge.id" :edge="edge" :return-to="returnTo" @event-navigate="emit('event-navigate', $event)" /></ul>
          <p v-else class="text-muted-foreground text-[13px]">尚无已登记的事件对应关系。候选需另行核验，不能把企业级查询视为本事件出处。</p>
        </section>
        <section v-if="eventSections.current.length" aria-label="当前导出快照">
          <h4 class="mb-2 text-sm font-medium">当前导出快照（非历史出处）</h4>
          <p class="text-muted-foreground mb-2 text-[13px]">仅核对当前名称与代码，不作历史认定证据。</p>
          <ul class="flex flex-col gap-2"><CorrespondenceItem v-for="edge in eventSections.current" :key="edge.id" :edge="edge" :return-to="returnTo" @event-navigate="emit('event-navigate', $event)" /></ul>
        </section>
      </template>
      <template v-else>
        <SourceRowDetail v-if="relation" :relation="relation" />
        <SourceRowDetail v-if="exportRow" :export-row="exportRow" />
        <section aria-label="来源行对应事件">
          <h4 class="mb-2 text-sm font-medium">对应事件</h4>
          <ul v-if="visible?.correspondences.length" class="flex flex-col gap-2"><CorrespondenceItem v-for="edge in visible.correspondences" :key="edge.id" :edge="edge" :return-to="returnTo" @event-navigate="emit('event-navigate', $event)" /></ul>
          <p v-else class="text-muted-foreground text-[13px]">此原行尚无登记的对应关系；原查询行仍保留。</p>
        </section>
      </template>
    </template>
  </div>
</template>
