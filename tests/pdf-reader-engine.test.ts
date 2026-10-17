// @vitest-environment happy-dom
import { defineComponent, h } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import PdfPreview from '../components/preview/PdfPreview.vue'
const resource = vi.hoisted(() => ({ create: vi.fn(), destroy: vi.fn() }))
vi.mock('@embedpdf/engines/pdfium-worker-engine', () => ({ createPdfiumEngine: resource.create }))
const Core = defineComponent({ name: 'EmbedPDF', setup: () => () => h('div', { 'data-core': '' }) })
function reader() { return mount(PdfPreview, { props: { src: '/a.pdf' }, global: { stubs: { EmbedPDF: Core } } }) }
beforeEach(() => {
  resource.create.mockReset(); resource.destroy.mockReset()
  resource.create.mockImplementation(() => ({ destroy: resource.destroy }))
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(new Uint8Array([0,97,115,109,1,0,0,0])))))
})
afterEach(() => vi.unstubAllGlobals())
it('does not create a late worker after the reader has closed', async () => {
  const wrapper = reader()
  wrapper.unmount()
  await vi.dynamicImportSettled(); await flushPromises()
  expect(resource.create).not.toHaveBeenCalled()
})
it('releases its engine on document replacement and on close', async () => {
  const wrapper = reader()
  await vi.dynamicImportSettled(); await flushPromises()
  expect(resource.create).toHaveBeenCalledTimes(1)
  expect(resource.create.mock.calls[0]?.[0]).toBe(new URL('/pdfium.wasm', location.origin).href)
  expect(resource.create.mock.calls[0]?.[1]).toEqual({ fontFallback: null })
  await wrapper.setProps({ src: '/b.pdf' })
  await vi.dynamicImportSettled(); await flushPromises()
  expect(resource.destroy).toHaveBeenCalledTimes(1)
  expect(resource.create).toHaveBeenCalledTimes(2)
  wrapper.unmount()
  expect(resource.destroy).toHaveBeenCalledTimes(2)
})
it('exposes engine startup failure and creates a new attempt on retry', async () => {
  resource.create.mockImplementationOnce(() => { throw new Error('worker unavailable') })
  const wrapper = reader()
  await vi.dynamicImportSettled(); await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toContain('引擎资源加载失败')
  expect(wrapper.emitted('error')).toEqual([['PDF 引擎资源加载失败，请重试。']])
  await wrapper.findAll('button').find(b => b.text() === '重试读取 PDF')!.trigger('click')
  await vi.dynamicImportSettled(); await flushPromises()
  expect(resource.create).toHaveBeenCalledTimes(2)
  expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  wrapper.unmount()
})

it('reports unavailable WASM without creating a worker and recovers on retry', async () => {
  const fetchResource = vi.fn().mockResolvedValueOnce(new Response('missing', { status: 503 })).mockResolvedValue(new Response(new Uint8Array([0,97,115,109,1,0,0,0])))
  vi.stubGlobal('fetch', fetchResource)
  const wrapper = reader()
  await vi.dynamicImportSettled(); await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toContain('引擎资源加载失败')
  expect(resource.create).not.toHaveBeenCalled()
  await wrapper.findAll('button').find(b => b.text() === '重试读取 PDF')!.trigger('click')
  await vi.waitFor(() => expect(resource.create).toHaveBeenCalledTimes(1))
  wrapper.unmount()
  vi.unstubAllGlobals()
})
