// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import EventCorrespondenceReview from '../components/record-correspondence/EventCorrespondenceReview.vue'
import EventChip from '../components/EventChip.vue'
import TitleBadge from '../components/TitleBadge.vue'
import SourceChip from '../components/SourceChip.vue'
import TablePagination from '../components/TablePagination.vue'
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

it('does no annual fanout at tab mount then automatically reads and submits only the expanded event without a confirmation click', async () => {
  const fetch = fixture(); mountReview(); await flushPromises()
  expect(fetch.mock.calls.some(([url]) => url.endsWith('/annual-process'))).toBe(false)
  await open(7)
  expect(posts(fetch)).toHaveLength(1)
  expect(posts(fetch)[0]![0]).toBe('/api/roster/events/7/annual-correspondence-tasks')
  expect(Object.keys(posts(fetch)[0]![1].body)).toEqual(['clientRequestId'])
  expect(fetch.mock.calls.some(([url]) => url === '/api/roster/events/8/annual-process')).toBe(false)
  expect(wrapper.findAll('[data-annual-step]')).toHaveLength(2)
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(1)
  expect(wrapper.text()).toContain('已读回当前年度过程、对应与审计')
})

it.each([{ name: 'disabled', answer: Promise.resolve({ writeEnabled: false }) }, { name: 'unavailable', answer: () => Promise.reject(new Error('offline')) }])('stays readonly without posting when browser context is $name', async ({ answer }) => {
  const fetch = fixture(url => url.endsWith('/browser-context') ? typeof answer === 'function' ? answer() : answer : undefined)
  mountReview(7); await flushPromises()
  expect(posts(fetch)).toHaveLength(0)
  expect(wrapper.text()).toContain('当前只读')
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(0)
  expect(wrapper.findAll('[data-annual-step]')).toHaveLength(2)
})

it('never treats a done task or its historical confirmations as final when the current annual GET remains only eligible', async () => {
  fixture(url => url.endsWith('/annual-process') ? Promise.resolve(annual()) : undefined)
  mountReview(7); await flushPromises()
  expect(wrapper.text()).toContain('已读回当前年度过程、对应与审计')
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(0)
  expect(wrapper.text()).toContain('尚无已确认最终结果')
})

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
async function click(text: string) { await wrapper.findAll('button').find(button => button.text() === text)!.trigger('click'); await flushPromises() }

it.each([{ name: 'annual', suffix: '/annual-process' }, { name: 'audit', suffix: '/42/audit' }])('keeps accepted work unsynchronized on $name readback failure and retries only reads with the original job', async ({ suffix }) => {
  let annualReads = 0, fail = true
  const fetch = fixture(url => {
    if (url.endsWith('/annual-process')) { annualReads++; if (suffix === '/annual-process' && annualReads > 1 && fail) return Promise.reject(new Error('503')); return Promise.resolve(annual(7, 'scope-a', annualReads > 1 ? 'confirmed' : 'eligible')) }
    if (url.endsWith(suffix) && suffix !== '/annual-process' && fail) return Promise.reject(new Error('503'))
    return undefined
  })
  mountReview(7); await flushPromises()
  expect(wrapper.text()).toContain('已提交，但同步读回失败')
  expect(wrapper.text()).not.toContain('已读回当前年度过程、对应与审计')
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(0)
  expect(wrapper.findAll('[data-annual-step]')).toHaveLength(2)
  fail = false; await click('重试读回')
  expect(posts(fetch)).toHaveLength(1)
  expect(wrapper.text()).toContain('已读回当前年度过程、对应与审计')
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(1)
})

it('awaits deferred audit completion even after current annual qualification is confirmed', async () => {
  const audit = deferred<unknown>()
  const fetch = fixture(url => url.endsWith('/42/audit') ? audit.promise : undefined)
  mountReview(7); await flushPromises()
  expect(wrapper.text()).toContain('正在读回年度过程、对应与审计')
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(0)
  expect(wrapper.text()).not.toContain('已读回当前年度过程、对应与审计')
  audit.resolve({ rows: [{ correspondenceId: 42, resultingRevision: 2 }], total: 1, page: 1, pageSize: 200 }); await flushPromises()
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(1)
  expect(posts(fetch)).toHaveLength(1)
  await click('本次读回的对应与审计')
  expect(wrapper.text()).toContain('对应 #42 · 读回修订 2 · 已读回该修订审计')
})

