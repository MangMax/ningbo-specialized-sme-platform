<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import type { PlatformQualificationFact } from '#sme-roster/lib/roster/platform-qualification'
import type { RosterEnterpriseDetail } from '#sme-roster/lib/roster/enterprise-roster'
import type { CurrentTitle } from '#sme-roster/lib/roster/current-titles'
import { CURRENT_STATUS_LABELS } from '#sme-roster/lib/roster/current-status'
import RosterTitleBadge from './TitleBadge.vue'
import RosterPlatformRecords from './PlatformRecords.vue'
import ModalDialog from '#core/app/components/ModalDialog.vue'
import { Badge } from '#core/app/components/ui/badge'
import { Button } from '#core/app/components/ui/button'
import { reviewOutcomeLabel, timelineEventIdentity, type TimelineEventFacts } from '#sme-roster/lib/roster/enterprise-timeline'

const props = defineProps<{ events?: readonly TimelineEventFacts[]; enterpriseId?: number; source?: PlatformQualificationFact; inheritedFrom?: CurrentTitle }>()
const open = ref(false)
const detail = shallowRef<RosterEnterpriseDetail | null>(null)
const loading = ref(false)
const failure = ref(false)
let generation = 0
async function load() {
  if (props.enterpriseId == null) return
  const request = ++generation
  const enterpriseId = props.enterpriseId
  loading.value = true
  failure.value = false
  try {
    const result = await $fetch<RosterEnterpriseDetail>(`/api/roster/enterprises/${enterpriseId}`)
    if (request === generation) detail.value = result
  } catch {
    if (request === generation) failure.value = true
  } finally {
    if (request === generation) loading.value = false
  }
}
watch(() => props.enterpriseId, () => {
  generation++
  detail.value = null
  failure.value = false
  loading.value = false
  open.value = false
})
watch(open, value => { if (value) void load() })
const steps = computed(() => {
  const seen = new Set<string>()
  return (props.events ?? []).flatMap(event => {
    if (event.eventType !== 'award' && event.eventType !== 'review') return []
    const key = timelineEventIdentity('', event)
    if (seen.has(key)) return []
    seen.add(key)
    // A review's year is its original award year, not the review date.
    const recordedYear = event.eventType === 'award' ? event.decidedYear ?? event.year : event.decidedYear
    const year = recordedYear != null && Number.isInteger(recordedYear) && recordedYear >= 1900 && recordedYear <= 9999 ? recordedYear : null
    const label = event.eventType === 'award' ? '认定' : event.reviewOutcome === 'passed' ? '复核'
      : `复核（${reviewOutcomeLabel(event.reviewOutcome)}）`
    return [{ key, year, label, order: event.eventType === 'award' ? 0 : 1 }]
  }).sort((a, b) => (a.year ?? Infinity) - (b.year ?? Infinity) || a.order - b.order || a.key.localeCompare(b.key))
})

function assessmentBadgeVariant(assessment: RosterEnterpriseDetail['qualificationAssessment']['titles'][number]) {
  const status = assessment.effectiveQualification?.status
  if (status === 'effective' || assessment.group === 'eligible') return 'success'
  if (assessment.group === 'pending') return 'warning'
  if (status === 'terminated' || status === 'expired') return 'error'
  return 'quiet'
}
</script>

