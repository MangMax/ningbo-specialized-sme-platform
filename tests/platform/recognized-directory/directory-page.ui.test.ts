// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Page from '../../../layers/sme-roster/app/pages/platform-recognized-directory.vue'
import PlatformQueriesPage from '../../../layers/sme-roster/app/pages/platform-queries.vue'
import PlatformFilterSelect from '../../../layers/sme-roster/app/components/PlatformFilterSelect.vue'
import TablePagination from '../../../layers/core/app/components/TablePagination.vue'
import { Select } from '../../../layers/core/app/components/ui/select'

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
  RosterPlatformRecognizedDirectoryDetailDialog: { template: '<div />' },
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

describe('查询历史卡片的目录深链', () => {
  it.each(directoryLinkCases)('links a recognized query card with %s', async (_label, queryKey, expectedQuery) => {
    vi.stubGlobal('useRoute', () => ({ query: {} }))
    const fetch = vi.fn(async () => queryCardResponse(queryKey))
    vi.stubGlobal('$fetch', fetch)
    const view = mountQueriesPage()
    try {
      await flushPromises()
      const link = view.findAll('a').find(anchor => anchor.text() === '本地目录记录')!
      expect(JSON.parse(link.attributes('data-to')!)).toEqual({ path: '/platform-recognized-directory', query: expectedQuery })
      const history = view.get('[data-query-id="7"] button[aria-expanded]')
      expect(history.text()).toBe('查看查询记录')
      expect(history.attributes('aria-expanded')).toBe('false')
      expect(fetch).toHaveBeenCalledTimes(1)
    } finally { view.unmount(); vi.unstubAllGlobals() }
  })
})

describe('平台认定目录页面', () => {
  type TestFetch = (url: string, options: { query: Record<string, unknown> }) => Promise<unknown>
  let fetch: ReturnType<typeof vi.fn<TestFetch>>
  let optionsFetch: ReturnType<typeof vi.fn<TestFetch>>
  const candidates = {titles:['1','2','3','unknown-title'],declareKinds:['apply','review','update'],years:[2025,2024,2023],statuses:['终审通过','待审核'],batches:['2024-2','2023-2'],districts:['33020000'],validityDates:['2027-12-31']}
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    fetch = vi.fn<TestFetch>(async () => response)
    optionsFetch = vi.fn<TestFetch>(async () => candidates)
    vi.stubGlobal('$fetch', (url: string, options: { query: Record<string, unknown> }) => url === '/api/platform/filter-options' ? optionsFetch(url, options) : fetch(url, options))
    vi.stubGlobal('useRoute', () => ({ query: { platformKey: 'DIR-PREFILL', q: '影子企业' } }))
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('distinguishes missing projection from empty source even with assigned enterprise names', async () => {
    fetch.mockResolvedValueOnce({ ...response, rows: [
      { ...row, matchedVersion: { ...row.matchedVersion, ruleVersion: null, titleRaw: null, status: null, declarationYear: null, businessYear: null, validityDateRaw: null } },
      { ...row, record: { ...row.record, id: 999 }, matchedVersion: { ...row.matchedVersion, titleRaw: null, status: null, declarationYear: null, businessYear: null, validityDateRaw: null } },
    ] })
    const view = mountPage()
    try {
      await flushPromises()
      for (const kind of ['row', 'card']) {
        const items = view.findAll(`[data-record-id][data-testid$="-${kind}"]`)
        expect(items).toHaveLength(2)
        expect(items[0]!.text()).toContain(row.enterpriseNames[0])
        expect(items[0]!.text()).toContain('业务字段未同步')
        expect(items[0]!.text()).not.toContain('原文未提供')
        expect(items[1]!.text()).toContain('原文未提供')
        expect(items[1]!.text()).not.toContain('业务字段未同步')
      }
      expect(fetch.mock.calls.every(([, options]) => !('method' in options))).toBe(true)
    } finally { view.unmount() }
  })

  it('selects actual filter candidates immediately while text search stays debounced', async () => {
    const view = mountPage()
    try {
      await flushPromises()
      expect(optionsFetch).toHaveBeenCalledWith('/api/platform/filter-options', expect.objectContaining({query:{source:'recognized-directory',view:'records'}}))
      expect(view.findAll('input')).toHaveLength(1)
      await view.get('input[aria-label="企业名称或信用代码"]').setValue('甲')
      await view.get('input[aria-label="企业名称或信用代码"]').setValue('甲合成')
      expect(fetch).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(299);expect(fetch).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1);await flushPromises()
      expect(fetch.mock.calls.at(-1)![1].query.q).toBe('甲合成')
      for(const [label,key,value] of [["称号","titleRaw","2"],["有效期","rddqrq","2027-12-31"],["维护批次","whpc","2024-2"],["属地","szq","33020000"]]) {
        view.findAllComponents(PlatformFilterSelect).find(control=>control.props('label')===label)!.vm.$emit('update:modelValue',value)
        await flushPromises()
        expect(fetch.mock.calls.at(-1)![1].query[key!]).toBe(key==='year'?Number(value):value)
      }
      const mode=view.findAllComponents(Select).find(control=>control.find('[aria-label="目录视图"]').exists())!
      mode.vm.$emit('update:modelValue','isolated');await flushPromises()
      expect(fetch.mock.calls.at(-1)![1].query.view).toBe('isolated')
      expect(fetch.mock.calls.at(-1)![1].query).not.toHaveProperty('rddqrq')
      expect(fetch.mock.calls.at(-1)![1].query).not.toHaveProperty('whpc')
      expect(fetch.mock.calls.at(-1)![1].query).not.toHaveProperty('szq')
      expect(optionsFetch.mock.calls.at(-1)![1].query.view).toBe('isolated')
      view.findComponent(TablePagination).vm.$emit('update:pageSize',50);await flushPromises()
      expect(fetch.mock.calls.at(-1)![1].query).toMatchObject({pageSize:50,page:1})
      expect(view.findAll('button').some(button=>['查询','重置'].includes(button.text().trim()))).toBe(false)
    } finally {view.unmount()}
  })







  it('shows distinct empty records and isolated states', async () => {
    fetch.mockResolvedValue({ ...response, rows: [], total: 0 })
    const view = mountPage()
    try {
      await flushPromises()
      expect(view.text()).toContain('没有匹配的目录记录')
    } finally { view.unmount() }
  })


})
