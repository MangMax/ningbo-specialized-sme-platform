<script setup lang="ts">
import { computed, nextTick, shallowRef, watch } from 'vue'
import type { ImpactRow, ReviewAssessment, ReviewScope } from '~~/lib/roster/evidence-review-ui'
import { impactClassificationLabels } from '~~/lib/roster/evidence-review-ui'
import { TITLE_ORDER, comparisonDirectionLabel } from '~~/lib/labels'
import {
  assessmentHeadline,
  decisionMeasureLabel,
  decisionReasonLabel,
  titleLabel,
} from '~~/lib/roster/review-display'
import QueryAssessmentSummary from './QueryAssessmentSummary.vue'
import DecisionHistory from './DecisionHistory.vue'
import EvidenceReviewList from './EvidenceReviewList.vue'
import AssessmentStatusBadge from './AssessmentStatusBadge.vue'
import EnterpriseEvidenceSheet from '@/components/enterprise/EnterpriseEvidenceSheet.vue'
import TitleBadge from '@/components/TitleBadge.vue'
import { Button } from '@/components/ui/button'
import { ChevronRight } from '@lucide/vue'

const props = withDefaults(defineProps<{
  enterpriseId: number
  assessments: (ReviewAssessment & ReviewScope)[]
  titleCode?: string
  direction?: string
  impactId?: number
  locate?: boolean
  pending?: ImpactRow[]
  embedded?: boolean
  openScopeRequest?: { titleCode: string; direction: string } | null
}>(), {
  pending: () => [],
  embedded: false,
  openScopeRequest: null,
})

const emit = defineEmits<{ saved: [] }>()

const DIRECTIONS = ['missing_in_miit', 'extra_in_miit'] as const
const historyScope = shallowRef<string | null>(null)
const expandedKey = shallowRef<string | null>(null)
const showReviews = shallowRef(false)
const reviewGeneration = shallowRef(0)

const keyOf = (scope: ReviewScope) => `${scope.titleCode}-${scope.direction}`
const pendingByScope = computed(() => {
  const map = new Map<string, ImpactRow>()
  for (const row of props.pending) map.set(keyOf(row), row)
  return map
})

const orderedTitles = computed(() => {
  const present = new Set(props.assessments.map(item => item.titleCode))
  return [
    ...TITLE_ORDER.filter(code => present.has(code)),
    ...[...present].filter(code => !TITLE_ORDER.includes(code)),
  ]
})

const groups = computed(() => orderedTitles.value.map(titleCode => ({
  titleCode,
  byDirection: Object.fromEntries(DIRECTIONS.map(direction => [
    direction,
    props.assessments.find(item => item.titleCode === titleCode && item.direction === direction),
  ])) as Record<(typeof DIRECTIONS)[number], (ReviewAssessment & ReviewScope) | undefined>,
})))

const sheetOpen = shallowRef(false)
const selectedAssessment = shallowRef<(ReviewAssessment & ReviewScope) | undefined>()
const selectedImpact = shallowRef<ImpactRow | null>(null)
const selectedImpactId = shallowRef<number | undefined>()
const selectedTitle = shallowRef('')
const selectedDirection = shallowRef('')

function openScope(assessment: ReviewAssessment & ReviewScope) {
  const pending = pendingByScope.value.get(keyOf(assessment)) ?? null
  selectedAssessment.value = assessment
  selectedImpact.value = pending
  selectedImpactId.value = pending?.id
  selectedTitle.value = assessment.titleCode
  selectedDirection.value = assessment.direction
  if (props.embedded) {
    const key = keyOf(assessment)
    expandedKey.value = expandedKey.value === key ? null : key
    return
  }
  sheetOpen.value = true
}

function openImpact(row: ImpactRow) {
  selectedImpact.value = row
  selectedImpactId.value = row.id
  selectedAssessment.value = props.assessments.find(item => item.titleCode === row.titleCode && item.direction === row.direction)
  selectedTitle.value = row.titleCode
  selectedDirection.value = row.direction
  sheetOpen.value = true
}

function onSaved() {
  reviewGeneration.value++
  emit('saved')
}

