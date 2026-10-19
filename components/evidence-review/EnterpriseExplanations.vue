<script setup lang="ts">
import { computed, nextTick, shallowRef, watch } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import type { ImpactRow, ReviewAssessment, ReviewScope } from '~~/lib/roster/evidence-review-ui'
import { TITLE_ORDER } from '~~/lib/labels'
import {
  assessmentHeadline,
  decisionMeasureLabel,
  decisionReasonLabel,
  directionLabel,
  titleLabel,
} from '~~/lib/roster/review-display'
import EvidenceReviewList from './EvidenceReviewList.vue'
import AssessmentStatusBadge from './AssessmentStatusBadge.vue'
import EnterpriseEvidenceSheet from '@/components/enterprise/EnterpriseEvidenceSheet.vue'
import DisclosurePanel from '@/components/DisclosurePanel.vue'
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
  openScopeRequest?: { titleCode: string; direction: string } | null
}>(), {
  pending: () => [],
  openScopeRequest: null,
})

const emit = defineEmits<{ saved: [] }>()

const DIRECTIONS = ['missing_in_miit', 'extra_in_miit'] as const
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

/**
 * 390 只先摊开需要看的方向；“尚未核对”的其余方向折成一条。
 * 桌面不受影响，六个判断范围仍然全部可扫描。
 */
const isNarrow = useMediaQuery('(max-width: 767px)')
const showQuiet = shallowRef(false)
const isQuiet = (assessment: ReviewAssessment & ReviewScope) =>
  assessment.assessment === 'not_queried' && !pendingByScope.value.get(keyOf(assessment))
const hiddenQuietCount = computed(() => isNarrow.value
  ? props.assessments.filter(item => isQuiet(item)).length
  : 0)
const visibleDirections = (group: (typeof groups.value)[number]) => {
  if (!isNarrow.value || showQuiet.value) return DIRECTIONS
  return DIRECTIONS.filter(direction => {
    const assessment = group.byDirection[direction]
    return assessment != null && !isQuiet(assessment)
  })
}
const visibleGroups = computed(() => isNarrow.value && !showQuiet.value
  ? groups.value.filter(group => visibleDirections(group).length > 0)
  : groups.value)

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
  if (!request) return
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
  if (!impactId) return
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
        <p class="text-muted-foreground max-w-[46ch] text-[13px] leading-5">
          徽标深浅 = 称号等级（高 → 低）；两方向分开判断。
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

      <div v-for="group in visibleGroups" :key="group.titleCode" class="border-b last:border-b-0">
        <div class="grid grid-cols-1 md:grid-cols-[12rem_minmax(0,1fr)_minmax(0,1fr)]">
          <div class="bg-muted/20 flex flex-wrap items-center gap-2 border-b px-4 py-3 md:border-r md:border-b-0">
            <TitleBadge :code="group.titleCode" />
            <span class="text-muted-foreground text-[13px]">
              {{ Object.values(group.byDirection).filter(Boolean).length }} 个方向
            </span>
          </div>

          <template v-for="direction in visibleDirections(group)" :key="`${group.titleCode}-${direction}`">
            <article
              v-if="group.byDirection[direction]"
              :id="`explanation-${group.titleCode}-${direction}`"
              data-testid="assessment-scope"
              class="min-w-0 scroll-mt-20 border-b px-4 py-3 md:border-r md:border-b-0 md:last:border-r-0"
            >
              <button
                type="button"
                class="hover:bg-accent/50 focus-visible:ring-ring/50 -m-1 flex w-[calc(100%+0.5rem)] min-w-0 flex-col gap-1.5 rounded-sm p-1 text-left transition-colors focus-visible:ring-3 focus-visible:outline-none"
                :aria-label="`查看${titleLabel(group.titleCode)} · ${directionLabel(direction)}的核对依据`"
                @click="openScope(group.byDirection[direction]!)"
              >
                <!--
                  390 / 720 下两方向上下堆叠，列头消失；每个方向块必须自己带可见方向标签，
                  不能只靠 aria-label，否则两块卡片视觉同构。
                -->
                <span class="flex items-center gap-1.5 text-[13px] leading-5 font-medium md:hidden" data-testid="direction-label">
                  <span
                    class="size-1.5 shrink-0 rounded-full"
                    :class="direction === 'missing_in_miit' ? 'bg-warning' : 'bg-primary'"
                    aria-hidden="true"
                  />
                  {{ directionLabel(direction) }}
                </span>
                <span class="flex min-w-0 items-start justify-between gap-2">
                  <span class="flex flex-wrap items-center gap-1.5">
                    <AssessmentStatusBadge kind="coverage" :value="group.byDirection[direction]!.queryCoverage.status" />
                    <AssessmentStatusBadge
                      v-if="group.byDirection[direction]!.explanationValidity.status !== 'not_applicable'"
                      kind="validity"
                      :value="group.byDirection[direction]!.explanationValidity.status"
                    />
                    <!-- 「证据变化」已由解释有效性 chip 表达；这里只在前提失效时补充不同事实。 -->
                    <AssessmentStatusBadge
                      v-if="pendingByScope.get(`${group.titleCode}-${direction}`)?.classification === 'premise_invalid'"
                      kind="impact"
                      :value="'premise_invalid'"
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
              </button>
            </article>
            <div v-else class="text-muted-foreground border-b px-4 py-3 text-[13px] md:border-r md:border-b-0 md:last:border-r-0">
              此方向暂无核对范围
            </div>
          </template>
        </div>
      </div>
    </div>

    <div v-if="!visibleGroups.length" class="bg-card text-muted-foreground rounded-lg border px-4 py-4 text-[13px] leading-5">
      {{ isNarrow ? '其余方向尚未核对；展开后可逐项查看范围。' : '没有可显示的核对范围。' }}
    </div>

    <Button
      v-if="isNarrow && hiddenQuietCount"
      variant="ghost"
      size="sm"
      class="self-start"
      :aria-expanded="showQuiet"
      @click="showQuiet = !showQuiet"
    >
      {{ showQuiet ? '收起尚未核对的方向' : `展开其余 ${hiddenQuietCount} 个尚未核对的方向` }}
    </Button>

    <p class="text-muted-foreground max-w-[46ch] text-[13px] leading-5">
      三轴独立保留；覆盖完整或未发现差异都不自动等于“一致 / 无需处理”。
    </p>

    <DisclosurePanel compact content-class="pb-0" class="bg-card overflow-hidden rounded-lg border">
      <template #trigger>
        <span class="text-sm font-medium">企业全部复核记录</span>
      </template>
      <div class="border-t p-3">
        <EvidenceReviewList
          :key="reviewGeneration"
          :enterprise-id="enterpriseId"
          :title-code="titleCode"
          :direction="direction"
        />
      </div>
    </DisclosurePanel>

    <EnterpriseEvidenceSheet
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
