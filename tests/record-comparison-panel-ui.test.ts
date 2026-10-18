// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import RecordComparisonPanel from '../components/record-correspondence/RecordComparisonPanel.vue'
import { Select } from '../components/ui/select'
import { rememberEvidencePreviewReturn } from '../lib/roster/evidence-preview-return'

const calls = vi.hoisted(() => ({ query: [] as Record<string, unknown>[] }))
const result = (page = 1, pageSize = 25) => ({ rows: [], total: 75, page, pageSize, counts: { distinctEvents: 0 }, coverage: [], currentSourceConsistency: { recognizedObservations: [] } })
const stubs = {
  ComparisonSourcePicker: { props: ['selection'], emits: ['change'], template: '<button data-testid="select-sources" @click="$emit(\'change\', { queryIds: [7], exportBatchIds: [], officialSourceDocumentIds: [3], proofIds: [] })">选定来源</button>' },
  ComparisonProofPicker: { props: ['selection', 'asOf'], emits: ['change'], template: '<div data-testid="proof-cutoff">{{ asOf }}<button data-testid="select-proof" @click="$emit(\'change\', [12])">选定依据</button></div>' },
  ComparisonEvidence: { template: '<div data-testid="shown-result">已读取结果</div>' },
  ComparisonEventRow: true,
  TableLoadingStatus: true,
  TableFailureState: { props: ['title'], emits: ['retry'], template: '<div data-testid="fetch-error">{{ title }}<button @click="$emit(\'retry\')">重试</button></div>' },
  TablePagination: { emits: ['update:page', 'update:pageSize'], template: '<div><button data-testid="next-page" @click="$emit(\'update:page\', 2)">下一页</button><button data-testid="size-50" @click="$emit(\'update:pageSize\', 50)">每页50</button></div>' },
}
let wrapper: ReturnType<typeof mount> | null = null
let route: { query: Record<string, string>; fullPath: string }
let router: { push: ReturnType<typeof vi.fn>; replace: ReturnType<typeof vi.fn> }
function setRoute(query: Record<string, string>) {
  route.query = query
  route.fullPath = `/comparison?${new URLSearchParams(query)}`
  history.replaceState(null, '', route.fullPath)
}
function startWith(query: Record<string, string>) { setRoute({ mode: 'record', ...query }) }
async function chooseSources() {
  await wrapper!.get('[data-testid="select-sources"]').trigger('click')
  await wrapper!.findAll('button').find(button => button.text() === '按所选来源对比')!.trigger('click')
  await flushPromises()
}
beforeEach(() => {
  calls.query = []
  sessionStorage.clear()
  route = reactive({ query: {}, fullPath: '/comparison?mode=record' })
  router = { push: vi.fn(async ({ query }: { query: Record<string, string> }) => setRoute(query)), replace: vi.fn(async ({ query }: { query: Record<string, string> }) => setRoute(query)) }
  vi.stubGlobal('useRoute', () => route)
  vi.stubGlobal('useRouter', () => router)
  startWith({})
})
afterEach(() => { wrapper?.unmount(); wrapper = null; vi.unstubAllGlobals(); vi.unstubAllEnvs(); sessionStorage.clear() })

