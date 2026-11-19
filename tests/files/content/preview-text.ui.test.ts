// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import FilePreview from '../../../layers/core/app/components/preview/FilePreview.vue'
afterEach(() => vi.unstubAllGlobals())
it('opens Markdown and code from the shared entry including named blobs', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('# 文件正文')).mockResolvedValueOnce(new Response('<script>惰性源码</script>')))
  const wrapper = mount(FilePreview, { props: { src: '/api/files/notice.md' } })
  await flushPromises()
  expect(wrapper.find('h1').text()).toBe('文件正文')
  await wrapper.setProps({ src: `blob:${location.origin}/fixture`, name: '源代码.html' })
  await flushPromises()
  expect(wrapper.find('pre').element.textContent).toBe('<script>惰性源码</script>')
  expect(wrapper.find('script, iframe, canvas').exists()).toBe(false)
  wrapper.unmount()
})
