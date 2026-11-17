// @vitest-environment jsdom
import { DOMWrapper, mount, flushPromises } from '@vue/test-utils'
import { expect, it } from 'vitest'
import ContentPreview from '../../../components/preview/ContentPreview.vue'

it('renders headings lists GFM and merged OCR tables while blocking active HTML and resources', async () => {
  const source = '# 名单\n\n- 企业甲\n\n| 企业 | 年份 |\n| --- | --- |\n| 宁波甲 | 2026 |\n\n<table><tr><td rowspan="2" colspan="3" onclick="alert(1)">合并</td></tr></table>\n\n<script>alert(1)</script><iframe src="https://evil.test"></iframe><img src="https://evil.test/x" onerror="alert(1)">\n\n![远程图](https://evil.test/a.png)\n\n[官网](https://example.com)\n\n<a href="javascript:alert(1)">危险</a>'
  const wrapper = mount(ContentPreview, { props: { source, format: 'markdown' } })
  await flushPromises()
  expect(wrapper.find('h1').text()).toBe('名单')
  expect(wrapper.find('li').text()).toBe('企业甲')
  expect(wrapper.findAll('table')).toHaveLength(2)
  expect(wrapper.find('td[colspan="3"]').attributes('rowspan')).toBe('2')
  expect(wrapper.find('script, iframe, img, [onclick], [onerror], a[href^="javascript:"]').exists()).toBe(false)
  const external = wrapper.find('a[href="https://example.com/"]')
  expect(external.attributes('rel')).toContain('noopener')
  expect(external.text()).toContain('外链')
  expect(wrapper.text()).toContain('图片未自动加载')
})

it('copies and downloads the exact source and switches source wrap and theme without changing it', async () => {
  const { vi } = await import('vitest')
  const source = '# 原文\r\n\r\n<table>  标签 </table>\r\n```json\r\n{"企业":1}\r\n```\r\n'
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  const wrapper = mount(ContentPreview, { attachTo: document.body, props: { source, format: 'markdown', name: '名单.md' } })
  await flushPromises()
  const click = async (label: string) => {
    const button = wrapper.findAll('button').find(button => button.text() === label)
    if (button) return button.trigger('click')
    await wrapper.findAll('button').find(b => b.text() === '更多操作')!.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    await new DOMWrapper(document.body).findAll('[role="menuitem"]').find(item => item.text() === label)!.trigger('click')
    await flushPromises()
  }
  await click('复制原文')
  expect(writeText).toHaveBeenCalledWith(source)
  await click('查看源码')
  expect(wrapper.find('pre').element.textContent).toBe(source)
  await click('自动换行')
  expect(wrapper.find('.wrap-code').exists()).toBe(true)
  await click('深色主题')
  expect(wrapper.attributes('data-theme')).toBe('dark')
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test')
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const anchor = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  await click('下载')
  expect(await (create.mock.calls[0]![0] as Blob).text()).toBe(source)
  expect((anchor.mock.instances[0] as HTMLAnchorElement).download).toBe('名单.md')
  create.mockRestore(); revoke.mockRestore(); anchor.mockRestore()
  wrapper.unmount()
})

it('keeps HTML source inert and shows unknown languages and empty or large content as readable text', async () => {
  const source = '<script>alert(1)</script><img src="https://evil.test/x">'
  const wrapper = mount(ContentPreview, { props: { source, format: 'text', language: 'not-a-language' } })
  await flushPromises()
  expect(wrapper.find('pre').element.textContent).toBe(source)
  expect(wrapper.find('script, img').exists()).toBe(false)
  await wrapper.setProps({ source: '' })
  expect(wrapper.text()).toContain('正文为空')
  const large = '# 大正文\n' + '甲'.repeat(200_001)
  await wrapper.setProps({ source: large, format: 'markdown' })
  await flushPromises()
  expect(wrapper.text()).toContain('正文较大')
  expect(wrapper.find('pre').element.textContent).toBe(large)
  wrapper.unmount()
})

it('keeps fenced code source copyable and confines overrides to each preview instance', async () => {
  const { vi } = await import('vitest')
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  const first = mount(ContentPreview, { props: { source: '```json\n{"企业":"甲"}\n```' } })
  const second = mount(ContentPreview, { props: { source: '```python\nprint("乙")\n```', theme: 'dark' } })
  await flushPromises()
  await first.findAll('button').find(button => button.text() === '复制代码')!.trigger('click')
  expect(writeText).toHaveBeenCalledWith('{"企业":"甲"}\n')
  first.unmount()
  await second.setProps({ source: '```python\nprint("丙")\n```' })
  await flushPromises()
  await second.findAll('button').find(button => button.text() === '复制代码')!.trigger('click')
  expect(writeText).toHaveBeenLastCalledWith('print("丙")\n')
  second.unmount()
})

