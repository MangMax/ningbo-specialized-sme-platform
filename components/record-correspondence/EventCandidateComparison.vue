<script setup lang="ts">
import { computed } from 'vue'
import type { EventArchiveCandidate } from '~~/lib/roster/event-archive-candidates'
import { ARCHIVE_CONFLICT_LABELS } from '~~/lib/roster/event-archive-candidates'
import { TITLES } from '#sme-roster/lib/labels'

const props = defineProps<{ candidate: EventArchiveCandidate }>()
const fields = computed(() => {
  const { identity, title, temporal, process, source } = props.candidate.evidence
  const review = process.eventType === 'review'
  const year = review ? temporal.decisionYear : temporal.eventYear
  const batch = temporal.relationBatch ?? temporal.awardBatchLabel
  const status = (left: unknown, right: unknown, conflict: string, comparable = true) => {
    if (props.candidate.conflicts.includes(conflict)) return '差异（待核对）'
    if (left == null || left === '' || right == null || right === '') return '未提供，无法比较'
    if (comparable && String(left) === String(right)) return '一致'
    return '原值分别保留，待核对'
  }
  return [
    { label: '统一社会信用代码', official: identity.officialUsccRaw, platform: identity.rowUsccRaw, status: status(identity.officialUsccRaw, identity.rowUsccRaw, 'identity_conflict') },
    { label: '称号', official: TITLES[title.official] ?? title.official, platform: TITLES[title.row] ?? title.row, status: status(title.official, title.row, 'title_conflict') },
    { label: '年份', official: `${review ? '公布结论年' : '原认定年'}：${year ?? '未提供'}`, platform: `${source.interface === 'recognized_list' ? '目录年份' : '办理业务年'}：${temporal.relationYear ?? '未提供'}`, status: status(year, temporal.relationYear, 'year_mismatch', source.interface !== 'recognized_list') },
    { label: '批次', official: temporal.eventBatchSeq, platform: batch, status: status(temporal.eventBatchSeq, batch, 'batch_mismatch') },
  ]
})
const groups = computed(() => {
  const missing = ['official_year_missing', 'official_decision_year_missing', 'platform_year_missing', 'official_batch_missing', 'platform_batch_missing', 'process_type_unknown']
  const differences = ['year_mismatch', 'batch_mismatch', 'process_type_mismatch', 'identity_conflict', 'title_conflict', 'platform_field_conflict']
  const labels: Record<string, string> = { ...ARCHIVE_CONFLICT_LABELS, identity_conflict: '平台身份字段存在差异', title_conflict: '平台称号字段存在差异', platform_field_conflict: '平台原始字段存在差异' }
  return [
    { label: '资料缺失', codes: props.candidate.conflicts.filter(code => missing.includes(code)) },
    { label: '事项差异', codes: props.candidate.conflicts.filter(code => differences.includes(code)) },
    { label: '时间关系', codes: props.candidate.conflicts.filter(code => code === 'application_after_decision') },
    { label: '其他待核依据', codes: props.candidate.conflicts.filter(code => ![...missing, ...differences, 'application_after_decision', 'multiple_candidate_rows'].includes(code)) },
  ].filter(group => group.codes.length).map(group => ({ ...group, reasons: group.codes.map(code => labels[code] ?? code) }))
})
</script>

<template>
  <section aria-label="正式公布与平台记录对照" class="my-3 min-w-0 text-base leading-6 [overflow-wrap:anywhere]">
    <div class="hidden gap-3 border-b pb-2 font-medium sm:grid sm:grid-cols-[8rem_1fr_1fr]" aria-hidden="true"><span>对照字段</span><span>正式公布</span><span>平台记录</span></div>
    <dl>
      <div v-for="field in fields" :key="field.label" class="grid min-w-0 gap-2 border-b py-3 sm:grid-cols-[8rem_1fr_1fr] sm:gap-3">
        <dt class="font-medium">{{ field.label }}<span class="block text-sm font-normal text-muted-foreground">{{ field.status }}</span></dt>
        <dd class="min-w-0"><span class="font-medium sm:sr-only">正式公布：</span>{{ field.official ?? '未提供' }}</dd>
        <dd class="min-w-0"><span class="font-medium sm:sr-only">平台记录：</span>{{ field.platform ?? '未提供' }}</dd>
      </div>
    </dl>
    <p v-if="candidate.evidence.process.eventType === 'review'" class="mt-2">正式公布 · 原认定年：{{ candidate.evidence.temporal.eventYear ?? '未提供' }}</p>
    <p v-if="candidate.evidence.process.appliedAt" class="mt-2">平台记录 · 申报时间：{{ candidate.evidence.process.appliedAt }}</p>
    <section v-for="group in groups" :key="group.label" :aria-label="group.label" class="mt-3">
      <h4 class="font-medium">{{ group.label }}</h4>
      <ul class="list-inside list-disc"><li v-for="reason in group.reasons" :key="reason">{{ reason }}</li></ul>
      <p v-if="group.label === '时间关系'" class="text-muted-foreground">时间先后不代表业务错误，需结合原始事项核对。</p>
    </section>
  </section>
</template>
