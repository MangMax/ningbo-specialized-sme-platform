<script setup lang="ts">
import { computed } from 'vue'
import type { PlatformBusinessDetail } from '~~/lib/roster/platform-business-detail'
import type { PlatformRecord, PlatformRecordQuery } from '~~/lib/roster/platform-records'
import { PLATFORM_HISTORY_CONFLICTS, PLATFORM_HISTORY_STATES } from '~~/lib/roster/platform-records'
import { formatFetchTime } from '~~/lib/reconcile-time'
import { PLATFORM_RDJBS } from '~~/lib/labels'
import DisclosurePanel from './DisclosurePanel.vue'
import PlatformRecordDetails from './PlatformRecordDetails.vue'
import PlatformFieldConflicts from './PlatformFieldConflicts.vue'
import { Button } from '@/components/ui/button'

const props = defineProps<{ business: PlatformBusinessDetail; records: Map<number, PlatformRecord>; queries: Map<number, PlatformRecordQuery> }>()
const emit = defineEmits<{ source: [relationId: number] }>()
const sections = computed(() => [
  ...props.business.versions,
  ...props.business.observationRefs.filter(o => o.businessRecord.groupState !== 'verified' || o.businessRecord.versionId == null)
    .map(o => ({ businessRecord: o.businessRecord, observationRefs: [o] })),
])
const decisionStatus: Record<string, string> = { candidate: '待核', confirmed: '已确认', rejected: '已否决', unlinked: '已解除' }
</script>
<template>
  <DisclosurePanel compact :heading-level="4" :title="`版本与采集历史 · ${business.versionCount} 个内容版本 · ${business.observationCount} 次采集`" data-testid="platform-business-history">
    <template #title><span class="flex min-w-0 flex-1 flex-col items-start text-left"><span>版本与采集历史 · {{ business.versionCount }} 个内容版本 · {{ business.observationCount }} 次采集</span><span class="text-muted-foreground font-normal">{{ business.versionCount }} 个已核实版本 · {{ business.unknownContentObservationCount }} 次内容未核实</span></span></template>
    <div class="flex flex-col gap-3 px-3">
      <p class="text-muted-foreground text-[13px]">表格展示最近实际采集的原行；版本编号不表示时间。内容未核实的观察逐次保留，不计作内容版本。每次观察的对应决定仅属于该原行。</p>
      <section v-for="(section, index) in sections" :key="section.businessRecord.versionId ?? `unknown-${index}`" class="rounded-sm border p-3" :data-testid="section.businessRecord.groupState === 'verified' && section.businessRecord.versionId != null ? 'platform-content-version' : undefined">
        <h5 class="text-sm font-medium">{{ section.businessRecord.groupState === 'verified' ? `内容版本 #${section.businessRecord.versionId}` : PLATFORM_HISTORY_STATES[section.businessRecord.groupState] ?? '内容未知' }} · {{ section.observationRefs.length }} 次采集</h5>
        <div v-for="observation in section.observationRefs" :key="observation.relationId" class="mt-2 flex flex-col gap-1 border-t pt-2 text-[13px]" data-testid="platform-observation" :data-relation-id="observation.relationId">
          <p>行 #{{ observation.relationId }} · 查询 #{{ observation.queryId }} · <time :datetime="observation.queriedAt">{{ formatFetchTime(observation.queriedAt) ?? observation.queriedAt }}</time></p>
          <p class="text-muted-foreground">来源称号：{{ PLATFORM_RDJBS[records.get(observation.relationId)?.sourceRdjb ?? queries.get(observation.queryId)?.rdjb ?? ''] ?? '未标注' }} · {{ records.get(observation.relationId)?.nameRaw ?? '名称未提供' }} · {{ records.get(observation.relationId)?.usccRaw ?? '信用代码未提供' }}</p>
          <PlatformFieldConflicts :conflicts="records.get(observation.relationId)?.normalizationConflicts" />
          <p v-for="conflict in observation.conflicts" :key="conflict">{{ PLATFORM_HISTORY_CONFLICTS[conflict] ?? '原观察存在冲突，待核' }}</p>
          <p v-if="!observation.existingCorrespondences.length" class="text-muted-foreground">此原行暂无对应决定</p>
          <p v-for="decision in observation.existingCorrespondences" :key="decision.id">对应 #{{ decision.id }} · {{ decisionStatus[decision.status] ?? decision.status }}<template v-if="decision.eventId"> · 事件 #{{ decision.eventId }}</template></p>
          <div class="flex flex-wrap gap-1">
            <PlatformRecordDetails v-if="records.get(observation.relationId)" :record="records.get(observation.relationId)!" :query="queries.get(observation.queryId)" />
            <Button variant="ghost" size="sm" @click="emit('source', observation.relationId)">对应事件/出处</Button>
          </div>
        </div>
      </section>
    </div>
  </DisclosurePanel>
</template>