it('joins the real parent current point readback before success and propagates its 503 without mocking the listener', async () => {
  const delayed = deferred<unknown>(); let revision = 1, released = false
  const row = () => ({ id: 41, eventId: 7, type: 'event_process', role: 'context_only', status: 'confirmed', revision, relationId: 101, exportRowId: null, predecessorEventId: null, enterpriseId: 1, titleCode: 'specialized_sme', requiresRevalidation: false })
  const point = () => ({ ...row(), relation: { id: 101, sequenceNo: 1, status: '终审不通过', query: { id: 101, interface: 'business_list', queriedAt: '2026-10-01', status: 'success' } } })
  const fetch = fixture(url => {
    if (url.endsWith('/correspondences')) return Promise.resolve({ rows: [row()], total: 1, page: 1, pageSize: 200 })
    if (url.endsWith('/annual-correspondence-tasks')) { revision = 2; return Promise.resolve(receipt()) }
    if (url.endsWith('/annual-process')) return Promise.resolve(annual(7, 'scope-a', revision === 2 ? 'confirmed' : 'eligible'))
    if (url.endsWith('/correspondences/41')) return revision === 2 && !released ? delayed.promise : Promise.resolve(point())
    return undefined
  })
  mountReview(7); await flushPromises()
  expect(wrapper.text()).toContain('正在读取对应出处')
  expect(wrapper.text()).not.toContain('已读回当前年度过程、对应与审计')
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(0)
  delayed.reject(new Error('503 current point')); await flushPromises()
  expect(wrapper.text()).toContain('已提交，但同步读回失败')
  expect(wrapper.text()).toContain('对应出处读取失败')
  released = true; await click('重试读回')
  expect(wrapper.text()).toContain('已读回当前年度过程、对应与审计')
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(1)
  expect(posts(fetch)).toHaveLength(1)
})

it('freezes an unknown submission key across refresh and remount and resolves the same request without duplicate new keys', async () => {
  let attempts = 0
  const fetch = fixture(url => url.endsWith('/annual-correspondence-tasks') ? ++attempts === 1 ? Promise.reject(new Error('network result unknown')) : Promise.resolve(receipt()) : undefined)
  mountReview(7); await flushPromises()
  expect(wrapper.text()).toContain('提交结果尚未确认')
  const firstKey = posts(fetch)[0]![1].body.clientRequestId
  await click('刷新年度过程')
  expect(posts(fetch)).toHaveLength(1)
  wrapper.unmount(); mountReview(7); await flushPromises()
  expect(wrapper.text()).toContain('提交结果尚未确认')
  expect(posts(fetch)).toHaveLength(1)
  await click('重试同一请求')
  expect(posts(fetch).map(([, options]) => options.body.clientRequestId)).toEqual([firstKey, firstKey])
  expect(wrapper.text()).toContain('已读回当前年度过程、对应与审计')
})

it('restores an old done job and creates a new key only after its explicit source generation changed result', async () => {
  sessionStorage.setItem('roster-annual-review:v1:7', JSON.stringify({ clientRequestId: 'old-request', generation: 'scope-old', jobId }))
  const nextId = '01J00000000000000000000002', next = deferred<AnnualTaskDto>(); let posted = false
  const fetch = fixture(url => {
    if (url.endsWith('/annual-process')) return Promise.resolve(annual(7, 'scope-new', posted ? 'confirmed' : 'eligible'))
    if (url.endsWith('/annual-correspondence-tasks')) { posted = true; return Promise.resolve(receipt('scope-new', nextId)) }
    if (url.endsWith(`/annual-correspondence-tasks/${jobId}`)) return Promise.resolve(task('done', 'scope-old', ['source_generation_changed']))
    if (url.endsWith(`/annual-correspondence-tasks/${nextId}`)) return next.promise
    return undefined
  })
  mountReview(7); await flushPromises()
  expect(posts(fetch)).toHaveLength(1)
  expect(posts(fetch)[0]![1].body.clientRequestId).not.toBe('old-request')
  expect(fetch.mock.calls.findIndex(([url]) => url.endsWith(`/annual-correspondence-tasks/${jobId}`))).toBeLessThan(fetch.mock.calls.findIndex(([url]) => url.endsWith('/annual-correspondence-tasks')))
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(0)
  next.resolve({ ...task('done', 'scope-new'), jobId: nextId }); await flushPromises()
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(1)
})

