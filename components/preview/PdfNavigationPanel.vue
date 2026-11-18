<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef, toRaw, watch } from 'vue'
import type { PdfBookmarkObject, PdfDestinationObject, PdfEngine } from '@embedpdf/models'
import { PdfActionType, PdfErrorCode, PdfZoomMode } from '@embedpdf/models'
import { useDocumentState } from '@embedpdf/core/vue'
import { ThumbnailsPane, ThumbImg } from '@embedpdf/plugin-thumbnail/vue'
import { useSearch } from '@embedpdf/plugin-search/vue'
import { Button } from '#core/app/components/ui/button'
import { Input } from '#core/app/components/ui/input'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '#core/app/components/ui/tabs'
import type { PdfReadingPosition } from '~~/lib/pdf-reader'
const props = defineProps<{ documentId: string; engine: PdfEngine; currentPage: number }>()
const emit = defineEmits<{ navigate: [position: PdfReadingPosition]; close: [] }>()
const tab = shallowRef('thumbnails')
const query = shallowRef('')
const searched = shallowRef(false)
const failure = shallowRef('')
const bookmarks = shallowRef<PdfBookmarkObject[]>([])
const outlineStatus = shallowRef('loading')
const doc = useDocumentState(() => props.documentId)
const { provides: search, state: searchState } = useSearch(() => props.documentId)
watch(() => doc.value?.document, (document, _, cleanup) => {
  if (!document) return
  let active = true
  // Core Vue state is reactive; worker messages must contain the raw PDF descriptor.
  const task = props.engine.getBookmarks(toRaw(document))
  task.wait(result => { if (active) { bookmarks.value = result.bookmarks; outlineStatus.value = 'ready' } }, () => { if (active) outlineStatus.value = 'error' })
  cleanup(() => { active = false; task.abort({ code: PdfErrorCode.Cancelled, message: 'reader closed' }) })
}, { immediate: true })
function destinationPosition(destination: PdfDestinationObject): PdfReadingPosition {
  const page = doc.value?.document?.pages[destination.pageIndex]
  let point: { x: number; y: number } | undefined
  // PDF destinations use bottom-left user space; scroll uses top-left page space.
  if (page && destination.zoom.mode === PdfZoomMode.XYZ) {
    const { x, y } = destination.zoom.params
    if (Number.isFinite(x) && Number.isFinite(y)) point = { x: Math.max(0, x), y: Math.max(0, page.size.height - y) }
  } else if (page) {
    const view = destination.view
    const mode = destination.zoom.mode
    const x = mode === PdfZoomMode.FitVertical || mode === PdfZoomMode.FitBoundingBoxVertical || mode === PdfZoomMode.FitRectangle ? view[0] : 0
    const top = mode === PdfZoomMode.FitHorizontal || mode === PdfZoomMode.FitBoundingBoxHorizontal ? view[0] : mode === PdfZoomMode.FitRectangle ? view[3] : undefined
    if (x !== undefined && Number.isFinite(x) && (top === undefined || Number.isFinite(top)) && (top !== undefined || mode === PdfZoomMode.FitVertical || mode === PdfZoomMode.FitBoundingBoxVertical)) point = { x: Math.max(0, x), y: top === undefined ? 0 : Math.max(0, page.size.height - top) }
  }
  return { page: destination.pageIndex + 1, ...(point ? { point } : {}) }
}
function flatten(items: PdfBookmarkObject[], depth = 0): { title: string; position?: PdfReadingPosition; depth: number }[] {
  return items.flatMap(item => {
    const target = item.target
    const destination = target?.type === 'destination' ? target.destination : target?.type === 'action' && target.action.type === PdfActionType.Goto ? target.action.destination : null
    return [{ title: item.title, position: destination ? destinationPosition(destination) : undefined, depth }, ...flatten(item.children ?? [], depth + 1)]
  })
}
const outline = computed(() => flatten(bookmarks.value))
let cancelSearch: (() => void) | null = null
function runSearch() {
  cancelSearch?.()
  failure.value = ''; searched.value = false
  if (!query.value.trim() || !search.value) { search.value?.stopSearch(); return }
  search.value.startSearch()
  const task = search.value.searchAllPages(query.value.trim())
  let active = true
  cancelSearch = () => { active = false; task.abort({ code: PdfErrorCode.Cancelled, message: 'search replaced' }) }
  task.wait(() => { if (active) searched.value = true }, () => { if (active) { failure.value = '文本搜索失败，请重试。'; searched.value = false } })
}
watch(query, () => { cancelSearch?.(); searched.value = false; search.value?.stopSearch() })
onBeforeUnmount(() => { cancelSearch?.(); search.value?.stopSearch() })
function choose(position: PdfReadingPosition) { emit('navigate', position) }
</script>
<template>
  <aside aria-label="PDF 导航" class="bg-card flex h-full w-64 max-w-full flex-col border-r shadow-sm">
    <div class="flex items-center justify-between px-2 py-1"><span class="text-sm font-medium">查阅导航</span><Button variant="ghost" size="sm" @click="emit('close')">收起</Button></div>
    <Tabs v-model="tab" class="flex min-h-0 flex-1 flex-col px-2 pb-2">
      <TabsList class="w-full" aria-label="导航方式"><TabsTrigger value="thumbnails">缩略图</TabsTrigger><TabsTrigger value="outline">目录</TabsTrigger><TabsTrigger value="search">搜索</TabsTrigger></TabsList>
      <TabsContent value="thumbnails" class="min-h-0 flex-1 overflow-hidden">
        <ThumbnailsPane :document-id="documentId" class="h-full">
          <template #default="{ meta }">
            <button type="button" :aria-label="`跳到第 ${meta.pageIndex + 1} 页`" :aria-current="currentPage === meta.pageIndex + 1 ? 'page' : undefined" class="pdf-thumbnail focus-visible:ring-ring absolute left-0 flex w-full flex-col items-center rounded text-sm focus-visible:ring-2" :style="{ top: `${meta.top}px`, height: `${meta.wrapperHeight}px`, paddingTop: `${meta.padding ?? 0}px` }" @click="choose({ page: meta.pageIndex + 1 })">
              <span class="pdf-thumbnail-image outline-border overflow-hidden rounded outline-2 -outline-offset-2" :style="{ width: `${meta.width}px`, height: `${meta.height}px` }"><ThumbImg :document-id="documentId" :meta="meta" class="size-full" /></span>
              <span class="flex shrink-0 items-center justify-center" :style="{ height: `${meta.labelHeight}px`, marginTop: `${meta.padding ?? 0}px` }">{{ meta.pageIndex + 1 }}</span>
            </button>
          </template>
        </ThumbnailsPane>
      </TabsContent>
      <TabsContent value="outline" class="min-h-0 flex-1 overflow-auto">
        <p v-if="outlineStatus === 'loading'" role="status" class="text-muted-foreground p-2 text-sm">正在读取目录…</p>
        <p v-else-if="outlineStatus === 'error'" role="alert" class="p-2 text-sm">无法读取目录，可用页码导航。</p>
        <p v-else-if="!outline.length" class="text-muted-foreground p-2 text-sm">这份 PDF 没有目录。</p>
        <ul v-else class="flex flex-col gap-1"><li v-for="(item, index) in outline" :key="index" :style="{ paddingLeft: `${Math.min(item.depth, 5) * 12}px` }"><Button variant="ghost" size="sm" class="h-auto w-full justify-start whitespace-normal text-left" :disabled="!item.position" @click="choose(item.position!)">{{ item.title }}<span v-if="item.position" class="text-muted-foreground ml-auto pl-2">{{ item.position.page }}</span></Button></li></ul>
      </TabsContent>
      <TabsContent value="search" class="flex min-h-0 flex-1 flex-col gap-2">
        <form class="flex gap-1" @submit.prevent="runSearch"><Input v-model="query" aria-label="搜索 PDF 文本" placeholder="查找原文" /><Button type="submit" size="sm" :disabled="!query.trim() || searchState.loading">查找</Button></form>
        <p v-if="searchState.loading" role="status" class="text-muted-foreground text-sm">正在搜索…</p>
        <p v-else-if="failure" role="alert" class="text-destructive text-sm">{{ failure }}</p>
        <p v-else-if="searched && !searchState.total" role="status" class="text-muted-foreground text-sm">未找到可提取文本的匹配。扫描件可用页图 / OCR 核对，此处不会执行 OCR。</p>
        <p v-else-if="searched" role="status" class="text-muted-foreground text-sm">找到 {{ searchState.total }} 处</p>
        <div class="min-h-0 flex-1 overflow-auto"><ul class="flex flex-col gap-1"><li v-for="(result, index) in searchState.results" :key="index"><Button variant="ghost" class="h-auto w-full flex-col items-start whitespace-normal text-left" @click="choose({ page: result.pageIndex + 1, point: result.rects[0]?.origin })"><span class="text-muted-foreground">第 {{ result.pageIndex + 1 }} 页</span><span>{{ result.context.before }}<strong>{{ result.context.match }}</strong>{{ result.context.after }}</span></Button></li></ul></div>
      </TabsContent>
    </Tabs>
  </aside>
</template>

<style scoped>
.pdf-thumbnail[aria-current="page"] .pdf-thumbnail-image { outline-color: var(--primary); box-shadow: 0 0 0 2px var(--background), 0 0 0 4px var(--ring); }
.pdf-thumbnail[aria-current="page"] { font-weight: 600; }
.pdf-thumbnail:hover .pdf-thumbnail-image { outline-color: var(--ring); }
@media (prefers-reduced-motion: no-preference) { .pdf-thumbnail { transition: transform 100ms ease-out; } .pdf-thumbnail:active { transform: scale(.98); } }
</style>
