// @vitest-environment happy-dom
import { chooseCalendarSelect } from '../../support/calendar-select'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, reactive } from 'vue'
import ComparisonSourcePicker from '../../../layers/sme-roster/app/components/record-correspondence/ComparisonSourcePicker.vue'
import ComparisonProofPicker from '../../../layers/sme-roster/app/components/record-correspondence/ComparisonProofPicker.vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import RecordComparisonPanel from '../../../layers/sme-roster/app/components/record-correspondence/RecordComparisonPanel.vue'
import ComparisonDateTimePicker from '../../../layers/core/app/components/DateTimePicker.vue'
import { Select } from '../../../layers/core/app/components/ui/select'
import { rememberEvidencePreviewReturn } from '../../../layers/sme-roster/lib/roster/evidence-preview-return'

const calls = vi.hoisted(() => ({ query: [] as Record<string, unknown>[] }))
const result = (page = 1, pageSize = 25) => ({ rows: [], total: 75, page, pageSize, counts: { distinctEvents: 0 }, coverage: [], currentSourceConsistency: { recognizedObservations: [] } })
const stubs = {
  // These tests own request/readiness/return scheduling. Accordion uses its own RAF
  // to measure height; exercise that real component separately in disclosure/workflow tests.
  DisclosurePanel: { template: '<section><slot name="header" /><slot name="trigger" /><slot name="title" /><slot /></section>' },
  RosterComparisonSourcePicker: defineComponent({ props: ['selection'], emits: ['change', 'settled'], watch: { selection: { immediate: true, deep: true, handler(value: unknown) { this.$emit('settled', JSON.stringify(value), true) } } }, template: '<button data-testid="select-sources" @click="$emit(\'change\', { queryIds: [7], exportBatchIds: [], officialSourceDocumentIds: [3], proofIds: [] })">选定来源</button>' }),
  RosterComparisonProofPicker: defineComponent({ props: ['selection', 'asOf'], emits: ['change', 'settled'], watch: { selection: { immediate: true, deep: true, handler() { this.$emit('settled', JSON.stringify([this.selection, this.asOf]), true) } }, asOf() { this.$emit('settled', JSON.stringify([this.selection, this.asOf]), true) } }, template: '<div data-testid="proof-cutoff">{{ asOf }}<button data-testid="select-proof" @click="$emit(\'change\', [12])">选定依据</button></div>' }),
  RosterComparisonEvidence: { template: '<div data-testid="shown-result">已读取结果</div>' },
  RosterComparisonEventRow: true,
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
  await wrapper!.findAll('button').find(button => button.text() === '开始对比')!.trigger('click')
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
    expect(wrapper.get('button:disabled').text()).toContain('开始对比')
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
    expect(wrapper.findAll('h2').at(-1)!.text()).toBe('正式事件逐条对照 · 筛选后 75 条可见事件')
    await wrapper.get('[data-testid="fetch-error"] button').trigger('click')
    await flushPromises()
    expect(fetch).toHaveBeenLastCalledWith('/api/roster/record-comparison', expect.objectContaining({ query: expect.objectContaining({ page: 2 }) }))
  })

  it('passes only explicitly selected proof IDs alongside the source set', async () => {
    vi.stubGlobal('$fetch', vi.fn(async (_url: string, options: { query: Record<string, unknown> }) => { calls.query.push(options.query); return result() }))
    wrapper = mount(RecordComparisonPanel, { global: { stubs } })
    await wrapper.get('[data-testid="select-sources"]').trigger('click')
    await wrapper.get('[data-testid="select-proof"]').trigger('click')
    await wrapper.findAll('button').find(button => button.text() === '开始对比')!.trigger('click')
    await flushPromises()
    expect(calls.query[0]).toMatchObject({ queryIds: '7', officialSourceDocumentIds: '3', proofIds: '12' })
  })

  it('roundtrips the cutoff instant in Shanghai without hiding a proof or shifting a no-edit compare', async () => {
    vi.stubEnv('TZ', 'Asia/Shanghai')
    startWith({ queryIds: '7', exportBatchIds: '', officialSourceDocumentIds: '3', asOf: '2026-10-18T10:00:00.000Z', page: '1', pageSize: '25' })
    vi.stubGlobal('$fetch', vi.fn(async (_url: string, options: { query: Record<string, unknown> }) => { calls.query.push(options.query); return result() }))
    wrapper = mount(RecordComparisonPanel, { global: { stubs } })
    await flushPromises()
    expect(wrapper.findComponent(ComparisonDateTimePicker).props('modelValue')).toBe('2026-10-18T18:00:00.000')
    expect(wrapper.get('#record-as-of').text()).toContain('18:00:00')
    expect(wrapper.get('[data-testid="proof-cutoff"]').text()).toContain('2026-10-18T10:00:00.000Z')
    await wrapper.findAll('button').find(button => button.text() === '开始对比')!.trigger('click')
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
    wrapper.findComponent(ComparisonDateTimePicker).vm.$emit('update:modelValue', '2026-10-18T19:00:00.000')
    await wrapper.findAll('button').find(button => button.text() === '开始对比')!.trigger('click')
    await flushPromises()
    expect(wrapper.get('[aria-label="已加载结果范围"]').text()).toContain('2026-10-18 18:00')
    expect(wrapper.get('[aria-label="目标结果范围"]').text()).toContain('2026-10-18 19:00')
    expect(wrapper.find('[data-testid="shown-result"]').exists()).toBe(true)
  })

  it('blocks comparing an incomplete segmented time without clearing the last cutoff', async () => {
    startWith({ queryIds: '7', officialSourceDocumentIds: '3', asOf: '2026-10-18T10:00:00.123Z' })
    vi.stubGlobal('$fetch', vi.fn(async () => result()))
    wrapper = mount(RecordComparisonPanel, { global: { stubs } })
    await flushPromises()
    wrapper.findComponent(ComparisonDateTimePicker).vm.$emit('validity-change', false)
    await flushPromises()
    const run = wrapper.findAll('button').find(button => button.text() === '开始对比')!
    expect(run.attributes('disabled')).toBeDefined()
    expect(route.query.asOf).toBe('2026-10-18T10:00:00.123Z')
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


it.each(['result-first', 'pickers-first'])('waits for catalog, selected labels, selected proof and audit layout before return restore: %s', async (order) => {
  startWith({ queryIds: '7', officialSourceDocumentIds: '3', proofIds: '12' })
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 1400 })
  rememberEvidencePreviewReturn(route.fullPath)
  const pending = new Map<string, (value: unknown) => void>()
  vi.stubGlobal('$fetch', vi.fn((url: string, options?: { query?: { kind?: string; pageSize?: number } }) => new Promise(resolve => {
    const key = url.endsWith('/sources') ? `${options?.query?.kind}:${options?.query?.pageSize}` : url
    pending.set(key, resolve)
  })))
  const frames: FrameRequestCallback[] = []
  const scrollTo = vi.fn()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
  vi.stubGlobal('scrollTo', scrollTo)
  wrapper = mount(RecordComparisonPanel, { global: { stubs: { ...stubs, RosterComparisonSourcePicker: false, RosterComparisonProofPicker: false } } })
  await flushPromises()
  const finishResult = async () => { pending.get('/api/roster/record-comparison')!(result()); await flushPromises() }
  if (order === 'result-first') await finishResult()
  expect(frames).toHaveLength(0)
  pending.get('official_document:25')!({ rows: Array.from({ length: 25 }, (_, index) => ({ kind: 'official_document', id: index + 1, label: `公布名单 ${index + 1}`, selectable: true })), total: 25, page: 1, pageSize: 25 })
  pending.get('/api/roster/comparison-scope-proofs')!({ rows: [{ id: 11, kind: 'official_coverage', status: 'confirmed', valid: true, evidence: { titleCode: 'specialized_sme', sourceDocuments: [{ id: 3 }] } }], total: 1, page: 1, pageSize: 25 })
  await flushPromises()
  expect(wrapper.findComponent(ComparisonSourcePicker).findAll('li')).toHaveLength(25)
  expect(frames).toHaveLength(0)
  pending.get('official_document:200')!({ rows: [{ kind: 'official_document', id: 3, label: '正式文件名称', selectable: true }], total: 1, page: 1, pageSize: 200 })
  await flushPromises()
  pending.get('query:200')!({ rows: [{ kind: 'query', id: 7, label: '归档查询名称', selectable: true }], total: 1, page: 1, pageSize: 200 })
  pending.get('/api/roster/comparison-scope-proofs/12')!({ id: 12, kind: 'official_coverage', status: 'confirmed', valid: true, evidence: { titleCode: 'specialized_sme', sourceDocuments: [{ id: 3 }] } })
  await flushPromises()
  expect(frames).toHaveLength(0)
  pending.get('/api/roster/comparison-scope-proofs/12/audit')!({ rows: [{ basis: '延迟的多行登记依据' }], total: 1, page: 1, pageSize: 200 })
  await flushPromises()
  expect(frames).toHaveLength(0)
  pending.get('/api/roster/comparison-scope-proofs/11/audit')!({ rows: [{ basis: '尚未完整的登记历史' }], total: 201, page: 1, pageSize: 200 })
  await flushPromises()
  expect(frames).toHaveLength(0)
  pending.get('/api/roster/comparison-scope-proofs/11/audit')!({ rows: [{ basis: '最终登记依据会在目录中换行' }], total: 201, page: 2, pageSize: 200 })
  await flushPromises()
  expect(wrapper.findComponent(ComparisonProofPicker).text()).toContain('最终登记依据会在目录中换行')
  expect(frames).toHaveLength(0)
  pending.get('query:25')!({ rows: [{ kind: 'query', id: 7, label: '归档查询名称', selectable: true }], total: 1, page: 1, pageSize: 25 })
  await flushPromises()
  if (order === 'pickers-first') { expect(frames).toHaveLength(0); await finishResult() }
  expect(frames).toHaveLength(1)
  frames[0]!(0)
  expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 1400, behavior: 'instant' })
})