it('ignores late annual and capability responses after selection switches and submits only the new event', async () => {
  const oldRead = deferred<EventAnnualProcessPage>(), oldCapability = deferred<{ writeEnabled: boolean }>(); let contexts = 0
  const nextId = '01J00000000000000000000002'
  const fetch = fixture(url => {
    if (url.endsWith('/browser-context')) return ++contexts === 1 ? oldCapability.promise : Promise.resolve({ writeEnabled: true })
    if (url.endsWith('/events/7/annual-process')) return oldRead.promise
    if (url.endsWith('/events/8/annual-process')) return Promise.resolve(annual(8, 'scope-b', 'confirmed'))
    if (url.endsWith('/events/8/annual-correspondence-tasks')) return Promise.resolve({ ...receipt('scope-b', nextId), sourceGenerations: [{ eventId: 8, generation: 'scope-b' }] })
    if (url.endsWith(`/annual-correspondence-tasks/${nextId}`)) { const value = task('done', 'scope-b'); value.jobId = nextId; value.result!.events[0]!.eventId = 8; value.result!.events[0]!.outcomes = []; return Promise.resolve(value) }
    if (/\/correspondences\/42$/.test(url)) return Promise.resolve({ id: 42, eventId: 8, relationId: 102, revision: 2, status: 'confirmed', requiresRevalidation: false })
    return undefined
  })
  mountReview(7); await flushPromises(); await open(8)
  oldRead.resolve(annual(7, 'scope-late', 'confirmed')); oldCapability.resolve({ writeEnabled: true }); await flushPromises()
  expect(posts(fetch).map(([url]) => url)).toEqual(['/api/roster/events/8/annual-correspondence-tasks'])
  expect(wrapper.get('#review-event-8').findAll('[data-final-result]')).toHaveLength(1)
  expect(wrapper.get('#review-event-7').findAll('[data-annual-step]')).toHaveLength(0)
})

it('retains a failed pagination source and uses same-response latest summary without an extra last-page request', async () => {
  let fail = true
  const fetch = fixture((url, options) => {
    if (url.endsWith('/browser-context')) return Promise.resolve({ writeEnabled: false })
    if (url.endsWith('/annual-process')) {
      const value = annual(7, 'scope-a', 'confirmed')
      if (options.query.page === 2 && fail) return Promise.reject(new Error('503 page2'))
      value.page = options.query.page; value.pageSize = options.query.pageSize
      value.process.steps = value.process.steps.slice((value.page - 1) * value.pageSize, value.page * value.pageSize)
      return Promise.resolve(value)
    }
    return undefined
  })
  mountReview(7); await flushPromises()
  expect(fetch.mock.calls.filter(([url]) => url.endsWith('/annual-process'))).toHaveLength(1)
  wrapper.findComponent(AnnualProcessTimeline).findComponent(TablePagination).vm.$emit('update:pageSize', 1); await flushPromises()
  expect(wrapper.findAll('[data-annual-step]')).toHaveLength(1)
  expect(wrapper.get('[data-testid="event-annual-summary"]').text()).toContain('终审通过')
  expect(wrapper.get('[data-annual-summary]').text()).toContain('已有最终结果：终审通过')
  await wrapper.get('[data-testid="annual-process-timeline"] button[aria-label="下一页"]').trigger('click'); await flushPromises()
  expect(wrapper.text()).toContain('年度过程第 2 页读取失败')
  expect(wrapper.text()).toContain('过程来源第 1 页')
  expect(wrapper.findAll('[data-annual-step]')[0]!.text()).toContain('终审不通过')
  fail = false; await wrapper.get('[data-testid="annual-process-review"] [data-testid="table-retry"]').trigger('click'); await flushPromises()
  expect(wrapper.text()).toContain('过程来源第 2 页')
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(1)
  expect(posts(fetch)).toHaveLength(0)
})

it('cancels and retries the same running job then stops polling at terminal completion and on collapse', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  let state: AnnualTaskDto['status'] = 'running'
  const fetch = fixture(url => {
    if (url.endsWith('/cancel')) { state = 'cancelled'; return Promise.resolve({ jobId, state, cancelled: true }) }
    if (url.endsWith('/retry')) { state = 'running'; return Promise.resolve(receipt()) }
    if (url.endsWith(`/annual-correspondence-tasks/${jobId}`)) return Promise.resolve(task(state))
    if (url.endsWith('/annual-process')) return Promise.resolve(annual(7, 'scope-a', state === 'done' ? 'confirmed' : 'eligible'))
    return undefined
  })
  mountReview(7); await flushPromises()
  expect(wrapper.text()).toContain('正在核对本事件年度过程')
  await click('取消任务'); expect(wrapper.text()).toContain('年度核对已取消')
  await click('重试任务'); expect(wrapper.text()).toContain('正在核对本事件年度过程')
  state = 'done'; await vi.advanceTimersByTimeAsync(3000); await flushPromises()
  expect(wrapper.text()).toContain('已读回当前年度过程、对应与审计')
  const count = fetch.mock.calls.filter(([url]) => url.endsWith(`/annual-correspondence-tasks/${jobId}`)).length
  await vi.advanceTimersByTimeAsync(12000); await flushPromises()
  expect(fetch.mock.calls.filter(([url]) => url.endsWith(`/annual-correspondence-tasks/${jobId}`))).toHaveLength(count)
  expect(posts(fetch)).toHaveLength(1)
  await open(7); await vi.advanceTimersByTimeAsync(9000)
  expect(fetch.mock.calls.filter(([url]) => url.endsWith(`/annual-correspondence-tasks/${jobId}`))).toHaveLength(count)
})

