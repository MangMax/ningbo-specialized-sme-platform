// @vitest-environment happy-dom
import { defineComponent, h, shallowRef } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { PdfActionType, PdfZoomMode } from '@embedpdf/models'
import PdfPreview from '../components/preview/PdfPreview.vue'

// Control only the public headless engine/hooks. Exercise the real application tree.
const control = vi.hoisted(() => ({ layout: null as any, scroll: null as any, move: vi.fn(), destroy: vi.fn(), viewport: { scrollLeft: 0, scrollTop: 240 }, bookmarks: [] as any[] }))
vi.mock('@embedpdf/engines/pdfium-worker-engine', () => ({ createPdfiumEngine: () => ({ destroy: control.destroy, getBookmarks: () => ({ wait: (ok: any) => ok({ bookmarks: control.bookmarks }), abort() {} }) }) }))
vi.mock('@embedpdf/core/vue', async () => {
  const { shallowRef, defineComponent, h } = await import('vue')
  return {
    EmbedPDF: defineComponent({ setup: (_, { slots }) => () => h('div', slots.default?.()) }),
    useDocumentState: () => shallowRef({ status: 'loaded', scale: 1, document: { pages: Array.from({ length: 12 }, () => ({ size: { width: 600, height: 1800 } })) } }),
  }
})
vi.mock('@embedpdf/plugin-scroll/vue', async (original) => {
  const actual = await original<any>()
  const { shallowRef, defineComponent, h } = await import('vue')
  return { ...actual,
    Scroller: defineComponent({ setup: (_, { slots }) => () => h('div', [3, 4].map(page => slots.default?.({ page: { pageNumber: page, pageIndex: page - 1, width: 600, height: 1800 } }))) }),
    useScrollCapability: () => ({ provides: shallowRef({
      onLayoutReady: (fn: any) => { control.layout = fn; return () => {} },
      onScroll: (fn: any) => { control.scroll = fn; return () => {} },
      forDocument: () => ({ scrollToPage: control.move, getMetrics: () => ({ currentPage: 3, pageVisibilityMetrics: [{ pageNumber: 3, visiblePercentage: 100, original: { pageX: 0, pageY: 240 } }] }) }),
    }) }),
  }
})
vi.mock('@embedpdf/plugin-document-manager/vue', async (original) => ({ ...await original<any>(), useDocumentManagerCapability: () => ({ provides: shallowRef({ onDocumentError: () => () => {} }) }) }))
vi.mock('@embedpdf/plugin-viewport/vue', async (original) => ({ ...await original<any>(), useViewportCapability: () => ({ provides: shallowRef({ forDocument: () => ({ getMetrics: () => control.viewport, scrollTo: ({ x, y }: any) => { control.viewport = { scrollLeft: x, scrollTop: y } } }) }) }) }))
vi.mock('@embedpdf/plugin-zoom/vue', async (original) => ({ ...await original<any>(), useZoom: () => ({ provides: shallowRef(null), state: shallowRef({ currentZoomLevel: 1 }) }) }))
vi.mock('@embedpdf/plugin-selection/vue', async (original) => ({ ...await original<any>(), useSelectionCapability: () => ({ provides: shallowRef(null) }) }))
vi.mock('@embedpdf/plugin-search/vue', async (original) => ({ ...await original<any>(), useSearch: () => ({ provides: shallowRef(null), state: shallowRef({ results: [], total: 0 }) }) }))
const Slot = defineComponent({ setup: (_, { slots }) => () => h('div', slots.default?.()) })
const Layer = defineComponent({ name: 'RenderLayer', props: ['pageIndex'], emits: ['load', 'error'], setup: props => () => h('div', `pixels ${props.pageIndex + 1}`) })
async function reader() {
  const wrapper = mount(PdfPreview, { props: { src: '/a.pdf' }, global: { stubs: { Viewport: Slot, PagePointerProvider: Slot, RenderLayer: Layer, SearchLayer: true, SelectionLayer: true, ThumbnailsPane: true } } })
  await vi.dynamicImportSettled(); await flushPromises()
  control.layout({ documentId: 'reader', totalPages: 12 })
  await flushPromises()
  wrapper.findAllComponents(Layer)[0]!.vm.$emit('load')
  await flushPromises()
  return wrapper
}
beforeEach(() => {
  control.move.mockClear(); control.destroy.mockClear(); control.bookmarks = []
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(new Uint8Array([0,97,115,109,1,0,0,0])))))
})
afterEach(() => vi.unstubAllGlobals())
it.each([3, 4])('retains the successful document and retries only failed physical page %i', async (failedPage) => {
  const wrapper = await reader()
  const success = wrapper.findAllComponents(Layer).find(l => l.props('pageIndex') !== failedPage - 1)!.element
  const buffer = wrapper.findAllComponents(Layer).find(l => l.props('pageIndex') === failedPage - 1)!
  buffer.vm.$emit('error', new Error('buffer failure'))
  await flushPromises()
  expect(wrapper.get('output[aria-label="当前实际页"]').text()).toBe('3 / 12')
  expect(wrapper.findAllComponents(Layer).find(l => l.props('pageIndex') !== failedPage - 1)!.element).toBe(success)
  expect(control.destroy).not.toHaveBeenCalled()
  expect(wrapper.get('[role="alert"]').text()).toContain(`第 ${failedPage} 页`)
  await wrapper.get(`button[aria-label="重试第 ${failedPage} 页"]`).trigger('click')
  const retry = wrapper.findAllComponents(Layer).find(l => l.props('pageIndex') === failedPage - 1)!
  expect(retry.element).not.toBe(buffer.element)
  retry.vm.$emit('load'); await flushPromises()
  expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  expect(wrapper.findAllComponents(Layer).find(l => l.props('pageIndex') !== failedPage - 1)!.element).toBe(success)
  expect(wrapper.emitted('error')).toBeUndefined()
  await wrapper.get('button[aria-label="下一页"]').trigger('click')
  expect(control.move).toHaveBeenLastCalledWith({ pageNumber: 4, pageCoordinates: undefined, behavior: 'instant' })
  wrapper.unmount()
})

