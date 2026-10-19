<script setup lang="ts">
import type { DecisionVersion } from '~~/lib/roster/evidence-review-ui'
import { DIFFERENCE_STATUSES, DIFFERENCE_REASONS, DIFFERENCE_MEASURES, TITLES } from '~~/lib/labels'
defineProps<{ decision: DecisionVersion; label?: string }>()
</script>
<template>
  <div class="flex min-w-0 flex-col gap-1 break-words text-[13px] leading-5">
    <p>{{ label ?? '决定' }} #{{ decision.id }} · {{ DIFFERENCE_STATUSES[decision.status] ?? decision.status }}</p>
    <p>原因：{{ DIFFERENCE_REASONS[decision.reasonCode ?? ''] ?? decision.reasonCode ?? '未填写' }}<template v-if="decision.reasonNote"> · {{ decision.reasonNote }}</template></p>
    <p>措施：{{ DIFFERENCE_MEASURES[decision.measureCode ?? ''] ?? decision.measureCode ?? '未填写' }}<template v-if="decision.measureNote"> · {{ decision.measureNote }}</template></p>
    <p v-if="decision.movedInCity || decision.movedInTitleCode || decision.movedInYear || decision.movedInBatch">迁入来源：{{ decision.movedInCity ?? '城市待补证' }} · {{ TITLES[decision.movedInTitleCode ?? ''] ?? '称号待补证' }} · {{ decision.movedInYear ?? '年份待补证' }} · {{ decision.movedInBatch ?? '批次待补证' }}</p>
    <p v-if="decision.evidenceQueryId || decision.evidenceRelationId">原证据：查询 #{{ decision.evidenceQueryId ?? '未指定' }} · 原行 #{{ decision.evidenceRelationId ?? '未指定' }}</p>
    <p v-if="decision.actor">{{ decision.actor.type }} · {{ decision.actor.id }}</p>
    <p v-if="decision.basis">决定依据：{{ decision.basis }}</p>
    <p>规则：{{ decision.ruleVersion ?? '未记录' }} · 生效：{{ decision.effectiveAt ?? '未记录' }} · 登记：{{ decision.recordedAt }}</p>
  </div>
</template>