it('rechecks generation after a deferred audit and requires an explicit old-job block before starting the new scope', async () => {
  const audit = deferred<unknown>(), nextTask = deferred<AnnualTaskDto>(); let generation = 'scope-a', submissions = 0
  const nextId = '01J00000000000000000000002'
  const fetch = fixture(url => {
    if (url.endsWith('/annual-process')) return Promise.resolve(annual(7, generation, 'confirmed'))
    if (url.endsWith('/annual-correspondence-tasks')) return Promise.resolve(++submissions === 1 ? receipt() : receipt('scope-b', nextId))
    if (url.endsWith(`/annual-correspondence-tasks/${jobId}`)) return Promise.resolve(task('done', 'scope-a', generation === 'scope-b' ? ['source_generation_changed'] : []))
    if (url.endsWith(`/annual-correspondence-tasks/${nextId}`)) return nextTask.promise
    if (url.endsWith('/42/audit')) return audit.promise
    return undefined
  })
  mountReview(7); await flushPromises()
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(0)
  generation = 'scope-b'
  const { refreshCorrespondenceViews } = await import('../composables/useCorrespondenceReadback')
  await refreshCorrespondenceViews()
  audit.resolve({ rows: [{ correspondenceId: 42, resultingRevision: 2 }], total: 1, page: 1, pageSize: 200 }); await flushPromises()
  expect(posts(fetch)).toHaveLength(2)
  expect(new Set(posts(fetch).map(([, options]) => options.body.clientRequestId)).size).toBe(2)
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(0)
  nextTask.resolve({ ...task('done', 'scope-b'), jobId: nextId }); await flushPromises()
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(1)
})

it('keeps an unknown original key through a new source until the original receipt is resolved and explicitly blocked', async () => {
  let attempts = 0, generation = 'scope-a'
  const nextId = '01J00000000000000000000002'
  const fetch = fixture(url => {
    if (url.endsWith('/annual-process')) return Promise.resolve(annual(7, generation, 'confirmed'))
    if (url.endsWith('/annual-correspondence-tasks')) {
      attempts++
      return attempts === 1 ? Promise.reject(new Error('unknown')) : Promise.resolve(attempts === 2 ? receipt() : receipt('scope-b', nextId))
    }
    if (url.endsWith(`/annual-correspondence-tasks/${jobId}`)) return Promise.resolve(task('done', 'scope-a', ['source_generation_changed']))
    if (url.endsWith(`/annual-correspondence-tasks/${nextId}`)) return Promise.resolve({ ...task('done', 'scope-b'), jobId: nextId })
    return undefined
  })
  mountReview(7); await flushPromises(); generation = 'scope-b'
  await click('刷新年度过程')
  expect(posts(fetch)).toHaveLength(1)
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(0)
  await click('重试同一请求')
  const keys = posts(fetch).map(([, options]) => options.body.clientRequestId)
  expect(keys).toHaveLength(3)
  expect(keys[1]).toBe(keys[0]); expect(keys[2]).not.toBe(keys[0])
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(1)
})

it('stops a running task poll when collapsed and ignores its delayed terminal answer after switching event', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const delayed = deferred<AnnualTaskDto>(); let reads = 0, contexts = 0
  const fetch = fixture(url => {
    if (url.endsWith('/browser-context')) return Promise.resolve({ writeEnabled: ++contexts === 1 })
    if (url.endsWith('/events/8/annual-process')) return Promise.resolve(annual(8, 'scope-b', 'none'))
    if (url.endsWith(`/annual-correspondence-tasks/${jobId}`)) return ++reads === 1 ? Promise.resolve(task('running')) : delayed.promise
    return undefined
  })
  mountReview(7); await flushPromises()
  await vi.advanceTimersByTimeAsync(3000); await flushPromises()
  expect(reads).toBe(2)
  await open(7)
  await vi.advanceTimersByTimeAsync(9000); await flushPromises()
  expect(reads).toBe(2)
  await wrapper.setProps({ eventId: 8 }); await flushPromises()
  delayed.resolve(task()); await flushPromises()
  expect(wrapper.get('#review-event-8').text()).not.toContain('已读回当前年度过程、对应与审计')
  expect(wrapper.get('#review-event-8').findAll('[data-final-result]')).toHaveLength(0)
  wrapper.unmount(); const count = fetch.mock.calls.length
  await vi.advanceTimersByTimeAsync(9000); expect(fetch.mock.calls).toHaveLength(count)
})

