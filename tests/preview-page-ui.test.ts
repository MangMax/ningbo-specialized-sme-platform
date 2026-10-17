// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import PreviewPage from '../pages/preview.vue'
import type { PdfPagesState, RenderOutcome } from '../server/utils/pdf-pages'

const mocks = vi.hoisted(() => ({
  pageState: null as unknown,
  galleryState: null as unknown,
  renderedPages: [1, 2, 3] as number[],
}))

vi.mock('@pinia/colada', async () => {
  const { ref } = await import('vue')
  return { useQuery: () => ({ data: ref(mocks.pageState) }) }
})

const file = 'synthetic/rl-10/notice.pdf'
const manifest = {
  dpi: 300,
  renderedAt: '2026-10-16T00:00:00.000Z',
  enhancement: 'white-flatten-grayscale-normalize-sharpen-v1' as const,
}

function pagesState(pages: number[]): PdfPagesState {
  return {
    file,
    pageCount: 3,
    dpi: 300,
    rendered: pages.length,
    upToDate: pages.length === 3,
    manifest: pages.length === 0 ? null : manifest,
    pages: pages.map((page) => ({
      page,
      relPath: `synthetic/rl-10/.notice.pdf.pages/p${String(page).padStart(3, '0')}.png`,
      url: `/synthetic/page-${page}.png`,
      width: 1653,
      height: 2339,
      bytes: 100,
    })),
  }
}

beforeEach(() => {
  mocks.pageState = pagesState([])
  mocks.galleryState = pagesState([])
  mocks.renderedPages = [1, 2, 3]
  vi.stubGlobal('useRoute', () => ({ query: { file, page: '3', back: '/?view=enterprise&page=2&expand=91' } }))
  vi.stubGlobal('useRequestURL', () => ({ origin: window.location.origin }))
  vi.stubGlobal('useHead', vi.fn())
  vi.stubGlobal(
    '$fetch',
    vi.fn(async (_url: string, options?: { method?: string }) => {
      if (options?.method === 'POST') {
        return {
          ...pagesState(mocks.renderedPages),
          written: mocks.renderedPages.length,
          skipped: 0,
          removed: 0,
          elapsedMs: 1,
        } satisfies RenderOutcome
      }
      return (mocks.galleryState as PdfPagesState | null) ?? pagesState([])
    }),
  )
})

