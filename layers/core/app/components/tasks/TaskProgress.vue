<script setup lang="ts">
import { computed } from 'vue'
import type { TaskSummary } from '#core/lib/task-center'

/**
 * 阶段进度。总量未知时不造百分比，只写“总量未知”。
 * `inline` 给窄屏摘要用：一行读完“阶段 · 已完成量”，不额外占高度。
 */
const props = withDefaults(defineProps<{ progress: TaskSummary['progress'], inline?: boolean }>(), { inline: false })

const amount = computed(() => props.progress.total === null
  ? `${props.progress.done} · 总量未知`
  : `${props.progress.done} / ${props.progress.total} ${props.progress.unit}`)
const text = computed(() => `${props.progress.stage} · ${amount.value}`)
</script>

<template>
  <span v-if="inline" class="text-muted-foreground text-xs tabular-nums" data-testid="task-progress-inline">{{ text }}</span>
  <div v-else class="flex flex-col gap-1 text-sm">
    <span>{{ progress.stage }}</span>
    <span class="text-muted-foreground text-xs tabular-nums">{{ amount }}</span>
  </div>
</template>
