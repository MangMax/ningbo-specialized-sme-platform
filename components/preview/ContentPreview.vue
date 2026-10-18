<script setup lang="ts">
import { computed, onErrorCaptured, onMounted, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import CodePreview from './CodePreview.vue'
import MarkdownPreview from './MarkdownPreview.vue'

const props = withDefaults(defineProps<{
  source: string
  format?: 'markdown' | 'text'
  language?: string
  name?: string
  context?: string
  hideName?: boolean
  theme?: 'light' | 'dark'
  mode?: 'rendered' | 'source'
  readonly?: boolean
  resources?: Readonly<Record<string, string>>
  /** Hide the built-in toolbar when the caller owns a compact pane header. */
  hideToolbar?: boolean
  /** Initial/controlled soft-wrap state. Defaults keep the shared preview unchanged. */
  wrap?: boolean
  /** Extra class for the scrollable content area, used by the OCR panes. */
  contentClass?: string
  /**
   * Make the horizontal scroll surface keyboard reachable (tabindex + region
   * name + visible focus). Opt-in: the OCR workbench needs it, other previews
   * keep their existing tab order.
   */
  focusableContent?: boolean
}>(), { format: 'markdown', language: '', name: '正文.md', theme: 'light', mode: 'rendered', readonly: true, hideToolbar: false, wrap: false, contentClass: '', focusableContent: false })
const emit = defineEmits<{ 'update:mode': [mode: 'rendered' | 'source']; copy: [source: string]; error: [message: string] }>()
const mounted = ref(false)
onMounted(() => { mounted.value = true })
const mode = ref(props.mode)
const wrap = ref(props.wrap)
const localTheme = ref(props.theme)
const failed = ref(false)
const message = ref('')
const language = computed(() => props.language || (props.format === 'markdown' ? 'markdown' : 'text'))
const tooLarge = computed(() => props.source.length > 200_000)
const rendered = computed(() => mounted.value && props.format === 'markdown' && mode.value === 'rendered' && !failed.value && !tooLarge.value)
watch(() => props.mode, value => { mode.value = value })
watch(() => props.wrap, value => { wrap.value = value })
watch(() => props.theme, value => { localTheme.value = value })
watch(() => props.source, () => { failed.value = false; message.value = '' })
function changeMode() { mode.value = mode.value === 'rendered' ? 'source' : 'rendered'; emit('update:mode', mode.value) }
onErrorCaptured(() => {
  failed.value = true
  message.value = '渲染失败，已保留源码。'
  emit('error', message.value)
  return false
})
async function copy() {
  try { await navigator.clipboard.writeText(props.source); message.value = '已复制原文'; emit('copy', props.source) }
  catch { message.value = '复制失败，请切换源码后选择复制。'; emit('error', message.value) }
}
function download() {
  const url = URL.createObjectURL(new Blob([props.source], { type: 'text/plain;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = props.name
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
</script>

<template>
  <section
    class="content-preview text-card-foreground flex min-h-0 min-w-0 flex-col overflow-hidden"
    :class="[
      hideToolbar ? 'bg-transparent' : 'bg-card rounded-lg border',
      { 'preview-dark': localTheme === 'dark' },
    ]"
    :data-theme="localTheme"
    :aria-label="name"
  >
    <div v-if="!hideToolbar" role="toolbar" aria-label="正文预览操作" class="bg-card flex shrink-0 flex-wrap items-center gap-1 border-b px-2 py-1">
      <div class="flex min-w-0 basis-full items-center gap-2">
        <template v-if="context">
          <span class="min-w-0 flex-1 truncate text-xs font-medium" :title="context">{{ context }}</span>
          <span class="shrink-0 text-xs font-medium">{{ name }}</span>
        </template>
        <template v-else>
          <span v-if="!hideName" class="truncate text-xs font-medium" :title="name">{{ name }}</span>
          <span class="text-muted-foreground shrink-0 text-xs">{{ format === 'markdown' ? 'Markdown 文档' : '代码 / 纯文本' }} · {{ language }}</span>
        </template>
      </div>
      <Button v-if="format === 'markdown'" variant="ghost" size="sm" :aria-pressed="mode === 'source'" @click="changeMode">{{ mode === 'rendered' ? '查看源码' : '渲染预览' }}</Button>
      <Button variant="ghost" size="sm" @click="copy">复制原文</Button>
      <DropdownMenu>
        <DropdownMenuTrigger as-child><Button variant="ghost" size="sm">更多操作</Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>
            <DropdownMenuItem @select="wrap = !wrap">{{ wrap ? '取消换行' : '自动换行' }}</DropdownMenuItem>
            <DropdownMenuItem @select="localTheme = localTheme === 'light' ? 'dark' : 'light'">{{ localTheme === 'light' ? '深色主题' : '浅色主题' }}</DropdownMenuItem>
            <DropdownMenuItem @select="download">下载</DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
    <p v-if="message" role="status" class="border-b px-4 py-2 text-xs text-muted-foreground">{{ message }}</p>
    <p v-if="tooLarge" role="status" class="px-4 py-2 text-xs text-muted-foreground">正文较大，已显示源码，可复制或下载完整原文。</p>
    <div
      class="preview-content min-h-0 min-w-0 flex-1 overflow-auto p-4"
      :class="[
        contentClass,
        focusableContent
          ? 'scroll-focus-ring'
          : '',
      ]"
      :tabindex="focusableContent ? 0 : undefined"
      :role="focusableContent ? 'region' : undefined"
      :aria-label="focusableContent ? `${name}（可横向滚动）` : undefined"
    >
      <p v-if="!source" class="text-muted-foreground text-sm">正文为空</p>
      <MarkdownPreview v-else-if="rendered" :source="source" :theme="localTheme" :wrap="wrap" :resources="resources" :focusable="focusableContent" />
      <pre v-else-if="!mounted" class="overflow-auto whitespace-pre-wrap">{{ source }}</pre>
      <CodePreview v-else :source="source" :language="language" :theme="localTheme" :wrap="wrap" :focusable="focusableContent" @error="emit('error', $event)" />
    </div>
  </section>
</template>

<style scoped>
.preview-dark { --card: #0d1117; --card-foreground: #e6edf3; --muted-foreground: #9da7b3; --primary: #93c5fd; --border: #30363d; background: var(--card); color: var(--card-foreground); color-scheme: dark; }
.preview-content :deep(.markdown-renderer) { color: inherit; background: transparent; }
.preview-content :deep(table) { border-collapse: collapse; width: max-content; min-width: 100%; font-size: .875rem; }
.preview-content :deep(th), .preview-content :deep(td) { border: 1px solid var(--border); padding: .5rem .75rem; text-align: left; }
.preview-content :deep(a) { color: var(--primary); text-decoration: underline; overflow-wrap: anywhere; }
.preview-content :deep(img) { max-width: 100%; }
.preview-content :deep(h1), .preview-content :deep(h2), .preview-content :deep(h3) { font-weight: 600; margin-block: 1em .5em; }
.preview-content :deep(ul) { list-style: disc; padding-left: 1.5em; }
.preview-content :deep(ol) { list-style: decimal; padding-left: 1.5em; }
.preview-content.scroll-focus-ring:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }
</style>
