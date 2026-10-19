<script setup lang="ts">
import { computed } from 'vue'
import type { ImpactRow, ReviewAssessment } from '~~/lib/roster/evidence-review-ui'
import { directionLabel, titleLabel } from '~~/lib/roster/review-display'
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
      </SheetHeader>

      <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <template v-if="resolvedImpactId">
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