<template>
  <p v-if="inheritedFrom" class="text-table font-medium">按有效{{ inheritedFrom === 'little_giant' ? '小巨人' : '专精特新中小企业' }}资格计入</p>
  <p v-if="source" class="min-w-0 break-words text-table leading-5 [overflow-wrap:anywhere]">{{ { recognized_list: '认定目录', business_list: '关联办理', apply_list: '申报记录' }[source.source] }} · {{ source.platformName ?? '来源原名未知' }}<br>业务时间：{{ source.businessTime.value ?? '未知' }}<br><template v-if="source.businessYear != null">业务年度：{{ source.businessYear }}<br></template>实际期间：{{ source.period.from.value ?? '起始未知' }} 至 {{ source.period.until.value ?? '结束未知' }}</p>
  <ol v-else-if="steps.length" class="flex flex-wrap items-center gap-x-2 gap-y-1 text-table leading-5" aria-label="认定与复核时间线">
    <li v-for="(step, index) in steps" :key="step.key" class="inline-flex items-center gap-2">
      <span v-if="index" class="text-muted-foreground" aria-hidden="true">→</span>
      <span><span class="tabular-nums">{{ step.year ?? '年份未记录' }}</span> {{ step.label }}</span>
    </li>
  </ol>
  <p v-else-if="!inheritedFrom" class="text-muted-foreground text-table leading-5">{{ props.events === undefined ? '认定与复核记录请查看详情' : '暂无认定与复核记录' }}</p>
  <button
    v-if="enterpriseId != null"
    type="button"
    class="text-primary mt-1 inline-flex cursor-pointer items-center text-xs font-medium hover:underline focus-visible:underline focus-visible:outline-none"
    @click="open = true"
  >
    查看全部业务来源
  </button>
  <ModalDialog
    v-model:open="open"
    title="企业业务时间线"
    description="按来源查看该企业的认定、复核及办理记录"
    hide-description
    size="xl"
    body-class="space-y-4"
  >
    <p v-if="loading" role="status" class="text-muted-foreground text-table">正在读取业务记录…</p>
    <div v-if="failure" role="alert" class="border-destructive-border bg-destructive-bg flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3.5 py-2.5 text-table">
      <p class="text-destructive">业务记录读取失败，保留上次成功结果。</p>
      <Button variant="outline" size="sm" :disabled="loading" @click="load">重试读取业务记录</Button>
    </div>
    <template v-if="detail">
      <section aria-label="当前资格摘要" class="bg-card divide-border-secondary min-w-0 divide-y overflow-hidden rounded-lg border text-table break-words [overflow-wrap:anywhere]">
        <header class="bg-surface-sunken flex items-center justify-between gap-2 px-4 py-2 text-xs">
          <span class="text-foreground font-medium">当前资格摘要</span>
          <span class="text-muted-foreground tabular-nums">评估时点：{{ detail.qualificationAssessment.asOf }}</span>
        </header>
        <article v-for="assessment in detail.qualificationAssessment.titles" :key="assessment.titleCode" class="px-4 py-3">
          <h3 class="flex flex-wrap items-center gap-2">
            <RosterTitleBadge :code="assessment.titleCode" />
            <Badge :variant="assessmentBadgeVariant(assessment)">
              {{ assessment.effectiveQualification ? CURRENT_STATUS_LABELS[assessment.effectiveQualification.status] : { eligible: '宁波当前可纳入', pending: '宁波当前待核', excluded: '不纳入宁波当前结果' }[assessment.group] }}
            </Badge>
          </h3>
          <dl class="mt-2 grid grid-cols-1 gap-x-5 gap-y-1.5 text-xs leading-5 sm:grid-cols-2">
            <div v-for="basis in assessment.effectiveQualification?.presentationBasis ?? []" :key="basis" class="sm:col-span-2">
              <dd class="text-foreground">{{ basis }}</dd>
            </div>
            <div v-if="!assessment.effectiveQualification?.source" class="sm:col-span-2">
              <dt class="text-muted-foreground inline">公布依据：</dt>
              <dd class="text-foreground inline">{{ assessment.officialQualification.message }}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground inline">主体：</dt>
              <dd class="text-muted-foreground inline">{{ assessment.subject.message }}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground inline">地域：</dt>
              <dd class="text-muted-foreground inline">{{ assessment.region.message }}</dd>
            </div>
          </dl>
        </article>
      </section>
      <RosterPlatformRecords :key="enterpriseId" :timeline="detail.businessTimeline" />
    </template>
  </ModalDialog>
</template>
