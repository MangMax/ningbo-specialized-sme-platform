// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import EventCorrespondenceReview from '../components/record-correspondence/EventCorrespondenceReview.vue'
import EventChip from '../components/EventChip.vue'
import TitleBadge from '../components/TitleBadge.vue'
import SourceChip from '../components/SourceChip.vue'
import AnnualProcessTimeline from '../components/record-correspondence/AnnualProcessTimeline.vue'
import { buildAnnualProcess, type EventAnnualProcessPage } from '../lib/roster/annual-process'
import type { AnnualTaskDto, AnnualTaskReceipt } from '../lib/roster/annual-correspondence'
import type { PlatformBusinessGroup, PlatformCorrespondenceRef } from '../lib/platform/business-record'

let wrapper: ReturnType<typeof mount>
beforeEach(() => { sessionStorage.clear(); const state = new Map(); vi.stubGlobal('useState', (key: string, init: () => unknown) => { if (!state.has(key)) state.set(key, ref(init())); return state.get(key) }) })
afterEach(() => { wrapper?.unmount(); document.body.innerHTML = ''; vi.useRealTimers(); vi.unstubAllGlobals() })
const events = [7, 8].map(id => ({ id, recordId: 2, type: 'award', year: 2024, seq: 1, decidedYear: null, reviewOutcome: null, titleCode: 'specialized_sme', source: 'jxj', district: null, evidence: [] }))
const jobId = '01J00000000000000000000001'
function annual(eventId = 7, generation = 'scope-a', status: 'confirmed' | 'eligible' | 'none' = 'eligible'): EventAnnualProcessPage {
  const event = { id: eventId, eventType: 'award', year: 2024, decidedYear: null, reviewOutcome: null, record: { enterpriseId: 1, titleCode: 'specialized_sme', usccRaw: '91330200123456789A' } }
  const groups = [101, 102].map((id, index): PlatformBusinessGroup => {
    const metadata = { recordId: id, versionId: id, interface: 'business_list', platformKey: `SYNTHETIC-${id}`, groupState: 'verified', identityState: 'resolved', contentState: 'verified', keySource: 'both', projectionRuleVersion: '1', hashAlgorithm: 'sha256', contentHash: `synthetic-${id}` } as const
    const decisions: PlatformCorrespondenceRef[] = status === 'confirmed' ? [{ id: id - 60, relationId: id, exportRowId: null, eventId, predecessorEventId: null, enterpriseId: 1, titleCode: event.record.titleCode, type: 'event_process', role: 'context_only', status: 'confirmed', revision: 2, ruleId: 'event-annual-process', ruleVersion: '1', createdAt: '2026-10-01', decidedAt: '2026-10-01', endedAt: null }] : []
    return { businessRecord: metadata, representativeRelationId: id, conflicts: [], existingCorrespondenceIds: decisions.map(d => d.id), existingCorrespondences: decisions,
      observationRefs: [{ relationId: id, queryId: id, sequenceNo: index + 1, interface: 'business_list', relationKey: metadata.platformKey, queriedAt: '2026-10-01T00:00:00Z', queryStatus: 'success', queryKey: event.record.usccRaw!, rdjb: '2', queryTitleCode: 'specialized_sme', titleCode: 'specialized_sme', enterpriseId: 1, usccRaw: event.record.usccRaw, nameRaw: '合成企业', verificationStatus: 'confirmed', matchBasis: 'uscc', target: { eventId, enterpriseId: 1, titleCode: 'specialized_sme', type: 'event_process', role: 'context_only' }, evidence: { process: { declareKind: 'apply', appliedAt: index ? '2024-12-01 12:00:00' : '2024-03-01 12:00:00', status: index ? '终审通过' : '终审不通过' }, temporal: { relationYear: 2024 } }, conflicts: [], businessRecord: metadata, existingCorrespondenceIds: decisions.map(d => d.id), existingCorrespondences: decisions }] }
  })
  const process = buildAnnualProcess({ event, groups, coverage: [] })
  process.finalQualification = { stepId: status === 'none' ? null : process.latestStepId, status, reasons: [], decisionRefs: groups[1]!.existingCorrespondences }
  return { process, sourceGeneration: generation, sourceRefs: { scope: { enterpriseId: 1, titleCode: 'specialized_sme', businessYear: 2024, declareKind: 'apply', ruleVersion: process.ruleVersion }, event: { ...event, revision: 1, recordId: 2, usccRaw: event.record.usccRaw }, evidence: [], titleScopeRefs: [], observations: [], coverage: [] }, total: 2, page: 1, pageSize: 50 }
}
function receipt(generation = 'scope-a', id = jobId): AnnualTaskReceipt { return { jobId: id, kind: 'event-annual-correspondence', state: 'queued', sourceGenerations: [{ eventId: 7, generation }] } }
function task(status: AnnualTaskDto['status'] = 'done', generation = 'scope-a', reasons: string[] = []): AnnualTaskDto {
  return { jobId, kind: 'event-annual-correspondence', status, progress: { done: status === 'running' ? 0 : 1, total: 1 }, errorCode: null, capabilities: { cancel: status === 'running', retry: status === 'failed' || status === 'cancelled' }, result: { ruleVersion: '1', attempt: 1, events: [{ eventId: 7, generation, status: status === 'running' ? 'running' : status === 'failed' ? 'failed' : 'done', outcomes: [101, 102].map(id => ({ stepId: String(id), status: 'created', relationId: id, reasons: [], decisionRefs: [{ id: id - 60, relationId: id, revision: 2, status: 'confirmed', requiresRevalidation: false }] })), finalQualification: { stepId: null, status: reasons.length ? 'blocked' : 'confirmed', reasons, decisionRefs: [] } }] } }
}
function fixture(overrides: (url: string, options: any) => unknown = () => undefined) {
  let submitted = false
  const fetch = vi.fn((url: string, options?: any): any => {
    const custom = overrides(url, options); if (custom !== undefined) return custom
    if (url.endsWith('/browser-context')) return Promise.resolve({ writeEnabled: true })
    if (url.endsWith('/annual-process')) return Promise.resolve(annual(Number(url.split('/')[4]), 'scope-a', submitted ? 'confirmed' : 'eligible'))
    if (url.endsWith('/annual-correspondence-tasks')) { submitted = true; return Promise.resolve(receipt()) }
    if (url.includes('/annual-correspondence-tasks/')) return Promise.resolve(task())
    if (url.endsWith('/correspondences')) return Promise.resolve({ rows: [], total: 0, page: 1, pageSize: 200 })
    if (url.endsWith('/discover')) return Promise.resolve({ event: { id: options.body.eventId, evidence: [] }, rows: [], total: 0, page: 1, pageSize: 50, coverage: { rows: [], total: 0, page: 1, pageSize: 25 }, interfaces: [] })
    if (url.endsWith('/audit')) return Promise.resolve({ rows: [{ correspondenceId: Number(url.split('/').at(-2)), resultingRevision: 2 }], total: 1, page: 1, pageSize: 200 })
    if (/\/correspondences\/\d+$/.test(url)) { const id = Number(url.split('/').at(-1)); return Promise.resolve({ id, eventId: 7, relationId: id + 60, revision: 2, status: 'confirmed', requiresRevalidation: false }) }
    throw new Error(`Unexpected HTTP boundary ${url}`)
  })
  vi.stubGlobal('$fetch', fetch)
  return fetch
}
function mountReview(eventId: number | null = null) { wrapper = mount(EventCorrespondenceReview, { props: { enterpriseId: 1, events, eventId, back: '/enterprises/1?tab=review' }, global: { components: { EventChip, TitleBadge, SourceChip } } }); return wrapper }
async function open(id: number) { await wrapper.get(`#review-event-${id} button[aria-expanded]`).trigger('click'); await flushPromises() }
const posts = (fetch: ReturnType<typeof fixture>) => fetch.mock.calls.filter(([url, options]) => url.endsWith('/annual-correspondence-tasks') && options?.method === 'POST')

