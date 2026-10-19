<script setup lang="ts">
import { computed, nextTick, shallowRef, watch } from 'vue'
import type { ReviewAssessment, ReviewScope } from '~~/lib/roster/evidence-review-ui'
import { TITLES, comparisonDirectionLabel } from '~~/lib/labels'
import QueryAssessmentSummary from './QueryAssessmentSummary.vue'
import DecisionHistory from './DecisionHistory.vue'
import EvidenceReviewList from './EvidenceReviewList.vue'
import EvidenceReviewDetail from './EvidenceReviewDetail.vue'
import { Button } from '@/components/ui/button'
const props = defineProps<{ enterpriseId: number; assessments: (ReviewAssessment & ReviewScope)[]; titleCode?: string; direction?: string; impactId?: number; locate?: boolean }>()
const historyScope = shallowRef<string | null>(null)
const showReviews = shallowRef(false)
const reviewGeneration = shallowRef(0)
const ordered = computed(() => [...props.assessments].sort((a, b) => Number(b.titleCode === props.titleCode && b.direction === props.direction) - Number(a.titleCode === props.titleCode && a.direction === props.direction)))
const key = (a: ReviewScope) => `${a.titleCode}-${a.direction}`
watch(() => [props.enterpriseId, props.titleCode, props.direction, props.assessments], async () => {
  if (props.locate === false) return
  if (!props.titleCode || !props.direction) return
  await nextTick()
  if (typeof document !== 'undefined') document.getElementById(`explanation-${props.titleCode}-${props.direction}`)?.scrollIntoView?.({ block: 'start' })
}, { immediate: true })
</script>
<template>
  <section class="flex min-w-0 flex-col gap-3" aria-label="查询覆盖与解释">
    <h2 class="text-sm font-medium">查询覆盖与解释</h2>
    <p class="text-muted-foreground text-[13px]">查询执行范围、业务决定和解释有效性分别保留。待复核不会撤回原决定。</p>
    <ul class="flex flex-col gap-3">
      <li v-for="assessment in ordered" :id="`explanation-${key(assessment)}`" :key="key(assessment)" data-testid="assessment-scope" class="flex min-w-0 scroll-mt-4 flex-col gap-2 border-t pt-3">
        <h3 class="text-[13px] font-medium">{{ TITLES[assessment.titleCode] ?? assessment.titleCode }} · {{ comparisonDirectionLabel(assessment.direction) }}</h3>
        <QueryAssessmentSummary :assessment="assessment" />
        <Button variant="ghost" size="sm" class="self-start" @click="historyScope = historyScope === key(assessment) ? null : key(assessment)">查看决定历史</Button>
        <DecisionHistory v-if="historyScope === key(assessment)" :key="key(assessment)" :scope="{ enterpriseId, titleCode: assessment.titleCode, direction: assessment.direction }" />
      </li>
    </ul>
    <EvidenceReviewDetail v-if="impactId" :key="impactId" :impact-id="impactId" :enterprise-id="enterpriseId" @saved="reviewGeneration++" />
    <Button variant="outline" class="self-start" :aria-expanded="showReviews" @click="showReviews = !showReviews">{{ showReviews ? '收起企业复核清单' : '查看企业待复核清单' }}</Button>
    <EvidenceReviewList v-if="showReviews" :key="reviewGeneration" :enterprise-id="enterpriseId" :title-code="titleCode" :direction="direction" />
  </section>
</template>
