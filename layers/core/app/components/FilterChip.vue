<script setup lang="ts">
import { X } from '@lucide/vue'
import { Button } from '#core/app/components/ui/button'

/**
 * 已生效的筛选条件。表格上方列出一行,每项可单独撤掉。
 * 光看四个下拉按钮看不出「年份里到底勾了哪几年」,所以把生效的值摊开写出来。
 */
defineProps<{ label: string; disabled?: boolean; removeLabel?: string }>()
defineEmits<{ remove: [] }>()
</script>

<template>
  <span
    data-testid="filter-chip"
    class="bg-accent text-accent-foreground inline-flex min-h-6 max-w-full min-w-0 shrink-0 items-center gap-1 rounded-sm pr-0.5 pl-2 text-xs font-medium"
  >
    <span class="min-w-0 whitespace-normal [overflow-wrap:anywhere]">{{ label }}</span>
    <Button
      variant="ghost"
      size="icon"
      class="hover:bg-primary/20 size-4 shrink-0 rounded-[3px]"
      :aria-label="removeLabel ?? `移除筛选条件:${label}`"
      :disabled="disabled"
      @click="$emit('remove')"
    >
      <X class="size-3" aria-hidden="true" />
    </Button>
  </span>
</template>
