// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { expect, it, vi } from 'vitest'
vi.mock('markstream-vue', async importOriginal => ({
  ...await importOriginal<typeof import('markstream-vue')>(),
  parseMarkdownToStructure: () => { throw new Error('display unavailable') },
}))
import OcrPageRow from '../../../components/ocr/OcrPageRow.vue'

it('OCR 渲染失败保留有文本、来源和原始编辑草稿，不产生写入或空结果', async () => {
  const source = '# 名单\n\n<table><tr><td>企业甲</td></tr></table>'
  const wrapper = mount(OcrPageRow, {
    props: {
      filePath: 'synthetic/only.pdf',
      editing: false,
      draft: '',
      view: 'compare',
      row: { page: 47, image: null, result: {
        page: 47, markdown: source, engine: 'paddleocr', model: '原引擎', channel: 'api',
        createdAt: '2026-10-17T00:00:00Z', pageRelPath: null,
      } },
    },
  })
  await flushPromises()
  expect(wrapper.text()).toContain('渲染失败')
  expect(wrapper.text()).toContain('有文本')
  expect(wrapper.text()).toContain('原引擎')
  expect(wrapper.text()).toContain('还没有页图')
  expect(wrapper.text()).not.toContain('空结果')
  expect(wrapper.get('pre').element.textContent).toBe(source)
  expect(wrapper.emitted('save')).toBeUndefined()
  expect(wrapper.emitted('remove')).toBeUndefined()

  await wrapper.setProps({ editing: true, draft: source })
  expect(wrapper.get('textarea').element).toHaveProperty('value', source)
  expect(wrapper.emitted('save')).toBeUndefined()
  wrapper.unmount()
})
