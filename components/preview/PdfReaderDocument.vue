<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, shallowRef, useTemplateRef, watch } from 'vue'
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
import { usePdfPageImages } from '@/composables/usePdfPageImages'
import type { PdfNavigationOptions, PdfReadingPosition, PdfReadingMode } from '~~/lib/pdf-reader'
const props = defineProps<{ documentId: string; tools: boolean; engine: PdfEngine }>()
const emit = defineEmits<{ ready: [event: { totalPages: number }]; position: [position: PdfReadingPosition]; navigate: [position: PdfReadingPosition]; error: [message: string] }>()
const doc = useDocumentState(() => props.documentId)
const { provides: manager } = useDocumentManagerCapability()
const { provides: scroll } = useScrollCapability()
const { provides: viewport } = useViewportCapability()
const { provides: zoom, state: zoomState } = useZoom(() => props.documentId)
const { provides: selection } = useSelectionCapability()
const colorMode = useAppColorMode()
const root = useTemplateRef<HTMLElement>('root')
const navigationToggle = useTemplateRef<{ $el: HTMLButtonElement }>('navigationToggle')
const sidebar = shallowRef(false)
const sidebarVisited = shallowRef(false)
watch(sidebar, open => { if (open) sidebarVisited.value = true })
function closeSidebar() {
  sidebar.value = false
  navigationToggle.value?.$el?.focus()
}
const mode = shallowRef<PdfReadingMode>('continuous')
const singlePage = shallowRef(1)
const loaded = new Set<number>()
const layoutReady = shallowRef(false)
const images = usePdfPageImages(props.documentId)
const pendingTarget = shallowRef<PdfReadingPosition | null>(null)
const navigationFailure = shallowRef<PdfReadingPosition | null>(null)
let request = 0
let moving = false
let awaitingScroll = false
let preferred: { page: number; offset: { x: number; y: number } } | null = null
let prepared: ReturnType<typeof images.acquire> | null = null
let frame = 0
const pageSurface = useTemplateRef<HTMLElement>('pageSurface')
let arrival: Animation | undefined
function cancelNavigation() {
  request++; pendingTarget.value = null; moving = false; awaitingScroll = false
  prepared?.release(); prepared = null
  cancelAnimationFrame(frame); arrival?.cancel()
}
onBeforeUnmount(cancelNavigation)
watch(viewport, (capability, _, cleanup) => {
  if (capability) cleanup(capability.onScrollActivity(e => {
    if (e.documentId === props.documentId && !e.activity.isSmoothScrolling) report()
  }))
}, { immediate: true })
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
  if (awaitingScroll || pendingTarget.value && !moving) return
  if (mode.value === 'single') {
    if (!loaded.has(singlePage.value) || singleRestore) return
    if (pendingTarget.value && pendingTarget.value.page !== singlePage.value) return
    finishNavigation()
    const metrics = viewport.value?.forDocument(props.documentId).getMetrics()
    publish({ page: singlePage.value, point: { x: (metrics?.scrollLeft ?? 0) / scale.value, y: (metrics?.scrollTop ?? 0) / scale.value } })
    return
  }
  const metrics = scroll.value?.forDocument(props.documentId).getMetrics()
  if (!metrics || restore) return
  if (preferred && (Math.abs(metrics.scrollOffset.x - preferred.offset.x) > 1 || Math.abs(metrics.scrollOffset.y - preferred.offset.y) > 1)) preferred = null
  const requestedPage = pendingTarget.value?.page ?? preferred?.page
  const requested = requestedPage && metrics.pageVisibilityMetrics.find(p => p.pageNumber === requestedPage && p.visiblePercentage > 0 && loaded.has(p.pageNumber))
  const visible = requested || metrics.pageVisibilityMetrics.find(p => p.pageNumber === metrics.currentPage)
  if (!visible || visible.visiblePercentage <= 0 || !loaded.has(visible.pageNumber)) return
  if (pendingTarget.value) {
    if (visible.pageNumber !== pendingTarget.value.page || viewport.value?.forDocument(props.documentId).isSmoothScrolling()) return
    preferred = { page: visible.pageNumber, offset: { ...metrics.scrollOffset } }
  }
  finishNavigation()
  publish({ page: visible.pageNumber, point: { x: visible.original.pageX, y: visible.original.pageY } })
}
function finishNavigation() {
  if (!pendingTarget.value) return
  pendingTarget.value = null; moving = false; prepared?.release(); prepared = null
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
async function navigate(target: PdfReadingPosition, options: PdfNavigationOptions = {}) {
  if (!layoutReady.value) return
  cancelNavigation()
  navigationFailure.value = null
  pendingTarget.value = target
  const owner = request
  const readingMode = mode.value
  const lease = images.acquire(target.page - 1, scale.value)
  prepared = lease
  try {
    await lease.ready
    if (owner !== request) return
    moving = true
    awaitingScroll = mode.value === 'continuous'
    const animate = options.animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const adjacent = Math.abs(target.page - position.value.page) <= 1
    if (mode.value === 'single') {
      singleRestore = target
      singlePage.value = target.page
      await nextTick()
      if (loaded.has(target.page)) await rendered(target.page)
    } else {
      scroll.value?.forDocument(props.documentId).scrollToPage({ pageNumber: target.page, pageCoordinates: target.point, behavior: animate && adjacent && !target.point ? 'smooth' : 'instant' })
    }
    if (owner !== request || readingMode !== mode.value) return
    if (animate && (mode.value === 'single' || !adjacent)) {
      arrival?.cancel()
      arrival = pageSurface.value?.animate?.([{ opacity: .8, transform: `translateY(${target.page >= position.value.page ? 8 : -8}px)` }, { opacity: 1, transform: 'translateY(0)' }], { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' })
    }
    // A no-distance scroll may emit no activity. Frames only recheck real metrics
    // and image loads; they never substitute for smooth-scroll completion.
    frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => { if (owner === request) { awaitingScroll = false; report() } }) })
  } catch {
    if (owner === request) { pendingTarget.value = null; moving = false; navigationFailure.value = target; lease.release(); prepared = null }
  }
}
function changeMode(value: unknown) {
  if (value !== 'single' && value !== 'continuous' || value === mode.value) return
  const anchor = pendingTarget.value ?? position.value
  cancelNavigation()
  if (value === 'single') { singlePage.value = anchor.page; singleRestore = anchor }
  else restore = anchor
  mode.value = value
}
watch(scale, () => {
  if (pendingTarget.value) void navigate(pendingTarget.value)
  else if (mode.value === 'single') singleRestore = position.value
})
function choose(target: PdfReadingPosition) {
  // Keep controls on the application-owned navigation boundary.
  emit('navigate', target)
  if ((root.value?.clientWidth ?? 0) < 768) closeSidebar()
}
function copy(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && !(event.target as HTMLElement).closest('input,textarea,[contenteditable="true"]')) selection.value?.forDocument(props.documentId).copyToClipboard()
}
defineExpose({ navigate })
</script>
<template>
  <div ref="root" class="pdf-document flex min-h-0 flex-1 flex-col" @keydown="copy">
    <div role="group" aria-label="阅读工具" class="pdf-tools-shell" :data-open="tools" :inert="!tools" :aria-hidden="!tools"><div class="pdf-tools-clip">
    <div class="pdf-tools flex flex-wrap items-center gap-1 border-b px-2 py-1">
      <Button ref="navigationToggle" variant="ghost" size="sm" :aria-expanded="sidebar" @click="sidebar = !sidebar"><PanelLeft data-icon="inline-start" />导航</Button>
      <Button variant="ghost" size="icon-sm" aria-label="缩小" @click="zoom?.zoomOut()"><Minus /></Button>
      <span class="text-muted-foreground min-w-12 text-center text-sm tabular-nums">{{ Math.round(zoomState.currentZoomLevel * 100) }}%</span>
      <Button variant="ghost" size="icon-sm" aria-label="放大" @click="zoom?.zoomIn()"><Plus /></Button>
      <Button variant="ghost" size="sm" @click="zoom?.requestZoom(ZoomMode.FitWidth)">适合宽度</Button>
      <Button variant="ghost" size="sm" @click="zoom?.requestZoom(ZoomMode.FitPage)">适合页面</Button>
      <Tabs :model-value="mode" @update:model-value="changeMode"><TabsList aria-label="阅读模式"><TabsTrigger value="continuous">连续</TabsTrigger><TabsTrigger value="single">单页</TabsTrigger></TabsList></Tabs>
      <Button variant="ghost" size="icon-sm" aria-label="切换阅读主题" @click="colorMode = colorMode === 'dark' ? 'light' : 'dark'"><Sun v-if="colorMode === 'dark'" /><Moon v-else /></Button>
    </div>
    </div></div>
    <div class="bg-muted relative flex min-h-0 flex-1 overflow-hidden">
      <div class="pdf-navigation" :data-open="sidebar && tools" :inert="!sidebar || !tools" :aria-hidden="!sidebar || !tools" @keydown.esc.stop="closeSidebar">
      <PdfNavigationPanel v-if="sidebarVisited && doc?.status === 'loaded'" :document-id="documentId" :engine="engine" :current-page="position.page" @navigate="choose" @close="closeSidebar" />
      </div>
      <div ref="pageSurface" class="relative min-h-0 min-w-0 flex-1" :aria-busy="!!pendingTarget">
        <p v-if="pendingTarget" role="status" class="bg-card/95 pointer-events-none absolute inset-x-0 top-0 z-10 px-3 py-1 text-center text-sm">正在前往第 {{ pendingTarget.page }} 页…</p>
        <div v-if="navigationFailure" role="alert" class="bg-card/95 absolute inset-x-0 top-0 z-10 flex items-center justify-center gap-2 p-2 text-sm"><span>第 {{ navigationFailure.page }} 页未能加载，保留当前页。</span><Button variant="outline" size="sm" @click="navigate(navigationFailure, { animate: true })">重试跳页</Button></div>
        <!-- Reserve the vertical gutter even when all pages fit. Otherwise fit-mode
             zoom can toggle the scrollbar and alternate between two viewport sizes. -->
        <Viewport v-if="doc?.status === 'loaded'" :document-id="documentId" class="h-full w-full" style="scrollbar-gutter: stable" @scroll="mode === 'single' && report()">
          <Scroller v-if="mode === 'continuous'" :document-id="documentId">
            <template #default="{ page }">
              <div :style="{ width: `${page.width}px`, height: `${page.height}px`, position: 'relative' }" :aria-label="`PDF 第 ${page.pageNumber} 页`">
                <PdfReaderPage :key="page.pageIndex" :document-id="documentId" :page-index="page.pageIndex" :scale="scale" @ready="rendered" @release="loaded.delete($event)" />
              </div>
            </template>
          </Scroller>
          <div v-else :style="singleSize" :aria-label="`PDF 第 ${singlePage} 页`">
            <PdfReaderPage :key="singlePage" :document-id="documentId" :page-index="singlePage - 1" :scale="scale" @ready="rendered" @release="loaded.delete($event)" />
          </div>
        </Viewport>
      </div>
    </div>
  </div>
