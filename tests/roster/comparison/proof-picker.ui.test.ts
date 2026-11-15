// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import ComparisonProofPicker from '../../../components/record-correspondence/ComparisonProofPicker.vue'
import type { ComparisonProof } from '../../../lib/roster/record-comparison-view'

const official = { id: 12, kind: 'official_coverage', status: 'confirmed', valid: true, createdAt: '2026-10-18T00:00:00Z', revision: 2, decidedAt: '2026-10-18T01:00:00Z', invalidReason: null, evidence: { titleCode: 'specialized_sme', fromYear: 2023, throughYear: 2025, fullRange: true, sourceDocuments: [{ id: 3, fileId: 90, sha256: 'a'.repeat(64), reference: { field: 'source_document.path' as const } }], enterpriseIds: null }, sourceSummary: { documents: [{ path: 'jxj/notice.pdf' }] } } satisfies ComparisonProof
const stale = { ...official, id: 13, valid: false, invalidReason: 'source_drift_or_missing' as const } satisfies ComparisonProof
const candidate = { ...official, id: 14, status: 'candidate' as const, valid: false } satisfies ComparisonProof
const current = { id: 15, kind: 'current_source_equivalence', status: 'confirmed', valid: true, createdAt: '2026-10-18T00:00:00Z', revision: 2, decidedAt: '2026-10-18T02:00:00Z', invalidReason: null, evidence: { titleCode: 'specialized_sme', queryId: 7, exportBatchId: 8, queryReference: 'platform_query.collectionEvidence' as const, exportReference: 'platform_export_batch.sha256' as const, scope: { queryAccount: 'account', exportAccount: 'account', queryRegion: 'ningbo', exportRegion: 'ningbo', queryFilters: {}, exportFilters: {}, windowStart: '2025-01-01T00:00:00Z', windowEnd: '2025-01-31T00:00:00Z', platformVersion: 'v1', freezeReference: 'frozen collection', freezeFileId: 91, freezeSha256: 'b'.repeat(64) } }, sourceSummary: {} } satisfies ComparisonProof
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
  expect(wrapper.findAll('[id="proof-12"]')).toHaveLength(1)
  await wrapper.get('[id="proof-12"]').trigger('click')
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

it('offers a current version proof only with both archived sources and a compatible cutoff', async () => {
  vi.stubGlobal('$fetch', vi.fn(async (url: string) => {
    if (url === '/api/roster/comparison-scope-proofs') return { rows: [current], total: 1, page: 1, pageSize: 25 }
    if (url === '/api/roster/comparison-scope-proofs/15/audit') return { rows: [{ basis: '同版本冻结材料', decidedAt: current.decidedAt }], total: 1, page: 1, pageSize: 200 }
    throw new Error(`Unexpected ${url}`)
  }))
  const wrapper = mount(ComparisonProofPicker, { props: { selection: { queryIds: [7], exportBatchIds: [8], officialSourceDocumentIds: [], proofIds: [] }, asOf: '2026-10-18T01:30:00Z' }, global: { stubs: { TableLoadingStatus: true, TableFailureState: true, TablePagination: true } } })
  mounted.push(wrapper)
  await flushPromises()
  expect(wrapper.find('[id="proof-15"]').exists()).toBe(false)
  await wrapper.setProps({ asOf: '' })
  await flushPromises()
  expect(wrapper.text()).toContain('同版本冻结材料')
  await wrapper.get('[id="proof-15"]').trigger('click')
  expect(wrapper.emitted('change')?.at(-1)?.[0]).toEqual([15])
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


it('ignores superseded selected proof hydration and settles the current scope after a read failure', async () => {
  let resolveOld!: (value: unknown) => void
  let rejectCurrent!: (reason: unknown) => void
  vi.stubGlobal('$fetch', vi.fn((url: string) => {
    if (url === '/api/roster/comparison-scope-proofs') return Promise.resolve({ rows: [], total: 0, page: 1, pageSize: 25 })
    if (url.endsWith('/13')) return new Promise(resolve => { resolveOld = resolve })
    if (url.endsWith('/12')) return new Promise((_resolve, reject) => { rejectCurrent = reject })
    throw new Error(`Unexpected ${url}`)
  }))
  const selection = { queryIds: [], exportBatchIds: [], officialSourceDocumentIds: [3], proofIds: [13] }
  const wrapper = mount(ComparisonProofPicker, { props: { selection, asOf: '' }, global: { stubs: { TableLoadingStatus: true, TableFailureState: true, TablePagination: true } } })
  mounted.push(wrapper)
  await flushPromises()
  expect(wrapper.emitted('settled')?.at(-1)?.[1]).toBe(false)
  const next = { ...selection, proofIds: [12] }
  await wrapper.setProps({ selection: next })
  resolveOld(stale)
  await flushPromises()
  expect(wrapper.emitted('change')).toBeUndefined()
  expect(wrapper.emitted('settled')?.at(-1)).toEqual([JSON.stringify([next, '']), false])
  rejectCurrent(new Error('offline'))
  await flushPromises()
  expect(wrapper.text()).toContain('部分已选依据暂不可读')
  expect(wrapper.emitted('settled')?.at(-1)).toEqual([JSON.stringify([next, '']), true])
  expect(wrapper.emitted('change')).toBeUndefined()
})
