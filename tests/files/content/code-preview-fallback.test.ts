// @vitest-environment jsdom
import { mount, flushPromises } from '@vue/test-utils'
import { expect, it, vi } from 'vitest'
vi.mock('shiki/core', () => ({ createHighlighterCore: () => Promise.reject(new Error('engine unavailable')) }))
import CodePreview from '../../../layers/core/app/components/preview/CodePreview.vue'
it('preserves readable source when Shiki initialization fails', async () => {
  const source = '<script>原文</script>\n'
  const wrapper = mount(CodePreview, { props: { source, language: 'html' } })
  await flushPromises()
  expect(wrapper.find('pre').element.textContent).toBe(source)
  expect(wrapper.find('script').exists()).toBe(false)
  expect(wrapper.text()).toContain('高亮暂不可用')
  await wrapper.setProps({ source: '新文件', theme: 'dark' })
  await flushPromises()
  expect(wrapper.find('pre').element.textContent).toBe('新文件')
  wrapper.unmount()
})