it('navigates native destination and goto bookmarks to their page coordinates', async () => {
  control.bookmarks = [
    { title: 'Lower chapter', target: { type: 'destination', destination: { pageIndex: 2, zoom: { mode: PdfZoomMode.XYZ, params: { x: 40, y: 1250, zoom: 0 } }, view: [] } } },
    { title: 'Goto chapter', target: { type: 'action', action: { type: PdfActionType.Goto, destination: { pageIndex: 3, zoom: { mode: PdfZoomMode.XYZ, params: { x: 25, y: 900, zoom: 0 } }, view: [] } } } },
    { title: 'Horizontal chapter', target: { type: 'destination', destination: { pageIndex: 2, zoom: { mode: PdfZoomMode.FitHorizontal }, view: [600] } } },
    { title: 'Page only', target: { type: 'destination', destination: { pageIndex: 4, zoom: { mode: PdfZoomMode.FitPage }, view: [] } } },
  ]
  const wrapper = await reader()
  await wrapper.get('button[aria-label="阅读工具"]').trigger('click')
  await wrapper.findAll('button').find(b => b.text() === '导航')!.trigger('click')
  await flushPromises()
  // Tabs use their visible accessible labels, never library-owned layout selectors.
  const tab = wrapper.findAll('[role="tab"]').find(t => t.text() === '目录')!
  await tab.trigger('mousedown', { button: 0, ctrlKey: false }); await tab.trigger('click'); await flushPromises()
  for (const title of ['Lower chapter', 'Goto chapter', 'Horizontal chapter', 'Page only']) await wrapper.findAll('button').find(b => b.text().startsWith(title))!.trigger('click')
  expect(control.move.mock.calls.map(([target]) => target)).toEqual([
    { pageNumber: 3, pageCoordinates: { x: 40, y: 550 }, behavior: 'instant' },
    { pageNumber: 4, pageCoordinates: { x: 25, y: 900 }, behavior: 'instant' },
    { pageNumber: 3, pageCoordinates: { x: 0, y: 1200 }, behavior: 'instant' },
    { pageNumber: 5, pageCoordinates: undefined, behavior: 'instant' },
  ])
  wrapper.unmount()
})

it('keeps the confirmed page and anchor through tools theme and reading mode changes', async () => {
  const wrapper = await reader()
  const findButton = (text: string) => wrapper.findAll('button').find(b => b.text() === text)!
  await wrapper.get('button[aria-label="阅读工具"]').trigger('click')
  await wrapper.get('button[aria-label="切换阅读主题"]').trigger('click')
  await findButton('导航').trigger('click')
  expect(wrapper.get('output[aria-label="当前实际页"]').text()).toBe('3 / 12')
  await findButton('单页').trigger('mousedown', { button: 0, ctrlKey: false })
  await flushPromises()
  wrapper.findComponent(Layer).vm.$emit('load'); await flushPromises()
  expect(wrapper.emitted('position-change')?.at(-1)).toEqual([{ src: '/a.pdf', page: 3, point: { x: 0, y: 240 } }])
  await findButton('连续').trigger('mousedown', { button: 0, ctrlKey: false })
  await flushPromises()
  control.layout({ documentId: 'reader', totalPages: 12 })
  expect(control.move).toHaveBeenLastCalledWith({ pageNumber: 3, pageCoordinates: { x: 0, y: 240 }, behavior: 'instant' })
  expect(control.destroy).not.toHaveBeenCalled()
  wrapper.unmount()
})
