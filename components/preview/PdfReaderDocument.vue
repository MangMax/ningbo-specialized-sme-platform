<script setup lang="ts">
import { computed, nextTick, shallowRef, watch } from 'vue'
import type { PdfEngine } from '@embedpdf/models'
import { useDocumentState } from '@embedpdf/core/vue'
import { useDocumentManagerCapability } from '@embedpdf/plugin-document-manager/vue'
import { Viewport, useViewportCapability } from '@embedpdf/plugin-viewport/vue'
import { Scroller, useScrollCapability } from '@embedpdf/plugin-scroll/vue'
import { useZoom, ZoomMode } from '@embedpdf/plugin-zoom/vue'
import { useSelectionCapability } from '@embedpdf/plugin-selection/vue'
import { Minus, Plus, PanelLeft, Moon, Sun } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAppColorMode } from '@/composables/useAppColorMode'
import PdfNavigationPanel from './PdfNavigationPanel.vue'
import PdfReaderPage from './PdfReaderPage.vue'
import type { PdfReadingPosition, PdfReadingMode } from '~~/lib/pdf-reader'
const props = defineProps<{ documentId: string; tools: boolean; engine: PdfEngine }>()
const emit = defineEmits<{ ready: [event: { totalPages: number }]; position: [position: PdfReadingPosition]; navigate: [position: PdfReadingPosition]; error: [message: string] }>()
const doc = useDocumentState(() => props.documentId)
const { provides: manager } = useDocumentManagerCapability()
const { provides: scroll } = useScrollCapability()
const { provides: viewport } = useViewportCapability()
const { provides: zoom, state: zoomState } = useZoom(() => props.documentId)
const { provides: selection } = useSelectionCapability()
const colorMode = useAppColorMode()
const sidebar = shallowRef(false)
const mode = shallowRef<PdfReadingMode>('continuous')
const singlePage = shallowRef(1)
const loaded = new Set<number>()
const layoutReady = shallowRef(false)
const position = shallowRef<PdfReadingPosition>({ page: 1, point: { x: 0, y: 0 } })
let restore: PdfReadingPosition | null = null
let singleRestore: PdfReadingPosition | null = null
const scale = computed(() => doc.value?.scale ?? 1)
const singleSize = computed(() => {
  const page = doc.value?.document?.pages[singlePage.value - 1]
  return { width: `${(page?.size.width ?? 0) * scale.value}px`, height: `${(page?.size.height ?? 0) * scale.value}px`, position: 'relative' as const, margin: '0 auto' }
})
watch(manager, (capability, _, cleanup) => {
  if (!capability) return
  cleanup(capability.onDocumentError(e => { if (e.documentId === props.documentId) emit('error', 'PDF 读取失败：文件不存在、损坏或引擎资源不可用。') }))
}, { immediate: true })
watch(scroll, (capability, _, cleanup) => {
  if (!capability) return
  const off = [
    capability.onLayoutReady(e => {
      if (e.documentId !== props.documentId) return
      if (!layoutReady.value) { layoutReady.value = true; emit('ready', { totalPages: e.totalPages }) }
      if (mode.value === 'continuous' && restore) { const target = restore; restore = null; navigate(target) }
    }),
    capability.onScroll(e => { if (e.documentId === props.documentId && mode.value === 'continuous') report() }),
  ]
  cleanup(() => off.forEach(fn => fn()))
}, { immediate: true })
function report() {
  if (mode.value === 'single') {
    if (!loaded.has(singlePage.value) || singleRestore) return
    const metrics = viewport.value?.forDocument(props.documentId).getMetrics()
    publish({ page: singlePage.value, point: { x: (metrics?.scrollLeft ?? 0) / scale.value, y: (metrics?.scrollTop ?? 0) / scale.value } })
    return
  }
  const metrics = scroll.value?.forDocument(props.documentId).getMetrics()
  if (!metrics || !loaded.has(metrics.currentPage) || restore) return
  const visible = metrics.pageVisibilityMetrics.find(p => p.pageNumber === metrics.currentPage)
  if (!visible || visible.visiblePercentage <= 0) return
  publish({ page: metrics.currentPage, point: { x: visible.original.pageX, y: visible.original.pageY } })
}
function publish(value: PdfReadingPosition) { position.value = value; emit('position', value) }
async function rendered(page: number) {
  loaded.add(page)
  if (mode.value === 'single' && singleRestore && singlePage.value === page) {
    const target = singleRestore; singleRestore = null
    await nextTick()
    viewport.value?.forDocument(props.documentId).scrollTo({ x: (target.point?.x ?? 0) * scale.value, y: (target.point?.y ?? 0) * scale.value, behavior: 'instant' })
  }
  report()
}
function navigate(target: PdfReadingPosition) {
  if (!layoutReady.value) return
  if (mode.value === 'single') {
    singlePage.value = target.page
    singleRestore = target
    if (loaded.has(target.page)) void rendered(target.page)
  } else scroll.value?.forDocument(props.documentId).scrollToPage({ pageNumber: target.page, pageCoordinates: target.point, behavior: 'instant' })
}
function changeMode(value: unknown) {
  if (value !== 'single' && value !== 'continuous' || value === mode.value) return
  const anchor = position.value
  if (value === 'single') { singlePage.value = anchor.page; singleRestore = anchor }
  else restore = anchor
  mode.value = value
}
watch(scale, () => { if (mode.value === 'single') singleRestore = position.value })
function choose(target: PdfReadingPosition) {
  // Keep controls on the application-owned navigation boundary.
  emit('navigate', target)
  if (window.matchMedia('(max-width: 639px)').matches) sidebar.value = false
}
function copy(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && !(event.target as HTMLElement).closest('input,textarea,[contenteditable="true"]')) selection.value?.forDocument(props.documentId).copyToClipboard()
}
defineExpose({ navigate })
</script>
<template>
  <div class="flex min-h-0 flex-1 flex-col" @keydown="copy">
    <div v-if="tools" class="pdf-tools flex flex-wrap items-center gap-1 border-b px-2 py-1" role="group" aria-label="阅读工具">
      <Button variant="ghost" size="sm" :aria-expanded="sidebar" @click="sidebar = !sidebar"><PanelLeft data-icon="inline-start" />导航</Button>
      <Button variant="ghost" size="icon-sm" aria-label="缩小" @click="zoom?.zoomOut()"><Minus /></Button>
      <span class="text-muted-foreground min-w-12 text-center text-sm tabular-nums">{{ Math.round(zoomState.currentZoomLevel * 100) }}%</span>
      <Button variant="ghost" size="icon-sm" aria-label="放大" @click="zoom?.zoomIn()"><Plus /></Button>
      <Button variant="ghost" size="sm" @click="zoom?.requestZoom(ZoomMode.FitWidth)">适合宽度</Button>
      <Button variant="ghost" size="sm" @click="zoom?.requestZoom(ZoomMode.FitPage)">适合页面</Button>
      <Tabs :model-value="mode" @update:model-value="changeMode"><TabsList aria-label="阅读模式"><TabsTrigger value="continuous">连续</TabsTrigger><TabsTrigger value="single">单页</TabsTrigger></TabsList></Tabs>
      <Button variant="ghost" size="icon-sm" aria-label="切换阅读主题" @click="colorMode = colorMode === 'dark' ? 'light' : 'dark'"><Sun v-if="colorMode === 'dark'" /><Moon v-else /></Button>
    </div>
    <div class="bg-muted relative flex min-h-0 flex-1 overflow-hidden">
      <PdfNavigationPanel v-if="sidebar && doc?.status === 'loaded'" class="pdf-navigation absolute inset-y-0 left-0 z-10 sm:static sm:shrink-0" :document-id="documentId" :engine="engine" :current-page="position.page" @navigate="choose" @close="sidebar = false" />
      <div class="min-h-0 min-w-0 flex-1">
        <Viewport v-if="doc?.status === 'loaded'" :document-id="documentId" class="h-full w-full" @scroll="mode === 'single' && report()">
          <Scroller v-if="mode === 'continuous'" :document-id="documentId">
            <template #default="{ page }">
              <div :style="{ width: `${page.width}px`, height: `${page.height}px`, position: 'relative' }" :aria-label="`PDF 第 ${page.pageNumber} 页`">
                <PdfReaderPage :key="`${page.pageIndex}:${scale}`" :document-id="documentId" :page-index="page.pageIndex" :scale="scale" @ready="rendered" @release="loaded.delete($event)" />
              </div>
            </template>
          </Scroller>
          <div v-else :style="singleSize" :aria-label="`PDF 第 ${singlePage} 页`">
            <PdfReaderPage :key="`${singlePage}:${scale}`" :document-id="documentId" :page-index="singlePage - 1" :scale="scale" @ready="rendered" @release="loaded.delete($event)" />
          </div>
        </Viewport>
      </div>
    </div>
  </div>
</template>
<style scoped>
@media (prefers-reduced-motion: no-preference) {
  .pdf-tools, .pdf-navigation { animation: reveal 120ms ease-out; }
}
@keyframes reveal { from { opacity: 0; } to { opacity: 1; } }
</style>
