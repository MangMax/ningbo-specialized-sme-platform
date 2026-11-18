<script setup lang="ts">
import { computed } from 'vue'
import type { BadgeVariants } from '#core/app/components/ui/badge'
import { Badge } from '#core/app/components/ui/badge'
import { TITLE_LEVEL, TITLE_RANK, TITLES } from '~~/lib/labels'

/**
 * 称号标签 —— 台账里唯一定义「梯度」的视觉元素。
 * 等级 1/2/3 对应 tier-1/2/3 变体,由高到低是一条色阶;金色方标只给国家级。
 */
const props = defineProps<{ code: string }>()

const label = computed(() => TITLES[props.code] ?? props.code)
const variant = computed<BadgeVariants['variant']>(() => {
  const rank = TITLE_RANK[props.code]
  return rank != null && rank <= 3 ? (`tier-${rank}` as BadgeVariants['variant']) : 'quiet'
})
const national = computed(() => TITLE_LEVEL[props.code] === 'national')
/** 徽标深浅对应称号等级；把来源字段（等级、rank）直接写进提示，不另造说法。 */
const semantics = computed(() => {
  const level = TITLE_LEVEL[props.code] === 'national' ? '国家级' : TITLE_LEVEL[props.code] === 'municipal' ? '市级' : '层级待核'
  const rank = TITLE_RANK[props.code]
  return `${label.value} · ${level}${rank != null ? ` · 等级 ${rank}` : ''}`
})
</script>

<template>
  <Badge :variant="variant" :class="national && 'gap-1.5 pl-1'" :title="semantics">
    <span
      v-if="national"
      aria-hidden="true"
      class="bg-mark-national size-1.5 shrink-0 rounded-[1px]"
    />
    {{ label }}
  </Badge>
</template>
