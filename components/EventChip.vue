<script setup lang="ts">
import { computed } from 'vue'
import type { BadgeVariants } from '@/components/ui/badge'
import { Badge } from '@/components/ui/badge'
import { EVENTS } from '~~/lib/labels'

/**
 * 记录事件标签。事件在表里成片出现,所以只在**线型**上分三层,不给每种类型配色:
 *   认定 → 深一档的实线(新增了一条称号事实,是这条记录的由来)
 *   复核 / 维护 → 普通描边(存量的续期记录,两者靠文字区分)
 *   入库培育 → 虚线(尚未构成称号)
 * 变的是线,不是颜色 —— 颜色留给称号梯度。
 */
const props = defineProps<{
  type: string
  year?: number | null
  seq?: number | null
}>()

const VARIANT: Record<string, BadgeVariants['variant']> = {
  award: 'solid',
  review: 'quiet',
  maintain: 'quiet',
  nurture: 'dashed',
}

const typeName = computed(() => EVENTS[props.type] ?? props.type)
/** 年份-批次,如 2024-1;年份缺失时留一个占位符。 */
const batch = computed(() => {
  if (props.year == null) return '—'
  return props.seq != null ? `${props.year}-${props.seq}` : String(props.year)
})
</script>

<template>
  <!-- 类型名始终退到次级色,年份-批次是本 chip 要读的信息,始终最重。 -->
  <Badge :variant="VARIANT[type] ?? 'quiet'" class="gap-1.5 pl-1.5 font-normal">
    <span class="text-muted-foreground font-normal">{{ typeName }}</span>
    <span class="text-foreground font-medium tabular-nums">{{ batch }}</span>
  </Badge>
</template>
