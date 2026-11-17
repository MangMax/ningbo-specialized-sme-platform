<script setup lang="ts">
import { CircleAlert, RefreshCw } from '@lucide/vue'
import { Button } from '@/components/ui/button'

withDefaults(defineProps<{
  title: string
  compact?: boolean
  pending?: boolean
  description?: string
}>(), { compact: false, pending: false })
defineEmits<{ retry: [] }>()
</script>

<template>
  <div
    data-testid="table-failure-state"
    role="status"
    aria-live="polite"
    :aria-busy="pending"
    :data-compact="compact"
    :class="compact ? 'border-b bg-muted/20 px-4 py-3' : 'px-4 py-6 sm:px-6 sm:py-8'"
  >
    <!-- 失败目标、原因和重试在同一组靠左阅读，不再把重试推到整行最右端。 -->
    <div class="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:gap-3">
      <CircleAlert class="text-muted-foreground mt-0.5 size-5 shrink-0" aria-hidden="true" />
      <div class="min-w-0 flex-1">
        <p class="text-foreground text-sm leading-5 font-medium" data-testid="table-failure-title">{{ title }}</p>
        <p class="text-muted-foreground mt-1 text-table leading-5">
          {{ description ?? (compact ? '显示的是上次加载的结果。' : '筛选条件已保留，可以重新加载。') }}
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        class="bg-card min-w-24 shrink-0 self-start whitespace-nowrap text-table shadow-none"
        :disabled="pending"
        data-testid="table-retry"
        @click="$emit('retry')"
      >
        <RefreshCw class="size-3.5" :class="pending ? 'animate-spin [animation-timing-function:var(--ease-snap)] motion-reduce:animate-none' : ''" aria-hidden="true" />
        {{ pending ? '正在重试' : '重新加载' }}
      </Button>
    </div>
  </div>
</template>
