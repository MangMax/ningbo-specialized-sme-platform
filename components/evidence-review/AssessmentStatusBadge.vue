<script setup lang="ts">
/**
 * 核对状态标签。
 *
 * 三类事实必须一眼可分组：
 *  - 查询覆盖：方形标记 + 描边（事实/范围）；
 *  - 业务判断：圆点 + 浅实底（人工结论）；
 *  - 解释有效性：图标 + 描边（复核状态）。
 *
 * 颜色只作辅助，读屏与色觉差异都能靠文字与形状区分。
 */
import { computed } from 'vue'
import { Badge } from '#core/app/components/ui/badge'
import {
  AlertTriangle,
  Check,
  CircleAlert,
  Clock3,
  Minus,
} from '@lucide/vue'
import {
  coverageLabels,
  impactClassificationLabels,
  lineageLabels,
  validityLabels,
} from '~~/lib/roster/evidence-review-ui'
import { PLATFORM_QUERY_STATUSES } from '~~/lib/labels'

type Kind = 'coverage' | 'validity' | 'assessment' | 'impact' | 'lineage' | 'query' | 'review'
type Tone = 'primary' | 'primary-solid' | 'warning' | 'warning-solid' | 'destructive' | 'muted'

const props = defineProps<{ kind: Kind; value: string; label?: string }>()

const assessmentLabels: Record<string, string> = {
  queried_unjudged: '已查询 · 尚未判断',
  not_queried: '尚未查询 · 尚未判断',
  decided: '已有业务决定',
  withdrawn: '决定已撤回',
  unknown: '尚未判断 · 查询范围待核',
}

const reviewLabels: Record<string, string> = {
  pending: '待复核',
  reviewed: '已复核',
}

const text = computed(() => {
  if (props.label) return props.label
  switch (props.kind) {
    case 'coverage': return coverageLabels[props.value] ?? '覆盖待核'
    case 'validity': return validityLabels[props.value] ?? '解释有效性待核'
    case 'assessment': return assessmentLabels[props.value] ?? '判断待核'
    case 'impact': return impactClassificationLabels[props.value] ?? '证据变化'
    case 'lineage': return lineageLabels[props.value] ?? '决定状态待核'
    case 'query': return PLATFORM_QUERY_STATUSES[props.value] ?? '查询状态待核'
    case 'review': return reviewLabels[props.value] ?? '复核状态待核'
  }
})

const tone = computed<Tone>(() => {
  if (props.kind === 'coverage') {
    if (props.value === 'complete') return 'primary'
    if (props.value === 'partial') return 'warning'
    if (props.value === 'failed') return 'destructive'
    return 'muted'
  }
  if (props.kind === 'validity') {
    if (props.value === 'valid') return 'primary'
    if (props.value === 'evidence_changed' || props.value === 'premise_invalid') return 'warning'
    return 'muted'
  }
  if (props.kind === 'impact') {
    return props.value === 'premise_invalid' ? 'warning-solid' : 'warning'
  }
  if (props.kind === 'lineage') {
    if (props.value === 'current') return 'primary'
    if (props.value === 'withdrawn' || props.value === 'merged') return 'muted'
    return 'muted'
  }
  if (props.kind === 'query') {
    if (props.value === 'success') return 'primary'
    if (props.value === 'partial') return 'warning'
    if (props.value === 'failed') return 'destructive'
    return 'muted'
  }
  if (props.kind === 'review') {
    // 复核状态是队列的主状态：待复核用实心藏青，已复核保留浅色描边。
    if (props.value === 'pending') return 'primary-solid'
    if (props.value === 'reviewed') return 'primary'
    return 'muted'
  }
  if (props.value === 'decided') return 'primary'
  if (props.value === 'queried_unjudged') return 'warning'
  if (props.value === 'withdrawn') return 'muted'
  return 'muted'
})

const classes = computed(() => ({
  primary: 'border-primary/35 bg-primary/5 text-primary',
  'primary-solid': 'border-transparent bg-primary text-primary-foreground',
  warning: 'border-warning/50 bg-warning/10 text-warning',
  'warning-solid': 'border-transparent bg-warning/15 text-warning',
  destructive: 'border-destructive/45 bg-destructive/10 text-destructive',
  muted: props.value === 'not_queried'
    ? 'border-dashed border-border bg-transparent text-muted-foreground'
    : 'border-border bg-transparent text-muted-foreground',
}[tone.value]))

const icon = computed(() => {
  if (props.kind === 'validity') {
    if (props.value === 'valid') return Check
    if (props.value === 'evidence_changed' || props.value === 'premise_invalid') return Clock3
    if (props.value === 'not_applicable') return Minus
    return CircleAlert
  }
  if (props.kind === 'impact') return AlertTriangle
  if (props.kind === 'review') {
    if (props.value === 'reviewed') return Check
    if (props.value === 'pending') return Clock3
    return null
  }
  return null
})
</script>

<template>
  <Badge
    variant="outline"
    :class="['gap-1 font-normal', classes]"
    :data-status-kind="kind"
    :data-status-value="value"
  >
    <component :is="icon" v-if="icon" class="size-3" aria-hidden="true" />
    <span
      v-else
      aria-hidden="true"
      class="size-1.5 shrink-0"
      :class="kind === 'coverage' ? 'rounded-[1px]' : 'rounded-full'"
      :style="{ backgroundColor: 'currentColor' }"
    />
    {{ text }}
  </Badge>
</template>
