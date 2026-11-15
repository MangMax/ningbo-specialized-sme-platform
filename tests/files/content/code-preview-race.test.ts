// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ waiting: false, release: () => {} }))
vi.mock('shiki/core', () => ({ createHighlighterCore: async () => ({
  loadLanguage: async (grammar: { default: Array<{ name: string }> }) => {
    if (grammar.default.some(language => language.name === 'javascript')) {
      state.waiting = true
      await new Promise<void>(resolve => { state.release = resolve })
    }
  },
  loadTheme: async () => {},
  codeToHtml: (source: string, options: { theme: string }) => `<pre class="${options.theme}"><code>${source}</code></pre>`,
}) }))
import CodePreview from '../../../components/preview/CodePreview.vue'
it('ignores a late old highlight after changing source language and theme', async () => {
  const wrapper = mount(CodePreview, { props: { source: '旧文件', language: 'js' } })
  await vi.waitFor(() => expect(state.waiting).toBe(true))
  await wrapper.setProps({ source: '新文件', language: 'py', theme: 'dark' })
  await vi.waitFor(() => expect(wrapper.find('.highlight-output').text()).toBe('新文件'))
  state.release()
  await flushPromises()
  expect(wrapper.find('.highlight-output').text()).toBe('新文件')
  expect(wrapper.find('pre').classes()).toContain('github-dark')
  wrapper.unmount()
})
