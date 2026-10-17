// @vitest-environment happy-dom
import { defineComponent, h, shallowRef } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { PdfActionType, PdfZoomMode } from '@embedpdf/models'
import PdfPreview from '../components/preview/PdfPreview.vue'

// Control only the public headless engine/hooks. Exercise the real application tree.
const control = vi.hoisted(() => ({ documentState: null as any, layout: null as any, scroll: null as any, move: vi.fn(), destroy: vi.fn(), viewport: { scrollLeft: 0, scrollTop: 240 }, bookmarks: [] as any[], manualRaster: false, raster: null as any, activity: null as any, pages: null as any, smooth: false, metrics: null as any }))
vi.mock('@embedpdf/engines/pdfium-worker-engine', () => ({ createPdfiumEngine: () => ({ destroy: control.destroy, getBookmarks: () => ({ wait: (ok: any) => ok({ bookmarks: control.bookmarks }), abort() {} }) }) }))
vi.mock('@embedpdf/core/vue', async () => {
  const { shallowRef, defineComponent, h } = await import('vue')
  return {
    EmbedPDF: defineComponent({ setup: (_, { slots }) => () => h('div', slots.default?.()) }),
    useDocumentState: () => control.documentState,
  }
})
vi.mock('@embedpdf/plugin-scroll/vue', async (original) => {
  const actual = await original<any>()
  const { shallowRef, defineComponent, h } = await import('vue')
  return { ...actual,
    Scroller: defineComponent({ setup: (_, { slots }) => () => h('div', control.pages.value.map((page: number) => slots.default?.({ page: { pageNumber: page, pageIndex: page - 1, width: 600, height: 1800 } }))) }),
    useScrollCapability: () => ({ provides: shallowRef({
      onLayoutReady: (fn: any) => { control.layout = fn; return () => {} },
      onScroll: (fn: any) => { control.scroll = fn; return () => {} },
      forDocument: () => ({ scrollToPage: control.move, getMetrics: () => control.metrics ?? ({ scrollOffset: { x: 0, y: 240 }, currentPage: 3, pageVisibilityMetrics: [{ pageNumber: 3, visiblePercentage: 100, original: { pageX: 0, pageY: 240 } }] }) }),
    }) }),
  }
})
vi.mock('@embedpdf/plugin-render/vue', async (original) => ({ ...await original<any>(), useRenderCapability: () => ({ provides: shallowRef({ forDocument: () => ({ renderPage: () => ({ wait: (ok: any, fail: any) => { control.raster = { ok, fail }; if (!control.manualRaster) ok(new Blob(['pixels'])) }, abort() {} }) }) }) }) }))
vi.mock('@embedpdf/plugin-document-manager/vue', async (original) => ({ ...await original<any>(), useDocumentManagerCapability: () => ({ provides: shallowRef({ onDocumentError: () => () => {} }) }) }))
vi.mock('@embedpdf/plugin-viewport/vue', async (original) => ({ ...await original<any>(), useViewportCapability: () => ({ provides: shallowRef({ onScrollActivity: (fn: any) => { control.activity = fn; return () => {} }, forDocument: () => ({ isSmoothScrolling: () => control.smooth, getMetrics: () => control.viewport, scrollTo: ({ x, y }: any) => { control.viewport = { scrollLeft: x, scrollTop: y } } }) }) }) }))
vi.mock('@embedpdf/plugin-zoom/vue', async (original) => ({ ...await original<any>(), useZoom: () => ({ provides: shallowRef(null), state: shallowRef({ currentZoomLevel: 1 }) }) }))
vi.mock('@embedpdf/plugin-selection/vue', async (original) => ({ ...await original<any>(), useSelectionCapability: () => ({ provides: shallowRef(null) }) }))
vi.mock('@embedpdf/plugin-search/vue', async (original) => ({ ...await original<any>(), useSearch: () => ({ provides: shallowRef(null), state: shallowRef({ results: [], total: 0 }) }) }))
const Slot = defineComponent({ setup: (_, { slots }) => () => h('div', slots.default?.()) })
const Layer = defineComponent({ name: 'RenderLayer', props: ['pageIndex', 'scale'], emits: ['load', 'error'], setup: props => () => h('div', `pixels ${props.pageIndex + 1}`) })
async function reader(onPositionChange?: (...args: any[]) => void) {
  const wrapper = mount(PdfPreview, { attachTo: document.body, props: { src: '/a.pdf', onPositionChange }, global: { stubs: { Viewport: Slot, PagePointerProvider: Slot, PdfPageImage: Layer, SearchLayer: true, SelectionLayer: true, ThumbnailsPane: true } } })
  await vi.dynamicImportSettled(); await flushPromises()
  control.layout({ documentId: 'reader', totalPages: 12 })
  await flushPromises()
  wrapper.findAllComponents(Layer)[0]!.vm.$emit('load')
  await flushPromises()
  return wrapper
}
beforeEach(() => {
  control.documentState = shallowRef({ status: 'loaded', scale: 1, document: { pages: Array.from({ length: 12 }, () => ({ size: { width: 600, height: 1800 } })) } })
  vi.spyOn(HTMLElement.prototype, 'animate').mockReturnValue({ cancel() {} } as Animation)
  control.pages = shallowRef([3, 4])
  control.metrics = null; control.smooth = false
  control.manualRaster = false
  control.raster = null
  vi.stubGlobal('Image', class { src = ''; decode() { return Promise.resolve() } })
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:prepared')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  control.move.mockClear(); control.destroy.mockClear(); control.bookmarks = []
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(new Uint8Array([0,97,115,109,1,0,0,0])))))
})
afterEach(() => vi.unstubAllGlobals())
it('retains rendered pages while zoom changes and updates their render scale', async () => {
  const wrapper = await reader()
  const successfulPage = wrapper.findAllComponents(Layer)[0]!.element
  for (const scale of [1.27, 1.3, 1.25]) {
    control.documentState.value = { ...control.documentState.value, scale }
    await flushPromises()
    const page = wrapper.findAllComponents(Layer)[0]!
    expect(page.element).toBe(successfulPage)
    expect(page.props('scale')).toBe(scale)
    expect(wrapper.get('output[aria-label="当前实际页"]').text()).toBe('3 / 12')
    expect(control.destroy).not.toHaveBeenCalled()
  }
  wrapper.unmount()
})
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
  expect(control.move).toHaveBeenLastCalledWith({ pageNumber: 4, pageCoordinates: undefined, behavior: 'smooth' })
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
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  await flushPromises()
  control.move.mockClear()
  // Tabs use their visible accessible labels, never library-owned layout selectors.
  const tab = wrapper.findAll('[role="tab"]').find(t => t.text() === '目录')!
  await tab.trigger('mousedown', { button: 0, ctrlKey: false }); await tab.trigger('click'); await flushPromises()
  const cases = [
    ['Lower chapter', { pageNumber: 3, pageCoordinates: { x: 40, y: 550 }, behavior: 'instant' }],
    ['Goto chapter', { pageNumber: 4, pageCoordinates: { x: 25, y: 900 }, behavior: 'instant' }],
    ['Horizontal chapter', { pageNumber: 3, pageCoordinates: { x: 0, y: 1200 }, behavior: 'instant' }],
    ['Page only', { pageNumber: 5, pageCoordinates: undefined, behavior: 'instant' }],
  ] as const
  for (const [title, target] of cases) {
    await wrapper.findAll('button').find(b => b.text().startsWith(title))!.trigger('click')
    await flushPromises()
    // A closing overlay may restore the same target after its final layout.
    // Verify the requested coordinates survive that correction.
    expect(control.move).toHaveBeenLastCalledWith(target)
  }
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
  await flushPromises()
  expect(control.move).toHaveBeenLastCalledWith({ pageNumber: 3, pageCoordinates: { x: 0, y: 240 }, behavior: 'instant' })
  expect(control.destroy).not.toHaveBeenCalled()
  wrapper.unmount()
})

