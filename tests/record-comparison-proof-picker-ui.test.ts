// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import ComparisonProofPicker from '../components/record-correspondence/ComparisonProofPicker.vue'

const official = { id: 12, kind: 'official_coverage', status: 'confirmed', valid: true, decidedAt: '2026-10-18T01:00:00Z', evidence: { titleCode: 'specialized_sme', fromYear: 2023, throughYear: 2025, sourceDocuments: [{ id: 3 }], enterpriseIds: null }, sourceSummary: { documents: [{ path: 'jxj/notice.pdf' }] } }
const stale = { ...official, id: 13, valid: false }
const candidate = { ...official, id: 14, status: 'candidate' }
const current = { id: 15, kind: 'current_source_equivalence', status: 'confirmed', valid: true, decidedAt: '2026-10-18T02:00:00Z', evidence: { titleCode: 'specialized_sme', queryId: 7, exportBatchId: 8, scope: { windowStart: '2025-01-01T00:00:00Z', windowEnd: '2025-01-31T00:00:00Z', platformVersion: 'v1' } }, sourceSummary: {} }
const mounted: ReturnType<typeof mount>[] = []
afterEach(() => { for (const wrapper of mounted.splice(0)) wrapper.unmount(); vi.unstubAllGlobals() })

it('offers only current confirmed proofs for the selected business sources and exposes the decision basis', async () => {
  const fetch = vi.fn(async (url: string) => {
    if (url === '/api/roster/comparison-scope-proofs') return { rows: [official, stale, candidate, current], total: 4, page: 1, pageSize: 25 }
    if (url === '/api/roster/comparison-scope-proofs/12/audit') return { rows: [{ basis: '正式公告覆盖核对', decidedAt: official.decidedAt }], total: 1, page: 1, pageSize: 200 }
    if (url === '/api/roster/comparison-scope-proofs/15/audit') return { rows: [{ basis: '冻结文件和查询窗口核对', decidedAt: current.decidedAt }], total: 1, page: 1, pageSize: 200 }
    throw new Error(`Unexpected ${url}`)
  })
  vi.stubGlobal('$fetch', fetch)
  const wrapper = mount(ComparisonProofPicker, { props: { selection: { queryIds: [7], exportBatchIds: [], officialSourceDocumentIds: [3], proofIds: [] }, asOf: '' }, global: { stubs: { TableLoadingStatus: true, TableFailureState: true, TablePagination: true } } })
  mounted.push(wrapper)
  await flushPromises()
  expect(fetch).toHaveBeenCalledWith('/api/roster/comparison-scope-proofs', expect.objectContaining({ query: expect.objectContaining({ status: 'confirmed' }) }))
  expect(wrapper.text()).toContain('专精特新中小企业')
  expect(wrapper.text()).toContain('2023–2025')
  expect(wrapper.text()).toContain('正式公告覆盖核对')
  expect(wrapper.text()).not.toContain('冻结文件和查询窗口核对')
  expect(wrapper.findAll('[aria-label="选择正式覆盖范围依据"]')).toHaveLength(1)
  await wrapper.get('[aria-label="选择正式覆盖范围依据"]').trigger('click')
  expect(wrapper.emitted('change')?.[0]?.[0]).toEqual([12])
})

it('drops a bookmarked proof that became invalid before a new compare', async () => {
  vi.stubGlobal('$fetch', vi.fn(async (url: string) => {
    if (url === '/api/roster/comparison-scope-proofs') return { rows: [], total: 0, page: 1, pageSize: 25 }
    if (url === '/api/roster/comparison-scope-proofs/13') return stale
    throw new Error(`Unexpected ${url}`)
  }))
  const wrapper = mount(ComparisonProofPicker, { props: { selection: { queryIds: [], exportBatchIds: [], officialSourceDocumentIds: [3], proofIds: [13] }, asOf: '' }, global: { stubs: { TableLoadingStatus: true, TableFailureState: true, TablePagination: true } } })
  mounted.push(wrapper)
  await flushPromises()
  expect(wrapper.emitted('change')?.at(-1)?.[0]).toEqual([])
  expect(wrapper.text()).not.toContain('已确认有效')
})

it('keeps the prior proof catalog on a failed target page and retries it', async () => {
  const fetch = vi.fn().mockResolvedValueOnce({ rows: [official], total: 2, page: 1, pageSize: 1 }).mockResolvedValueOnce({ rows: [], total: 0, page: 1, pageSize: 200 }).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ rows: [current], total: 2, page: 2, pageSize: 1 }).mockResolvedValueOnce({ rows: [], total: 0, page: 1, pageSize: 200 })
  vi.stubGlobal('$fetch', fetch)
  const wrapper = mount(ComparisonProofPicker, { props: { selection: { queryIds: [7], exportBatchIds: [8], officialSourceDocumentIds: [3], proofIds: [] }, asOf: '' }, global: { stubs: { TableLoadingStatus: true, TableFailureState: { emits: ['retry'], template: '<button data-testid="retry" @click="$emit(\'retry\')">重试</button>' }, TablePagination: { emits: ['update:page'], template: '<button data-testid="next" @click="$emit(\'update:page\', 2)">下一页</button>' } } } })
  mounted.push(wrapper)
  await flushPromises()
  await wrapper.get('[data-testid="next"]').trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('2023–2025')
  expect(wrapper.text()).toContain('上次成功')
  await wrapper.get('[data-testid="retry"]').trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('v1')
})
