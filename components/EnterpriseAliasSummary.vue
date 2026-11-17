<script setup lang="ts">
import { ref } from 'vue'
import { Badge } from '@/components/ui/badge'
import { HoverCard, HoverCardTrigger } from '@/components/ui/hover-card'
import TableHoverCardContent from './TableHoverCardContent.vue'
defineProps<{ names: string[] }>()
const open = ref(false)
</script>
<template>
  <HoverCard v-if="names.length" v-model:open="open" :open-delay="120" :close-delay="120">
    <HoverCardTrigger as-child>
      <button
        type="button"
        class="text-muted-foreground hover:text-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-3 focus-visible:outline-none active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none motion-reduce:active:scale-100 mt-0.5 flex max-w-full items-center gap-1 rounded-sm text-left text-[13px] leading-4 transition-[color,background-color,transform] duration-150 ease-snap"
        data-testid="alias-summary"
        aria-label="查看全部曾用名"
        @click.stop="open = true"
      >
        <span class="truncate">原 {{ names[0] }}</span>
        <Badge v-if="names.length > 1" variant="quiet" class="shrink-0 py-0 text-[13px] leading-[18px] tabular-nums" data-testid="alias-overflow-trigger">+{{ names.length - 1 }}</Badge>
      </button>
    </HoverCardTrigger>
    <TableHoverCardContent @click.stop>
      <div class="mb-2 text-sm font-medium">曾用名</div>
      <ul class="space-y-1 text-sm break-words" data-testid="all-enterprise-aliases"><li v-for="name in names" :key="name">{{ name }}</li></ul>
    </TableHoverCardContent>
  </HoverCard>
</template>
