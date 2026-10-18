// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import RecordComparisonPanel from '../components/record-correspondence/RecordComparisonPanel.vue'

const calls = vi.hoisted(() => ({ query: [] as Record<string, unknown>[] }))
const result = { rows: [], total: 0, page: 1, pageSize: 25, counts: { distinctEvents: 0 }, coverage: [], currentSourceConsistency: { recognizedObservations: [] } }
const stubs = {
  ComparisonSourcePicker: { props: ['selection'], emits: ['change'], template: '<button data-testid="select-sources" @click="$emit(\'change\', { queryIds: [7], exportBatchIds: [], officialSourceDocumentIds: [3], proofIds: [] })">选定来源</button>' },
  ComparisonProofPicker: { props: ['selection'], emits: ['change'], template: '<button data-testid="select-proof" @click="$emit(\'change\', [12])">选定依据</button>' },
  ComparisonEvidence: { template: '<div data-testid="shown-result">已读取结果</div>' },
  ComparisonEventRow: true,
  TableLoadingStatus: true,
  TableFailureState: { props: ['title'], emits: ['retry'], template: '<div data-testid="fetch-error">{{ title }}<button @click="$emit(\'retry\')">重试</button></div>' },
  TablePagination: { emits: ['update:page'], template: '<button data-testid="next-page" @click="$emit(\'update:page\', 2)">下一页</button>' },
}
let wrapper: ReturnType<typeof mount> | null = null
beforeEach(() => {
  calls.query = []
  vi.stubGlobal('useRoute', () => ({ query: {}, fullPath: '/comparison' }))
  vi.stubGlobal('useRouter', () => ({ replace: vi.fn(async () => undefined) }))
})
afterEach(() => { wrapper?.unmount(); wrapper = null; vi.unstubAllGlobals() })

describe('record comparison public interaction', () => {
  it('waits for explicit documents and queries before loading and sends the selected IDs', async () => {
    vi.stubGlobal('$fetch', vi.fn(async (_url: string, options: { query: Record<string, unknown> }) => { calls.query.push(options.query); return result }))
    wrapper = mount(RecordComparisonPanel, { global: { stubs } })
    await flushPromises()
    expect(calls.query).toHaveLength(0)
    expect(wrapper.get('button:disabled').text()).toContain('按所选来源对比')
    await wrapper.get('[data-testid="select-sources"]').trigger('click')
    await wrapper.findAll('button').find(button => button.text() === '按所选来源对比')!.trigger('click')
    await flushPromises()
    expect(calls.query).toHaveLength(1)
    expect(calls.query[0]).toMatchObject({ queryIds: '7', exportBatchIds: '', officialSourceDocumentIds: '3', page: 1 })
    expect(wrapper.get('[data-testid="shown-result"]').text()).toContain('已读取结果')
  })

  it('retains the previous result and offers retry after a failed target page', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(result).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ...result, page: 2 })
    vi.stubGlobal('$fetch', fetch)
    wrapper = mount(RecordComparisonPanel, { global: { stubs } })
    await wrapper.get('[data-testid="select-sources"]').trigger('click')
    await wrapper.findAll('button').find(button => button.text() === '按所选来源对比')!.trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="next-page"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="fetch-error"]').text()).toContain('记录级对比读取失败')
    expect(wrapper.get('[data-testid="shown-result"]').text()).toContain('已读取结果')
    expect(wrapper.text()).toContain('上次成功')
    await wrapper.get('[data-testid="fetch-error"] button').trigger('click')
    await flushPromises()
    expect(fetch).toHaveBeenLastCalledWith('/api/roster/record-comparison', expect.objectContaining({ query: expect.objectContaining({ page: 2 }) }))
  })

  it('passes only explicitly selected proof IDs alongside the source set', async () => {
    vi.stubGlobal('$fetch', vi.fn(async (_url: string, options: { query: Record<string, unknown> }) => { calls.query.push(options.query); return result }))
    wrapper = mount(RecordComparisonPanel, { global: { stubs } })
    await wrapper.get('[data-testid="select-sources"]').trigger('click')
    await wrapper.get('[data-testid="select-proof"]').trigger('click')
    await wrapper.findAll('button').find(button => button.text() === '按所选来源对比')!.trigger('click')
    await flushPromises()
    expect(calls.query[0]).toMatchObject({ queryIds: '7', officialSourceDocumentIds: '3', proofIds: '12' })
  })
})
