<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from '#core/lib/utils'
import { Card } from './ui/card'

/**
 * 详情页 / 配置页 / 定时任务页的通用分区卡片。
 *
 * 标题与说明走 `title` / `description`（也可以整体替换成 `header` 插槽），
 * 右侧操作放 `actions`，正文默认带 16px 内边距（`padded` 可关）。
 * 卡片自身不写间距，分区之间由页面用 flex gap 控制。
 */
const props = withDefaults(
  defineProps<{
    title?: string
    description?: string
    padded?: boolean
    class?: HTMLAttributes['class']
    headerClass?: HTMLAttributes['class']
    bodyClass?: HTMLAttributes['class']
  }>(),
  { padded: true },
)

defineSlots<{
  header?(): unknown
  actions?(): unknown
  default?(): unknown
}>()
</script>

<template>
  <Card :class="cn('min-w-0 gap-0 overflow-hidden py-0 shadow-none', props.class)">
    <div
      v-if="props.title || props.description || $slots.header || $slots.actions"
      :class="
        cn(
          'flex flex-wrap items-start justify-between gap-2 border-b px-4 py-3',
          props.headerClass,
        )
      "
    >
      <slot name="header">
        <div class="flex min-w-0 flex-col gap-1">
          <h2 v-if="props.title" class="text-base leading-tight font-semibold">{{ props.title }}</h2>
          <p v-if="props.description" class="text-muted-foreground text-sm">{{ props.description }}</p>
        </div>
      </slot>
      <div v-if="$slots.actions" class="flex shrink-0 flex-wrap items-center gap-2">
        <slot name="actions" />
      </div>
    </div>
    <div :class="cn(props.padded && 'p-4', props.bodyClass)">
      <slot />
    </div>
  </Card>
</template>