watch(() => [props.enterpriseId, props.titleCode, props.direction, props.assessments, props.locate] as const, async () => {
  if (props.locate === false) return
  if (!props.titleCode || !props.direction) return
  await nextTick()
  if (typeof document !== 'undefined') {
    document.getElementById(`explanation-${props.titleCode}-${props.direction}`)?.scrollIntoView?.({ block: 'start' })
  }
}, { immediate: true })

/** 首屏“查看尚未判断项 / 查看范围”打开对应范围的证据抽屉。 */
watch(() => props.openScopeRequest, request => {
  if (!request || props.embedded) return
  const assessment = props.assessments.find(item => item.titleCode === request.titleCode && item.direction === request.direction)
  if (!assessment) return
  const pending = pendingByScope.value.get(keyOf(assessment)) ?? null
  selectedAssessment.value = assessment
  selectedImpact.value = pending
  selectedImpactId.value = pending?.id
  selectedTitle.value = assessment.titleCode
  selectedDirection.value = assessment.direction
  sheetOpen.value = true
}, { immediate: true })

/** 深链 impactId：即使它不在待复核清单里，也打开对应范围的证据详情。 */
watch(() => props.impactId, impactId => {
  if (!impactId || props.embedded) return
  const row = props.pending.find(item => item.id === impactId) ?? null
  const titleCode = row?.titleCode ?? props.titleCode ?? ''
  const direction = row?.direction ?? props.direction ?? ''
  if (!titleCode || !direction) return
  selectedImpact.value = row
  selectedImpactId.value = impactId
  selectedAssessment.value = props.assessments.find(item => item.titleCode === titleCode && item.direction === direction)
  selectedTitle.value = titleCode
  selectedDirection.value = direction
  sheetOpen.value = true
}, { immediate: true })
</script>

