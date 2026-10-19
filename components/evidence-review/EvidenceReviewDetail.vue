<script setup lang="ts">
import { useEvidenceReviewRefresh } from '~/composables/useEvidenceReviewRefresh'
import { useQuery } from '@pinia/colada'
import type { ImpactDetail } from '~~/lib/roster/evidence-review-ui'
import { impactClassificationLabels, lineageLabels } from '~~/lib/roster/evidence-review-ui'
import { reviewTimeLabel, titleLabel, directionLabel } from '~~/lib/roster/review-display'
import EvidenceImpactSources from './EvidenceImpactSources.vue'
import EvidenceReviewForm from './EvidenceReviewForm.vue'
import QueryCoverageDetails from './QueryCoverageDetails.vue'
import DecisionVersionDetails from './DecisionVersionDetails.vue'
import DecisionHistory from './DecisionHistory.vue'
import AssessmentStatusBadge from './AssessmentStatusBadge.vue'
import TableFailureState from '@/components/TableFailureState.vue'

const emit = defineEmits<{ saved: [] }>()
const refreshAffected = useEvidenceReviewRefresh()
const props = defineProps<{ impactId: number; enterpriseId?: number }>()
const { data, isLoading, error, refetch } = useQuery({ key: () => ['evidence-impact', props.impactId], query: () => $fetch<ImpactDetail>(`/api/roster/evidence-impacts/${props.impactId}`) })
async function reloadCurrent() {
  await refreshAffected()
  await refetch()
}
</script>

<template>
  <div class="flex min-w-0 flex-col gap-3 border-t pt-3">
    <div v-if="isLoading && !data" class="flex flex-col gap-2" role="status" aria-label="正在读取复核详情">
      <span class="bg-muted h-5 w-56 animate-pulse rounded-sm" />
      <span class="bg-muted h-24 w-full animate-pulse rounded-sm" />
      <span class="bg-muted h-16 w-full animate-pulse rounded-sm" />
    </div>

    <TableFailureState
      v-if="error"
      title="复核详情读取失败"
      :description="`读取目标：复核项 #${impactId}。已加载的复核项仍保留；重试只读取当前目标。`"
      :pending="isLoading"
      @retry="refetch()"
    />

    <p v-if="data && enterpriseId != null && data.enterpriseId !== enterpriseId" role="alert" class="text-destructive text-[13px] leading-5">
      该复核项不属于当前企业。请从清单选择准确坐标。
    </p>

    <template v-else-if="data">
      <header class="flex min-w-0 flex-col gap-1.5">
        <div class="flex flex-wrap items-center gap-1.5">
          <h3 class="text-sm font-semibold">复核项 #{{ data.id }}</h3>
          <AssessmentStatusBadge kind="impact" :value="data.classification" />
          <AssessmentStatusBadge kind="lineage" :value="data.lineage" />
          <span class="text-muted-foreground text-[13px]">{{ data.pending ? '待复核' : '已登记复核' }}</span>
        </div>
        <p class="text-muted-foreground text-[13px] leading-5">
          {{ titleLabel(data.titleCode) }} · {{ directionLabel(data.direction) }} ·
          {{ impactClassificationLabels[data.classification] ?? '证据变化' }}
        </p>
      </header>

      <div class="grid min-w-0 gap-3 sm:grid-cols-2">
        <section v-if="data.oldDecision" class="bg-card min-w-0 rounded-md border p-3">
          <DecisionVersionDetails :decision="data.oldDecision" label="原决定" />
        </section>
        <section
          v-if="data.currentDecision?.current && data.oldDecision && data.currentDecision.current.id !== data.oldDecision.id"
          class="bg-card min-w-0 rounded-md border p-3"
        >
          <DecisionVersionDetails :decision="data.currentDecision.current" label="当前决定" />
        </section>
      </div>

      <div
        v-if="data.gaps.decisionUnavailable || !data.oldDecision"
        class="bg-destructive/5 border-destructive/30 rounded-md border px-3 py-2.5 text-[13px] leading-5"
        data-testid="decision-unavailable"
      >
        <p class="text-foreground font-medium">历史决定原文不可用</p>
        <p class="text-muted-foreground mt-0.5">
          原决定 #{{ data.decisionId }} · 企业 #{{ data.enterpriseId }} · {{ titleLabel(data.titleCode) }} ·
          {{ directionLabel(data.direction) }} 的历史坐标和来源仍保留；不替代为其他企业或幸存者的决定。
        </p>
      </div>

      <p v-if="data.gaps.subjectUnknown" class="text-warning text-[13px] leading-5">
        主体未确认，不能推断为零记录。
      </p>

      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] leading-5">
        <span>
          当前决定：
          <strong>{{ data.currentDecision?.versionId != null ? `#${data.currentDecision.versionId}` : '无' }}</strong>
        </span>
        <span class="text-muted-foreground">本复核项{{ data.pending ? '待复核' : '已复核' }}</span>
        <span class="text-muted-foreground">证据版本已更新</span>
      </div>

      <details class="text-muted-foreground text-[13px] leading-5">
        <summary class="cursor-pointer select-none">技术详情</summary>
        <p class="mt-1 break-words">
          复核项 #{{ data.id }} · 决定 #{{ data.decisionId }} · 当前版本 #{{ data.currentDecision?.versionId ?? '无' }} ·
          证据修订 #{{ data.evidenceToken.latestRevisionId }} · 投影
          {{ data.evidenceToken.projectionReady ? '就绪' : '未就绪' }} · 来源
          {{ data.lineage }}
        </p>
      </details>

      <QueryCoverageDetails v-if="data.queryCoverage" :coverage="data.queryCoverage" />

      <section
        v-if="data.reviewedBaseline"
        data-testid="reviewed-baseline"
        class="bg-muted/20 flex min-w-0 flex-col gap-1 rounded-md border px-3 py-2.5 text-[13px] leading-5"
      >
        <h4 class="text-sm font-medium">已登记的证据复核</h4>
        <p>复核至修订 #{{ data.reviewedBaseline.reviewedRevisionId }} · {{ data.reviewedBaseline.actor.type === 'agent' ? '代理' : '人工' }} · {{ data.reviewedBaseline.actor.id }}</p>
        <p>复核依据：{{ data.reviewedBaseline.basis }}</p>
        <p>
          规则：{{ data.reviewedBaseline.ruleVersion }} ·
          生效：{{ reviewTimeLabel(data.reviewedBaseline.effectiveAt) }} ·
          登记：{{ reviewTimeLabel(data.reviewedBaseline.recordedAt) }}
        </p>
        <details class="text-muted-foreground">
          <summary class="cursor-pointer select-none">技术详情</summary>
          <p class="mt-1 break-words">
            生效时间（原始）：{{ data.reviewedBaseline.effectiveAt }} ·
            登记时间（原始）：{{ data.reviewedBaseline.recordedAt }}
          </p>
        </details>
      </section>

      <EvidenceImpactSources :impact-id="data.id" :enterprise-id="data.enterpriseId" />

      <DecisionHistory
        v-if="data.oldDecision && !data.gaps.decisionUnavailable && data.lineage !== 'merged'"
        :scope="{ enterpriseId: data.enterpriseId, titleCode: data.titleCode, direction: data.direction }"
      />

      <EvidenceReviewForm :detail="data" :refreshing="isLoading || !!error" @reload="reloadCurrent" @saved="emit('saved')" />
    </template>

    <button v-else-if="!isLoading && !error" type="button" class="text-primary self-start text-[13px] hover:underline" @click="refetch()">
      读取复核项
    </button>
  </div>
</template>
