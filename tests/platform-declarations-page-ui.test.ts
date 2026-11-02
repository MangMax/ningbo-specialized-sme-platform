// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Page from '../pages/platform-declarations.vue'
import TablePagination from '../components/TablePagination.vue'
import { Select } from '../components/ui/select'

const row = {
  kind: 'record' as const,
  record: { id: 7, platformKey: 'SQ-2024-1', interface: 'apply_list' as const },
  matchedVersion: { versionId: 12, declareKind: 'apply', declarationYear: 2024, appliedAt: '2024-03-01 09:00:00', status: '终审通过', nameRaw: '甲合成企业', usccRaw: '91330211255994457P', ruleVersion: 'platform-apply-v1' },
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
  let fetch: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetch = vi.fn(async () => response)
    vi.stubGlobal('$fetch', fetch)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('loads the first page and re-queries with filters, view and page size', async () => {
    const view = mountPage()
    try {
      await flushPromises()
      expect(fetch).toHaveBeenCalledWith('/api/platform/declarations', expect.objectContaining({ query: expect.objectContaining({ view: 'records', page: 1, pageSize: 25 }) }))
      expect(view.text()).toContain('SQ-2024-1')
      expect(view.text()).toContain('甲合成企业')

      await view.get('input[aria-label="申报编号"]').setValue('SQ-2024-1')
      await view.get('form').trigger('submit')
      await flushPromises()
      expect(fetch.mock.calls.at(-1)![1].query).toMatchObject({ platformKey: 'SQ-2024-1', page: 1 })

      const select = view.findAllComponents(Select)[0]!
      select.vm.$emit('update:modelValue', 'isolated')
      await flushPromises()
      expect(fetch.mock.calls.at(-1)![1].query).toMatchObject({ view: 'isolated', page: 1 })

      view.findComponent(TablePagination).vm.$emit('update:pageSize', 50)
      await flushPromises()
      expect(fetch.mock.calls.at(-1)![1].query).toMatchObject({ pageSize: 50, page: 1 })
    } finally { view.unmount() }
  })

  it('shows a distinct empty state without inventing records', async () => {
    fetch.mockResolvedValue({ ...response, rows: [], total: 0 })
    const view = mountPage()
    try {
      await flushPromises()
      expect(view.text()).toContain('没有匹配的申报记录')
      expect(view.text()).toContain('未知事项或年度不会猜填')
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
      expect(view.text()).toContain('SQ-2024-1')
      expect(view.text()).not.toContain('synthetic read failure')
    } finally { view.unmount() }
  })
})
