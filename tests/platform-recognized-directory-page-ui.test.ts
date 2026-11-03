// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Page from '../pages/platform-recognized-directory.vue'
import PlatformQueriesPage from '../pages/platform-queries.vue'
import TablePagination from '../components/TablePagination.vue'
import { Select } from '../components/ui/select'

const version = {
  versionId: 12, validityDateRaw: '2027-12-31', maintenanceYear: 2024, maintenanceBatch: '2024-2',
  district: '33020000', awardNote: '原认定说明', titleRaw: '2', nameRaw: '甲目录企业',
  usccRaw: '91330211AAAAAAAA1X', ruleVersion: 'platform-recognized-v1',
}
const row = {
  kind: 'record' as const,
  record: { id: 7, platformKey: 'DIR-2024-1', interface: 'recognized_list' as const },
  matchedVersion: version,
  matchedVersionCount: 1,
  versionCount: 1,
  observationCount: 2,
  latestObservationAt: '2026-10-02T00:00:00Z',
  enterpriseIds: [11],
  enterpriseNames: ['甲目录企业'],
  titleScopes: ['2'],
  conflicts: [],
}
const response = { view: 'records' as const, rows: [row], total: 1, page: 1, pageSize: 25 }
const stubs = {
  NuxtLink: { props: ['to'], template: '<a :href="typeof to === \'string\' ? to : to.path"><slot /></a>' },
  PlatformRecognizedDirectoryDetailDialog: { template: '<div />' },
}
function mountPage() {
  return mount(Page, { global: { stubs } })
}

const queryCardResponse = (queryKey: string) => ({
  total: 1, page: 1, pageSize: 50, counts: { partial: 1 },
  rows: [{ relationsIncluded: false, query: { id: 7, queryKey, interface: 'recognized_list', status: 'partial', rdjb: '2', queriedAt: '2026-10-21', createdAt: '2026-10-21', relationCount: 1 }, relations: [] }],
})
function mountQueriesPage() {
  return mount(PlatformQueriesPage, {
    global: {
      stubs: {
        NuxtLink: { props: ['to'], template: '<a :data-to="JSON.stringify(to)"><slot /></a>' },
        PageHeader: { template: '<header><slot /></header>' },
      },
    },
  })
}
const directoryLinkCases = [
  ['an exact USCC key', '91330211AAAAAAAA1X', { q: '91330211AAAAAAAA1X' }],
  ['a name: key', 'name:宁波示例企业', { q: '宁波示例企业' }],
  ['a scope: key', 'scope:queryBusList:1:%7B%22whpcyear%22%3A%222024%22%7D', {}],
] as const

describe('查询证据卡片的目录深链', () => {
  it.each(directoryLinkCases)('links a recognized query card with %s', async (_label, queryKey, expectedQuery) => {
    vi.stubGlobal('useRoute', () => ({ query: {} }))
    vi.stubGlobal('$fetch', vi.fn(async () => queryCardResponse(queryKey)))
    const view = mountQueriesPage()
    try {
      await flushPromises()
      const link = view.findAll('a').find(anchor => anchor.text() === '本地目录记录')!
      expect(JSON.parse(link.attributes('data-to')!)).toEqual({ path: '/platform-recognized-directory', query: expectedQuery })
      // The evidence reader still renders on the same card.
      expect(view.text()).toContain('尚未加载')
    } finally { view.unmount(); vi.unstubAllGlobals() }
  })
})

describe('平台认定目录页面', () => {
  let fetch: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetch = vi.fn(async () => response)
    vi.stubGlobal('$fetch', fetch)
    vi.stubGlobal('useRoute', () => ({ query: { platformKey: 'DIR-PREFILL', q: '影子企业' } }))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('seeds the exact directory id from the consumer link and re-queries raw filters', async () => {
    const view = mountPage()
    try {
      await flushPromises()
      expect(fetch).toHaveBeenCalledWith('/api/platform/recognized-directory', expect.objectContaining({ query: expect.objectContaining({ view: 'records', platformKey: 'DIR-PREFILL', q: '影子企业', page: 1, pageSize: 25 }) }))
      expect(view.text()).toContain('DIR-2024-1')
      expect(view.text()).toContain('甲目录企业')
      expect(view.text()).toContain('不是当前有效资格')
      expect(view.get('a[href="/current-enterprises"]').element.tagName).toBe('A')

      await view.get('input[aria-label="有效期原值"]').setValue('2027-12-31')
      await view.get('input[aria-label="维护批次"]').setValue('2024-2')
      await view.get('input[aria-label="属地"]').setValue('33020000')
      await view.get('input[aria-label="有效维护年"]').setValue('2024')
      await view.get('form').trigger('submit')
      await flushPromises()
      expect(fetch.mock.calls.at(-1)![1].query).toMatchObject({ rddqrq: '2027-12-31', whpc: '2024-2', szq: '33020000', whpcyear: 2024, page: 1 })

      const selects = view.findAllComponents(Select)
      selects[0]!.vm.$emit('update:modelValue', '1')
      await flushPromises()
      expect(fetch.mock.calls.at(-1)![1].query).toMatchObject({ rdjb: '1', page: 1 })
      selects[1]!.vm.$emit('update:modelValue', 'isolated')
      await flushPromises()
      expect(fetch.mock.calls.at(-1)![1].query).toMatchObject({ view: 'isolated', page: 1 })

      view.findComponent(TablePagination).vm.$emit('update:pageSize', 50)
      await flushPromises()
      expect(fetch.mock.calls.at(-1)![1].query).toMatchObject({ pageSize: 50, page: 1 })
    } finally { view.unmount() }
  })

  it('rejects a non-integer maintenance year before querying', async () => {
    const view = mountPage()
    try {
      await flushPromises()
      const calls = fetch.mock.calls.length
      await view.get('input[aria-label="有效维护年"]').setValue('20x4')
      expect(view.text()).toContain('有效维护年必须是正整数')
      await view.get('form').trigger('submit')
      await flushPromises()
      expect(fetch.mock.calls.length).toBe(calls)
    } finally { view.unmount() }
  })

  it('shows distinct empty records and isolated states', async () => {
    fetch.mockResolvedValue({ ...response, rows: [], total: 0 })
    const view = mountPage()
    try {
      await flushPromises()
      expect(view.text()).toContain('没有匹配的目录记录')
      expect(view.text()).toContain('不猜填')
    } finally { view.unmount() }
  })

  it('keeps a failed page retryable and recovers on explicit retry', async () => {
    fetch.mockRejectedValueOnce(new Error('synthetic directory read failure'))
    const view = mountPage()
    try {
      await flushPromises()
      expect(view.text()).toContain('加载失败')
      expect(view.text()).toContain('synthetic directory read failure')
      fetch.mockResolvedValueOnce(response)
      await view.get('[data-testid="table-retry"]').trigger('click')
      await flushPromises()
      expect(view.text()).toContain('DIR-2024-1')
      expect(view.text()).not.toContain('synthetic directory read failure')
    } finally { view.unmount() }
  })
})