describe('record comparison public interaction', () => {
  it('waits for explicit documents and queries before loading and sends the selected IDs', async () => {
    vi.stubGlobal('$fetch', vi.fn(async (_url: string, options: { query: Record<string, unknown> }) => { calls.query.push(options.query); return result() }))
    wrapper = mount(RecordComparisonPanel, { global: { stubs } })
    await flushPromises()
    expect(calls.query).toHaveLength(0)
    expect(wrapper.get('button:disabled').text()).toContain('按所选来源对比')
    await chooseSources()
    expect(calls.query).toHaveLength(1)
    expect(calls.query[0]).toMatchObject({ queryIds: '7', exportBatchIds: '', officialSourceDocumentIds: '3', page: 1, pageSize: 25 })
    expect(route.query).toMatchObject({ queryIds: '7', page: '1', pageSize: '25' })
    expect(wrapper.get('[data-testid="shown-result"]').text()).toContain('已读取结果')
  })

  it('retains the previous result and offers retry after a failed target page', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(result()).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(result(2))
    vi.stubGlobal('$fetch', fetch)
    wrapper = mount(RecordComparisonPanel, { global: { stubs } })
    await chooseSources()
    await wrapper.get('[data-testid="next-page"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="fetch-error"]').text()).toContain('记录级对比读取失败')
    expect(wrapper.get('[data-testid="shown-result"]').text()).toContain('已读取结果')
    expect(wrapper.get('[aria-label="已加载结果范围"]').text()).toContain('第 1 页')
    expect(wrapper.get('[aria-label="目标结果范围"]').text()).toContain('第 2 页')
    await wrapper.get('[data-testid="fetch-error"] button').trigger('click')
    await flushPromises()
    expect(fetch).toHaveBeenLastCalledWith('/api/roster/record-comparison', expect.objectContaining({ query: expect.objectContaining({ page: 2 }) }))
  })

  it('passes only explicitly selected proof IDs alongside the source set', async () => {
    vi.stubGlobal('$fetch', vi.fn(async (_url: string, options: { query: Record<string, unknown> }) => { calls.query.push(options.query); return result() }))
    wrapper = mount(RecordComparisonPanel, { global: { stubs } })
    await wrapper.get('[data-testid="select-sources"]').trigger('click')
    await wrapper.get('[data-testid="select-proof"]').trigger('click')
    await wrapper.findAll('button').find(button => button.text() === '按所选来源对比')!.trigger('click')
    await flushPromises()
    expect(calls.query[0]).toMatchObject({ queryIds: '7', officialSourceDocumentIds: '3', proofIds: '12' })
  })

  it('roundtrips the cutoff instant in Shanghai without hiding a proof or shifting a no-edit compare', async () => {
    vi.stubEnv('TZ', 'Asia/Shanghai')
    startWith({ queryIds: '7', exportBatchIds: '', officialSourceDocumentIds: '3', asOf: '2026-10-18T10:00:00.000Z', page: '1', pageSize: '25' })
    vi.stubGlobal('$fetch', vi.fn(async (_url: string, options: { query: Record<string, unknown> }) => { calls.query.push(options.query); return result() }))
    wrapper = mount(RecordComparisonPanel, { global: { stubs } })
    await flushPromises()
    expect((wrapper.get('#record-as-of').element as HTMLInputElement).value).toBe('2026-10-18T18:00')
    expect(wrapper.get('[data-testid="proof-cutoff"]').text()).toContain('2026-10-18T10:00:00.000Z')
    await wrapper.findAll('button').find(button => button.text() === '按所选来源对比')!.trigger('click')
    await flushPromises()
    expect(calls.query.at(-1)).toMatchObject({ asOf: '2026-10-18T10:00:00.000Z' })
  })

  it('restores page size and classification on query Back/Forward and ignores an older response', async () => {
    startWith({ queryIds: '7', exportBatchIds: '', officialSourceDocumentIds: '3', page: '2', pageSize: '50', classification: 'unresolved' })
    let resolveOld!: (value: unknown) => void
    const old = new Promise(resolve => { resolveOld = resolve })
    const fetch = vi.fn().mockImplementationOnce(() => old).mockResolvedValueOnce(result(1, 25))
    vi.stubGlobal('$fetch', fetch)
    wrapper = mount(RecordComparisonPanel, { global: { stubs } })
    await flushPromises()
    expect(calls.query).toHaveLength(0)
    expect(fetch).toHaveBeenCalledWith('/api/roster/record-comparison', expect.objectContaining({ query: expect.objectContaining({ page: 2, pageSize: 50, classification: 'unresolved' }) }))
    startWith({ queryIds: '7', exportBatchIds: '', officialSourceDocumentIds: '3', page: '1', pageSize: '25' })
    await flushPromises()
    resolveOld(result(2, 50))
    await flushPromises()
    expect(wrapper.get('[aria-label="已加载结果范围"]').text()).toContain('每页 25 条')
    expect(wrapper.get('[aria-label="已加载结果范围"]').text()).toContain('全部分类')
    expect(wrapper.get('[aria-label="已加载结果范围"]').text()).not.toContain('第 2 页')
  })

  it('writes classification and page size to the address before paging, then rehydrates Back navigation', async () => {
    vi.stubGlobal('$fetch', vi.fn(async (_url: string, options: { query: { page: number; pageSize: number } }) => result(options.query.page, options.query.pageSize)))
    wrapper = mount(RecordComparisonPanel, { global: { stubs } })
    await chooseSources()
    wrapper.findComponent(Select).vm.$emit('update:modelValue', 'unresolved')
    await flushPromises()
    expect(route.query.classification).toBe('unresolved')
    await wrapper.get('[data-testid="size-50"]').trigger('click')
    await flushPromises()
    expect(route.query).toMatchObject({ classification: 'unresolved', page: '1', pageSize: '50' })
    await wrapper.get('[data-testid="next-page"]').trigger('click')
    await flushPromises()
    expect(route.query).toMatchObject({ classification: 'unresolved', page: '2', pageSize: '50' })
    startWith({ queryIds: '7', exportBatchIds: '', officialSourceDocumentIds: '3', page: '1', pageSize: '50', classification: 'unresolved' })
    await flushPromises()
    expect(wrapper.get('[aria-label="已加载结果范围"]').text()).toContain('第 1 页 · 每页 50 条')
  })

  it('keeps actual loaded classification and cutoff visible when a changed target fails', async () => {
    vi.stubEnv('TZ', 'Asia/Shanghai')
    startWith({ queryIds: '7', exportBatchIds: '', officialSourceDocumentIds: '3', asOf: '2026-10-18T10:00:00.000Z', page: '1', pageSize: '25' })
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValueOnce(result()).mockRejectedValue(new Error('offline')))
    wrapper = mount(RecordComparisonPanel, { global: { stubs } })
    await flushPromises()
    wrapper.findComponent(Select).vm.$emit('update:modelValue', 'unresolved')
    await flushPromises()
    expect(wrapper.get('[aria-label="已加载结果范围"]').text()).toContain('全部分类')
    expect(wrapper.get('[aria-label="目标结果范围"]').text()).toContain('证据不足 · 待核')
    await wrapper.get('#record-as-of').setValue('2026-10-18T19:00:00.000')
    await wrapper.findAll('button').find(button => button.text() === '按所选来源对比')!.trigger('click')
    await flushPromises()
    expect(wrapper.get('[aria-label="已加载结果范围"]').text()).toContain('2026-10-18T10:00:00.000Z')
    expect(wrapper.get('[aria-label="目标结果范围"]').text()).toContain('2026-10-18T11:00:00.000Z')
    expect(wrapper.find('[data-testid="shown-result"]').exists()).toBe(true)
  })

  it('restores comparison scroll only after the matching URL result has rendered', async () => {
    startWith({ queryIds: '7', exportBatchIds: '', officialSourceDocumentIds: '3', page: '2', pageSize: '50' })
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 480 })
    rememberEvidencePreviewReturn(route.fullPath)
    let resolve!: (value: unknown) => void
    vi.stubGlobal('$fetch', vi.fn(() => new Promise(value => { resolve = value })))
    const frames: FrameRequestCallback[] = []
    const scrollTo = vi.fn()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
    vi.stubGlobal('scrollTo', scrollTo)
    wrapper = mount(RecordComparisonPanel, { global: { stubs } })
    await flushPromises()
    expect(scrollTo).not.toHaveBeenCalled()
    resolve(result(2, 50))
    await flushPromises()
    expect(frames).toHaveLength(1)
    frames[0]!(0)
    expect(scrollTo).toHaveBeenCalledWith({ top: 480, behavior: 'instant' })
  })
})
