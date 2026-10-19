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
const props = defineProps<{ impactId: number }>()
const { data, isLoading, error, refetch } = useQuery({ key: () => ['evidence-impact', props.impactId], query: () => $fetch<ImpactDetail>(`/api/roster/evidence-impacts/${props.impactId}`) })
</script>
<template>
  <div class="flex min-w-0 flex-col gap-3 border-t pt-3">
    <p v-if="isLoading" role="status">正在读取当前决定和证据版本…</p>
    <TableFailureState v-if="error" title="复核详情读取失败" :pending="isLoading" @retry="refetch()" />
    <template v-if="data">
      <DecisionVersionDetails :decision="data.oldDecision" label="原决定" />
      <DecisionVersionDetails v-if="data.currentDecision?.current && data.currentDecision.current.id !== data.oldDecision.id" :decision="data.currentDecision.current" label="当前决定" />
      <p>当前决定 #{{ data.currentDecision?.versionId ?? '无' }} · {{ data.pending ? '待复核' : '已复核' }} · 证据修订 #{{ data.evidenceToken.latestRevisionId }}</p>
      <p v-if="data.gaps.subjectUnknown">主体未确认，不能推断为零记录。</p>
      <QueryCoverageDetails v-if="data.queryCoverage" :coverage="data.queryCoverage" />
      <EvidenceImpactSources :impact-id="data.id" :enterprise-id="data.enterpriseId" />
      <DecisionHistory :scope="{ enterpriseId: data.enterpriseId, titleCode: data.titleCode, direction: data.direction }" />
      <EvidenceReviewForm :detail="data" :refreshing="isLoading || !!error" @reload="refetch()" @saved="refetch()" />
    </template>
    <Button v-else-if="!isLoading && !error" variant="outline" @click="refetch()">读取复核项</Button>
  </div>
</template>