it('returns the owned event to its viewport offset after an expanded evidence section remounts collapsed', async () => {
  startWith({ queryIds: '7', officialSourceDocumentIds: '3' })
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 1400 })
  const origin = document.createElement('article')
  origin.dataset.eventId = '42'
  const link = document.createElement('a')
  origin.append(link)
  vi.spyOn(origin, 'getBoundingClientRect').mockReturnValue({ top: 160 } as DOMRect)
  rememberEvidencePreviewReturn(route.fullPath, link)
  const frames: FrameRequestCallback[] = []
  const scrollTo = vi.fn()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
  vi.stubGlobal('scrollTo', scrollTo)
  vi.stubGlobal('$fetch', vi.fn(async () => ({ ...result(), rows: [{ event: { id: 42 } }] })))
  wrapper = mount(RecordComparisonPanel, { global: { stubs: { ...stubs, RosterComparisonEventRow: { template: '<article data-event-id="42" />' } } } })
  await flushPromises()
  vi.spyOn(wrapper.get('[data-event-id="42"]').element, 'getBoundingClientRect').mockReturnValue({ top: 600 } as DOMRect)
  frames[0]!(0)
  expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 1840, behavior: 'instant' })
})


it.each(['unmount', 'route-change', 'picker-pending'])('does not let a queued return frame outlive its owner: %s', async (change) => {
  startWith({ queryIds: '7', officialSourceDocumentIds: '3' })
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 500 })
  rememberEvidencePreviewReturn(route.fullPath)
  const frames: FrameRequestCallback[] = []
  const scrollTo = vi.fn()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
  vi.stubGlobal('scrollTo', scrollTo)
  vi.stubGlobal('$fetch', vi.fn(async () => result()))
  wrapper = mount(RecordComparisonPanel, { global: { stubs } })
  await flushPromises()
  expect(frames).toHaveLength(1)
  if (change === 'unmount') { wrapper.unmount(); wrapper = null }
  else if (change === 'route-change') startWith({ queryIds: '7', officialSourceDocumentIds: '3', page: '2' })
  else wrapper.findComponent(ComparisonSourcePicker).vm.$emit('settled', JSON.stringify({ queryIds: [7], exportBatchIds: [], officialSourceDocumentIds: [3], proofIds: [] }), false)
  await flushPromises()
  frames[0]!(0)
  expect(scrollTo).not.toHaveBeenCalled()
  if (change === 'picker-pending') {
    wrapper!.findComponent(ComparisonSourcePicker).vm.$emit('settled', JSON.stringify({ queryIds: [7], exportBatchIds: [], officialSourceDocumentIds: [3], proofIds: [] }), true)
    await flushPromises()
    expect(frames).toHaveLength(2)
    frames[1]!(0)
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 500, behavior: 'instant' })
  }
})

