// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import PreviewPage from '../pages/preview.vue'
import type { PdfPagesState, RenderOutcome } from '../server/utils/pdf-pages'

const mocks = vi.hoisted(() => ({ pageState: null as unknown }))

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
  vi.stubGlobal('useRoute', () => ({ query: { file, page: '3', back: '/?view=enterprise&page=2&expand=91' } }))
  vi.stubGlobal('useHead', vi.fn())
  vi.stubGlobal(
    '$fetch',
    vi.fn(async (_url: string, options?: { method?: string }) => {
      if (options?.method === 'POST') {
        return {
          ...pagesState([1, 2, 3]),
          written: 3,
          skipped: 0,
          removed: 0,
          elapsedMs: 1,
        } satisfies RenderOutcome
      }
      return pagesState([])
    }),
  )
})

describe('来源预览页图深链', () => {
  it('渲染尚未生成的目标页后自动打开该页并清除待渲染提示', async () => {
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
    expect(wrapper.text()).toContain('第 3 页的页图还没有渲染')

    const render = wrapper.findAll('button').find((button) => button.text().includes('渲染页图'))
    expect(render).toBeDefined()
    await render!.trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-test="single-page-preview"]').text()).toBe('第 3 页')
    expect(wrapper.text()).not.toContain('第 3 页的页图还没有渲染')
    wrapper.unmount()
  })
})
