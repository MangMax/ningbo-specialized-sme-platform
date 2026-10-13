<script setup lang="ts">
/**
 * 页头。标题、一行说明、右侧操作 —— 四个页面共用同一种结构,
 * 页面里不再各写一遍 h1 的样式。
 */
defineProps<{
  title: string
  /** 一行说明,写这一页回答什么问题,不写凑数的介绍。 */
  description?: string
}>()
</script>

<template>
  <header class="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
    <div class="flex min-w-0 flex-col gap-1">
      <div v-if="$slots.breadcrumb" class="text-muted-foreground mb-0.5 text-xs">
        <slot name="breadcrumb" />
      </div>
      <h1 class="text-xl leading-tight font-semibold tracking-tight">{{ title }}</h1>
      <p v-if="description || $slots.description" class="text-muted-foreground text-sm">
        <slot name="description">{{ description }}</slot>
      </p>
    </div>
    <div v-if="$slots.actions" class="flex flex-wrap items-center gap-2">
      <slot name="actions" />
    </div>
  </header>
</template>
