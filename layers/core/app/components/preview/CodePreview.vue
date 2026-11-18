<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { Button } from '#core/app/components/ui/button'
import { highlightContent } from '#core/lib/content-highlight'
const props = withDefaults(defineProps<{ source: string; language?: string; theme?: 'light' | 'dark'; wrap?: boolean; copyable?: boolean; focusable?: boolean }>(), { language: 'text', theme: 'light', wrap: false, copyable: false, focusable: false })
const emit = defineEmits<{ error: [message: string] }>()
const html = ref<string | null>(null)
const message = ref('')
const root = ref<HTMLElement | null>(null)
watch(() => [props.source, props.language, props.theme] as const, async ([source, language, theme], _, onCleanup) => {
  let current = true
  onCleanup(() => { current = false })
  html.value = null
  message.value = ''
  try {
    const result = await highlightContent(source, language, theme)
    if (current) html.value = result
  } catch {
    if (current) { message.value = '高亮暂不可用，已显示原文。'; emit('error', message.value) }
  }
}, { immediate: true })

/**
 * Shiki renders its own `<pre>`; the fallback path has a plain one. Make the
 * actual horizontal scroller keyboard reachable when the caller opts in (the OCR
 * workbench), without changing tab order for other previews.
 */
watch([html, () => props.focusable], async () => {
  await nextTick()
  const pre = root.value?.querySelector('pre')
  if (!pre) return
  if (props.focusable) {
    pre.setAttribute('tabindex', '0')
    pre.setAttribute('role', 'region')
    pre.setAttribute('aria-label', '源码（可横向滚动）')
    pre.classList.add('scroll-focus-ring')
  } else {
    pre.removeAttribute('tabindex')
    pre.removeAttribute('role')
    pre.removeAttribute('aria-label')
    pre.classList.remove('scroll-focus-ring')
  }
}, { immediate: true })
async function copy() {
  try { await navigator.clipboard.writeText(props.source); message.value = '已复制代码原文' }
  catch { message.value = '复制失败，请选择源码复制。' }
}
</script>

<template>
  <div ref="root" class="code-preview min-w-0" :class="{ 'wrap-code': wrap }">
    <div v-if="copyable" class="mb-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>{{ language || '纯文本' }}</span><Button variant="ghost" size="sm" @click="copy">复制代码</Button>
    </div>
    <p v-if="message" role="status" class="text-muted-foreground text-xs">{{ message }}</p>
    <div v-if="html" class="highlight-output" v-html="html" />
    <pre v-else><code>{{ source }}</code></pre>
  </div>
</template>

<style scoped>
.code-preview :deep(pre) { margin: 0; overflow: auto; padding: 1rem; font-size: var(--code-font-size, .8125rem); line-height: 1.7; tab-size: 2; }
.wrap-code :deep(pre), .wrap-code :deep(code) { white-space: pre-wrap; overflow-wrap: anywhere; }
:deep(pre.scroll-focus-ring:focus-visible) { outline: 2px solid var(--ring); outline-offset: -2px; }
</style>
