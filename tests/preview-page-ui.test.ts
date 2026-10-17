// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import PageImageGallery from '../components/preview/PageImageGallery.vue'
import type { PdfPagesState, RenderOutcome } from '../server/utils/pdf-pages'

const file = 'synthetic/rl-10/notice.pdf'
function pagesState(pages: number[], count: number | null = 3): PdfPagesState {
  return {
    file, pageCount: count, dpi: 300, rendered: pages.length, upToDate: pages.length === 3,
    manifest: pages.length ? { dpi: 300, renderedAt: '2026-10-16T00:00:00.000Z', enhancement: 'white-flatten-grayscale-normalize-sharpen-v1' } : null,
    pages: pages.map(page => ({ page, relPath: `synthetic/p${page}.png`, url: `/synthetic/page-${page}.png`, width: 1653, height: 2339, bytes: 100 })),
  }
}
function open(page = 3) {
  return mount(PageImageGallery, { props: { file, page }, global: { stubs: {
    ImagePreview: { props: ['name', 'src'], template: '<div data-test="single-page-preview" :data-src="src">{{ name }}</div>' },
  } } })
}
beforeEach(() => {
  vi.stubGlobal('$fetch', vi.fn(async (_url: string, options?: { method?: string }) => {
    if (options?.method === 'POST') return { ...pagesState([1, 2, 3]), written: 3, skipped: 0, removed: 0, elapsedMs: 1 } satisfies RenderOutcome
    return pagesState([])
  }))
})

describe('independent page-image deep links', () => {
  it('generates missing images only when the gallery is mounted and opens the requested physical page', async () => {
    const wrapper = open()
    await flushPromises()
    expect($fetch).toHaveBeenCalledWith('/api/pdf-pages', { method: 'POST', body: expect.objectContaining({ file, dpi: expect.any(Number) }) })
    expect(wrapper.get('[data-test="single-page-preview"]').text()).toBe('第 3 页')
    expect(wrapper.get('[data-test="single-page-preview"]').attributes('data-src')).toContain('/synthetic/page-3.png')
    expect(wrapper.emitted('page-change')?.at(-1)).toEqual([3])
    wrapper.unmount()
  })
  it('retains the requested image on rendering failure and never substitutes another page', async () => {
    vi.stubGlobal('$fetch', vi.fn(async (_url: string, options?: { method?: string }) => {
      if (options?.method === 'POST') throw new Error('synthetic renderer failure')
      return pagesState([1, 2])
    }))
    const wrapper = open()
    await flushPromises()
    expect(wrapper.text()).toContain('渲染没有成功')
    expect(wrapper.find('[data-test="single-page-preview"]').exists()).toBe(false)
    wrapper.unmount()
  })
  it('reports an unconfirmable image target when the current manifest has no PDF count', async () => {
    vi.stubGlobal('$fetch', vi.fn(async () => ({ ...pagesState([], null), upToDate: true })))
    const wrapper = open()
    await flushPromises()
    expect(wrapper.text()).toContain('无法确认 PDF 页数，不能定位到第 3 页')
    expect(wrapper.find('[data-test="single-page-preview"]').exists()).toBe(false)
    wrapper.unmount()
  })
  it('reports an out-of-range gallery target without displaying a different image', async () => {
    vi.stubGlobal('$fetch', vi.fn(async () => pagesState([1, 2, 3])))
    const wrapper = open(4)
    await flushPromises()
    expect(wrapper.text()).toContain('第 4 页不存在')
    expect(wrapper.find('[data-test="single-page-preview"]').exists()).toBe(false)
    wrapper.unmount()
  })
  it('opens an existing target image even when the manifest page count is unavailable', async () => {
    vi.stubGlobal('$fetch', vi.fn(async () => pagesState([1, 2, 3], null)))
    const wrapper = open()
    await flushPromises()
    expect(wrapper.get('[data-test="single-page-preview"]').text()).toBe('第 3 页')
    expect(wrapper.text()).not.toContain('无法确认 PDF 页数')
    expect(vi.mocked($fetch).mock.calls.every(call => call[1]?.method !== 'POST')).toBe(true)
    wrapper.unmount()
  })
})
