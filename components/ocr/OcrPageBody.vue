<script setup lang="ts">
import ContentPreview from '@/components/preview/ContentPreview.vue'
import { useAppColorMode } from '@/composables/useAppColorMode'

/** Display only. The row editor remains the sole source of write payloads. */
defineProps<{
  markdown: string
  filePath: string
  page: number
}>()

const colorMode = useAppColorMode()
</script>

<template>
  <ContentPreview
    :key="`${filePath}:${page}`"
    :source="markdown"
    format="markdown"
    :name="`第 ${page} 页.md`"
    :theme="colorMode === 'dark' ? 'dark' : 'light'"
  />
</template>
