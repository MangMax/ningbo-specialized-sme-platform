<script setup lang="ts">
import ContentPreview from '@/components/preview/ContentPreview.vue'
import { useAppColorMode } from '@/composables/useAppColorMode'

/**
 * OCR 正文 → 共享只读预览的薄适配。
 *
 * 主阅读区、编辑旁边的阅读态和对照弹窗都走这里，保证同一份原始 Markdown
 * 只有一套渲染/复制规则。编辑与保存仍由父级使用独立的原始 Markdown 草稿。
 */
withDefaults(
  defineProps<{
    markdown: string
    filePath: string
    page: number
    mode?: 'rendered' | 'source'
    wrap?: boolean
    hideToolbar?: boolean
    contentClass?: string
  }>(),
  {
    mode: 'rendered',
    wrap: true,
    hideToolbar: true,
    contentClass: 'p-4 lg:p-5',
  },
)

const colorMode = useAppColorMode()
</script>

<template>
  <ContentPreview
    :key="`${filePath}:${page}`"
    class="h-full min-h-0"
    :source="markdown"
    format="markdown"
    :name="`第 ${page} 页.md`"
    :theme="colorMode === 'dark' ? 'dark' : 'light'"
    :mode="mode"
    :wrap="wrap"
    :hide-toolbar="hideToolbar"
    :content-class="contentClass"
    focusable-content
  />
</template>
