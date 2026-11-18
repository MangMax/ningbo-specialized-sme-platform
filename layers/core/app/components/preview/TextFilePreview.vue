<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { Button } from '#core/app/components/ui/button'
import ContentPreview from './ContentPreview.vue'
import PreviewStates from './PreviewStates.vue'
import { describeLoadError, retrySrc } from '#core/lib/preview'
const props = withDefaults(defineProps<{ src: string; name?: string; hideName?: boolean; format: 'markdown' | 'text'; language?: string }>(), { name: '', language: 'text' })
const emit = defineEmits<{ error: [message: string] }>()
const mounted = ref(false)
const attempt = ref(0)
const source = ref('')
const loadedSrc = ref('')
const loadedName = ref('')
const loadedFormat = ref(props.format)
const loadedLanguage = ref(props.language)
const status = ref<'loading' | 'ready' | 'error'>('loading')
const error = ref('')
const downloadSrc = ref('')
onMounted(() => { mounted.value = true })
watch(() => props.src, () => { attempt.value = 0 })
watch(() => [props.src, attempt.value, mounted.value] as const, async ([src, retry, active], _, onCleanup) => {
  if (!active) return
  const controller = new AbortController()
  let current = true
  onCleanup(() => { current = false; controller.abort() })
  const targetName = props.name || src
  const targetFormat = props.format
  const targetLanguage = props.language
  status.value = 'loading'
  error.value = ''
  downloadSrc.value = ''
  try {
    const url = new URL(src, location.origin)
    const sameOrigin = url.origin === location.origin
    if (!sameOrigin || !['http:', 'https:', 'blob:'].includes(url.protocol) || url.username || url.password) throw new Error('只支持同源文件或当前页面创建的 blob 地址。')
    downloadSrc.value = url.href
    const response = await fetch(retrySrc(url.href, retry), { signal: controller.signal, credentials: 'same-origin', redirect: 'error', cache: retry ? 'reload' : 'default' })
    if (!response.ok) {
      const body = await response.json().catch(() => null)
      throw new Error(body?.data?.code ?? body?.message ?? String(response.status))
    }
    if (Number(response.headers.get('content-length')) > 5_000_000) { await response.body?.cancel(); throw new Error('文本超过 5 MB，请下载原文查看。') }
    const reader = response.body?.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    if (reader) {
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          bytes += chunk.value.byteLength
          if (bytes > 5_000_000) { await reader.cancel(); throw new Error('文本超过 5 MB，请下载原文查看。') }
          chunks.push(chunk.value)
        }
      } finally { reader.releaseLock() }
    }
    const buffer = new Uint8Array(bytes)
    let offset = 0
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength }
    const text = new TextDecoder().decode(buffer)
    if (text.includes('\0')) throw new Error('文件包含二进制内容，无法作为文本预览。')
    if (current) { source.value = text; loadedSrc.value = src; loadedName.value = targetName; loadedFormat.value = targetFormat; loadedLanguage.value = targetLanguage; status.value = 'ready' }
  } catch (cause) {
    if (current) { error.value = describeLoadError(cause); status.value = 'error'; emit('error', error.value) }
  }
}, { immediate: true })
</script>

<template>
  <div class="bg-card flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border">
    <div v-if="status !== 'ready'" class="flex min-h-48 flex-col">
      <p class="border-b px-4 py-2 text-xs">{{ name || src }}</p>
      <PreviewStates :status="status" :message="error" :retryable="status === 'error'" @retry="attempt++" />
      <Button v-if="status === 'error' && downloadSrc" as-child variant="ghost" size="sm" class="mx-auto mb-4"><a :href="downloadSrc" :download="name || true">下载原文</a></Button>
    </div>
    <p v-if="loadedSrc && status !== 'ready'" class="border-b px-4 py-2 text-xs text-muted-foreground">仍显示上次读取的 {{ loadedName }}；目标文件：{{ name || src }}。</p>
    <ContentPreview v-if="loadedSrc" class="min-h-0 flex-1 border-0" :source="source" :name="loadedName" :hide-name="hideName" :format="loadedFormat" :language="loadedLanguage" @error="emit('error', $event)" />
  </div>
</template>
