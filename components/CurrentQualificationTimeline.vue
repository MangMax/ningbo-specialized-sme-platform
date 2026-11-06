<script setup lang="ts">
import { computed } from 'vue'
import { reviewOutcomeLabel, timelineEventIdentity, type TimelineEventFacts } from '~~/lib/roster/enterprise-timeline'

const props = defineProps<{ events?: readonly TimelineEventFacts[] }>()
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
  <ol v-if="steps.length" class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm leading-6" aria-label="认定与复核时间线">
    <li v-for="(step, index) in steps" :key="step.key" class="inline-flex items-center gap-2">
      <span v-if="index" class="text-muted-foreground" aria-hidden="true">→</span>
      <span><span class="tabular-nums">{{ step.year ?? '年份未记录' }}</span> {{ step.label }}</span>
    </li>
  </ol>
  <p v-else class="text-muted-foreground text-sm leading-6">{{ props.events === undefined ? '认定与复核记录请查看详情' : '暂无认定与复核记录' }}</p>
</template>
