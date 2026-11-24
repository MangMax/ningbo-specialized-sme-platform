<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "#core/lib/utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <th
    data-slot="table-head"
    :class="cn('text-muted-foreground h-9 px-3 text-left align-middle text-xs font-medium tracking-[0.01em] whitespace-nowrap [&:has([role=checkbox])]:pr-0 *:[[role=checkbox]]:translate-y-0.5', props.class)"
  >
    <slot />
  </th>
</template>
