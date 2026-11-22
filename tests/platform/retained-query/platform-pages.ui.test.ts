// @vitest-environment jsdom
import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, afterEach, describe, it, expect, vi, type Mock } from 'vitest'
import Business from '../../../layers/sme-roster/app/pages/platform-business-processes.vue'
import Declarations from '../../../layers/sme-roster/app/pages/platform-declarations.vue'
import Directory from '../../../layers/sme-roster/app/pages/platform-recognized-directory.vue'
import TablePagination from '../../../layers/core/app/components/TablePagination.vue'
import { Select } from '../../../layers/core/app/components/ui/select'
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
  const mountPage = () => mount(Page, { global: { stubs: { NuxtLink: { props: ['to'], template: '<a :data-to="JSON.stringify(to)"><slot/></a>' } } } })
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
      expect(view.text()).not.toContain('共 0 条')
      expect(view.find('[data-slot="empty"]').exists()).toBe(false)
      await view.get('[data-testid="table-retry"]').trigger('click'); await flushPromises()
      expect(view.text()).toContain('独立页面样例'); expect(view.text()).not.toContain('read unavailable')
    } finally { view.unmount() }
  })
  it('keeps the successful rows, count and pagination unit when a view change fails, then retries the new view', async () => {
    const observation = {
      kind: 'observation', relationId: 41, queryId: 23, queryKey: 'shared-key',
      queriedAt: '2026-11-18', sequenceNo: 2, nameRaw: '隔离页面样例',
      identityState: 'missing_key', contentState: 'verified',
    }
    fetch.mockResolvedValueOnce({ ...response, page: 2 })
      .mockRejectedValueOnce(new Error('isolated unavailable'))
      .mockResolvedValueOnce({ view: 'isolated', rows: [observation], total: 4, page: 1, pageSize: 25 })
    const view = mountPage()
    try {
      await flushPromises()
      const mode = view.findAllComponents(Select).find(control => control.find('[aria-label$="视图"]').exists())!
      mode.vm.$emit('update:modelValue', 'isolated')
      await flushPromises()
      expect(view.text()).toContain('独立页面样例')
      expect(view.text()).toContain('共 80 条记录')
      expect(view.text()).toContain('保留第 2 页结果')
      expect(view.findComponent(TablePagination).props()).toMatchObject({ page: 2, total: 80, unit: '条记录' })
      await view.get('[data-testid="table-retry"]').trigger('click')
      await flushPromises()
      expect(fetch.mock.calls.at(-1)![1].query).toEqual({ view: 'isolated', page: 1, pageSize: 25 })
      expect(view.text()).toContain('隔离页面样例')
      expect(view.text()).toContain('共 4 条观察')
      expect(view.text()).not.toContain('独立页面样例')
      expect(view.findComponent(TablePagination).props()).toMatchObject({ page: 1, total: 4, unit: '条观察' })
      const links = view.findAll('a').filter(link => link.text() === '查看原查询')
      expect(links.map(link => JSON.parse(link.attributes('data-to')!))).toEqual([
        { path: '/platform-queries', query: { queryId: 23 } },
        { path: '/platform-queries', query: { queryId: 23 } },
      ])
    } finally { view.unmount() }
  })
  it('retains a confirmed empty result if the other view fails', async () => {
    fetch.mockResolvedValueOnce({ ...response, rows: [], total: 0 })
      .mockRejectedValueOnce(new Error('isolated unavailable'))
    const view = mountPage()
    try {
      await flushPromises()
      const title = view.get('[data-slot="empty-title"]').text()
      const mode = view.findAllComponents(Select).find(control => control.find('[aria-label$="视图"]').exists())!
      mode.vm.$emit('update:modelValue', 'isolated')
      await flushPromises()
      expect(view.text()).toContain('isolated unavailable')
      expect(view.text()).toContain('共 0 条记录')
      expect(view.get('[data-slot="empty-title"]').text()).toBe(title)
    } finally { view.unmount() }
  })
  it('shows individually removable filters and omits unavailable facets', async () => {
    const view = mountPage()
    try {
      await flushPromises()
      expect(view.find('[aria-label="维护批次"]').exists()).toBe(false)
      await view.get('input[aria-label="企业名称或信用代码"]').setValue('保留条件')
      view.findAllComponents(PlatformFilterSelect).find(control => control.props('label') === '称号')!.vm.$emit('update:modelValue', '2')
      await flushPromises()
      expect(view.findAll('[data-testid="filter-chip"]')).toHaveLength(2)
      await view.get('[aria-label^="移除筛选条件:称号"]').trigger('click')
      await flushPromises()
      expect(view.findAll('[data-testid="filter-chip"]').map(chip => chip.text())).toEqual(['企业：保留条件'])
      expect(fetch.mock.calls.at(-1)![1].query).toEqual({ view: 'records', q: '保留条件', page: 1, pageSize: 25 })
    } finally { view.unmount() }
  })
})
