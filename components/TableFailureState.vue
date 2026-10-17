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
    :class="compact ? 'border-b bg-muted/20 px-4 py-3' : 'flex min-h-52 items-center justify-center px-4 py-8 sm:min-h-60'"
  >
    <div class="grid w-full min-w-0 grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-3" :class="compact ? '' : 'max-w-lg'">
      <CircleAlert class="text-muted-foreground size-5" aria-hidden="true" />
      <div class="min-w-0">
        <p class="text-foreground text-sm font-medium leading-5" data-testid="table-failure-title">{{ title }}</p>
        <p class="text-muted-foreground mt-1 text-[13px] leading-5">
          {{ description ?? (compact ? '显示的是上次加载的结果。' : '筛选条件已保留，可以重新加载。') }}
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        class="bg-card min-w-24 shrink-0 whitespace-nowrap text-[13px] shadow-none"
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
