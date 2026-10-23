<script setup lang="ts">
import { computed, shallowRef, watch } from 'vue'
import { useEnterpriseCorrespondences } from '~/composables/useEnterpriseCorrespondences'
import RecordEventRow from './RecordEventRow.vue'
import TableFailureState from '@/components/TableFailureState.vue'

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
const { rows, ready, loading, error, reload, detailsForEvent, detailLoadingForEvent, detailErrorForEvent, loadEvent } = useEnterpriseCorrespondences(() => props.enterpriseId, selected)
watch([selected, ready, rows], () => {
  if (selected.value != null && events.value.some(event => event.id === selected.value)) void loadEvent(selected.value)
}, { immediate: true })
function select(eventId: number, open: boolean) {
  selected.value = open ? eventId : null
  emit('select', selected.value)
}
</script>

<template>
  <section class="bg-card min-w-0 overflow-hidden rounded-lg border" aria-label="公布事件与平台对应">
    <header class="flex flex-col gap-1 border-b px-4 py-3">
      <h2 class="text-sm font-semibold">公布事件与平台对应</h2>
      <p class="text-muted-foreground text-[13px] leading-5">展开一次公布事件，核对平台原行并登记对应；下方差异解释按称号判断原因。</p>
    </header>
    <TableFailureState v-if="error" compact title="已登记对应读取失败" description="公布事实保留；请重试读取已有决定。" :pending="loading" @retry="reload" />
    <p v-if="!events.length" class="text-muted-foreground px-4 py-6 text-[13px]">尚无可核对平台对应的正式公布事件。</p>
    <ul v-else class="divide-y">
      <li v-for="event in events" :key="event.id">
        <RecordEventRow
          :event="event" :evidence="event.evidence" :edges="rows.filter(edge => edge.eventId === event.id)"
          :full-edges="detailsForEvent(event.id)" :links-ready="ready"
          :details-loading="detailLoadingForEvent(event.id)" :details-error="detailErrorForEvent(event.id)"
          :back="back" :open="selected === event.id" review
          @update:open="select(event.id, $event)" @preview="emit('preview', $event)"
          @event-navigate="emit('event-navigate', $event)" @page-open="(id, mouse) => emit('page-open', id, mouse)"
          @retry-detail="loadEvent(event.id, true)"
        />
      </li>
    </ul>
  </section>
</template>
