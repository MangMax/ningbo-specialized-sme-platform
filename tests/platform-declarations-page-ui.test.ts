// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Page from '../pages/platform-declarations.vue'
import PlatformFilterSelect from '../components/PlatformFilterSelect.vue'
import TablePagination from '../components/TablePagination.vue'
import { Select } from '../components/ui/select'

const row = {
  kind: 'record' as const,
  record: { id: 7, platformKey: 'SQ-2024-1', interface: 'apply_list' as const },
  matchedVersion: { versionId: 12, titleRaw: '2', declareKind: 'apply', declarationYear: 2024, appliedAt: '2024-03-01 09:00:00', status: '终审通过', nameRaw: '甲合成企业', usccRaw: '91330211255994457P', ruleVersion: 'platform-apply-v1' },
  matchedVersionCount: 1,
  versionCount: 1,
  observationCount: 1,
  latestObservationAt: '2026-10-02T00:00:00Z',
  enterpriseIds: [11],
  enterpriseNames: ['甲合成企业'],
  conflicts: [],
}
const response = { view: 'records' as const, rows: [row], total: 1, page: 1, pageSize: 25 }
const stubs = { NuxtLink: { template: '<a><slot /></a>' } }
function mountPage() {
  return mount(Page, { global: { stubs } })
}

describe('申报记录页面', () => {
  type TestFetch = (url: string, options: { query: Record<string, unknown> }) => Promise<unknown>
  let fetch: ReturnType<typeof vi.fn<TestFetch>>
  let optionsFetch: ReturnType<typeof vi.fn<TestFetch>>
  const candidates = {titles:['1','2','3','unknown-title'],declareKinds:['apply','review','update'],years:[2025,2024,2023],statuses:['终审通过','待审核'],batches:['2024-2','2023-2'],districts:['33020000'],validityDates:['2027-12-31']}
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    fetch = vi.fn<TestFetch>(async () => response)
    optionsFetch = vi.fn<TestFetch>(async () => candidates)
    vi.stubGlobal('$fetch', (url: string, options: { query: Record<string, unknown> }) => url === '/api/platform/filter-options' ? optionsFetch(url, options) : fetch(url, options))
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('selects actual filter candidates immediately while text search stays debounced', async () => {
    const view = mountPage()
    try {
      await flushPromises()
      expect(optionsFetch).toHaveBeenCalledWith('/api/platform/filter-options', expect.objectContaining({query:{source:'declarations',view:'records'}}))
      expect(view.findAll('input')).toHaveLength(1)
      await view.get('input[aria-label="企业名称或信用代码"]').setValue('甲')
      await view.get('input[aria-label="企业名称或信用代码"]').setValue('甲合成')
      expect(fetch).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(299);expect(fetch).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1);await flushPromises()
      expect(fetch.mock.calls.at(-1)![1].query.q).toBe('甲合成')
      for(const [label,key,value] of [["称号","titleRaw","2"],["事项","declareKind","review"],["年度","year","2024"],["状态","status","终审通过"]]) {
        view.findAllComponents(PlatformFilterSelect).find(control=>control.props('label')===label)!.vm.$emit('update:modelValue',value)
        await flushPromises()
        expect(fetch.mock.calls.at(-1)![1].query[key!]).toBe(key==='year'?Number(value):value)
      }
      const mode=view.findAllComponents(Select).find(control=>control.find('[aria-label="申报记录视图"]').exists())!
      mode.vm.$emit('update:modelValue','isolated');await flushPromises()
      expect(fetch.mock.calls.at(-1)![1].query.view).toBe('isolated')
      expect(optionsFetch.mock.calls.at(-1)![1].query.view).toBe('isolated')
      view.findComponent(TablePagination).vm.$emit('update:pageSize',50);await flushPromises()
      expect(fetch.mock.calls.at(-1)![1].query).toMatchObject({pageSize:50,page:1})
      expect(view.findAll('button').some(button=>['查询','重置'].includes(button.text().trim()))).toBe(false)
    } finally {view.unmount()}
  })

  it('clears all filters and returns to page one without a delayed duplicate query', async () => {
    fetch.mockImplementation(async (_url, options) => ({ ...response, total: 80, page: options.query.page, pageSize: options.query.pageSize }))
    const view = mountPage()
    try {
      await flushPromises()
      view.findComponent(TablePagination).vm.$emit('update:page', 3)
      await flushPromises()
      expect(fetch.mock.calls.at(-1)![1].query.page).toBe(3)
      await view.get('input[aria-label="企业名称或信用代码"]').setValue('待清除搜索')
      for(const control of view.findAllComponents(PlatformFilterSelect)) {control.vm.$emit('update:modelValue',String(control.props('options')[0]));await flushPromises()}
      const clear = view.findAll('button').find(button => button.text() === '清除筛选')
      expect(clear).toBeDefined()
      await clear!.trigger('click')
      await flushPromises()
      expect(fetch.mock.calls.at(-1)![1].query).toEqual({ view: 'records', page: 1, pageSize: 25 })
      expect((view.get('input[aria-label="企业名称或信用代码"]').element as HTMLInputElement).value).toBe('')
      for(const control of view.findAllComponents(PlatformFilterSelect)) expect(control.props('modelValue')).toBe('')
      expect(view.findAll('button').some(button => button.text() === '清除筛选')).toBe(false)
      const completed = fetch.mock.calls.length
      await vi.advanceTimersByTimeAsync(300)
      expect(fetch).toHaveBeenCalledTimes(completed)
    } finally { view.unmount() }
  })

  it('keeps list results readable when options fail and retries options explicitly', async () => {
    optionsFetch.mockRejectedValueOnce(new Error('options unavailable'))
    const view=mountPage()
    try {
      await flushPromises()
      expect(view.get('[role=alert]').text()).toContain('筛选选项加载失败')
      expect(view.find('[data-testid="platform-declaration-row"]').exists()).toBe(true)
      await view.get('[role=alert] button').trigger('click');await flushPromises()
      expect(view.find('[role=alert]').exists()).toBe(false)
      expect(optionsFetch).toHaveBeenCalledTimes(2);expect(fetch).toHaveBeenCalledTimes(1)
    } finally {view.unmount()}
  })

  it('does not query after unmount with a pending automatic filter', async () => {
    const view = mountPage()
    await flushPromises()
    await view.get('input[aria-label="企业名称或信用代码"]').setValue('未提交搜索')
    view.unmount()
    await vi.advanceTimersByTimeAsync(300)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('shows a distinct empty state without inventing records', async () => {
    fetch.mockResolvedValue({ ...response, rows: [], total: 0 })
    const view = mountPage()
    try {
      await flushPromises()
      expect(view.text()).toContain('没有匹配的申报记录')
      expect(view.text()).toContain('未找到符合筛选条件的申报记录。')
    } finally { view.unmount() }
  })

  it('keeps a failed page retryable and recovers on explicit retry', async () => {
    fetch.mockRejectedValueOnce(new Error('synthetic read failure'))
    const view = mountPage()
    try {
      await flushPromises()
      expect(view.text()).toContain('加载失败')
      expect(view.text()).toContain('synthetic read failure')
      fetch.mockResolvedValueOnce(response)
      await view.get('[data-testid="table-retry"]').trigger('click')
      await flushPromises()
      expect(view.text()).toContain('甲合成企业')
      expect(view.text()).not.toContain('SQ-2024-1')
      expect(view.text()).not.toContain('synthetic read failure')
    } finally { view.unmount() }
  })
})