it('resumes the saved job after an initial annual read failure is explicitly retried without submitting a second task', async () => {
  sessionStorage.setItem('roster-annual-review:v1:7', JSON.stringify({ clientRequestId: 'saved-request', generation: 'scope-a', jobId }))
  let reads = 0
  const fetch = fixture(url => url.endsWith('/annual-process') ? ++reads === 1 ? Promise.reject(new Error('503 first read')) : Promise.resolve(annual(7, 'scope-a', 'confirmed')) : undefined)
  mountReview(7); await flushPromises()
  expect(wrapper.text()).toContain('年度过程第 1 页读取失败')
  await click('刷新年度过程')
  expect(posts(fetch)).toHaveLength(0)
  expect(wrapper.text()).toContain('已读回当前年度过程、对应与审计')
})

it('invalidates a previously synchronized final immediately when an external readback changes the source before the old job answers', async () => {
  let generation = 'scope-a', reads = 0
  const blocked = deferred<AnnualTaskDto>()
  const fetch = fixture(url => {
    if (url.endsWith('/annual-process')) return Promise.resolve(annual(7, generation, 'confirmed'))
    if (url.endsWith(`/annual-correspondence-tasks/${jobId}`)) return ++reads === 1 ? Promise.resolve(task()) : blocked.promise
    return undefined
  })
  mountReview(7); await flushPromises()
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(1)
  generation = 'scope-b'
  const { refreshCorrespondenceViews } = await import('../composables/useCorrespondenceReadback')
  await refreshCorrespondenceViews(); await flushPromises()
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(0)
  expect(wrapper.text()).toContain('来源已变化')
  expect(posts(fetch)).toHaveLength(1)
  expect(reads).toBe(2)
})

it('reports an explicit readonly server refusal as readonly rather than an unknown accepted submission', async () => {
  const fetch = fixture(url => url.endsWith('/annual-correspondence-tasks') ? Promise.reject({ statusCode: 403, data: { error: { code: 'readonly_database' } } }) : undefined)
  mountReview(7); await flushPromises()
  expect(posts(fetch)).toHaveLength(1)
  expect(wrapper.text()).toContain('当前只读')
  expect(wrapper.text()).not.toContain('提交结果尚未确认')
  expect(wrapper.findAll('button').map(button => button.text())).not.toContain('重试同一请求')
})

it('uses the same-origin JSON browser write contract for task cancel and retry without a credential header', async () => {
  let state: AnnualTaskDto['status'] = 'running'
  const fetch = fixture(url => {
    if (url.endsWith('/cancel')) { state = 'cancelled'; return Promise.resolve({ jobId, state, cancelled: true }) }
    if (url.endsWith('/retry')) { state = 'running'; return Promise.resolve(receipt()) }
    if (url.endsWith(`/annual-correspondence-tasks/${jobId}`)) return Promise.resolve(task(state))
    return undefined
  })
  mountReview(7); await flushPromises(); await click('取消任务'); await click('重试任务')
  const commands = fetch.mock.calls.filter(([url]) => url.endsWith('/cancel') || url.endsWith('/retry'))
  expect(commands).toHaveLength(2)
  for (const [, options] of commands) expect(options).toEqual({ method: 'POST', body: {} })
})

it('stops audit pagination on invalid metadata and retains the accepted job for readback retry', async () => {
  let reads = 0
  const fetch = fixture(url => {
    if (url.endsWith('/42/audit')) return ++reads === 1 ? Promise.resolve({ rows: [], page: 1, pageSize: 200 }) : Promise.reject(new Error('stop unexpected extra audit fetch'))
    return undefined
  })
  mountReview(7); await flushPromises()
  expect(reads).toBe(1)
  expect(wrapper.text()).toContain('已提交，但同步读回失败')
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(0)
  expect(posts(fetch)).toHaveLength(1)
})

it('shows a returned-state business reason once when current process and task report the same reason', async () => {
  fixture(url => {
    if (url.endsWith('/annual-process')) { const value=annual(7,'scope-a','none'); value.process.latestStepSummary!.status='已退回待审核'; value.process.reasons=['latest_status_not_terminal']; value.process.finalQualification!.reasons=['latest_status_not_terminal']; return Promise.resolve(value) }
    if (url.endsWith(`/annual-correspondence-tasks/${jobId}`)) return Promise.resolve(task('done','scope-a',['latest_status_not_terminal']))
    return undefined
  })
  mountReview(7); await flushPromises()
  expect(wrapper.findAll('p').filter(p=>p.text()==='平台年度末态尚未形成可对应的终审结论，保留全部年度过程。')).toHaveLength(1)
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(0)
})

it('withholds a previous final when an explicit annual refresh fails then restores it through readback only', async () => {
  let fail = false
  const fetch = fixture(url=>url.endsWith('/annual-process')&&fail?Promise.reject(new Error('service offline')):undefined)
  mountReview(7); await flushPromises()
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(1)
  fail=true; await click('刷新年度过程')
  expect(wrapper.text()).toContain('已提交，但同步读回失败')
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(0)
  expect(wrapper.findAll('[data-annual-step]')).toHaveLength(2)
  fail=false; await click('重试读回')
  expect(posts(fetch)).toHaveLength(1)
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(1)
})