function page(eventId: number, generation: string, number: number, total = 121): EventAnnualProcessPage {
  const value = annual(eventId, generation, 'confirmed')
  const prototype = value.process.steps[1]!
  const steps = Array.from({ length: total }, (_, i) => ({ ...prototype, id: `business-${i}`, appliedAt: new Date(Date.UTC(2024, 0, 1, 0, i)).toISOString(), businessKey: `${generation}-${i}`, status: i === total - 1 ? '终审通过' : '审核中', groups: [] }))
  value.process.steps = steps.slice((number - 1) * 50, number * 50)
  value.process.latestStepId = steps.at(-1)?.id ?? null
  value.process.latestStepSummary = steps.at(-1) ?? null
  value.process.finalQualification!.stepId = value.process.latestStepId
  value.page = number; value.total = total
  return value
}
function readonlyPages(override: (id: number, number: number) => unknown = () => undefined) {
  return fixture((url, options) => {
    if (url.endsWith('/browser-context')) return Promise.resolve({ writeEnabled: false })
    if (url.endsWith('/annual-process')) {
      const id = Number(url.split('/')[4]), number = options.query.page
      return override(id, number) ?? Promise.resolve(page(id, 'scope-a', number))
    }
    return undefined
  })
}
const ids = () => wrapper.findAll('[data-annual-step]').map(row => row.attributes('data-annual-step'))
const reads = (fetch: ReturnType<typeof fixture>) => fetch.mock.calls.filter(([url]) => url.endsWith('/annual-process')).map(([, options]) => ({ ...options.query }))
async function click(text: string) { await wrapper.findAll('button').find(button => button.text() === text)!.trigger('click'); await flushPromises() }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