it('returns focus to the tools toggle and immediately hides closed controls from interaction', async () => {
  const wrapper = await reader()
  await wrapper.get('button[aria-label="阅读工具"]').trigger('click')
  const tools = wrapper.get('[aria-label="阅读工具"][role="group"]')
  await wrapper.get('button[aria-label="放大"]').trigger('focus')
  await wrapper.get('button[aria-label="阅读工具"]').trigger('click')
  expect(tools.attributes('inert')).toBeDefined()
  expect(tools.attributes('aria-hidden')).toBe('true')
  expect(document.activeElement?.getAttribute('aria-label')).toBe('阅读工具')
  wrapper.unmount()
})

it('keeps the readable page until the newest distant target image is decoded', async () => {
  const wrapper = await reader()
  control.manualRaster = true
  await wrapper.get('input').setValue('9')
  await wrapper.get('form').trigger('submit')
  expect(control.move).not.toHaveBeenCalled()
  expect(wrapper.get('output').text()).toBe('3 / 12')
  expect(wrapper.get('[role="status"]').text()).toContain('9')
  const old = control.raster
  await wrapper.get('input').setValue('11')
  await wrapper.get('form').trigger('submit')
  old.ok(new Blob(['old']))
  await flushPromises()
  expect(control.move).not.toHaveBeenCalled()
  control.raster.ok(new Blob(['new']))
  await flushPromises()
  expect(control.move).toHaveBeenCalledExactlyOnceWith({ pageNumber: 11, pageCoordinates: undefined, behavior: 'instant' })
  expect(wrapper.get('output').text()).toBe('3 / 12')
  wrapper.unmount()
})

