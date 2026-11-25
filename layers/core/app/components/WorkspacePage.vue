<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from '#core/lib/utils'
import PageHeader from './PageHeader.vue'

/**
 * 列表/详情页的统一骨架：页头 + 页面主体。
 *
 * - `viewport`（默认）：整页占满外壳剩余高度，主体（DataTableCard）在自己
 *   的高度里滚动。列表页都用这一档。
 * - `scroll`：页面跟随文档滚动，适合详情、配置这类内容高度不固定的页面。
 *
 * 只负责布局与页头，不接手任何数据逻辑。
 */
const props = withDefaults(
  defineProps<{
    title: string
    /** 一行说明，写这一页回答什么问题。 */
    description?: string
    mode?: 'viewport' | 'scroll'
    /** 请求进行中：标到页面根上，读屏能感知整页繁忙。 */
    busy?: boolean
    class?: HTMLAttributes['class']
    headerClass?: HTMLAttributes['class']
  }>(),
  { mode: 'viewport' },
)

defineSlots<{
  breadcrumb?(): unknown
  description?(): unknown
  actions?(): unknown
  default?(): unknown
}>()
</script>

<template>
  <div
    :class="
      cn(
        props.mode === 'viewport'
          ? 'workspace-list flex min-h-0 min-w-0 flex-1 flex-col gap-3'
          : 'flex min-w-0 flex-col gap-4',
        props.class,
      )
    "
    :aria-busy="props.busy ? 'true' : undefined"
  >
    <PageHeader
      class="shrink-0"
      :class="props.headerClass"
      :title="props.title"
      :description="props.description"
    >
      <template v-if="$slots.breadcrumb" #breadcrumb>
        <slot name="breadcrumb" />
      </template>
      <template v-if="$slots.description" #description>
        <slot name="description" />
      </template>
      <template v-if="$slots.actions" #actions>
        <slot name="actions" />
      </template>
    </PageHeader>
    <slot />
  </div>
</template>
