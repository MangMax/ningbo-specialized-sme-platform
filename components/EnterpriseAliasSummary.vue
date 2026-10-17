<script setup lang="ts">
import { ref } from 'vue'
import { Badge } from '@/components/ui/badge'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
defineProps<{ names: string[] }>()
const open = ref(false)
</script>
<template>
  <HoverCard v-if="names.length" v-model:open="open" :open-delay="120" :close-delay="120">
    <HoverCardTrigger as-child>
      <button type="button" class="text-muted-foreground mt-0.5 flex max-w-full items-center gap-1 text-left text-[13px] leading-4" data-testid="alias-summary" aria-label="查看全部曾用名" @click.stop="open = true">
        <span class="truncate">原 {{ names[0] }}</span>
        <Badge v-if="names.length > 1" variant="quiet" class="shrink-0 py-0 text-[13px] leading-[18px] tabular-nums" data-testid="alias-overflow-trigger">+{{ names.length - 1 }}</Badge>
      </button>
    </HoverCardTrigger>
    <HoverCardContent align="start" class="w-80 max-w-[calc(100vw-2rem)] p-3 shadow-none" @click.stop>
      <div class="mb-2 text-sm font-medium">曾用名</div>
      <ul class="space-y-1 text-sm break-words" data-testid="all-enterprise-aliases"><li v-for="name in names" :key="name">{{ name }}</li></ul>
    </HoverCardContent>
  </HoverCard>
</template>