it.each(['refresh', 'page', 'readback'] as const)('withdraws readonly final and parent summary after %s failure until a successful current read', async action => {
  let fail = false, delayed: ReturnType<typeof deferred<EventAnnualProcessPage>> | null = null
  const fetch = fixture((url, options) => {
    if (url.endsWith('/browser-context')) return Promise.resolve({ writeEnabled: false })
    if (url.endsWith('/annual-process')) {
      if (fail) return Promise.reject(new Error('503 readonly annual'))
      if (delayed) return delayed.promise
      const value = annual(7, 'scope-a', 'confirmed'); value.page = options.query.page
      return Promise.resolve(value)
    }
    return undefined
  })
  mountReview(7); await flushPromises()
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(1)
  fail = true
  if (action === 'refresh') await click('刷新年度过程')
  else if (action === 'page') { wrapper.findComponent(AnnualProcessTimeline).vm.$emit('page', 2); await flushPromises() }
  else { const { refreshCorrespondenceViews } = await import('../composables/useCorrespondenceReadback'); await expect(refreshCorrespondenceViews()).rejects.toThrow('readback_failed'); await flushPromises() }
  expect(wrapper.text()).toContain('当前只读')
  expect(wrapper.text()).toContain(`年度过程第 ${action === 'page' ? 2 : 1} 页读取失败`)
  expect(wrapper.text()).toContain('保留第 1 页年度过程')
  expect(wrapper.findAll('[data-annual-step]')).toHaveLength(2)
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(0)
  expect(wrapper.get('[data-testid="event-annual-summary"]').text()).not.toContain('· 已确认最终结果')
  expect(wrapper.get('[data-annual-summary]').text()).toContain('尚无已确认最终结果')
  fail = false; delayed = deferred<EventAnnualProcessPage>()
  await click('刷新年度过程')
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(0)
  const recovered = annual(7, 'scope-a', 'confirmed'); recovered.page = action === 'page' ? 2 : 1
  delayed.resolve(recovered); await flushPromises()
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(1)
  expect(wrapper.get('[data-testid="event-annual-summary"]').text()).toContain('· 已确认最终结果')
  expect(posts(fetch)).toHaveLength(0)
})

it.each([
  { name: 'newer manual unlink', revision: 3, status: 'unlinked', requiresRevalidation: false },
  { name: 'newer manual rejection', revision: 3, status: 'rejected', requiresRevalidation: false },
  { name: 'newer candidate', revision: 3, status: 'candidate', requiresRevalidation: false },
  { name: 'newer confirmed revision', revision: 3, status: 'confirmed', requiresRevalidation: false },
  { name: 'newer confirmed requiring revalidation', revision: 3, status: 'confirmed', requiresRevalidation: true },
  { name: 'same revision requiring revalidation', revision: 2, status: 'confirmed', requiresRevalidation: true },
  { name: 'ended confirmation', revision: 3, status: 'confirmed', requiresRevalidation: false, endedAt: '2026-10-02' },
])('withholds stale annual final on $name and retries only current reads without changing manual decisions', async point => {
  let annualReads = 0, recovered = false
  const fetch = fixture(url => {
    if (url.endsWith('/annual-process')) { annualReads++; return Promise.resolve(annual(7, 'scope-a', recovered ? 'none' : 'confirmed')) }
    if (url.endsWith('/correspondences/42')) return Promise.resolve({ id: 42, eventId: 7, relationId: 102, ...point })
    if (url.endsWith('/42/audit')) return Promise.resolve({ rows: [{ correspondenceId: 42, resultingRevision: point.revision }], total: 1, page: 1, pageSize: 200 })
    return undefined
  })
  mountReview(7); await flushPromises()
  expect(annualReads).toBe(3) // initial, task readback, bounded mismatch reread
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(0)
  expect(wrapper.get('[data-testid="event-annual-summary"]').text()).not.toContain('· 已确认最终结果')
  expect(wrapper.text()).toContain('已提交，但同步读回失败')
  expect(wrapper.findComponent({ name: 'AnnualProcessReview' }).props('auditReadback')).toContainEqual({ id: 42, revision: point.revision, status: point.status })
  recovered = true; await click('重试读回')
  expect(wrapper.text()).toContain('已读回当前年度过程、对应与审计')
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(0)
  expect(posts(fetch)).toHaveLength(1)
  expect(fetch.mock.calls.filter(([url, options]) => options?.method === 'POST' && !url.endsWith('/discover')).map(([url]) => url)).toEqual(['/api/roster/events/7/annual-correspondence-tasks'])
})

