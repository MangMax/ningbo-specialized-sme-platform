<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "#core/lib/utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <thead
    data-slot="table-header"
    :class="cn('bg-surface-sunken/95 sticky top-0 z-20 backdrop-blur-xs [&_tr]:border-b [&_tr]:border-border', props.class)"
  >
    <slot />
  </thead>
</template>
