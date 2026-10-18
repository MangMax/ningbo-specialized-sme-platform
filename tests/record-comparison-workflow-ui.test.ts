// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, reactive } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import RecordComparisonPanel from '../components/record-correspondence/RecordComparisonPanel.vue'

const sources = {
  official_document: [{ kind: 'official_document', id: 3, label: '2024 年公布名单', subtitle: '甬经信〔2024〕1号', observedAt: '2024-10-01', status: 'available', selectable: true, path: 'jxj/a.pdf' }],
  query: [{ kind: 'query', id: 7, label: '称号查询 · 恒川制造', observedAt: '2025-01-02T00:00:00Z', status: 'success', selectable: true, completeness: 'complete', fullRange: true, conditions: {} }],
  export_batch: [],
}
const counts = { distinctEvents: 0, distinctPlatformRows: 0, distinctEnterpriseTitles: 0, laterProcessRows: 0, historical_aligned: 0, historical_conflict: 0, official_without_correspondence: 0, unresolved: 0, platformWithoutOfficialRows: 0, unresolvedPlatformRows: 0, recognizedRows: 0, exportRows: 0, observedRecognizedExportPairs: 0 }
const result = { rows: [], total: 0, page: 1, pageSize: 25, counts, coverage: [], officialCoverage: { qualification: 'unknown', reasons: [] }, currentSourceConsistency: { qualification: 'not_comparable', reasons: [], recognizedObservations: [], exportObservations: [] }, platformWithoutOfficial: { rows: [], total: 0 }, historicalDecisionUnavailable: [], laterProcessPlatformRows: [] }
const stubs = {
  ComparisonProofPicker: defineComponent({ props: ['selection', 'asOf'], emits: ['settled'], watch: { selection: { immediate: true, deep: true, handler() { this.$emit('settled', JSON.stringify([this.selection, this.asOf]), true) } } }, template: '<div />' }),
  ComparisonEvidence: { template: '<div data-testid="compared-result">对比结果</div>' },
  ComparisonEventRow: true,
  TableLoadingStatus: true,
  TableFailureState: true,
  TablePagination: true,
}
let wrapper: ReturnType<typeof mount> | undefined
let fetch: ReturnType<typeof vi.fn>
let route: { query: Record<string, string>; fullPath: string }
beforeEach(() => {
  route = reactive({ query: { mode: 'record' }, fullPath: '/comparison?mode=record' })
  const navigate = async ({ query }: { query: Record<string, string> }) => {
    route.query = query
    route.fullPath = `/comparison?${new URLSearchParams(query)}`
  }
  vi.stubGlobal('useRoute', () => route)
  vi.stubGlobal('useRouter', () => ({ push: navigate, replace: navigate }))
  fetch = vi.fn(async (url: string, options?: { query: Record<string, unknown> }) => {
    if (url.endsWith('/sources')) {
      const kind = options!.query.kind as keyof typeof sources
      return { rows: sources[kind], total: sources[kind].length, page: options!.query.page, pageSize: options!.query.pageSize, counts: { official_document: 1, query: 1, export_batch: 0 } }
    }
    if (url === '/api/roster/record-comparison') return result
    throw new Error(`Unexpected request: ${url}`)
  })
  vi.stubGlobal('$fetch', fetch)
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.unstubAllGlobals(); sessionStorage.clear() })
const compareRequests = () => fetch.mock.calls.filter(([url]) => url === '/api/roster/record-comparison')
const runButton = () => wrapper!.findAll('button').find(button => button.text() === '开始对比')!
async function selectBoth() {
  await wrapper!.get('[aria-label="选择2024 年公布名单"]').trigger('click')
  await wrapper!.get('[aria-label="选择称号查询 · 恒川制造"]').trigger('click')
  await flushPromises()
}

