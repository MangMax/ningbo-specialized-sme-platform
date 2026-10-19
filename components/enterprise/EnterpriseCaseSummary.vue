<script setup lang="ts">
import { computed } from 'vue'
import type { ImpactRow, ReviewAssessment, ReviewScope } from '~~/lib/roster/evidence-review-ui'
import { impactClassificationLabels } from '~~/lib/roster/evidence-review-ui'
import {
  enterpriseHeadline,
  impactOldDecisionText,
  impactScopeLabel,
  type CaseTone,
} from '~~/lib/roster/review-display'
import AssessmentStatusBadge from '@/components/evidence-review/AssessmentStatusBadge.vue'
import { Button } from '@/components/ui/button'

const props = defineProps<{
  assessments: (ReviewAssessment & ReviewScope)[]
  pending: ImpactRow[]
  pendingHasMore: boolean
  pendingLoading: boolean
  pendingError: boolean
}>()

const emit = defineEmits<{
  'open-impact': [row: ImpactRow]
  'open-scope': [assessment: ReviewAssessment & ReviewScope]
  'retry-pending': []
}>()

const headline = computed(() => enterpriseHeadline(props.assessments, {
  rows: props.pending,
  hasMore: props.pendingHasMore,
  loading: props.pendingLoading,
  error: props.pendingError,
}))

const firstPending = computed(() => props.pending[0] ?? null)

const toneBorder: Record<CaseTone, string> = {
  action: 'border-l-primary',
  failed: 'border-l-destructive',
  waiting: 'border-l-warning',
  done: 'border-l-primary',
  muted: 'border-l-border',
}
const toneDot: Record<CaseTone, string> = {
  action: 'bg-primary',
  failed: 'bg-destructive',
  waiting: 'bg-warning',
  done: 'bg-primary',
  muted: 'bg-muted-foreground/50',
}

/** 主操作只做已有能力：打开第一项复核，或打开第一个需要看依据的范围。 */
function primaryAction() {
  if (firstPending.value) {
    emit('open-impact', firstPending.value)
    return
  }
  if (headline.value.action === '重试读取待复核清单') {
    emit('retry-pending')
    return
  }
  const ordered = [
    ...props.assessments.filter(item => item.queryCoverage.status === 'failed' || item.queryCoverage.status === 'partial'),
    ...props.assessments.filter(item => item.assessment === 'queried_unjudged'),
    ...props.assessments.filter(item => item.assessment === 'decided'),
    ...props.assessments.filter(item => item.assessment === 'unknown'),
    ...props.assessments.filter(item => item.assessment === 'withdrawn'),
    ...props.assessments,
  ]
  if (ordered[0]) emit('open-scope', ordered[0])
}

const visiblePending = computed(() => props.pending.slice(0, 3))
const hiddenPending = computed(() => Math.max(0, props.pending.length - visiblePending.value.length))
</script>

<template>
  <section
    class="bg-card min-w-0 overflow-hidden rounded-lg border border-l-4"
    :class="toneBorder[headline.tone]"
    data-testid="enterprise-case-summary"
  >
    <div class="flex min-w-0 flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div class="min-w-0">
        <p class="text-muted-foreground flex items-center gap-1.5 text-xs font-medium tracking-wide">
          <span class="size-1.5 rounded-full" :class="toneDot[headline.tone]" aria-hidden="true" />
          当前状态
        </p>
        <h2 class="mt-1 text-xl leading-7 font-semibold tracking-tight">{{ headline.label }}</h2>
        <p class="text-muted-foreground mt-1 text-sm leading-6">{{ headline.detail }}</p>
        <p v-if="firstPending" class="mt-2 text-sm leading-6">
          <span class="text-muted-foreground">先处理：</span>
          {{ impactScopeLabel(firstPending) }}
          <span class="text-muted-foreground"> · </span>
          {{ impactClassificationLabels[firstPending.classification] ?? '证据变化' }}
        </p>
        <p v-else-if="pendingError" class="text-destructive mt-2 text-[13px] leading-5">
          待复核清单读取失败；这不代表没有待处理项。
        </p>
      </div>
      <Button size="sm" class="shrink-0 self-start sm:self-center" @click="primaryAction">
        {{ headline.action }}
      </Button>
    </div>

    <ul v-if="visiblePending.length" class="divide-y border-t" aria-label="待处理复核项">
      <li
        v-for="row in visiblePending"
        :key="row.id"
        class="flex min-w-0 flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-between"
      >
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-1.5">
            <span class="text-sm font-medium">{{ impactScopeLabel(row) }}</span>
            <AssessmentStatusBadge kind="impact" :value="row.classification" />
            <span class="text-muted-foreground text-[13px]">
              {{ row.pending ? '待处理' : '已登记复核' }}
            </span>
          </div>
          <p class="text-muted-foreground mt-0.5 text-[13px] leading-5">
            {{ impactOldDecisionText(row) }}
          </p>
        </div>
        <Button variant="outline" size="sm" class="shrink-0 self-start sm:self-center" @click="emit('open-impact', row)">
          核对这一项
        </Button>
      </li>
    </ul>

    <p
      v-if="hiddenPending"
      class="text-muted-foreground border-t px-5 py-2 text-[13px]"
    >
      另有 {{ hiddenPending }} 项待处理，可在待复核队列中查看。
    </p>
  </section>
</template>
