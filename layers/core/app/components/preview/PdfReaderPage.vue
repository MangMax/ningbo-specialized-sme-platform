<script setup lang="ts">
import { onBeforeUnmount, shallowRef } from 'vue'
import PdfPageImage from './PdfPageImage.vue'
import { PagePointerProvider } from '@embedpdf/plugin-interaction-manager/vue'
import { SelectionLayer, useSelectionCapability } from '@embedpdf/plugin-selection/vue'
import { SearchLayer } from '@embedpdf/plugin-search/vue'
import { Button } from '#core/app/components/ui/button'
const props = defineProps<{ documentId: string; pageIndex: number; scale: number }>()
const emit = defineEmits<{ ready: [page: number]; release: [page: number] }>()
const failed = shallowRef(false)
const attempt = shallowRef(0)
function failedRender() { failed.value = true; emit('release', props.pageIndex + 1) }
function rendered() { failed.value = false; emit('ready', props.pageIndex + 1) }
const { provides: selection } = useSelectionCapability()
onBeforeUnmount(() => emit('release', props.pageIndex + 1))
</script>
<template>
  <PagePointerProvider :document-id="documentId" :page-index="pageIndex" :scale="scale" class="relative h-full w-full">
    <PdfPageImage :key="attempt" :document-id="documentId" :page-index="pageIndex" :scale="scale" @load="rendered" @error="failedRender" />
    <div v-if="failed" role="alert" class="bg-card/95 absolute inset-x-0 top-0 z-10 flex flex-wrap items-center justify-center gap-2 p-3 text-sm">
      <span class="text-destructive">PDF 第 {{ pageIndex + 1 }} 页渲染失败，其他页面可继续阅读。</span>
      <Button variant="outline" size="sm" :aria-label="`重试第 ${pageIndex + 1} 页`" @click="attempt++">重试第 {{ pageIndex + 1 }} 页</Button>
    </div>
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
