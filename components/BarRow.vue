<script setup lang="ts">
import { computed } from 'vue'
import { Progress } from '@/components/ui/progress'

/**
 * 构成条:标签 | 条形 | 数值。用于来源、事件、区县这类「几项到几十项」的计数。
 *
 * 这些数字用图表反而更难读:两个来源画成两根柱子,轴和网格都成了装饰。
 * 一条一行、数字右对齐,扫一眼就能比出来,而且整行可点、直接下钻到台账。
 *
 * 条形用官方的 Progress;颜色不另写样式,而是在外层覆盖局部 --primary
 * (tailwind 的 @theme inline 会把 bg-primary 直接编译成 var(--primary))。
 */
const props = withDefaults(
  defineProps<{
    label: string
    value: number
    /** 本组最大值,用来算条长。 */
    max: number
    color?: string
    /** 传了就是可点的下钻入口。 */
    to?: string
  }>(),
  { color: '', to: '' },
)

const pct = computed(() => (props.max > 0 ? (props.value / props.max) * 100 : 0))
const display = computed(() => props.value.toLocaleString('zh-CN'))
</script>

<template>
  <component
    :is="to ? 'NuxtLink' : 'div'"
    :to="to || undefined"
    class="group -mx-1.5 grid grid-cols-[6.5rem_1fr_3.75rem] items-center gap-3 rounded-sm px-1.5 py-1 transition-colors"
    :class="to && 'hover:bg-accent focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-3'"
    :style="color ? { '--primary': color } : undefined"
  >
    <span class="text-muted-foreground group-hover:text-foreground truncate text-xs">{{ label }}</span>
    <Progress
      :model-value="pct"
      class="bg-muted h-1.5 rounded-[2px] [&_[data-slot=progress-indicator]]:rounded-[2px]"
    />
    <span class="text-right text-xs font-medium tabular-nums">{{ display }}</span>
  </component>
</template>
