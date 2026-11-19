// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, afterEach, describe, it, expect, vi, type Mock } from 'vitest'
import Business from '../../../layers/sme-roster/app/pages/platform-business-processes.vue'
import Declarations from '../../../layers/sme-roster/app/pages/platform-declarations.vue'
import Directory from '../../../layers/sme-roster/app/pages/platform-recognized-directory.vue'
import TablePagination from '../../../layers/core/app/components/TablePagination.vue'
import PlatformFilterSelect from '../../../layers/sme-roster/app/components/PlatformFilterSelect.vue'

describe.each([
  ['business-processes', Business],
  ['declarations', Declarations],
  ['recognized-directory', Directory],
] as const)('%s shared list interactions', (source, Page) => {
  const row = { kind: 'record', record: { id: 7, platformKey: 'SYNTHETIC', interface: 'business_list' }, matchedVersion: { versionId: 12, titleRaw: '2', declareKind: 'apply', year: 2024, declarationYear: 2024, businessYear: 2024, nameRaw: '独立页面样例', usccRaw: '91330211255994457P', ruleVersion: 'synthetic' }, enterpriseIds: [11], enterpriseNames: ['独立页面样例'], titleScopes: ['2'], conflicts: [], matchedVersionCount: 1, versionCount: 1, observationCount: 1 }
  const response = { view: 'records', rows: [row], total: 80, page: 1, pageSize: 25 }
  type Fetch = (url: string, options: { query: Record<string, unknown> }) => Promise<unknown>
  let fetch: Mock<Fetch>, optionsFetch: Mock<Fetch>
  const mountPage = () => mount(Page, { global: { stubs: { NuxtLink: { template: '<a><slot/></a>' } } } })
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    fetch = vi.fn<Fetch>(async (_url: string, options: { query: Record<string, unknown> }) => ({ ...response, page: options.query.page }))
    optionsFetch = vi.fn<Fetch>(async () => ({ titles: ['2'], declareKinds: ['apply'], years: [2024], statuses: [], batches: [], districts: [], validityDates: [] }))
    vi.stubGlobal('useRoute', () => ({ query: {} }))
    vi.stubGlobal('$fetch', (url: string, options: any) => url === '/api/platform/filter-options' ? optionsFetch(url, options) : fetch(url, options))
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
  it('clears filters to page one without a delayed duplicate query', async () => {
    const view = mountPage()
    try {
      await flushPromises()
      expect(optionsFetch.mock.calls[0]![1].query.source).toBe(source)
      view.findComponent(TablePagination).vm.$emit('update:page', 3); await flushPromises()
      await view.get('input[aria-label="企业名称或信用代码"]').setValue('待清除')
      view.findAllComponents(PlatformFilterSelect)[0]!.vm.$emit('update:modelValue', '2'); await flushPromises()
      await view.findAll('button').find(button => button.text() === '清除筛选')!.trigger('click'); await flushPromises()
      expect(fetch.mock.calls.at(-1)![1].query).toEqual({ view: 'records', page: 1, pageSize: 25 })
      const completed = fetch.mock.calls.length
      await vi.advanceTimersByTimeAsync(300)
      expect(fetch).toHaveBeenCalledTimes(completed)
    } finally { view.unmount() }
  })
  it('keeps successful rows when options fail and retries options only', async () => {
    optionsFetch.mockRejectedValueOnce(new Error('options unavailable'))
    const view = mountPage()
    try {
      await flushPromises()
      expect(view.text()).toContain('独立页面样例')
      await view.get('[role=alert] button').trigger('click'); await flushPromises()
      expect(view.find('[role=alert]').exists()).toBe(false)
      expect(optionsFetch).toHaveBeenCalledTimes(2); expect(fetch).toHaveBeenCalledTimes(1)
    } finally { view.unmount() }
  })
  it('cancels a pending text query on unmount', async () => {
    const view = mountPage(); await flushPromises()
    await view.get('input[aria-label="企业名称或信用代码"]').setValue('未提交')
    view.unmount(); await vi.advanceTimersByTimeAsync(300)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('recovers failed rows on explicit retry', async () => {
    fetch.mockRejectedValueOnce(new Error('read unavailable'))
    const view = mountPage()
    try {
      await flushPromises(); expect(view.text()).toContain('read unavailable')
      await view.get('[data-testid="table-retry"]').trigger('click'); await flushPromises()
      expect(view.text()).toContain('独立页面样例'); expect(view.text()).not.toContain('read unavailable')
    } finally { view.unmount() }
  })
})