it('opens only explicitly mapped relative resources and never auto-loads images or optional renderers', async () => {
  const wrapper = mount(ContentPreview, { props: {
    source: '![页图](page.png)\n\n![越界](../secret.png)\n\n<img src="page.png">\n\n```mermaid\ngraph LR; A-->B\n```\n\n```image\n保留代码\n```\n\n<SomeComponent onclick="alert(1)">保留文字</SomeComponent>',
    resources: { 'page.png': '/api/files/current/page.png', '../secret.png': '/api/files/../secret.png' },
  } })
  await flushPromises()
  expect(wrapper.findAll('a[href="/api/files/current/page.png"]')).toHaveLength(2)
  expect(wrapper.findAll('img, iframe, svg, [onclick]').map(node => node.element.parentElement?.outerHTML)).toEqual([])
  expect(wrapper.find('a[href*="secret"]').exists()).toBe(false)
  expect(wrapper.text()).toContain('graph LR; A-->B')
  expect(wrapper.text()).toContain('保留文字')
  expect(wrapper.text()).toContain('保留代码')
  wrapper.unmount()
})

it('rejects dangerous link protocols and nested active markup without changing copied source', async () => {
  const { vi } = await import('vitest')
  const source = '[脚本](javascript:alert(1))\n\n[数据](data:text/html,test)\n\n<a href="jav&#x61;script:alert(1)">实体链接</a><svg><a href="javascript:alert(1)">SVG</a></svg><form action="https://evil.test"><input autofocus onfocus="alert(1)"></form>'
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  const wrapper = mount(ContentPreview, { props: { source } })
  await flushPromises()
  expect(wrapper.findAll('a[href^="javascript:"], a[href^="data:"], svg, form, input, [onfocus]').map(node => node.element.parentElement?.outerHTML)).toEqual([])
  await wrapper.findAll('button').find(button => button.text() === '复制原文')!.trigger('click')
  expect(writeText).toHaveBeenCalledWith(source)
  wrapper.unmount()
})


it('confines .preview-dark token overrides to the preview section so app theming cannot leak', async () => {
  const wrapper = mount(ContentPreview, { attachTo: document.body, props: { source: '# 正文', theme: 'dark' } })
  await flushPromises()
  const section = wrapper.get('section.content-preview')
  // The dark skin hangs on the component's own root section only — never on a
  // shared ancestor where it would re-skin the whole app.
  expect(section.classes()).toContain('preview-dark')
  expect(section.attributes('data-theme')).toBe('dark')
  expect(document.documentElement.classList.contains('preview-dark')).toBe(false)
  expect(document.body.classList.contains('preview-dark')).toBe(false)
  expect(document.documentElement.getAttribute('data-theme')).toBeNull()
  expect(document.body.getAttribute('data-theme')).toBeNull()
  // No element outside the section may carry the theme class or attribute.
  const outside = Array.from(document.body.querySelectorAll('.preview-dark, [data-theme="dark"]'))
  expect(outside.every(node => section.element.contains(node))).toBe(true)
  wrapper.unmount()
})

it('shows caller context and keeps secondary preview actions reachable from the menu', async () => {
  const wrapper = mount(ContentPreview, { attachTo: document.body, props: {
    source: '# 正文', name: '第 7 页.md', context: '原始公告长文件名.pdf · 第 7 页',
  } })
  await flushPromises()
  const toolbar = wrapper.get('[role="toolbar"]')
  expect(toolbar.text()).toContain('原始公告长文件名.pdf · 第 7 页')
  expect(toolbar.text()).not.toContain('Markdown 文档 · markdown')
  expect(toolbar.findAll('button').map(b => b.text())).toEqual(['查看源码', '复制原文', '更多操作'])
  const more = toolbar.findAll('button').find(b => b.text() === '更多操作')!
  await more.trigger('keydown', { key: 'Enter' })
  await flushPromises()
  const menu = new DOMWrapper(document.body).get('[role="menu"]')
  expect(menu.text()).toContain('下载')
  expect(menu.text()).toContain('深色主题')
  await menu.findAll('[role="menuitem"]').find(item => item.text() === '自动换行')!.trigger('click')
  await flushPromises()
  await wrapper.findAll('button').find(b => b.text() === '查看源码')!.trigger('click')
  expect(wrapper.find('.wrap-code').exists()).toBe(true)
  wrapper.unmount()
})
