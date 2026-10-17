<script setup lang="ts">
/** #48 seam: the original single-page string; never derive writes from displayed DOM. */
defineProps<{
  markdown: string
  /** Same identity as the surrounding image; available to #48 resource resolution. */
  filePath: string
  page: number
}>()
</script>

<template>
  <pre
    class="bg-muted/40 min-w-0 overflow-auto rounded-sm p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap"
    >{{ markdown || '(空)' }}</pre>
</template>
