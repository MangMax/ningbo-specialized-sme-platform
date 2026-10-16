<script setup lang="ts">
import { computed } from 'vue'
import type { ComparisonPlatformEvidence } from '~~/lib/comparison-platform'
import {
  DIFFERENCE_MEASURES,
  DIFFERENCE_REASONS,
  DIFFERENCE_STATUSES,
  VERIFICATION_STATUSES,
} from '~~/lib/labels'
import { Badge } from '@/components/ui/badge'

/**
 * 比对行的**库内平台证据**(RL-03 的现有接缝):让现名之外的
 * **曾用名**(`enterprise_alias`)与**已核验处置**(`difference_reason`:原因 + 配对措施)
 * 在比对页就能看到,并能**跳转**到该企业的全部平台关系(`/platform-queries`)。
 *
 * 与「平台解释」列分工不同:`ComparisonReconcile` 展示的是**离线解释缓存**
 * (`data/platform-reconcile.json`);这里展示的是**库内证据**。两者都缺时这一格为空 —
 * 证据是增强项,不该让比对页挂掉。
 */
const props = defineProps<{
  evidence: ComparisonPlatformEvidence | null
  enterpriseId: number
}>()

const aliases = computed(() => props.evidence?.aliases ?? [])
const confirmedAliases = computed(() => aliases.value.filter((a) => a.verificationStatus === 'confirmed'))
const pendingAliases = computed(() => aliases.value.filter((a) => a.verificationStatus !== 'confirmed'))
const disposition = computed(() => props.evidence?.disposition ?? null)
const relationCount = computed(() => props.evidence?.relationCount ?? 0)

const statusLabel = computed(() =>
  disposition.value ? (DIFFERENCE_STATUSES[disposition.value.status] ?? disposition.value.status) : null,
)
const reasonLabel = computed(() =>
  disposition.value?.reasonCode
    ? (DIFFERENCE_REASONS[disposition.value.reasonCode] ?? disposition.value.reasonCode)
    : null,
)
const measureLabel = computed(() =>
  disposition.value?.measureCode
    ? (DIFFERENCE_MEASURES[disposition.value.measureCode] ?? disposition.value.measureCode)
    : null,
)
/** 迁入的原城市/称号/年份/批次;缺项留空待核,不猜填。 */
const movedIn = computed(() => {
  const value = disposition.value?.movedIn
  if (!value) return null
  const parts = [value.city, value.titleCode, value.year != null ? `${value.year} 年` : null, value.batch != null ? `第 ${value.batch} 批` : null]
  const filled = parts.filter((p): p is string => !!p)
  return filled.length ? filled.join(' · ') : null
})
const link = computed(() => `/platform-queries?enterpriseId=${props.enterpriseId}`)
</script>

<template>
  <div v-if="evidence" class="flex flex-col gap-1" data-testid="comparison-platform-evidence">
    <div v-if="confirmedAliases.length" class="flex flex-wrap items-center gap-1 text-xs">
      <span class="text-muted-foreground">曾用名</span>
      <Badge
        v-for="alias in confirmedAliases"
        :key="alias.id"
        variant="outline"
        class="font-normal"
        :title="alias.note ?? undefined"
        >{{ alias.name }}</Badge
      >
    </div>
    <div v-if="pendingAliases.length" class="flex flex-wrap items-center gap-1 text-xs">
      <span class="text-muted-foreground">待核别名</span>
      <Badge
        v-for="alias in pendingAliases"
        :key="alias.id"
        variant="quiet"
        class="font-normal"
        :title="VERIFICATION_STATUSES[alias.verificationStatus] ?? alias.verificationStatus"
        >{{ alias.name }}</Badge
      >
    </div>
    <div v-if="disposition" class="flex flex-wrap items-center gap-1 text-xs">
      <Badge variant="secondary" class="font-normal">{{ statusLabel }}</Badge>
      <span v-if="reasonLabel" class="text-muted-foreground">{{ reasonLabel }}</span>
      <span v-if="measureLabel" class="text-muted-foreground">→ {{ measureLabel }}</span>
      <span v-if="disposition.verificationStatus !== 'confirmed'" class="text-muted-foreground">
        ({{ VERIFICATION_STATUSES[disposition.verificationStatus] ?? disposition.verificationStatus }})
      </span>
    </div>
    <p v-if="movedIn" class="text-muted-foreground text-xs">迁入来源:{{ movedIn }}</p>
    <NuxtLink
      v-if="relationCount"
      :to="link"
      class="text-primary text-xs hover:underline"
      data-testid="comparison-platform-link"
      >平台关系 {{ relationCount }} 条 · 查看</NuxtLink
    >
  </div>
  <span v-else class="text-muted-foreground text-xs">—</span>
</template>
