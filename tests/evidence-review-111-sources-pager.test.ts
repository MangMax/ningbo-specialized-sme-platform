// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import { afterEach, expect, it, vi } from 'vitest'
import EvidenceImpactSources from '../components/evidence-review/EvidenceImpactSources.vue'

const source = (revisionId: number) => ({
  revisionId,
  sourceKind: 'platform_query',
  sourceKey: `query-${revisionId}`,
  sourceVersion: 'v2',
  classification: 'premise_invalid',
  eventId: null,
  coverageChanged: true,
  factChanged: false,
})

function render(fetcher: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('$fetch', fetcher)
  return mount(EvidenceImpactSources, {
    props: { impactId: 4, enterpriseId: 7 },
    global: { plugins: [createPinia(), PiniaColada], stubs: { NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' } } },
  })
}

afterEach(() => vi.unstubAllGlobals())

it('hides the whole pager for a successful single source page', async () => {
  const fetcher = vi.fn().mockResolvedValue({ rows: [source(9)], nextCursor: null, asOf: {} })
  const view = render(fetcher)
  await flushPromises()
  expect(view.text()).toContain('query-9')
  expect(view.text()).not.toContain('每页最多 25 项')
  expect(view.findAll('button').some(button => button.text().includes('上一页来源'))).toBe(false)
  expect(view.findAll('button').some(button => button.text().includes('下一页来源'))).toBe(false)
  expect(view.text()).toContain('复核项 #4')
  view.unmount()
})

it('shows the pager when nextCursor exists even though the current page has fewer than 25 rows', async () => {
  let page = 1
  const fetcher = vi.fn(async (_url: string, options?: any) => {
    if (options?.query?.cursor === 'next-page') {
      page = 2
      return { rows: [source(10)], nextCursor: null, asOf: {} }
    }
    return { rows: [source(9)], nextCursor: 'next-page', asOf: {} }
  })
  const view = render(fetcher)
  await flushPromises()
  expect(view.text()).toContain('每页最多 25 项')
  const next = view.findAll('button').find(button => button.text().includes('下一页来源'))!
  expect(next).toBeTruthy()
  await next.trigger('click')
  await flushPromises()
  expect(fetcher).toHaveBeenCalledWith('/api/roster/evidence-impacts/4/sources', { query: { limit: 25, cursor: 'next-page' } })
  expect(page).toBe(2)
  expect(view.text()).toContain('来源第 2 页')
  expect(view.findAll('button').find(button => button.text().includes('上一页来源'))!.attributes('disabled')).toBeUndefined()
  expect(view.findAll('button').find(button => button.text().includes('下一页来源'))!.attributes('disabled')).toBeDefined()
  view.unmount()
})

it('retains retry and the source-page context when a cursor read fails', async () => {
  const fetcher = vi.fn(async (_url: string, options?: any) => {
    if (options?.query?.cursor === 'bad-page') throw new Error('private upstream detail')
    return { rows: [source(9)], nextCursor: 'bad-page', asOf: {} }
  })
  const view = render(fetcher)
  await flushPromises()
  await view.findAll('button').find(button => button.text().includes('下一页来源'))!.trigger('click')
  await flushPromises()
  expect(view.text()).toContain('证据变化来源读取失败')
  expect(view.text()).toContain('复核项 #4 · 来源第 1 页')
  expect(view.text()).toContain('来源第 1 页 · 每页最多 25 项')
  expect(view.text()).not.toContain('private upstream detail')
  expect(view.find('[data-testid="table-retry"]').exists()).toBe(true)
  expect(view.findAll('button').some(button => button.text().includes('上一页来源'))).toBe(true)
  view.unmount()
})