describe('来源预览页图深链', () => {
  it('有效深链自动生成缺失页图并打开目标页', async () => {
    const wrapper = mount(PreviewPage, {
      attachTo: document.body,
      global: {
        stubs: {
          PageHeader: { template: '<div><slot name="breadcrumb"/><slot name="actions"/></div>' },
          NuxtLink: { props: ['to'], template: '<a :href="to"><slot/></a>' },
          ImagePreview: {
            props: ['name', 'src'],
            template: '<div data-test="single-page-preview" :data-src="src">{{ name }}</div>',
          },
        },
      },
    })

    await flushPromises()
    await vi.waitFor(() => {
      expect(vi.mocked($fetch)).toHaveBeenCalledWith('/api/pdf-pages', {
        method: 'POST',
        body: expect.objectContaining({ file, dpi: expect.any(Number) }),
      })
    })
    await flushPromises()

    expect(wrapper.find('[data-test="single-page-preview"]').text()).toBe('第 3 页')
    expect(wrapper.find('[data-test="single-page-preview"]').attributes('data-src')).toContain(
      '/synthetic/page-3.png',
    )
    expect(wrapper.text()).not.toContain('第 3 页的页图还没有渲染')
    wrapper.unmount()
  })

  it('渲染失败时明确报错且不退回到其他页', async () => {
    mocks.pageState = pagesState([3])
    vi.stubGlobal(
      '$fetch',
      vi.fn(async (_url: string, options?: { method?: string }) => {
        if (options?.method === 'POST') throw new Error('synthetic renderer failure')
        return pagesState([1, 2])
      }),
    )

    const wrapper = mount(PreviewPage, {
      attachTo: document.body,
      global: {
        stubs: {
          PageHeader: { template: '<div><slot name="breadcrumb"/><slot name="actions"/></div>' },
          NuxtLink: { props: ['to'], template: '<a :href="to"><slot/></a>' },
          ImagePreview: {
            props: ['name'],
            template: '<div data-test="single-page-preview">{{ name }}</div>',
          },
        },
      },
    })

    await flushPromises()
    await vi.waitFor(() => {
      expect(vi.mocked($fetch)).toHaveBeenCalledWith('/api/pdf-pages', expect.objectContaining({ method: 'POST' }))
    })
    await flushPromises()

    expect(wrapper.text()).toContain('渲染没有成功')
    expect(wrapper.find('[data-test="single-page-preview"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('实际页数未知时明确说明无法确认深链落点', async () => {
    const stateWithUnknownCount = { ...pagesState([]), pageCount: null }
    mocks.pageState = stateWithUnknownCount
    mocks.galleryState = stateWithUnknownCount
    vi.stubGlobal('$fetch', vi.fn(async () => stateWithUnknownCount))

    const wrapper = mount(PreviewPage, {
      attachTo: document.body,
      global: {
        stubs: {
          PageHeader: { template: '<div><slot name="breadcrumb"/><slot name="actions"/></div>' },
          NuxtLink: { props: ['to'], template: '<a :href="to"><slot/></a>' },
          ImagePreview: { template: '<div data-test="single-page-preview" />' },
        },
      },
    })

    await flushPromises()
    expect(wrapper.text()).toContain('无法确认 PDF 页数')
    expect(wrapper.find('[data-test="single-page-preview"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('深链页码超过 PDF 实际页数时明确提示页码不存在', async () => {
    vi.stubGlobal('useRoute', () => ({ query: { file, page: '4', back: '/' } }))

    const wrapper = mount(PreviewPage, {
      attachTo: document.body,
      global: {
        stubs: {
          PageHeader: { template: '<div><slot name="breadcrumb"/><slot name="actions"/></div>' },
          NuxtLink: { props: ['to'], template: '<a :href="to"><slot/></a>' },
          ImagePreview: {
            props: ['name'],
            template: '<div data-test="single-page-preview">{{ name }}</div>',
          },
        },
      },
    })

    await flushPromises()

    expect(wrapper.text()).toContain('第 4 页不存在')
    expect(wrapper.text()).toContain('该 PDF 共 3 页，请检查来源页码。')
    wrapper.unmount()
  })

  it('父页查询没有数据时仍用画廊读取的页数提示页码越界', async () => {
    mocks.pageState = null
    mocks.galleryState = pagesState([1, 2, 3])
    vi.stubGlobal('useRoute', () => ({ query: { file, page: '5', back: '/' } }))

    const wrapper = mount(PreviewPage, {
      attachTo: document.body,
      global: {
        stubs: {
          PageHeader: { template: '<div><slot name="breadcrumb"/><slot name="actions"/></div>' },
          NuxtLink: { props: ['to'], template: '<a :href="to"><slot/></a>' },
          ImagePreview: {
            props: ['name'],
            template: '<div data-test="single-page-preview">{{ name }}</div>',
          },
        },
      },
    })

    await flushPromises()

    expect(wrapper.text()).toContain('第 5 页不存在')
    expect(wrapper.text()).toContain('该 PDF 共 3 页，请检查来源页码。')
    wrapper.unmount()
  })

  it('预览返回链接保留站内筛选、当前页和展开行地址', async () => {
    const back = '/?view=enterprise&q=%E5%BC%80%E8%AF%9A&page=2&expand=91'
    vi.stubGlobal('useRoute', () => ({ query: { file, page: '8', back } }))

    const wrapper = mount(PreviewPage, {
      attachTo: document.body,
      global: {
        stubs: {
          PageHeader: { template: '<div><slot name="breadcrumb"/><slot name="actions"/></div>' },
          NuxtLink: { props: ['to'], template: '<a :href="to"><slot/></a>' },
          ImagePreview: { props: ['name'], template: '<div>{{ name }}</div>' },
        },
      },
    })

    const backLinks = wrapper.findAll('a').filter((link) => link.attributes('href') === back)
    expect(backLinks.length).toBeGreaterThanOrEqual(2)
    expect(backLinks.map((link) => link.text()).join(' ')).toContain('返回')
    wrapper.unmount()
  })

  it('实际页数未知但目标页图已存在时仍打开对应页图', async () => {
    const stateWithKnownTarget = { ...pagesState([3]), pageCount: null }
    mocks.pageState = stateWithKnownTarget
    mocks.galleryState = stateWithKnownTarget

    const wrapper = mount(PreviewPage, {
      attachTo: document.body,
      global: {
        stubs: {
          PageHeader: { template: '<div><slot name="breadcrumb"/><slot name="actions"/></div>' },
          NuxtLink: { props: ['to'], template: '<a :href="to"><slot/></a>' },
          ImagePreview: {
            props: ['name', 'src'],
            template: '<div data-test="single-page-preview" :data-src="src">{{ name }}</div>',
          },
        },
      },
    })

    await flushPromises()
    expect(wrapper.find('[data-test="single-page-preview"]').text()).toBe('第 3 页')
    expect(wrapper.find('[data-test="single-page-preview"]').attributes('data-src')).toContain(
      '/synthetic/page-3.png',
    )
    expect(wrapper.text()).not.toContain('无法确认 PDF 页数')
    wrapper.unmount()
  })
})
