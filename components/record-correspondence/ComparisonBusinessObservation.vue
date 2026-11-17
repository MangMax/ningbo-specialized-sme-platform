<script setup lang="ts">
import type { RecordComparisonResult } from '~~/lib/roster/record-comparison-view'
import { comparisonReasonText } from '~~/lib/roster/record-comparison-view'
import { TITLES } from '~~/lib/labels'
import { humanRecordTime } from '~~/lib/roster/record-ledger'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { comparisonLinkText as linkText, comparisonQualificationText as qualificationText, comparisonDecisionText as decisionText } from '~~/lib/roster/record-comparison-display'

defineProps<{ observation: RecordComparisonResult['businessGroups']['rows'][number]['unknownObservations'][number] }>()
const emit = defineEmits<{ 'open-source': [relationId: number] }>()
</script>

<template>
  <li class="min-w-0 border-t pt-2 text-table [overflow-wrap:anywhere]" data-testid="comparison-business-observation">
    <div class="flex flex-wrap items-center gap-2"><strong>观察 #{{ observation.relation.id }} · {{ observation.relation.nameRaw ?? '企业原名未提供' }}</strong><Badge variant="outline">{{ linkText(observation.linkState) }}</Badge></div>
    <p>查询 #{{ observation.relation.queryId }} · 行 {{ observation.relation.sequenceNo }} · {{ humanRecordTime(observation.relation.queriedAt) }}</p>
    <p>{{ TITLES[observation.relation.titleCode ?? ''] ?? '称号未确定' }} · 原状态 {{ observation.relation.status ?? '未提供' }}</p>
    <p v-if="observation.currentSource">现状比较：{{ qualificationText(observation.currentSource.qualification) }}<span v-if="observation.currentSource.proofId"> · 范围依据 {{ observation.currentSource.proofId }}</span>。{{ observation.currentSource.reasons.map(comparisonReasonText).join('；') }}</p>
    <p v-if="observation.withoutOfficial">正式来源资格：{{ qualificationText(observation.withoutOfficial.qualification) }}<span v-if="observation.withoutOfficial.proofId"> · 范围依据 {{ observation.withoutOfficial.proofId }}</span>。{{ observation.withoutOfficial.reasons.map(comparisonReasonText).join('；') }}</p>
    <p v-if="observation.historicalDecisionUnavailable.length">截止时点后的决定状态无法还原，本观察保持待核。</p>
    <ul v-if="observation.correspondences.length">
      <li v-for="edge in observation.correspondences" :key="edge.id">原对应 #{{ edge.id }} · {{ decisionText(edge.status) }}<span v-if="edge.eventId"> · 正式事件 #{{ edge.eventId }}</span><span v-if="edge.predecessorEventId"> · 前序正式事件 #{{ edge.predecessorEventId }}</span><span v-if="edge.exportRowId"> · 平台导出行 #{{ edge.exportRowId }}</span><span v-if="edge.requiresRevalidation"> · 需要重新核验</span></li>
    </ul>
    <p v-else class="text-muted-foreground">本次范围内没有可用的原对应；同组其他观察的决定不适用于本观察。</p>
    <Button variant="link" size="sm" @click="emit('open-source', observation.relation.id)">查看观察 #{{ observation.relation.id }} 原始记录</Button>
  </li>
</template>