it('rereads a newer still-confirmed final revision and awaits its current audit before restoring final', async () => {
  let annualReads = 0, pointReads = 0
  const currentAudit = deferred<unknown>()
  const fetch = fixture(url => {
    if (url.endsWith('/annual-process')) {
      const value = annual(7, 'scope-a', 'confirmed')
      if (++annualReads >= 3) value.process.finalQualification!.decisionRefs[0]!.revision = 3
      return Promise.resolve(value)
    }
    if (url.endsWith('/correspondences/42')) { pointReads++; return Promise.resolve({ id: 42, eventId: 7, relationId: 102, revision: 3, status: 'confirmed', requiresRevalidation: false }) }
    if (url.endsWith('/42/audit')) return pointReads === 1 ? Promise.resolve({ rows: [{ correspondenceId: 42, resultingRevision: 3 }], total: 1, page: 1, pageSize: 200 }) : currentAudit.promise
    return undefined
  })
  mountReview(7); await flushPromises()
  expect(annualReads).toBe(3)
  expect(pointReads).toBe(2)
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(0)
  expect(wrapper.text()).toContain('正在读回年度过程、对应与审计')
  currentAudit.resolve({ rows: [{ correspondenceId: 42, resultingRevision: 3 }], total: 1, page: 1, pageSize: 200 }); await flushPromises()
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(1)
  expect(wrapper.findComponent({ name: 'AnnualProcessReview' }).props('auditReadback')).toContainEqual({ id: 42, revision: 3, status: 'confirmed' })
  expect(posts(fetch)).toHaveLength(1)
})

it('accepts current annual withdrawal after a same-generation manual unlink without resubmitting', async () => {
  let reads = 0
  const fetch = fixture(url => {
    if (url.endsWith('/annual-process')) return Promise.resolve(annual(7, 'scope-a', ++reads >= 3 ? 'none' : 'confirmed'))
    if (url.endsWith('/correspondences/42')) return Promise.resolve({ id: 42, eventId: 7, relationId: 102, revision: 3, status: 'unlinked', requiresRevalidation: false })
    if (url.endsWith('/42/audit')) return Promise.resolve({ rows: [{ correspondenceId: 42, resultingRevision: 3 }], total: 1, page: 1, pageSize: 200 })
    return undefined
  })
  mountReview(7); await flushPromises()
  expect(reads).toBe(3)
  expect(wrapper.text()).toContain('已读回当前年度过程、对应与审计')
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(0)
  expect(wrapper.get('[data-testid="event-annual-summary"]').text()).not.toContain('· 已确认最终结果')
  expect(wrapper.findComponent({ name: 'AnnualProcessReview' }).props('auditReadback')).toContainEqual({ id: 42, revision: 3, status: 'unlinked' })
  expect(posts(fetch)).toHaveLength(1)
})

it('reconciles a newer manual unlink exposed by the audit after an older confirmed point read', async () => {
  let revision = 2, reads = 0, pointReads = 0
  const fetch = fixture(url => {
    if (url.endsWith('/annual-process')) { reads++; return Promise.resolve(annual(7, 'scope-a', revision === 2 ? 'confirmed' : 'none')) }
    if (url.endsWith('/correspondences/42')) { pointReads++; return Promise.resolve({ id: 42, eventId: 7, relationId: 102, revision, status: revision === 2 ? 'confirmed' : 'unlinked', requiresRevalidation: false }) }
    if (url.endsWith('/42/audit')) { revision = 3; return Promise.resolve({ rows: [{ correspondenceId: 42, resultingRevision: 2 }, { correspondenceId: 42, resultingRevision: 3 }], total: 2, page: 1, pageSize: 200 }) }
    return undefined
  })
  mountReview(7); await flushPromises()
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(0)
  expect(wrapper.get('[data-testid="event-annual-summary"]').text()).not.toContain('· 已确认最终结果')
  expect(reads).toBe(3); expect(pointReads).toBe(2)
  expect(wrapper.text()).toContain('已读回当前年度过程、对应与审计')
  expect(wrapper.findComponent({ name: 'AnnualProcessReview' }).props('auditReadback')).toContainEqual({ id: 42, revision: 3, status: 'unlinked' })
  expect(posts(fetch)).toHaveLength(1)
})

function auditHistory(page: number, total = 201) {
  return { rows: Array.from({ length: Math.min(200, Math.max(0, total - (page - 1) * 200)) }, (_, index) => ({ id: (page - 1) * 200 + index + 1, correspondenceId: 42, resultingRevision: (page - 1) * 200 + index + 1 })), total, page, pageSize: 200 }
}

