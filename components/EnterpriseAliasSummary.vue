<script setup lang="ts">
import { ref } from 'vue'
import { Badge } from '#core/app/components/ui/badge'
import { HoverCard, HoverCardTrigger } from '#core/app/components/ui/hover-card'
import { interactiveTriggerState } from '#core/lib/utils'
import TableHoverCardContent from '../layers/core/app/components/TableHoverCardContent.vue'
defineProps<{ names: string[] }>()
const open = ref(false)
</script>
<template>
  <HoverCard v-if="names.length" v-model:open="open" :open-delay="120" :close-delay="120">
    <HoverCardTrigger as-child>
      <button
        type="button"
        :class="`text-muted-foreground hover:text-foreground mt-0.5 flex max-w-full items-center gap-1 rounded-sm text-left text-table leading-4 ${interactiveTriggerState}`"
        data-testid="alias-summary"
        aria-label="查看全部曾用名"
        @click.stop="open = true"
      >
        <span class="truncate">原 {{ names[0] }}</span>
        <Badge v-if="names.length > 1" variant="quiet" class="shrink-0 py-0 text-table leading-[18px] tabular-nums" data-testid="alias-overflow-trigger">+{{ names.length - 1 }}</Badge>
      </button>
    </HoverCardTrigger>
    <TableHoverCardContent @click.stop>
      <div class="mb-2 text-sm font-medium">曾用名</div>
      <ul class="space-y-1 text-sm break-words" data-testid="all-enterprise-aliases"><li v-for="name in names" :key="name">{{ name }}</li></ul>
    </TableHoverCardContent>
  </HoverCard>
</template>
