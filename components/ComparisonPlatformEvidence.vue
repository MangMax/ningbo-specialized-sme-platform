<script setup lang="ts">
import { computed, shallowRef } from 'vue'
import type { ComparisonPlatformEvidence } from '~~/lib/comparison-platform'
import { PLATFORM_QUERY_STATUSES, PLATFORM_QUERY_STATUS_ORDER } from '~~/lib/labels'
import { historicalAliasNamesForDisplay } from '~~/lib/roster/enterprise-name-display'
import PlatformRecords from '@/components/PlatformRecords.vue'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'

/** 比对页只展示简短摘要；平台原始记录在宽面板中逐条列表。 */
const props = defineProps<{
  evidence: ComparisonPlatformEvidence
  enterpriseId: number
  currentName: string
}>()

const aliases = computed(() => props.evidence.aliases)
const historicalAliases = computed(() => {
  const names = new Set(historicalAliasNamesForDisplay(
    aliases.value.map((alias) => alias.name),
    props.currentName,
  ))
  return aliases.value.filter((alias) => names.has(alias.name))
})
const confirmedAliases = computed(() => historicalAliases.value.filter((a) => a.verificationStatus === 'confirmed'))
const pendingAliases = computed(() => historicalAliases.value.filter((a) => a.verificationStatus !== 'confirmed'))
const queries = computed(() => props.evidence.queries)
const relationCount = computed(() => props.evidence.relationCount)
const hasEvidence = computed(() => historicalAliases.value.length > 0 || queries.value.length > 0)

const showDetails = shallowRef(false)

/** 首行只保留足以识别证据状态的信息;接口、时点与原始关系在点开后完整呈现。 */
const statusCounts = computed(() => {
  const counts = new Map<string, number>()
  for (const query of queries.value) counts.set(query.status, (counts.get(query.status) ?? 0) + 1)
  return [...PLATFORM_QUERY_STATUS_ORDER, ...counts.keys()]
    .filter((status, index, statuses) => statuses.indexOf(status) === index && counts.has(status))
    .map((status) => ({
      status,
      count: counts.get(status)!,
      label: PLATFORM_QUERY_STATUSES[status] ?? status,
    }))
})
const compactSummary = computed(() => {
  const parts = [
    ...statusCounts.value.map(({ label, count }) => `${label} ×${count}`),
    pendingAliases.value.length ? `待核别名 ${pendingAliases.value.length}` : null,
    relationCount.value ? `平台记录 ${relationCount.value} 条` : null,
    !queries.value.length && confirmedAliases.value.length ? `已确认曾用名 ${confirmedAliases.value.length}` : null,
  ].filter((part): part is string => !!part)
  return parts.join(' · ') || '—'
})

</script>

<template>
  <div v-if="hasEvidence" class="flex min-w-0 flex-col items-start gap-0.5" data-testid="comparison-platform-evidence">
    <p class="max-w-full break-words text-[13px] font-medium leading-5" data-testid="platform-evidence-summary">{{ compactSummary }}</p>
    <Dialog v-model:open="showDetails">
      <DialogTrigger as-child>
        <button type="button" data-testid="platform-evidence-details-toggle" class="text-primary text-[13px] leading-5 hover:underline">查看平台记录</button>
      </DialogTrigger>
      <DialogContent v-if="showDetails" class="max-h-[90dvh] w-[calc(100%-2rem)] max-w-[calc(100%-2rem)] flex flex-col overflow-hidden p-4 shadow-none sm:max-w-6xl" data-testid="platform-records-dialog">
        <DialogHeader>
          <DialogTitle class="pr-6">平台记录</DialogTitle>
          <DialogDescription>{{ currentName }}</DialogDescription>
        </DialogHeader>
        <div class="min-h-0 flex-1 space-y-3 overflow-y-auto">
        <div v-if="confirmedAliases.length" class="flex flex-wrap items-center gap-1 text-[13px]" data-testid="platform-confirmed-aliases">
          <span class="text-muted-foreground">曾用名</span>
          <Badge v-for="alias in confirmedAliases" :key="alias.id" variant="outline" class="text-[13px] font-normal">{{ alias.name }}</Badge>
        </div>
        <div v-if="pendingAliases.length" class="flex flex-wrap items-center gap-1 text-[13px]" data-testid="platform-pending-aliases">
          <span class="text-muted-foreground">待核别名</span>
          <Badge v-for="alias in pendingAliases" :key="alias.id" variant="quiet" class="text-[13px] font-normal">{{ alias.name }}</Badge>
        </div>
        <PlatformRecords :queries="queries" :relations="queries.flatMap(query => query.relations)" />

        </div>
      </DialogContent>
    </Dialog>
  </div>
  <span v-else class="text-muted-foreground text-xs">—</span>
</template>
