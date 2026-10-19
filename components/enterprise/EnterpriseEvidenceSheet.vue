<script setup lang="ts">
import { computed } from 'vue'
import type { ImpactRow, ReviewAssessment } from '~~/lib/roster/evidence-review-ui'
import {
  assessmentHeadline,
  directionLabel,
  titleLabel,
} from '~~/lib/roster/review-display'
import AssessmentStatusBadge from '@/components/evidence-review/AssessmentStatusBadge.vue'
import QueryAssessmentSummary from '@/components/evidence-review/QueryAssessmentSummary.vue'
import DecisionHistory from '@/components/evidence-review/DecisionHistory.vue'
import EvidenceReviewDetail from '@/components/evidence-review/EvidenceReviewDetail.vue'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'

const open = defineModel<boolean>('open', { required: true })

const props = defineProps<{
  enterpriseId: number
  titleCode: string
  direction: string
  assessment?: ReviewAssessment
  impact?: ImpactRow | null
  impactId?: number
}>()

const emit = defineEmits<{ saved: [] }>()

const headline = computed(() => props.assessment ? assessmentHeadline(props.assessment) : null)
const resolvedImpactId = computed(() => props.impact?.id ?? props.impactId)
</script>

<template>
  <Sheet v-model:open="open">
    <SheetContent side="right" class="w-full gap-0 p-0 sm:max-w-[560px]">
      <SheetHeader class="border-b px-5 py-4 pr-12">
        <SheetTitle class="text-base">{{ titleLabel(titleCode) }} · {{ directionLabel(direction) }}</SheetTitle>
        <SheetDescription class="text-[13px] leading-5">
          核对依据、当前决定与证据复核。查询覆盖、业务决定和解释有效性分别保留。
        </SheetDescription>
        <div class="flex flex-wrap items-center gap-1.5 pt-1">
          <AssessmentStatusBadge
            v-if="impact"
            kind="impact"
            :value="impact.classification"
          />
          <template v-else-if="assessment">
            <AssessmentStatusBadge kind="coverage" :value="assessment.queryCoverage.status" />
            <AssessmentStatusBadge kind="assessment" :value="assessment.assessment" />
            <AssessmentStatusBadge
              v-if="assessment.explanationValidity.status !== 'not_applicable'"
              kind="validity"
              :value="assessment.explanationValidity.status"
            />
          </template>
          <span v-if="headline" class="text-muted-foreground text-[13px] leading-5">{{ headline.label }}</span>
        </div>
      </SheetHeader>

      <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <template v-if="resolvedImpactId">
          <p class="text-muted-foreground mb-3 text-[13px] leading-5">
            该复核项{{ impact?.pending === false ? '已登记复核' : '待处理' }}；原决定保留在历史中，维持不会改写原原因或措施。
          </p>
          <EvidenceReviewDetail
            :key="resolvedImpactId"
            :impact-id="resolvedImpactId"
            :enterprise-id="enterpriseId"
            @saved="emit('saved')"
          />
        </template>

        <template v-else-if="assessment">
          <QueryAssessmentSummary :assessment="assessment" />
          <section class="mt-4 border-t pt-3">
            <DecisionHistory :scope="{ enterpriseId, titleCode, direction }" />
          </section>
          <p class="text-muted-foreground mt-4 border-t pt-3 text-[13px] leading-5">
            查询完成、覆盖完整或未发现差异，都不自动等于“一致 / 无需处理”。
            证据变化后原决定保留待复核；更正必须由人工明确追加。
          </p>
        </template>
      </div>
    </SheetContent>
  </Sheet>
</template>
