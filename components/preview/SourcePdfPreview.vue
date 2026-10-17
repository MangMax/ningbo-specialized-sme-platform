<script setup lang="ts">
import { computed, shallowRef, watch, useTemplateRef, nextTick } from 'vue'
import PdfPreview from './PdfPreview.vue'
import PageImageGallery from './PageImageGallery.vue'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { fileUrl } from '~~/lib/preview'
import type { PdfReadingPosition, PdfPositionEvent, PdfNavigationRequest, PdfReadyEvent } from '~~/lib/pdf-reader'

const props = defineProps<{ file: string; name: string; sourcePage: number | null; target?: PdfReadingPosition; invalid?: string; view?: string }>()
const emit = defineEmits<{ visible: [position: PdfReadingPosition, explicit: boolean]; 'view-change': [view: string] }>()
const reader = useTemplateRef('reader')
const view = shallowRef(props.view === 'pages' ? 'pages' : 'pdf')
const originalOpened = shallowRef(view.value === 'pdf')
const total = shallowRef(0)
const actual = shallowRef<PdfReadingPosition | null>(null)
const target = shallowRef(props.target)
const pending = shallowRef(props.target)
const explicit = shallowRef(false)
const error = shallowRef('')
const galleryPage = shallowRef<number | null>(null)
const src = computed(() => fileUrl(props.file))
watch(() => props.target, value => { target.value = value; pending.value = value; galleryPage.value = value?.page ?? null; explicit.value = false; error.value = '' })
watch(() => props.view, value => { view.value = value === 'pages' ? 'pages' : 'pdf'; if (view.value === 'pdf') originalOpened.value = true })
const outOfRange = computed(() => pending.value && total.value && pending.value.page > total.value)
const sourceOutOfRange = computed(() => props.sourcePage !== null && total.value > 0 && props.sourcePage > total.value)
const status = computed(() => {
  if (props.invalid) return props.invalid
  if (sourceOutOfRange.value) return `来源第 ${props.sourcePage} 页不存在。该 PDF 共 ${total.value} 页，请检查来源页码。`
  if (outOfRange.value) return `第 ${pending.value!.page} 页不存在。该 PDF 共 ${total.value} 页，请检查来源页码。`
  if (error.value) return `定位未完成：${error.value}`
  if (props.sourcePage === null) return '来源页码待核'
  if (actual.value?.page === props.sourcePage) return `已定位来源第 ${props.sourcePage} 页`
  if (!actual.value || pending.value?.page === props.sourcePage) return `正在定位来源第 ${props.sourcePage} 页…`
  return `来源第 ${props.sourcePage} 页 · 当前浏览第 ${actual.value.page} 页`
})
const statusNeedsSpace = computed(() => !!(props.invalid || sourceOutOfRange.value || outOfRange.value || error.value || props.sourcePage === null || !actual.value || pending.value))
function ready(event: PdfReadyEvent) { if (event.src === src.value) total.value = event.totalPages }
function navigation(event: PdfNavigationRequest) {
  if (event.src !== src.value) return
  pending.value = { page: event.page, point: event.point }
  explicit.value = true; error.value = ''
}
function visible(event: PdfPositionEvent) {
  if (event.src !== src.value || view.value !== 'pdf') return
  actual.value = { page: event.page, ...(event.point ? { point: event.point } : {}) }
  if (pending.value && pending.value.page !== event.page) return
  if (props.invalid && !explicit.value) return
  pending.value = undefined
  error.value = ''
  emit('visible', actual.value, explicit.value)
  explicit.value = false
}
function galleryVisible(page: number) {
  if (view.value !== 'pages') return
  galleryPage.value = page
  // Gallery events include initialization/external restores: synchronize by replace,
  // without adding a reader visit or claiming an original-PDF render.
  emit('visible', { page }, false)
}
async function returnToSource() {
  if (!props.sourcePage) return
  originalOpened.value = true; view.value = 'pdf'; emit('view-change', 'pdf')
  await nextTick()
  reader.value?.navigate({ page: props.sourcePage }, 'explicit')
}
async function changeView(value: string | number) {
  view.value = String(value)
  if (view.value === 'pdf') originalOpened.value = true
  emit('view-change', view.value)
  if (view.value === 'pages') galleryPage.value = actual.value?.page ?? target.value?.page ?? null
  else if (galleryPage.value !== null) {
    pending.value = { page: galleryPage.value }; explicit.value = false
    await nextTick()
    reader.value?.navigate(pending.value!)
  }
}
</script>

<template>
  <div class="flex min-w-0 flex-col gap-3">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <Tabs :model-value="view" @update:model-value="changeView">
        <TabsList aria-label="来源 PDF 视图"><TabsTrigger value="pdf">原文</TabsTrigger><TabsTrigger value="pages">页图核对</TabsTrigger></TabsList>
      </Tabs>
      <Button v-if="sourcePage !== null" variant="outline" size="sm" :disabled="sourceOutOfRange" @click="returnToSource">回到来源第 {{ sourcePage }} 页</Button>
    </div>
    <Alert v-if="view === 'pdf' && statusNeedsSpace" :variant="invalid || outOfRange || sourceOutOfRange || error ? 'destructive' : 'default'">
      <AlertDescription role="status" aria-live="polite">{{ status }}</AlertDescription>
    </Alert>
    <span v-else-if="view === 'pdf'" role="status" aria-live="polite" class="sr-only">{{ status }}</span>
    <div v-if="originalOpened" v-show="view === 'pdf'" class="flex h-[75vh] min-h-96 flex-col">
      <ClientOnly>
        <PdfPreview ref="reader" :src="src" :name="name" :target-position="target" @ready="ready" @navigation-request="navigation" @position-change="visible" @error="error = $event" />
      </ClientOnly>
    </div>
    <PageImageGallery v-if="view === 'pages'" class="h-[75vh] min-h-96" :file="file" :page="galleryPage ?? target?.page" @page-change="galleryVisible" />
  </div>
</template>
