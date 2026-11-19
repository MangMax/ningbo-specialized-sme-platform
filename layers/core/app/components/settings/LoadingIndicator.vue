<script setup lang="ts">
import { LoaderCircle } from '@lucide/vue'
import { AnimatePresence, motion, useReducedMotion } from 'motion-v'

defineProps<{ active: boolean }>()
const reducedMotion = useReducedMotion()
</script>

<template>
  <AnimatePresence>
    <motion.span
      v-if="active"
      aria-hidden="true"
      data-slot="loading-indicator"
      class="inline-flex shrink-0 items-center justify-center overflow-hidden"
      :initial="{ width: 0, opacity: 0, scale: 0.8 }"
      :animate="{ width: 16, opacity: 1, scale: 1 }"
      :exit="{ width: 0, opacity: 0, scale: 0.8 }"
      :transition="{ duration: reducedMotion ? 0 : 0.16, ease: 'easeOut' }"
    >
      <LoaderCircle class="size-4 shrink-0 animate-spin motion-reduce:animate-none" />
    </motion.span>
  </AnimatePresence>
</template>
