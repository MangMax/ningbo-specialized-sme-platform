<script setup lang="ts">
import { Badge } from '#core/app/components/ui/badge'

/**
 * 统计页的下钻入口。点一项就在台账页按该条件筛选。
 *
 * 原来的写法是「Badge 套 NuxtLink」—— 一个纯展示组件被当链接用,
 * 悬停只有一点变色,看不出能点。这里保留 chip 的外形,但把可点性写进
 * 悬停态(描边变主色 + 底色抬起)并交给键盘聚焦。
 */
defineProps<{
  to: string
  label: string
  value: number
  /** 色标色,和对应图表/徽章一致;不传则不画方标。 */
  mark?: string
}>()
</script>

<template>
  <NuxtLink :to="to" class="group focus-visible:ring-ring rounded-sm focus-visible:ring-3 focus-visible:outline-none">
    <Badge
      variant="outline"
      class="group-hover:border-primary/50 group-hover:bg-accent h-6 cursor-pointer gap-1.5 pl-1.5 font-normal transition-colors"
    >
      <span
        v-if="mark"
        aria-hidden="true"
        class="size-1.5 shrink-0 rounded-[1px]"
        :style="{ backgroundColor: mark }"
      />
      {{ label }}
      <span class="text-muted-foreground tabular-nums">{{ value.toLocaleString('zh-CN') }}</span>
    </Badge>
  </NuxtLink>
</template>