it('settles failed picker reads with their visible fallback layout before numeric return restoration', async () => {
  startWith({ queryIds: '7', officialSourceDocumentIds: '3', proofIds: '12' })
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 730 })
  rememberEvidencePreviewReturn(route.fullPath)
  const frames: FrameRequestCallback[] = []
  const scrollTo = vi.fn()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
  vi.stubGlobal('scrollTo', scrollTo)
  vi.stubGlobal('$fetch', vi.fn(async (url: string) => {
    if (url === '/api/roster/record-comparison') return result()
    throw new Error('offline')
  }))
  wrapper = mount(RecordComparisonPanel, { global: { stubs: { ...stubs, RosterComparisonSourcePicker: false, RosterComparisonProofPicker: false } } })
  await flushPromises()
  expect(wrapper.text()).toContain('来源目录读取失败')
  expect(wrapper.text()).toContain('范围依据目录读取失败')
  expect(wrapper.text()).toContain('部分已选依据暂不可读')
  expect(frames).toHaveLength(1)
  frames[0]!(0)
  expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 730, behavior: 'instant' })
})


it('distinguishes initial loading and failed comparison from a successful empty filtered result', async () => {
  startWith({ queryIds: '7', officialSourceDocumentIds: '3', classification: 'historical_conflict' })
  let reject!: (error: Error) => void
  const fetch = vi.fn().mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    .mockResolvedValueOnce({ ...result(), total: 0 })
  vi.stubGlobal('$fetch', fetch)
  wrapper = mount(RecordComparisonPanel, { global: { stubs } })
  expect(wrapper.findAll('h2').at(-1)!.text()).toBe('正式事件逐条对照 · 正在读取对照结果')
  expect(wrapper.text()).not.toContain('0 条可见事件')
  reject(new Error('offline'))
  await flushPromises()
  expect(wrapper.findAll('h2').at(-1)!.text()).toBe('正式事件逐条对照 · 对照结果暂不可用')
  expect(wrapper.find('[data-testid="fetch-error"]').exists()).toBe(true)
  expect(wrapper.text()).not.toContain('0 条可见事件')
  expect(wrapper.text()).not.toContain('所选范围内没有可见正式事件')
  await wrapper.get('[data-testid="fetch-error"] button').trigger('click')
  await flushPromises()
  expect(fetch).toHaveBeenLastCalledWith('/api/roster/record-comparison', expect.objectContaining({ query: expect.objectContaining({ queryIds: '7', officialSourceDocumentIds: '3', classification: 'historical_conflict' }) }))
  expect(wrapper.findAll('h2').at(-1)!.text()).toBe('正式事件逐条对照 · 筛选后 0 条可见事件')
  expect(wrapper.text()).toContain('所选范围内没有可见正式事件')
  expect(wrapper.find('[data-testid="fetch-error"]').exists()).toBe(false)
})

