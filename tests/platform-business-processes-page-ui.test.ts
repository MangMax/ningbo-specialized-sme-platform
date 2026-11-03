// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Page from '../pages/platform-business-processes.vue'
import TablePagination from '../components/TablePagination.vue'
import { Select } from '../components/ui/select'

const row = {
  kind: 'record' as const,
  record: { id: 7, platformKey: 'SQ-2023-1', interface: 'business_list' as const },
  matchedVersion: { versionId: 12, declareKind: 'review', businessYear: 2023, appliedAt: '2023-02-01 09:00:00', status: '终审通过', batch: '2023-2', awardBatchLabel: '第三批', province: '浙江省', nameRaw: '甲办理企业', usccRaw: '91330211255994457P', ruleVersion: 'platform-business-v1' },
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
  let fetch: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetch = vi.fn(async () => response)
    vi.stubGlobal('$fetch', fetch)
    vi.stubGlobal('useRoute', () => ({ query: { platformKey: 'SQ-PREFILL', q: '影子企业' } }))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('seeds the exact 办理编号 from the existing consumer link and re-queries with filters', async () => {
    const view = mountPage()
    try {
      await flushPromises()
      expect(fetch).toHaveBeenCalledWith('/api/platform/business-processes', expect.objectContaining({ query: expect.objectContaining({ view: 'records', platformKey: 'SQ-PREFILL', q: '影子企业', page: 1, pageSize: 25 }) }))
      expect(view.text()).toContain('SQ-2023-1')
      expect(view.text()).toContain('甲办理企业')

      await view.get('input[aria-label="事项"]').setValue('复核')
      await view.get('input[aria-label="维护批次"]').setValue('2023-2')
      await view.get('form').trigger('submit')
      await flushPromises()
      expect(fetch.mock.calls.at(-1)![1].query).toMatchObject({ declareKind: '复核', batch: '2023-2', page: 1 })

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

  it('shows distinct empty records and isolated states', async () => {
    fetch.mockResolvedValue({ ...response, rows: [], total: 0 })
    const view = mountPage()
    try {
      await flushPromises()
      expect(view.text()).toContain('没有匹配的关联办理记录')
      expect(view.text()).toContain('未知事项、业务年、状态或批次不会猜填')
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
      expect(view.text()).toContain('SQ-2023-1')
      expect(view.text()).not.toContain('synthetic read failure')
    } finally { view.unmount() }
  })
})