<template>
  <section class="flex min-w-0 flex-col gap-3" aria-label="称号核对">
    <header class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <div class="min-w-0">
        <h2 class="text-sm font-semibold">称号核对</h2>
        <p class="text-muted-foreground text-[13px] leading-5">
          同一称号的两个方向分开判断；状态只反映查询事实与已有决定。
        </p>
      </div>
      <span class="text-muted-foreground text-[13px]">共 {{ assessments.length }} 个判断范围</span>
    </header>

    <div class="bg-card overflow-hidden rounded-lg border">
      <div class="bg-muted/40 text-muted-foreground hidden border-b px-4 py-2 text-xs font-medium md:grid md:grid-cols-[12rem_minmax(0,1fr)_minmax(0,1fr)] md:gap-3">
        <span>称号</span>
        <span>应纳未纳</span>
        <span>平台多出</span>
      </div>

      <div v-for="group in groups" :key="group.titleCode" class="border-b last:border-b-0">
        <div class="grid grid-cols-1 md:grid-cols-[12rem_minmax(0,1fr)_minmax(0,1fr)]">
          <div class="bg-muted/20 flex flex-wrap items-center gap-2 border-b px-4 py-3 md:border-r md:border-b-0">
            <TitleBadge :code="group.titleCode" />
            <span class="text-muted-foreground text-[13px]">
              {{ Object.values(group.byDirection).filter(Boolean).length }} 个方向
            </span>
          </div>

          <template v-for="direction in DIRECTIONS" :key="`${group.titleCode}-${direction}`">
            <article
              v-if="group.byDirection[direction]"
              :id="`explanation-${group.titleCode}-${direction}`"
              data-testid="assessment-scope"
              class="min-w-0 scroll-mt-20 border-b px-4 py-3 md:border-r md:border-b-0 md:last:border-r-0"
            >
              <button
                type="button"
                class="hover:bg-accent/50 focus-visible:ring-ring/50 -m-1 flex w-[calc(100%+0.5rem)] min-w-0 flex-col gap-1.5 rounded-sm p-1 text-left transition-colors focus-visible:ring-3 focus-visible:outline-none"
                :aria-label="`查看${titleLabel(group.titleCode)} · ${comparisonDirectionLabel(direction)}的核对依据`"
                @click="openScope(group.byDirection[direction]!)"
              >
                <span class="flex min-w-0 items-start justify-between gap-2">
                  <span class="flex flex-wrap items-center gap-1.5">
                    <AssessmentStatusBadge kind="coverage" :value="group.byDirection[direction]!.queryCoverage.status" />
                    <AssessmentStatusBadge kind="assessment" :value="group.byDirection[direction]!.assessment" />
                    <AssessmentStatusBadge
                      v-if="group.byDirection[direction]!.explanationValidity.status !== 'not_applicable'"
                      kind="validity"
                      :value="group.byDirection[direction]!.explanationValidity.status"
                    />
                    <AssessmentStatusBadge
                      v-if="pendingByScope.get(`${group.titleCode}-${direction}`)"
                      kind="impact"
                      :value="pendingByScope.get(`${group.titleCode}-${direction}`)!.classification"
                    />
                  </span>
                  <ChevronRight class="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden="true" />
                </span>

                <span class="text-foreground text-sm leading-5 font-medium">
                  {{ assessmentHeadline(group.byDirection[direction]!).label }}
                </span>
                <span class="text-muted-foreground text-[13px] leading-5">
                  {{ assessmentHeadline(group.byDirection[direction]!).detail }}
                </span>

                <span
                  v-if="group.byDirection[direction]!.currentDecision.current"
                  class="text-[13px] leading-5"
                >
                  {{ decisionReasonLabel(group.byDirection[direction]!) }}
                </span>
                <span
                  v-if="decisionMeasureLabel(group.byDirection[direction]!)"
                  class="text-muted-foreground text-[13px] leading-5"
                >
                  {{ decisionMeasureLabel(group.byDirection[direction]!) }}
                </span>

                <span
                  v-if="pendingByScope.get(`${group.titleCode}-${direction}`)"
                  class="text-warning text-[13px] leading-5"
                >
                  待处理 · {{ impactClassificationLabels[pendingByScope.get(`${group.titleCode}-${direction}`)!.classification] ?? '证据变化' }}
                </span>
              </button>

              <div v-if="embedded && expandedKey === `${group.titleCode}-${direction}`" class="mt-3 border-t pt-3">
                <QueryAssessmentSummary :assessment="group.byDirection[direction]!" />
                <Button
                  variant="ghost"
                  size="sm"
                  class="mt-2 self-start"
                  @click="historyScope = historyScope === `${group.titleCode}-${direction}` ? null : `${group.titleCode}-${direction}`"
                >
                  {{ historyScope === `${group.titleCode}-${direction}` ? '收起决定历史' : '查看决定历史' }}
                </Button>
                <DecisionHistory
                  v-if="historyScope === `${group.titleCode}-${direction}`"
                  :key="`${group.titleCode}-${direction}`"
                  :scope="{ enterpriseId, titleCode: group.titleCode, direction }"
                />
              </div>
            </article>
            <div v-else class="text-muted-foreground border-b px-4 py-3 text-[13px] md:border-r md:border-b-0 md:last:border-r-0">
              此方向暂无核对范围
            </div>
          </template>
        </div>
      </div>
    </div>

    <p class="text-muted-foreground text-[13px] leading-5">
      查询覆盖、业务决定和解释有效性分别保留；待复核不会撤回原决定。
      查询完成、覆盖完整或未发现差异，都不自动等于“一致 / 无需处理”。
    </p>

    <template v-if="!embedded">
      <Button variant="ghost" size="sm" class="self-start" :aria-expanded="showReviews" @click="showReviews = !showReviews">
        {{ showReviews ? '收起企业复核记录' : '查看企业全部复核记录' }}
      </Button>
      <EvidenceReviewList
        v-if="showReviews"
        :key="reviewGeneration"
        :enterprise-id="enterpriseId"
        :title-code="titleCode"
        :direction="direction"
      />
    </template>

    <EnterpriseEvidenceSheet
      v-if="!embedded"
      v-model:open="sheetOpen"
      :enterprise-id="enterpriseId"
      :title-code="selectedTitle"
      :direction="selectedDirection"
      :assessment="selectedAssessment"
      :impact="selectedImpact"
      :impact-id="selectedImpactId"
      @saved="onSaved"
    />
  </section>
</template>