it('labels the successful filtered event count while retaining the loaded source scope', async () => {
  startWith({ queryIds: '7', officialSourceDocumentIds: '3', classification: 'historical_conflict' })
  vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ ...result(), total: 1 }))
  wrapper = mount(RecordComparisonPanel, { global: { stubs } })
  await flushPromises()
  expect(wrapper.findAll('h2').at(-1)!.text()).toBe('正式事件逐条对照 · 筛选后 1 条可见事件')
  expect(wrapper.get('[aria-label="已加载结果范围"]').text()).toContain('同一事件原行陈述冲突')
})

it('retains a successful empty result and its original source scope after target failure', async () => {
  startWith({ queryIds: '7', officialSourceDocumentIds: '3' })
  vi.stubGlobal('$fetch', vi.fn().mockResolvedValueOnce({ ...result(), total: 0 }).mockRejectedValue(new Error('offline')))
  wrapper = mount(RecordComparisonPanel, { global: { stubs } })
  await flushPromises()
  expect(wrapper.text()).toContain('所选范围内没有可见正式事件')
  startWith({ queryIds: '8', officialSourceDocumentIds: '4', classification: 'historical_conflict' })
  await flushPromises()
  expect(wrapper.find('[data-testid="fetch-error"]').exists()).toBe(true)
  expect(wrapper.findAll('h2').at(-1)!.text()).toBe('正式事件逐条对照 · 筛选后 0 条可见事件')
  expect(wrapper.get('[aria-label="已加载结果范围"]').text()).toContain('全部分类')
  expect(wrapper.get('[aria-label="目标结果范围"]').text()).toContain('同一事件原行陈述冲突')
  expect(wrapper.get('[data-testid="shown-result"]').attributes('return-to')).toContain('queryIds=7')
})

