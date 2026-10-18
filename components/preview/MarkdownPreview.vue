<script lang="ts">
let previewSequence = 0
</script>

<script setup lang="ts">
import { computed, defineComponent, h, markRaw, onBeforeUnmount, useId } from 'vue'
import MarkdownRender, { getMarkdown, parseMarkdownToStructure, removeCustomComponents, setCustomComponents } from 'markstream-vue'
import 'markstream-vue/index.css'
import SafeHtmlPreview from './SafeHtmlPreview.vue'
import CodePreview from './CodePreview.vue'
import { previewLink } from '~~/lib/content-preview-security'

const props = defineProps<{ source: string; theme: 'light' | 'dark'; wrap: boolean; resources?: Readonly<Record<string, string>>; focusable?: boolean }>()
const id = `content-preview-${useId()}-${++previewSequence}`
// The public custom-id registry scopes overrides to this renderer only, including nested blocks.
const HtmlNode = defineComponent({ props: ['node'], setup: p => () => h(SafeHtmlPreview, { source: p.node.content ?? p.node.raw ?? '', resources: props.resources, focusable: props.focusable }) })
const CodeNode = defineComponent({ props: ['node'], setup: p => () => h(CodePreview, { source: p.node.code ?? p.node.raw ?? '', language: p.node.language, theme: props.theme, wrap: props.wrap, copyable: true, focusable: props.focusable }) })
const LinkNode = defineComponent({ props: ['node'], setup: p => () => {
  const href = previewLink(p.node.href ?? '', props.resources)
  const text = p.node.text ?? p.node.raw ?? ''
  return href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer nofollow' }, `${text}${href.startsWith('/') ? '（打开资源）' : '（外链）'}`) : h('span', text)
} })
const ImageNode = defineComponent({ props: ['node'], setup: p => () => {
  const href = previewLink(p.node.src ?? '', props.resources)
  return h('span', { class: 'text-muted-foreground' }, [ `图片未自动加载${p.node.alt ? `：${p.node.alt}` : ''} `, href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer nofollow' }, href.startsWith('/') ? '打开资源' : '打开外链') : null ])
} })
setCustomComponents(id, { preview_html: markRaw(HtmlNode), code_block: markRaw(CodeNode), preview_code: markRaw(CodeNode), link: markRaw(LinkNode), image: markRaw(ImageNode) })
onBeforeUnmount(() => removeCustomComponents(id))
const markdown = getMarkdown()
// Drop optional executable/rendering node families; unknown custom nodes become inert text.
const allowed = new Set(['text', 'paragraph', 'heading', 'code_block', 'list', 'list_item', 'blockquote', 'table', 'table_row', 'table_cell', 'hardbreak', 'link', 'image', 'thematic_break', 'strong', 'emphasis', 'strikethrough', 'inline_code', 'html_inline', 'html_block'])
const nodes = computed(() => {
  const parsed = parseMarkdownToStructure(props.source, markdown, { final: true })
  function inert<T extends { type: string; raw?: string }>(node: T): T {
    // Markstream gives language-specific renderers precedence over code_block.
    // Normalize through its public nodes/custom-component boundary so every fence
    // stays inert, even languages named after registered nodes (image/link/HTML).
    if (node.type === 'code_block') return { ...node, type: 'preview_code' }
    if (node.type === 'html_inline' || node.type === 'html_block') return { type: 'preview_html', content: (node as T & { content?: string }).content ?? node.raw ?? '', raw: node.raw ?? '' } as unknown as T
    if (!allowed.has(node.type)) return { type: 'text', content: node.raw ?? '', raw: node.raw ?? '' } as unknown as T
    // Parser structures include nested rows/cells as well as children.
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, Array.isArray(value) ? value.map(v => v && typeof v === 'object' && 'type' in v ? inert(v) : v) : value])) as T
  }
  return parsed.map(inert)
})
</script>

<template>
  <MarkdownRender :nodes="nodes" :custom-id="id" :is-dark="theme === 'dark'" :final="true" :typewriter="false" :smooth-streaming="false" :fade="false" :batch-rendering="false" :node-virtual="false" :defer-nodes-until-visible="false" :show-tooltips="false" />
</template>
