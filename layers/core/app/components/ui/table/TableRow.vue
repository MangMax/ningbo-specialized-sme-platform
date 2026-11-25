<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "#core/lib/utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <tr
    data-slot="table-row"
    :class="cn('border-border-secondary focus-within:bg-accent/35 data-[state=selected]:bg-primary/6 data-[state=selected]:shadow-[inset_2px_0_0_var(--primary)] border-b transition-colors duration-fast ease-snap', props.class)"
  >
    <slot />
  </tr>
</template>