it('refreshes correspondence badges without closing the open original row dialog', async () => {
  const { rosterRefreshCorrespondenceViews } = await import('../../../layers/sme-roster/app/composables/useRosterCorrespondenceReadback')
  let status = 'confirmed'
  const row = () => ({ event: { id: 298, eventType: 'award', year: 2021 }, record: { enterpriseId: 2516, titleCode: 'specialized_sme', nameRaw: '合成企业' }, evidence: [], classification: 'unresolved', reasons: [], correspondences: [{ id: 575, relationId: 3130, status, requiresRevalidation: false }], platformRows: [{ id: 3130, queryId: 2772, interface: 'business_list', status: '终审通过' }] })
  vi.stubGlobal('$fetch', vi.fn(async () => ({ ...result(), rows: [row()] })))
  wrapper = mount(RecordComparisonPanel, { global: { stubs: { ...stubs, RosterComparisonEventRow: false, RosterSourceReader: { template: '<div>原行已读取</div>' }, NuxtLink: { template: '<a><slot /></a>' } } } })
  await chooseSources()
  await wrapper.findAll('button').find(button => button.text() === '查看原始记录')!.trigger('click'); await flushPromises()
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('原行已读取')
  status = 'unlinked'
  await rosterRefreshCorrespondenceViews(); await flushPromises()
  expect(wrapper.text()).toContain('已解除')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('原行已读取')
})

it('browses cutoff years without querying and commits a real leap day only on compare', async () => {
  vi.stubEnv('TZ', 'Asia/Shanghai')
  startWith({ queryIds: '7', officialSourceDocumentIds: '3', asOf: '2026-10-18T10:04:05.123Z' })
  vi.stubGlobal('$fetch', vi.fn(async (_url: string, options: { query: Record<string, unknown> }) => { calls.query.push(options.query); return result() }))
  wrapper = mount(RecordComparisonPanel, { attachTo: document.body, global: { stubs } })
  await flushPromises()
  const before = calls.query.length
  await wrapper.get('#record-as-of').trigger('click'); await flushPromises()
  await chooseCalendarSelect('年份', '2024')
  await chooseCalendarSelect('月份', '2')
  expect(calls.query).toHaveLength(before)
  expect(route.query.asOf).toBe('2026-10-18T10:04:05.123Z')
  document.querySelector<HTMLElement>('[data-value="2024-02-29"]')!.click(); await flushPromises()
  expect(calls.query).toHaveLength(before)
  ;[...document.querySelectorAll('button')].find(button => button.textContent === '完成')!.click(); await flushPromises()
  await wrapper.findAll('button').find(button => button.text() === '开始对比')!.trigger('click'); await flushPromises()
  expect(calls.query.at(-1)?.asOf).toBe('2024-02-29T10:04:05.123Z')
})
