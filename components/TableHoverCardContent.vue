<script setup lang="ts">
import { HoverCardContent } from '@/components/ui/hover-card'
</script>

<template>
  <HoverCardContent
    side="bottom"
    align="start"
    :side-offset="4"
    :collision-padding="16"
    class="w-80 max-w-[calc(100vw-2rem)] break-words p-3 text-table leading-5 shadow-none [overflow-wrap:anywhere]"
  >
    <slot />
  </HoverCardContent>
</template>