it('enables comparison only after choosing a document and query through the real controls', async () => {
  wrapper = mount(RecordComparisonPanel, { global: { stubs } })
  await flushPromises()
  expect(compareRequests()).toHaveLength(0)
  expect(wrapper.get('[aria-label="选择2024 年公布名单"]').isVisible()).toBe(true)
  expect(wrapper.get('[aria-label="选择称号查询 · 恒川制造"]').isVisible()).toBe(true)
  expect(runButton().attributes('disabled')).toBeDefined()
  await wrapper.get('[aria-label="选择2024 年公布名单"]').trigger('click')
  await flushPromises()
  expect(runButton().attributes('disabled')).toBeDefined()
  expect(wrapper.text()).toMatch(/请选择.*平台查询|还.*平台查询/)
  await wrapper.get('[aria-label="选择称号查询 · 恒川制造"]').trigger('click')
  await flushPromises()
  expect(runButton().attributes('disabled')).toBeUndefined()
  await runButton().trigger('click')
  await flushPromises()
  expect(compareRequests()).toHaveLength(1)
  expect(compareRequests()[0]![1]!.query).toMatchObject({ queryIds: '7', officialSourceDocumentIds: '3', exportBatchIds: '' })
  expect(route.query).toMatchObject({ queryIds: '7', officialSourceDocumentIds: '3' })
  expect(wrapper.get('[data-testid="compared-result"]').text()).toBe('对比结果')
  const modify = wrapper.findAll('button').find(button => button.text() === '展开修改')!
  expect(modify.attributes('aria-expanded')).toBe('false')
  expect(wrapper.get('[aria-label="选择2024 年公布名单"]').element.closest('[inert]')).not.toBeNull()
  const catalogReads = fetch.mock.calls.filter(([url]) => url.endsWith('/sources')).length
  await modify.trigger('click')
  await flushPromises()
  expect(wrapper.get('[aria-label="选择2024 年公布名单"]').element.closest('[inert]')).toBeNull()
  expect(fetch.mock.calls.filter(([url]) => url.endsWith('/sources'))).toHaveLength(catalogReads)
  expect(compareRequests()).toHaveLength(1)
})

it('keeps last compared sources when the draft is cleared and does not send an invalid request', async () => {
  wrapper = mount(RecordComparisonPanel, { global: { stubs } })
  await flushPromises()
  await selectBoth()
  await runButton().trigger('click')
  await flushPromises()
  await wrapper.findAll('button').find(button => button.text() === '展开修改')!.trigger('click')
  await wrapper.get('[aria-label="选择2024 年公布名单"]').trigger('click')
  await wrapper.get('[aria-label="选择称号查询 · 恒川制造"]').trigger('click')
  await flushPromises()
  expect(runButton().attributes('disabled')).toBeDefined()
  expect(wrapper.text()).toContain('上次结果')
  expect(wrapper.get('[data-testid="compared-result"]').text()).toBe('对比结果')
  expect(route.query).toMatchObject({ queryIds: '7', officialSourceDocumentIds: '3' })
  expect(compareRequests()).toHaveLength(1)
})

it('disables repeat submission while a comparison is pending and explains an empty result', async () => {
  const original = fetch.getMockImplementation()! as (url: string, options?: { query: Record<string, unknown> }) => Promise<unknown>
  let complete!: (value: unknown) => void
  fetch.mockImplementation((url: string, options?: { query: Record<string, unknown> }) => url === '/api/roster/record-comparison'
    ? new Promise<unknown>(resolve => { complete = resolve })
    : original(url, options))
  wrapper = mount(RecordComparisonPanel, { global: { stubs } })
  await flushPromises()
  await selectBoth()
  await runButton().trigger('click')
  await flushPromises()
  const busy = wrapper.findAll('button').find(button => button.attributes('aria-busy') === 'true')!
  expect(busy.exists()).toBe(true)
  expect(busy.attributes('disabled')).toBeDefined()
  expect(compareRequests()).toHaveLength(1)
  expect(wrapper.text()).not.toContain('所选范围内没有可见正式事件')
  complete(result)
  await flushPromises()
  expect(wrapper.text()).toContain('所选范围内没有可见正式事件')
  expect(wrapper.findAll('button').some(button => button.attributes('aria-busy') === 'true')).toBe(false)
  expect(route.query).toMatchObject({ queryIds: '7', officialSourceDocumentIds: '3' })
})
