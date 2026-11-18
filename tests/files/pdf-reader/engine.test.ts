// @vitest-environment happy-dom
import { defineComponent, h } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import PdfPreview from '../../../components/preview/PdfPreview.vue'
import PdfEngine from '../../../components/preview/PdfEngine.vue'
import { clientLibraryReporterKey } from '../../../layers/core/lib/client-logging/library-reporter'
const resource = vi.hoisted(() => ({ create: vi.fn(), destroy: vi.fn() }))
vi.mock('@embedpdf/engines/pdfium-worker-engine', () => ({ createPdfiumEngine: resource.create }))
const Core = defineComponent({ name: 'EmbedPDF', setup: () => () => h('div', { 'data-core': '' }) })
function reader() { return mount(PdfPreview, { props: { src: '/a.pdf' }, global: { stubs: { 'embed-pdf': Core } } }) }
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
  expect(resource.create.mock.calls[0]?.[1]).toEqual({ fontFallback: null, logger: expect.objectContaining({ debug: expect.any(Function), error: expect.any(Function) }) })
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
  vi.stubGlobal('fetch', vi.fn((url: string) => new URL(url, location.origin).pathname === '/pdfium.wasm' ? fetchResource() : Promise.resolve(new Response('source'))))
  const wrapper = reader()
  await vi.dynamicImportSettled(); await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toContain('引擎资源加载失败')
  expect(resource.create).not.toHaveBeenCalled()
  await wrapper.findAll('button').find(b => b.text() === '重试读取 PDF')!.trigger('click')
  await vi.waitFor(() => expect(resource.create).toHaveBeenCalledTimes(1))
  expect(fetchResource).toHaveBeenCalledTimes(2)
  wrapper.unmount()
  vi.unstubAllGlobals()
})

it('wires the same safe logger into engine and registry and reports only actual document readiness', async () => {
  const report = vi.fn()
  const embed = defineComponent({ props: ['config'], setup: (_, { slots }) => () => h('div', slots.default?.()) })
  const document = defineComponent({ name: 'PdfReaderDocument', emits: ['ready', 'error'], setup: () => () => h('div') })
  const wrapper = mount(PdfEngine, { props: { src: '/PRIVATE180.pdf', tools: false }, global: {
    provide: { [clientLibraryReporterKey as symbol]: report }, stubs: { 'embed-pdf': embed, PdfReaderDocument: document },
  } })
  await vi.dynamicImportSettled(); await flushPromises()
  const logger = resource.create.mock.calls[0]![1].logger
  expect(wrapper.findComponent(embed).props('config').logger).toBe(logger)
  expect(report).not.toHaveBeenCalled() // constructing a worker is not PDF readiness.
  const hostile = { get message() { throw Error('must not read') } }
  logger.warn('/PRIVATE180', 'PRIVATE180', hostile)
  wrapper.findComponent(document).vm.$emit('ready', { totalPages: 2 })
  wrapper.findComponent(document).vm.$emit('error', 'existing user-facing failure')
  expect(report.mock.calls).toEqual([['pdf_log_warn'], ['pdf_document_ready'], ['pdf_document_failure']])
  expect(wrapper.emitted('ready')).toEqual([[{ totalPages: 2 }]])
  expect(wrapper.emitted('error')).toEqual([['existing user-facing failure']])
  wrapper.unmount(); logger.error('PRIVATE180', 'PRIVATE180', hostile)
  expect(report).toHaveBeenCalledTimes(3)
})

it('reports true PDF startup failure while leaving retry UI behavior independent of telemetry faults', async () => {
  const report = vi.fn(() => { throw Error('sink unavailable') })
  resource.create.mockImplementationOnce(() => { throw Error('PRIVATE180 worker') })
  const wrapper = mount(PdfPreview, { props: { src: '/PRIVATE180.pdf' }, global: {
    provide: { [clientLibraryReporterKey as symbol]: report }, stubs: { 'embed-pdf': Core },
  } })
  await vi.dynamicImportSettled(); await flushPromises()
  expect(report.mock.calls).toEqual([['pdf_startup_failure']])
  expect(wrapper.emitted('error')).toEqual([['PDF 引擎资源加载失败，请重试。']])
  await wrapper.findAll('button').find(b => b.text() === '重试读取 PDF')!.trigger('click')
  await vi.dynamicImportSettled(); await flushPromises()
  expect(resource.create).toHaveBeenCalledTimes(2)
  expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  expect(report).toHaveBeenCalledTimes(1)
  wrapper.unmount()
})

it('does not report aborted PDF resource startup after disposal', async () => {
  const report = vi.fn()
  let reject!: (error: unknown) => void
  vi.stubGlobal('fetch', vi.fn(() => new Promise((_, no) => { reject = no })))
  const wrapper = mount(PdfEngine, { props: { src: '/PRIVATE180.pdf', tools: false }, global: { provide: { [clientLibraryReporterKey as symbol]: report } } })
  wrapper.unmount(); reject(Error('PRIVATE180 aborted'))
  await flushPromises()
  expect(report).not.toHaveBeenCalled()
  expect(resource.create).not.toHaveBeenCalled()
})
