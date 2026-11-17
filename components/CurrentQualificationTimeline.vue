<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import type { PlatformQualificationFact } from '~~/lib/roster/platform-qualification'
import type { RosterEnterpriseDetail } from '~~/lib/roster/enterprise-roster'
import type { CurrentTitle } from '~~/lib/roster/current-titles'
import { CURRENT_STATUS_LABELS } from '~~/lib/roster/current-status'
import TitleBadge from './TitleBadge.vue'
import PlatformRecords from './PlatformRecords.vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { reviewOutcomeLabel, timelineEventIdentity, type TimelineEventFacts } from '~~/lib/roster/enterprise-timeline'

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
</script>

<template>
  <p v-if="inheritedFrom" class="text-sm font-medium">按有效{{ inheritedFrom === 'little_giant' ? '小巨人' : '专精特新中小企业' }}资格计入</p>
  <p v-if="source" class="min-w-0 break-words text-sm leading-6 [overflow-wrap:anywhere]">{{ { recognized_list: '认定目录', business_list: '关联办理', apply_list: '申报记录' }[source.source] }} · {{ source.platformName ?? '来源原名未知' }}<br>业务时间：{{ source.businessTime.value ?? '未知' }}<br><template v-if="source.businessYear != null">业务年度：{{ source.businessYear }}<br></template>实际期间：{{ source.period.from.value ?? '起始未知' }} 至 {{ source.period.until.value ?? '结束未知' }}</p>
  <ol v-else-if="steps.length" class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm leading-6" aria-label="认定与复核时间线">
    <li v-for="(step, index) in steps" :key="step.key" class="inline-flex items-center gap-2">
      <span v-if="index" class="text-muted-foreground" aria-hidden="true">→</span>
      <span><span class="tabular-nums">{{ step.year ?? '年份未记录' }}</span> {{ step.label }}</span>
    </li>
  </ol>
  <p v-else-if="!inheritedFrom" class="text-muted-foreground text-sm leading-6">{{ props.events === undefined ? '认定与复核记录请查看详情' : '暂无认定与复核记录' }}</p>
  <Button v-if="enterpriseId != null" variant="outline" size="sm" class="mt-2 max-w-full whitespace-normal" @click="open = true">查看全部业务来源</Button>
  <Dialog v-model:open="open">
    <DialogContent class="max-h-[85dvh] min-w-0 overflow-y-auto sm:max-w-3xl">
      <DialogHeader><DialogTitle>企业业务时间线</DialogTitle><DialogDescription>公布资料、认定目录、关联办理与申报记录；资格采用同一详情快照的后端评估。</DialogDescription></DialogHeader>
      <p v-if="loading" role="status">正在读取业务记录</p>
      <div v-if="failure" role="alert"><p>业务记录读取失败，保留上次成功结果。</p><Button :disabled="loading" @click="load">重试读取业务记录</Button></div>
      <template v-if="detail">
        <section aria-label="当前资格摘要" class="bg-muted/30 min-w-0 space-y-3 rounded-lg border p-4 text-sm leading-6 break-words [overflow-wrap:anywhere]">
          <p>评估时点：{{ detail.qualificationAssessment.asOf }}</p>
          <article v-for="assessment in detail.qualificationAssessment.titles" :key="assessment.titleCode" class="space-y-2 border-t pt-3">
            <h3 class="flex flex-wrap items-center gap-2"><TitleBadge :code="assessment.titleCode" /><span>{{ assessment.effectiveQualification ? CURRENT_STATUS_LABELS[assessment.effectiveQualification.status] : { eligible: '宁波当前可纳入', pending: '宁波当前待核', excluded: '不纳入宁波当前结果' }[assessment.group] }}</span></h3>
            <p v-for="basis in assessment.effectiveQualification?.presentationBasis ?? []" :key="basis">{{ basis }}</p>
            <p v-if="!assessment.effectiveQualification?.source">公布依据：{{ assessment.officialQualification.message }}</p>
            <p>主体：{{ assessment.subject.message }}；地域：{{ assessment.region.message }}</p>
          </article>
        </section>
        <PlatformRecords :key="enterpriseId" :timeline="detail.businessTimeline" />
      </template>
    </DialogContent>
  </Dialog>
</template>
