<script setup lang="ts">
import RosterQueryCoverageDetails from './QueryCoverageDetails.vue'
import RosterAssessmentStatusBadge from './AssessmentStatusBadge.vue'
import { computed } from 'vue'
import type { ReviewAssessment } from '#sme-roster/lib/roster/evidence-review-ui'
import {
  decisionMeasureLabel,
  decisionReasonLabel,
  decisionStatusLabel,
} from '#sme-roster/lib/roster/review-display'

const props = withDefaults(defineProps<{ assessment: ReviewAssessment; compact?: boolean }>(), {
  compact: false,
})

const decision = computed(() => props.assessment.currentDecision.current)
const validity = computed(() => props.assessment.explanationValidity.status)
</script>

<template>
  <div
    class="flex min-w-0 flex-col"
    :class="compact ? 'gap-1' : 'gap-2'"
    data-testid="query-assessment"
  >
    <div class="flex flex-wrap items-center gap-1.5">
      <RosterAssessmentStatusBadge kind="coverage" :value="assessment.queryCoverage.status" />
      <RosterAssessmentStatusBadge kind="assessment" :value="assessment.assessment" />
      <RosterAssessmentStatusBadge
        v-if="validity !== 'not_applicable'"
        kind="validity"
        :value="validity"
      />
    </div>

    <div
      v-if="decision"
      class="min-w-0"
      :class="compact ? 'text-table leading-5' : 'bg-muted/40 rounded-md px-3 py-2 text-table leading-5'"
      data-testid="current-decision"
    >
      <p class="font-medium">当前决定 #{{ decision.id }} · {{ decisionStatusLabel(assessment) }}</p>
      <p>
        {{ decisionReasonLabel(assessment) }}
        <template v-if="decisionMeasureLabel(assessment)"> · {{ decisionMeasureLabel(assessment) }}</template>
      </p>
    </div>
    <p v-else class="text-muted-foreground text-table leading-5">
      尚无业务决定<template v-if="assessment.currentDecision.versionId">
        （撤回版本 #{{ assessment.currentDecision.versionId }}，历史保留）</template>
    </p>

    <RosterQueryCoverageDetails v-if="!compact" :coverage="assessment.queryCoverage" />
  </div>
</template>
