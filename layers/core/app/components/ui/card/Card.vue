<script setup lang="ts">
import { cn } from '#core/lib/utils'
import type { HTMLAttributes } from 'vue'

const props = defineProps<{ class?: HTMLAttributes['class'] }>()
</script>

<template>
  <div
    :class="
      cn(
        'bg-card text-card-foreground flex flex-col gap-6 rounded-lg border py-6 shadow-xs',
        props.class,
      )
    "
  >
    <slot />
  </div>
</template>
