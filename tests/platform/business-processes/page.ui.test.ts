// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Page from '../../../pages/platform-business-processes.vue'
import PlatformFilterSelect from '../../../components/PlatformFilterSelect.vue'
import TablePagination from '../../../components/TablePagination.vue'
import { Select } from '../../../components/ui/select'

const row = {
  kind: 'record' as const,
  record: { id: 7, platformKey: 'SQ-2023-1', interface: 'business_list' as const },
  matchedVersion: { versionId: 12, titleRaw: '2', declareKind: 'review', businessYear: 2023, appliedAt: '2023-02-01 09:00:00', status: '终审通过', batch: '2023-2', awardBatchLabel: '第三批', province: '浙江省', nameRaw: '甲办理企业', usccRaw: '91330211255994457P', ruleVersion: 'platform-business-v1' },
  matchedVersionCount: 1,
  versionCount: 1,
  observationCount: 2,
  latestObservationAt: '2026-10-02T00:00:00Z',
  enterpriseIds: [11],
  enterpriseNames: ['甲办理企业'],
  titleScopes: ['2'],
  conflicts: [],
}
const response = { view: 'records' as const, rows: [row], total: 1, page: 1, pageSize: 25 }
const stubs = { NuxtLink: { props: ['to'], template: '<a><slot /></a>' } }
function mountPage() {
  return mount(Page, { global: { stubs } })
}

describe('关联办理页面', () => {
  type TestFetch = (url: string, options: { query: Record<string, unknown> }) => Promise<unknown>
  let fetch: ReturnType<typeof vi.fn<TestFetch>>
  let optionsFetch: ReturnType<typeof vi.fn<TestFetch>>
  const candidates = {titles:['1','2','3','unknown-title'],declareKinds:['apply','review','update'],years:[2025,2024,2023],statuses:['终审通过','待审核'],batches:['2024-2','2023-2'],districts:['33020000'],validityDates:['2027-12-31']}
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    fetch = vi.fn<TestFetch>(async () => response)
    optionsFetch = vi.fn<TestFetch>(async () => candidates)
    vi.stubGlobal('$fetch', (url: string, options: { query: Record<string, unknown> }) => url === '/api/platform/filter-options' ? optionsFetch(url, options) : fetch(url, options))
    vi.stubGlobal('useRoute', () => ({ query: { platformKey: 'SQ-PREFILL', q: '影子企业' } }))
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
      expect(optionsFetch).toHaveBeenCalledWith('/api/platform/filter-options', expect.objectContaining({query:{source:'business-processes',view:'records'}}))
      expect(view.findAll('input')).toHaveLength(1)
      await view.get('input[aria-label="企业名称或信用代码"]').setValue('甲')
      await view.get('input[aria-label="企业名称或信用代码"]').setValue('甲合成')
      expect(fetch).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(299);expect(fetch).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1);await flushPromises()
      expect(fetch.mock.calls.at(-1)![1].query.q).toBe('甲合成')
      for(const [label,key,value] of [["称号","titleRaw","2"],["事项","declareKind","review"],["业务年","year","2024"],["办理状态","status","终审通过"],["维护批次","batch","2023-2"]]) {
        view.findAllComponents(PlatformFilterSelect).find(control=>control.props('label')===label)!.vm.$emit('update:modelValue',value)
        await flushPromises()
        expect(fetch.mock.calls.at(-1)![1].query[key!]).toBe(key==='year'?Number(value):value)
      }
      const mode=view.findAllComponents(Select).find(control=>control.find('[aria-label="关联办理视图"]').exists())!
      mode.vm.$emit('update:modelValue','isolated');await flushPromises()
      expect(fetch.mock.calls.at(-1)![1].query.view).toBe('isolated')
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
      expect(view.text()).toContain('没有匹配的关联办理记录')
      expect(view.text()).toContain('未找到符合筛选条件的关联办理记录。')
    } finally { view.unmount() }
  })


})