it('reads later audit pages beyond an old point match and preserves the job on a persistent newer unlink', async () => {
  let recovered = false, reads = 0
  const auditPages: number[] = []
  const fetch = fixture((url, options) => {
    if (url.endsWith('/annual-process')) {
      reads++; const value = annual(7, 'scope-a', recovered ? 'none' : 'confirmed')
      if (!recovered) value.process.finalQualification!.decisionRefs[0]!.revision = 200
      return Promise.resolve(value)
    }
    if (url.endsWith('/correspondences/42')) return Promise.resolve({ id: 42, eventId: 7, relationId: 102, revision: recovered ? 201 : 200, status: recovered ? 'unlinked' : 'confirmed', requiresRevalidation: false })
    if (url.endsWith('/42/audit')) { auditPages.push(options.query.page); return Promise.resolve(auditHistory(options.query.page)) }
    return undefined
  })
  mountReview(7); await flushPromises()
  const identity = sessionStorage.getItem('roster-annual-review:v1:7')
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(0)
  expect(wrapper.get('[data-testid="event-annual-summary"]').text()).not.toContain('· 已确认最终结果')
  expect(wrapper.text()).toContain('已提交，但同步读回失败')
  expect(reads).toBe(3); expect(auditPages).toEqual([1, 2, 1, 2])
  recovered = true; await click('重试读回')
  expect(wrapper.text()).toContain('已读回当前年度过程、对应与审计')
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(0)
  expect(wrapper.findComponent({ name: 'AnnualProcessReview' }).props('auditReadback')).toContainEqual({ id: 42, revision: 201, status: 'unlinked' })
  expect(sessionStorage.getItem('roster-annual-review:v1:7')).toBe(identity)
  expect(posts(fetch)).toHaveLength(1)
  expect(fetch.mock.calls.filter(([url, options]) => options?.method === 'POST' && !url.endsWith('/discover'))).toHaveLength(1)
})

it('restores a newer confirmed final only after every reconciled audit page aligns with the new point', async () => {
  let reads = 0, pointReads = 0, auditReads = 0
  const lastPage = deferred<ReturnType<typeof auditHistory>>()
  const fetch = fixture((url, options) => {
    if (url.endsWith('/annual-process')) { const value = annual(7, 'scope-a', 'confirmed'); value.process.finalQualification!.decisionRefs[0]!.revision = ++reads >= 3 ? 201 : 200; return Promise.resolve(value) }
    if (url.endsWith('/correspondences/42')) return Promise.resolve({ id: 42, eventId: 7, relationId: 102, revision: ++pointReads >= 2 ? 201 : 200, status: 'confirmed', requiresRevalidation: false })
    if (url.endsWith('/42/audit')) { auditReads++; return auditReads === 4 ? lastPage.promise : Promise.resolve(auditHistory(options.query.page)) }
    return undefined
  })
  mountReview(7); await flushPromises()
  const identity = sessionStorage.getItem('roster-annual-review:v1:7')
  expect(reads).toBe(3); expect(pointReads).toBe(2); expect(auditReads).toBe(4)
  expect(wrapper.text()).toContain('正在读回年度过程、对应与审计')
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(0)
  lastPage.resolve(auditHistory(2)); await flushPromises()
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(1)
  expect(wrapper.get('[data-testid="event-annual-summary"]').text()).toContain('· 已确认最终结果')
  expect(sessionStorage.getItem('roster-annual-review:v1:7')).toBe(identity)
  expect(posts(fetch)).toHaveLength(1)
})

it.each(['total-drift', 'wrong-page', 'wrong-size', 'missing-row'] as const)('retains sync failure on invalid later audit metadata %s without unbounded paging', async fault => {
  const auditPages: number[] = []
  const fetch = fixture((url, options) => {
    if (url.endsWith('/annual-process')) { const value = annual(7, 'scope-a', 'confirmed'); value.process.finalQualification!.decisionRefs[0]!.revision = 200; return Promise.resolve(value) }
    if (url.endsWith('/correspondences/42')) return Promise.resolve({ id: 42, eventId: 7, relationId: 102, revision: 200, status: 'confirmed', requiresRevalidation: false })
    if (url.endsWith('/42/audit')) {
      const page = options.query.page; auditPages.push(page); const value = auditHistory(page)
      if (page === 2) {
        if (fault === 'total-drift') { value.total = 202; value.rows.push({ id: 202, correspondenceId: 42, resultingRevision: 202 }) }
        if (fault === 'wrong-page') value.page = 1
        if (fault === 'wrong-size') value.pageSize = 100
        if (fault === 'missing-row') value.rows = []
      }
      return Promise.resolve(value)
    }
    return undefined
  })
  mountReview(7); await flushPromises()
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(0)
  expect(wrapper.get('[data-testid="event-annual-summary"]').text()).not.toContain('· 已确认最终结果')
  expect(wrapper.text()).toContain('已提交，但同步读回失败')
  expect(auditPages).toEqual([1, 2])
  expect(posts(fetch)).toHaveLength(1)
})
