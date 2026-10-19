<script setup lang="ts">
import { useQuery } from '@pinia/colada'
import type { ImpactDetail } from '~~/lib/roster/evidence-review-ui'
import EvidenceImpactSources from './EvidenceImpactSources.vue'
import EvidenceReviewForm from './EvidenceReviewForm.vue'
import QueryCoverageDetails from './QueryCoverageDetails.vue'
import DecisionVersionDetails from './DecisionVersionDetails.vue'
import DecisionHistory from './DecisionHistory.vue'
import { Button } from '@/components/ui/button'
import TableFailureState from '@/components/TableFailureState.vue'
const emit = defineEmits<{ saved: [] }>()
const props = defineProps<{ impactId: number; enterpriseId?: number }>()
const { data, isLoading, error, refetch } = useQuery({ key: () => ['evidence-impact', props.impactId], query: () => $fetch<ImpactDetail>(`/api/roster/evidence-impacts/${props.impactId}`) })
</script>
<template>
  <div class="flex min-w-0 flex-col gap-3 border-t pt-3">
    <p v-if="isLoading" role="status">正在读取当前决定和证据版本…</p>
    <TableFailureState v-if="error" title="复核详情读取失败" :pending="isLoading" @retry="refetch()" />
    <p v-if="data && enterpriseId != null && data.enterpriseId !== enterpriseId" role="alert">该复核项不属于当前企业。请从清单选择准确坐标。</p>
    <template v-else-if="data">
      <DecisionVersionDetails v-if="data.oldDecision" :decision="data.oldDecision" label="原决定" />
      <DecisionVersionDetails v-if="data.currentDecision?.current && data.oldDecision && data.currentDecision.current.id !== data.oldDecision.id" :decision="data.currentDecision.current" label="当前决定" />
      <p v-if="data.gaps.decisionUnavailable || !data.oldDecision">历史决定原文不可用。原决定 #{{ data.decisionId }} · 企业 #{{ data.enterpriseId }} · {{ data.titleCode }} · {{ data.direction }} 的历史坐标和来源仍保留。</p>
      <p>当前决定 #{{ data.currentDecision?.versionId ?? '无' }} · {{ data.pending ? '待复核' : '已复核' }} · 证据修订 #{{ data.evidenceToken.latestRevisionId }}</p>
      <p v-if="data.gaps.subjectUnknown">主体未确认，不能推断为零记录。</p>
      <QueryCoverageDetails v-if="data.queryCoverage" :coverage="data.queryCoverage" />
      <div v-if="data.reviewedBaseline" data-testid="reviewed-baseline" class="flex flex-col gap-1 break-words border-l pl-2">
        <h4 class="text-sm font-medium">已登记的证据复核</h4>
        <p>复核至修订 #{{ data.reviewedBaseline.reviewedRevisionId }} · {{ data.reviewedBaseline.actor.type }} · {{ data.reviewedBaseline.actor.id }}</p>
        <p>复核依据：{{ data.reviewedBaseline.basis }}</p>
        <p>规则：{{ data.reviewedBaseline.ruleVersion }} · 生效：{{ data.reviewedBaseline.effectiveAt }} · 登记：{{ data.reviewedBaseline.recordedAt }}</p>
      </div>
      <EvidenceImpactSources :impact-id="data.id" :enterprise-id="data.enterpriseId" />
      <DecisionHistory v-if="data.oldDecision && !data.gaps.decisionUnavailable && data.lineage !== 'merged'" :scope="{ enterpriseId: data.enterpriseId, titleCode: data.titleCode, direction: data.direction }" />
      <EvidenceReviewForm :detail="data" :refreshing="isLoading || !!error" @reload="refetch()" @saved="emit('saved')" />
    </template>
    <Button v-else-if="!isLoading && !error" variant="outline" @click="refetch()">读取复核项</Button>
  </div>
</template>
