<script setup lang="ts">
import { computed } from 'vue'
import AssessmentStatusBadge from './evidence-review/AssessmentStatusBadge.vue'
import type { ComparisonSummaryRow } from '~~/lib/comparison-summary'
import { DIFFERENCE_MEASURES, DIFFERENCE_REASONS, DIFFERENCE_STATUSES } from '~~/lib/labels'

const props = defineProps<{
  assessment: ComparisonSummaryRow['assessment']
  disposition: ComparisonSummaryRow['platform']['disposition']
}>()
const reason = computed(() => {
  const value = props.disposition
  if (value.reasonCode) return DIFFERENCE_REASONS[value.reasonCode] ?? value.reasonCode
  return value.status === 'not_queried' ? '尚无已确认原因' : DIFFERENCE_STATUSES[value.status] ?? value.status
})
const measure = computed(() => {
  const code = props.disposition.measureCode
  return code ? DIFFERENCE_MEASURES[code] ?? code : '后续措施尚未记录'
})
</script>

<template>
  <div class="flex min-w-0 flex-col gap-1 text-[13px] leading-5" data-testid="comparison-summary-assessment">
    <div class="flex flex-wrap gap-1.5">
      <AssessmentStatusBadge kind="coverage" :value="assessment.queryCoverage.status" />
      <AssessmentStatusBadge kind="assessment" :value="assessment.assessment" />
      <AssessmentStatusBadge v-if="assessment.explanationValidity.status !== 'not_applicable'" kind="validity" :value="assessment.explanationValidity.status" />
    </div>
    <template v-if="assessment.assessment === 'decided'">
      <p>{{ reason }}</p>
      <p class="text-muted-foreground">{{ measure }}</p>
    </template>
  </div>
</template>