it('renders one process without page numbers, page size or load controls', async () => {
  readonlyPages((id, number) => Promise.resolve(page(id, 'scope-a', number, 1)))
  mountReview(7); await flushPromises()
  expect(ids()).toEqual(['business-0'])
  expect(wrapper.find('[data-testid="annual-process-timeline"]').text()).not.toMatch(/每页|第.*页|加载更多/)
  expect(wrapper.find('[aria-label="下一页"]').exists()).toBe(false)
})

it('appends more than fifty processes in bounded batches with stable order and deduplication', async () => {
  const fetch = readonlyPages((id, number) => {
    const value = page(id, 'scope-a', number)
    if (number === 2) value.process.steps[0] = page(id, 'scope-a', 1).process.steps[49]!
    return Promise.resolve(value)
  })
  mountReview(7); await flushPromises()
  expect(ids()).toHaveLength(50)
  expect(wrapper.get('[data-annual-summary]').text()).toContain('已有最终结果：终审通过')
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(0) // full-scope DTO final is outside the display batch
  await click('加载更多过程')
  expect(ids()).toEqual([...Array.from({ length: 50 }, (_, i) => `business-${i}`), ...Array.from({ length: 49 }, (_, i) => `business-${i + 51}`)])
  await click('加载更多过程')
  expect(ids()).toHaveLength(120)
  expect(new Set(ids()).size).toBe(120)
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(1)
  expect(wrapper.findAll('button').some(button => button.text() === '加载更多过程')).toBe(false)
  expect(reads(fetch)).toEqual([1, 2, 3].map(page => ({ page, pageSize: 50 })))
  expect(posts(fetch)).toHaveLength(0)
})

it('retains loaded facts, withdraws readonly final and retries exactly the failed append target', async () => {
  let fail = true
  const fetch = readonlyPages((id, number) => number === 2 && fail ? Promise.reject(new Error('503 append')) : Promise.resolve(page(id, 'scope-a', number)))
  mountReview(7); await flushPromises()
  await click('加载更多过程')
  expect(ids()).toHaveLength(50)
  expect(wrapper.text()).toContain('保留已加载的年度过程及其来源')
  expect(wrapper.get('[data-annual-summary]').text()).toContain('尚无已确认最终结果')
  expect(wrapper.get('[data-testid="event-annual-summary"]').text()).not.toContain('已确认最终结果')
  fail = false
  await wrapper.get('[data-testid="annual-process-review"] [data-testid="table-retry"]').trigger('click'); await flushPromises()
  expect(ids()).toHaveLength(100)
  expect(reads(fetch).map(read => read.page)).toEqual([1, 2, 2])
  expect(wrapper.get('[data-annual-summary]').text()).toContain('已有最终结果：终审通过')
  expect(posts(fetch)).toHaveLength(0)
})

