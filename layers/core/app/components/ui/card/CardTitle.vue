<script setup lang="ts">
/**
 * 卡片标题。默认仍是 h3：页面 h1 → 区块 h2 → 卡片 h3 的层级不变。
 *
 * `as` 只给**页面主卡**用：那张卡的标题就是它所在区块的唯一 h2（`tasks.vue`
 * 的任务详情）。在它上面加一段没有内容的 h 元素「补层级」只是给检测器看的，
 * 对读屏的人毫无意义；`as="h2"` 由 CardTitle 自己渲染，视觉样式完全一致。
 */
import { cn } from '#core/lib/utils'
import type { HTMLAttributes } from 'vue'

const props = withDefaults(defineProps<{ class?: HTMLAttributes['class'], as?: 'h2' | 'h3' | 'h4' }>(), { as: 'h3' })
</script>

<template>
  <component :is="props.as" :class="cn('leading-none font-semibold tracking-tight', props.class)">
    <slot />
  </component>
</template>
