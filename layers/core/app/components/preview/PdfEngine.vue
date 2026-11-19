<script setup lang="ts">
import { inject, onMounted, onBeforeUnmount, shallowRef, useTemplateRef } from 'vue'
import { describeLoadError } from '#core/lib/preview'
import { createEmbedPdfLogger } from '#core/lib/client-logging/embedpdf'
import { clientLibraryReporterKey, ignoreClientLibrarySignal, safeLibraryReporter } from '#core/lib/client-logging/library-reporter'
import { EmbedPDF } from '@embedpdf/core/vue'
import { createPluginRegistration } from '@embedpdf/core'
import type { PdfEngine } from '@embedpdf/models'
import { DocumentManagerPluginPackage } from '@embedpdf/plugin-document-manager/vue'
import { ViewportPluginPackage } from '@embedpdf/plugin-viewport/vue'
import { ScrollPluginPackage } from '@embedpdf/plugin-scroll/vue'
import { RenderPluginPackage } from '@embedpdf/plugin-render/vue'
import { ZoomPluginPackage, ZoomMode } from '@embedpdf/plugin-zoom/vue'
import { ThumbnailPluginPackage } from '@embedpdf/plugin-thumbnail/vue'
import { SearchPluginPackage } from '@embedpdf/plugin-search/vue'
import { SelectionPluginPackage } from '@embedpdf/plugin-selection/vue'
import { InteractionManagerPluginPackage } from '@embedpdf/plugin-interaction-manager/vue'
import PdfReaderDocument from './PdfReaderDocument.vue'
import type { PdfNavigationOptions, PdfReadingPosition } from '#core/lib/pdf-reader'
const props = defineProps<{ src: string; tools: boolean }>()
const emit = defineEmits<{ ready: [event: { totalPages: number }]; position: [position: PdfReadingPosition]; navigate: [position: PdfReadingPosition]; error: [message: string] }>()
const engine = shallowRef<PdfEngine | null>(null)
const documentView = useTemplateRef('documentView')
let alive = true
const reportLibrary = safeLibraryReporter(inject(clientLibraryReporterKey, ignoreClientLibrarySignal))
const logger = createEmbedPdfLogger(signal => { if (alive) reportLibrary(signal) })
const registryConfig = { logger }
const startup = new AbortController()
const plugins = [
  createPluginRegistration(DocumentManagerPluginPackage, { initialDocuments: [{ url: props.src, documentId: 'reader' }] }),
  createPluginRegistration(ViewportPluginPackage),
  createPluginRegistration(ScrollPluginPackage, { defaultBufferSize: 2 }),
  createPluginRegistration(RenderPluginPackage),
  createPluginRegistration(ZoomPluginPackage, { defaultZoomLevel: ZoomMode.FitPage }),
  createPluginRegistration(InteractionManagerPluginPackage),
  createPluginRegistration(SelectionPluginPackage),
  createPluginRegistration(SearchPluginPackage),
  createPluginRegistration(ThumbnailPluginPackage, { width: 150, gap: 12, buffer: 3, labelHeight: 30, imagePadding: 2, paddingY: 12, scrollBehavior: 'instant' }),
]
onMounted(async () => {
  try {
    if (new URL(props.src, window.location.origin).origin === window.location.origin) {
      const source = await fetch(props.src, { headers: { Range: 'bytes=0-0' }, signal: startup.signal, cache: 'no-store' })
      if (!source.ok) {
        const body = await source.json().catch(() => null)
        if (alive) emit('error', describeLoadError(new Error(body?.data?.code ?? body?.message ?? String(source.status))))
        return
      }
      await source.body?.cancel()
    }
    const wasmUrl = new URL('/pdfium.wasm', window.location.origin).href
    // In 2.15.1 a rejected worker WASM initialization can leave document tasks pending.
    // Validate the same-origin asset before creating the worker. Its subsequent fetch
    // can use the HTTP cache; theme and layout changes never repeat this initialization.
    const response = await fetch(wasmUrl, { signal: startup.signal })
    if (!response.ok || !WebAssembly.validate(await response.arrayBuffer())) throw new Error('Invalid PDFium resource')
    if (!alive) return
    const { createPdfiumEngine } = await import('@embedpdf/engines/pdfium-worker-engine')
    if (!alive) return
    engine.value = createPdfiumEngine(wasmUrl, { fontFallback: null, logger })
  } catch { if (alive) { reportLibrary('pdf_startup_failure'); emit('error', 'PDF 引擎资源加载失败，请重试。') } }
})
onBeforeUnmount(() => { alive = false; startup.abort(); engine.value?.destroy?.(); engine.value = null })
function navigate(position: PdfReadingPosition, options?: PdfNavigationOptions) { documentView.value?.navigate(position, options) }
function documentReady(event: { totalPages: number }) { if (alive) reportLibrary('pdf_document_ready'); emit('ready', event) }
function documentError(message: string) { if (alive) reportLibrary('pdf_document_failure'); emit('error', message) }
defineExpose({ navigate })
</script>
<template>
  <EmbedPDF v-if="engine" :engine="engine" :plugins="plugins" :config="registryConfig" class="flex min-h-0 flex-1 flex-col">
    <PdfReaderDocument ref="documentView" document-id="reader" :tools="tools" :engine="engine" @ready="documentReady" @position="emit('position', $event)" @navigate="emit('navigate', $event)" @error="documentError" />
  </EmbedPDF>
</template>
