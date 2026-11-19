<script setup lang="ts">
import { computed } from 'vue'
import DOMPurify from 'dompurify'
import { previewLink } from '#core/lib/content-preview-security'

const props = defineProps<{ source: string; resources?: Readonly<Record<string, string>>; focusable?: boolean }>()
const html = computed(() => {
  if (typeof document === 'undefined') return ''
  const tags = ['table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'p', 'br', 'hr', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'span', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'img']
  // Sanitize before insertion into a detached document. No untrusted src/style enters a live DOM.
  const inert = document.createElement('template')
  inert.innerHTML = props.source
  // Native template contents are inert. Strip fetch-capable nodes/attributes before
  // the sanitizer clones them; this also protects DOM implementations with eager loads.
  for (const node of inert.content.querySelectorAll('*')) {
    if (['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'STYLE', 'LINK', 'META', 'BASE', 'SVG', 'MATH', 'VIDEO', 'AUDIO', 'SOURCE'].includes(node.tagName)) { node.remove(); continue }
    if (!tags.includes(node.tagName.toLowerCase())) { node.replaceWith(...node.childNodes); continue }
    if (node.tagName === 'IMG') {
      const placeholder = document.createElement('span')
      placeholder.textContent = `图片未自动加载${node.getAttribute('alt') ? `：${node.getAttribute('alt')}` : ''} `
      const href = previewLink(node.getAttribute('src') ?? '', props.resources)
      if (href) { const link = document.createElement('a'); link.setAttribute('href', href); link.textContent = '打开图片'; placeholder.append(link) }
      node.replaceWith(placeholder)
    }
    for (const attribute of [...node.attributes]) {
      if (!['href', 'alt', 'colspan', 'rowspan', 'scope'].includes(attribute.name)) node.removeAttribute(attribute.name)
    }
  }
  const clean = DOMPurify.sanitize(inert.content, {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: tags,
    ALLOWED_ATTR: ['colspan', 'rowspan', 'scope', 'href', 'alt'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  })
  const template = document.createElement('template')
  template.content.append(clean)
  for (const image of template.content.querySelectorAll('img')) {
    const placeholder = document.createElement('span')
    placeholder.textContent = `图片未自动加载${image.getAttribute('alt') ? `：${image.getAttribute('alt')}` : ''}`
    image.replaceWith(placeholder)
  }
  for (const link of template.content.querySelectorAll('a')) {
    const href = previewLink(link.getAttribute('href') ?? '', props.resources)
    if (!href) { link.replaceWith(document.createTextNode(link.textContent ?? '')); continue }
    link.setAttribute('href', href)
    link.setAttribute('target', '_blank')
    link.setAttribute('rel', 'noopener noreferrer nofollow')
    link.append(document.createTextNode(href.startsWith('/') ? '（打开资源）' : '（外链）'))
  }
  return template.innerHTML
})
</script>

<template>
  <div
    class="safe-preview-html overflow-x-auto"
    :tabindex="focusable ? 0 : undefined"
    :role="focusable ? 'region' : undefined"
    :aria-label="focusable ? '渲染表格（可横向滚动）' : undefined"
    :class="focusable ? 'safe-preview-scroll-focus' : ''"
    v-html="html"
  />
</template>

<style scoped>
.safe-preview-scroll-focus:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: -2px;
}
</style>