</template>
<style scoped>
.pdf-document { container: pdf-reader / inline-size; }
.pdf-tools-shell { display: grid; grid-template-rows: 0fr; opacity: 0; transition: grid-template-rows 150ms ease-in, opacity 150ms ease-in; }
.pdf-tools-shell[data-open="true"] { grid-template-rows: 1fr; opacity: 1; transition-duration: 220ms; transition-timing-function: cubic-bezier(.2,.8,.2,1); }
.pdf-tools-clip { min-height: 0; overflow: hidden; }
.pdf-tools { transform: translateY(-8px); transition: transform 150ms ease-in; }
.pdf-tools-shell[data-open="true"] .pdf-tools { transform: translateY(0); transition-duration: 220ms; }
.pdf-navigation { flex-shrink: 0; width: 0; overflow: hidden; opacity: 0; transition: width 180ms ease-in, opacity 180ms ease-in; }
.pdf-navigation[data-open="true"] { width: 16rem; opacity: 1; transition-duration: 280ms; transition-timing-function: cubic-bezier(.2,.8,.2,1); }
@container pdf-reader (max-width: 767px) {
  .pdf-navigation { position: absolute; inset: 0 auto 0 0; z-index: 10; width: min(16rem, 100%); transform: translateX(-100%); transition: transform 180ms ease-in, opacity 180ms ease-in; }
  .pdf-navigation[data-open="true"] { width: min(16rem, 100%); transform: translateX(0); transition-duration: 280ms; }
}
@media (prefers-reduced-motion: reduce) {
  .pdf-tools-shell, .pdf-tools, .pdf-navigation { transition: none; }
}
</style>