it('confirms an adjacent destination only after its actual image loads and smooth scrolling stops', async () => {
  const wrapper = await reader()
  await wrapper.get('button[aria-label="下一页"]').trigger('click')
  await flushPromises()
  expect(control.move).toHaveBeenLastCalledWith({ pageNumber: 4, pageCoordinates: undefined, behavior: 'smooth' })
  control.metrics = { scrollOffset: { x: 0, y: 2040 }, currentPage: 4, pageVisibilityMetrics: [{ pageNumber: 4, visiblePercentage: 100, original: { pageX: 0, pageY: 0 } }] }
  control.smooth = true
  wrapper.findAllComponents(Layer)[1]!.vm.$emit('load')
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  control.scroll({ documentId: 'reader' })
  expect(wrapper.get('output').text()).toBe('3 / 12')
  control.activity({ documentId: 'other', activity: { isSmoothScrolling: false } })
  expect(wrapper.get('output').text()).toBe('3 / 12')
  control.smooth = false
  control.activity({ documentId: 'reader', activity: { isSmoothScrolling: false } })
  await flushPromises()
  expect(wrapper.get('output').text()).toBe('4 / 12')
  wrapper.unmount()
})

it('retains the current page on a failed target and retries without replacing the document', async () => {
  const observation = vi.fn()
  const wrapper = await reader(observation)
  control.manualRaster = true
  await wrapper.get('input').setValue('9')
  await wrapper.get('form').trigger('submit')
  control.raster.fail(new Error('render failed'))
  await flushPromises()
  expect(wrapper.get('output').text()).toBe('3 / 12')
  expect(wrapper.get('[role="alert"]').text()).toContain('第 9 页未能加载')
  expect(control.move).not.toHaveBeenCalled()
  await wrapper.findAll('button').find(b => b.text() === '重试跳页')!.trigger('click')
  control.raster.ok(new Blob(['recovered']))
  await flushPromises()
  expect(control.move).toHaveBeenCalledExactlyOnceWith({ pageNumber: 9, pageCoordinates: undefined, behavior: 'instant' })
  expect(control.destroy).not.toHaveBeenCalled()
  const lastPosition = observation.mock.calls.length
  wrapper.unmount()
  control.raster.ok(new Blob(['late']))
  await flushPromises()
  expect(observation).toHaveBeenCalledTimes(lastPosition)
})

it('adds only the latest rendered visit to reading history after a rapid target replacement', async () => {
  const wrapper = await reader()
  control.manualRaster = true
  await wrapper.get('input').setValue('9')
  await wrapper.get('form').trigger('submit')
  const replaced = control.raster
  await wrapper.get('input').setValue('11')
  await wrapper.get('form').trigger('submit')
  const back = () => wrapper.get('button[aria-label="阅读位置后退"]')
  expect(back().attributes('disabled')).toBeDefined()
  replaced.ok(new Blob(['replaced']))
  await flushPromises()
  expect(control.move).not.toHaveBeenCalled()
  control.raster.ok(new Blob(['latest']))
  await flushPromises()
  control.pages.value = [10, 11, 12]
  control.metrics = { scrollOffset: { x: 0, y: 20000 }, currentPage: 11, pageVisibilityMetrics: [{ pageNumber: 11, visiblePercentage: 100, original: { pageX: 0, pageY: 0 } }] }
  await flushPromises()
  wrapper.findAllComponents(Layer).find(l => l.props('pageIndex') === 10)!.vm.$emit('load')
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  await flushPromises()
  expect(wrapper.get('output').text()).toBe('11 / 12')
  await back().trigger('click')
  control.raster.ok(new Blob(['back']))
  await flushPromises()
  expect(control.move).toHaveBeenLastCalledWith({ pageNumber: 3, pageCoordinates: { x: 0, y: 240 }, behavior: 'instant' })
  wrapper.unmount()
})

it('finishes an instant layout correction without inheriting a superseded smooth scroll', async () => {
  const wrapper = await reader()
  await wrapper.get('button[aria-label="下一页"]').trigger('click')
  await flushPromises()
  control.smooth = true
  control.documentState.value = { ...control.documentState.value, scale: 1.1 }
  await flushPromises()
  control.metrics = { scrollOffset: { x: 0, y: 2250 }, currentPage: 4, pageVisibilityMetrics: [{ pageNumber: 4, visiblePercentage: 100, original: { pageX: 0, pageY: 0 } }] }
  wrapper.findAllComponents(Layer)[1]!.vm.$emit('load')
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  await flushPromises()
  expect(wrapper.get('output').text()).toBe('4 / 12')
  expect(wrapper.find('[aria-busy="true"]').exists()).toBe(false)
  wrapper.unmount()
})

it('keeps the confirmed page while panel resizing changes the dominant visible page', async () => {
  const wrapper = await reader()
  await wrapper.get('button[aria-label="阅读工具"]').trigger('click')
  control.metrics = { scrollOffset: { x: 0, y: 900 }, currentPage: 4, pageVisibilityMetrics: [{ pageNumber: 4, visiblePercentage: 100, original: { pageX: 0, pageY: 20 } }] }
  wrapper.findAllComponents(Layer)[1]!.vm.$emit('load')
  await flushPromises()
  expect(wrapper.get('output').text()).toBe('3 / 12')
  await vi.waitFor(() => expect(control.move).toHaveBeenLastCalledWith({ pageNumber: 3, pageCoordinates: { x: 0, y: 240 }, behavior: 'instant' }))
  wrapper.unmount()
})