it('restarts at the first batch on a new source generation without mixing old and new processes', async () => {
  let generation = 'scope-a'
  const fetch = readonlyPages((id, number) => Promise.resolve(page(id, generation, number)))
  mountReview(7); await flushPromises()
  generation = 'scope-b'
  await click('加载更多过程')
  expect(reads(fetch).map(read => read.page)).toEqual([1, 2, 1])
  expect(ids()).toHaveLength(50)
  const view = wrapper.findComponent(AnnualProcessTimeline).props('view')
  expect(view.generation).toBe('scope-b')
  expect(view.steps.every(step => step.businessKey?.startsWith('scope-b-'))).toBe(true)
  await click('加载更多过程')
  expect(ids()).toHaveLength(100)
})

it('retains old facts without final if the new generation first batch fails and retries only that first batch', async () => {
  let changed = false, fail = true
  const fetch = readonlyPages((id, number) => changed && number === 1 && fail ? Promise.reject(new Error('503 replacement')) : Promise.resolve(page(id, changed ? 'scope-b' : 'scope-a', number)))
  mountReview(7); await flushPromises(); changed = true
  await click('加载更多过程')
  expect(ids()).toHaveLength(50)
  expect(wrapper.get('[data-annual-summary]').text()).toContain('尚无已确认最终结果')
  fail = false
  await wrapper.get('[data-testid="annual-process-review"] [data-testid="table-retry"]').trigger('click'); await flushPromises()
  expect(reads(fetch).map(read => read.page)).toEqual([1, 2, 1, 1])
  expect(wrapper.findComponent(AnnualProcessTimeline).props('view').generation).toBe('scope-b')
  expect(ids()).toHaveLength(50)
})

it('resets accumulated batches on explicit refresh and ignores a late append from another selection epoch', async () => {
  const late = deferred<EventAnnualProcessPage>()
  let delay = false
  const fetch = readonlyPages((id, number) => id === 7 && number === 2 && delay ? late.promise : Promise.resolve(page(id, `scope-${id}`, number)))
  mountReview(7); await flushPromises()
  await click('加载更多过程'); expect(ids()).toHaveLength(100)
  await click('刷新年度过程'); expect(ids()).toHaveLength(50)
  delay = true
  await wrapper.findAll('button').find(button => button.text() === '加载更多过程')!.trigger('click'); await flushPromises()
  expect(wrapper.findAll('button').find(button => button.text() === '加载更多过程')!.attributes('disabled')).toBeDefined()
  await open(8)
  late.resolve(page(7, 'late-old-event', 2)); await flushPromises()
  expect(wrapper.findComponent(AnnualProcessTimeline).props('view').eventId).toBe(8)
  expect(ids()).toHaveLength(50)
  expect(reads(fetch).map(read => read.page)).toEqual([1, 2, 1, 2, 1])
  expect(posts(fetch)).toHaveLength(0)
})

it('keeps appended facts while waiting for current full audit readback and never resubmits the saved job', async () => {
  const audit = deferred<unknown>(); let delay = false
  const fetch = fixture((url, options) => {
    if (url.endsWith('/annual-process')) return Promise.resolve(page(7, 'scope-a', options.query.page))
    if (delay && url.endsWith('/42/audit')) return audit.promise
    return undefined
  })
  mountReview(7); await flushPromises(); delay = true
  await click('加载更多过程')
  expect(ids()).toHaveLength(100)
  expect(wrapper.text()).toContain('正在读回年度过程、对应与审计')
  expect(wrapper.get('[data-annual-summary]').text()).toContain('尚无已确认最终结果')
  audit.resolve({ rows: [{ correspondenceId: 42, resultingRevision: 2 }], total: 1, page: 1, pageSize: 200 }); await flushPromises()
  expect(ids()).toHaveLength(100)
  expect(wrapper.get('[data-annual-summary]').text()).toContain('已有最终结果：终审通过')
  expect(posts(fetch)).toHaveLength(1)
  expect(JSON.parse(sessionStorage.getItem('roster-annual-review:v1:7')!).jobId).toBe(jobId)
})
