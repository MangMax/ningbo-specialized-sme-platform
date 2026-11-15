// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { expect, it, vi } from 'vitest'
vi.mock('markstream-vue', async importOriginal => {
  const original = await importOriginal<typeof import('markstream-vue')>()
  return { ...original, parseMarkdownToStructure: () => { throw new Error('renderer unavailable') } }
})
import ContentPreview from '../../../components/preview/ContentPreview.vue'
it('retains the exact source if the Markdown library fails', async () => {
  const source = '# 原文\n<table>甲</table>\n'
  const wrapper = mount(ContentPreview, { props: { source } })
  await flushPromises()
  expect(wrapper.text()).toContain('渲染失败')
  expect(wrapper.find('pre').element.textContent).toBe(source)
  expect(wrapper.emitted('error')?.[0]).toEqual(['渲染失败，已保留源码。'])
  wrapper.unmount()
})
