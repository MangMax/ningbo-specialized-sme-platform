<script setup lang="ts">
import { computed } from 'vue'
import { Card, CardContent } from '@/components/ui/card'

/**
 * 概览数字。统计页与质量页共用同一块砖:
 * 标签在上、数字最大、说明最小,一列排开时数字自然对齐。
 */
const props = withDefaults(
  defineProps<{
    label: string
    value: number | string
    hint?: string
  }>(),
  { hint: '' },
)

const display = computed(() =>
  typeof props.value === 'number' ? props.value.toLocaleString('zh-CN') : props.value,
)
</script>

<template>
  <Card class="gap-0 py-0">
    <CardContent class="flex flex-col gap-1.5 p-5">
      <span class="text-muted-foreground text-xs">{{ label }}</span>
      <span class="text-2xl leading-none font-semibold tracking-tight tabular-nums">
        {{ display }}
      </span>
      <span v-if="hint" class="text-muted-foreground text-xs">{{ hint }}</span>
    </CardContent>
  </Card>
</template>
