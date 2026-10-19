<script setup lang="ts">
import QueryCoverageDetails from './QueryCoverageDetails.vue'
import { computed } from 'vue'
import type { ReviewAssessment } from '~~/lib/roster/evidence-review-ui'
import { coverageLabels, validityLabels } from '~~/lib/roster/evidence-review-ui'
import { DIFFERENCE_STATUSES, DIFFERENCE_REASONS, DIFFERENCE_MEASURES } from '~~/lib/labels'
import { Badge } from '@/components/ui/badge'
const props = defineProps<{ assessment: ReviewAssessment }>()
const decision = computed(() => props.assessment.currentDecision.current)
const assessmentLabels: Record<string, string> = { queried_unjudged: '已查询，尚未判断', not_queried: '尚未查询，尚未判断', decided: '已有业务决定', withdrawn: '决定已撤回', unknown: '尚未判断，查询范围待核' }
</script>
<template>
  <div class="flex min-w-0 flex-col gap-1 text-[13px] leading-5" data-testid="query-assessment">
    <div class="flex flex-wrap gap-1">
      <Badge variant="outline">{{ coverageLabels[assessment.queryCoverage.status] ?? assessment.queryCoverage.status }}</Badge>
      <Badge variant="secondary">{{ validityLabels[assessment.explanationValidity.status] ?? assessment.explanationValidity.status }}</Badge>
    </div>
    <p>{{ assessmentLabels[assessment.assessment] ?? assessment.assessment }}</p>
    <template v-if="decision">
      <p>当前决定 #{{ decision.id }} · {{ DIFFERENCE_STATUSES[decision.status] ?? decision.status }}</p>
      <p>原因：{{ DIFFERENCE_REASONS[decision.reasonCode ?? ''] ?? decision.reasonCode ?? '未填写' }}<template v-if="decision.reasonNote"> · {{ decision.reasonNote }}</template></p>
      <p>措施：{{ DIFFERENCE_MEASURES[decision.measureCode ?? ''] ?? decision.measureCode ?? '未填写' }}<template v-if="decision.measureNote"> · {{ decision.measureNote }}</template></p>
    </template>
    <p v-else>尚无业务决定<template v-if="assessment.currentDecision.versionId">（撤回版本 #{{ assessment.currentDecision.versionId }}，历史保留）</template></p>
    <QueryCoverageDetails :coverage="assessment.queryCoverage" />
  </div>
</template>
