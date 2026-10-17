<script setup lang="ts">
import { onBeforeUnmount } from 'vue'
import { RenderLayer } from '@embedpdf/plugin-render/vue'
import { PagePointerProvider } from '@embedpdf/plugin-interaction-manager/vue'
import { SelectionLayer, useSelectionCapability } from '@embedpdf/plugin-selection/vue'
import { SearchLayer } from '@embedpdf/plugin-search/vue'
import { Button } from '@/components/ui/button'
const props = defineProps<{ documentId: string; pageIndex: number; scale: number }>()
const emit = defineEmits<{ ready: [page: number]; release: [page: number]; error: [message: string] }>()
const { provides: selection } = useSelectionCapability()
onBeforeUnmount(() => emit('release', props.pageIndex + 1))
</script>
<template>
  <PagePointerProvider :document-id="documentId" :page-index="pageIndex" :scale="scale" class="relative h-full w-full">
    <RenderLayer :document-id="documentId" :page-index="pageIndex" :scale="scale" @load="emit('ready', pageIndex + 1)" @error="emit('error', 'PDF 页面渲染失败，请重试。')" />
    <SearchLayer :document-id="documentId" :page-index="pageIndex" :scale="scale" />
    <SelectionLayer :document-id="documentId" :page-index="pageIndex" :scale="scale">
      <template #selection-menu="{ menuWrapperProps, placement }">
        <div v-bind="menuWrapperProps">
          <Button size="sm" :class="['pointer-events-auto absolute left-0', placement.suggestTop ? 'bottom-full mb-1' : 'top-full mt-1']" @click="selection?.forDocument(documentId).copyToClipboard()">复制文本</Button>
        </div>
      </template>
    </SelectionLayer>
  </PagePointerProvider>
</template>
