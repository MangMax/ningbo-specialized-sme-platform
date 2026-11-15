// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import EventCorrespondenceReview from '../../../components/record-correspondence/EventCorrespondenceReview.vue'
import EventChip from '../../../components/EventChip.vue'
import TitleBadge from '../../../components/TitleBadge.vue'
import SourceChip from '../../../components/SourceChip.vue'
import AnnualProcessTimeline from '../../../components/record-correspondence/AnnualProcessTimeline.vue'
import { buildAnnualProcess, type EventAnnualProcessPage } from '../../../lib/roster/annual-process'
import type { AnnualTaskDto, AnnualTaskReceipt } from '../../../lib/roster/annual-correspondence'
import type { PlatformBusinessGroup, PlatformCorrespondenceRef } from '../../../lib/platform/business-record'

let wrapper: ReturnType<typeof mount>
beforeEach(() => { sessionStorage.clear(); const state = new Map(); vi.stubGlobal('useState', (key: string, init: () => unknown) => { if (!state.has(key)) state.set(key, ref(init())); return state.get(key) }) })
afterEach(() => { wrapper?.unmount(); document.body.innerHTML = ''; vi.useRealTimers(); vi.unstubAllGlobals() })
const events = [7, 8].map(id => ({ id, recordId: 2, type: 'award', year: 2024, seq: 1, decidedYear: null, reviewOutcome: null, titleCode: 'specialized_sme', source: 'jxj', district: null, evidence: [] }))
const jobId = '01J00000000000000000000001'
function annual(eventId = 7, generation = 'scope-a', status: 'confirmed' | 'eligible' | 'none' = 'eligible'): EventAnnualProcessPage {
  const event = { id: eventId, eventType: 'award', year: 2024, batchSeq: 1, sortKey: 0, decidedYear: null, reviewOutcome: null, record: { enterpriseId: 1, titleCode: 'specialized_sme', usccRaw: '91330200123456789A' } }
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

it('independent review: readback retry preserves refresh reset intent', async () => {
  let failRefresh = false;
  const fetch = fixture((url, options) => {
    if (url.endsWith('/annual-process')) {
      if (options.query.page === 1 && failRefresh) return Promise.reject(new Error('review intentional refresh transport failure'));
      return Promise.resolve(page(7, 'scope-a', options.query.page));
    }
    return undefined;
  });
  mountReview(7); await flushPromises();
  await click('加载更多过程');
  expect(ids()).toHaveLength(100);
  expect(wrapper.text()).toContain('已读回当前年度过程、对应与审计');
  failRefresh = true;
  await click('刷新并核对年度过程');
  expect(ids()).toHaveLength(100);
  expect(wrapper.text()).toContain('已提交，但同步读回失败');
  expect(wrapper.get('[data-annual-summary]').text()).toContain('尚无已确认最终结果');
  failRefresh = false;
  await click('重试读回');
  console.log(JSON.stringify({afterRetryCount: ids().length, annualReads: reads(fetch), postCount: posts(fetch).length, summary: wrapper.get('[data-annual-summary]').text(), phaseText: wrapper.text().includes('已读回当前年度过程、对应与审计')}));
  expect(posts(fetch)).toHaveLength(1);
  expect(ids(), 'Explicit refresh must reset to first 50 even when recovered through the offered readback retry').toHaveLength(50);
});

it('refreshes an earlier loaded observation decision after same-generation manual readback', async () => {
  let changed = false
  function currentPage(id: number, number: number) {
    const value = page(id, 'scope-a', number, 51)
    const first = value.process.steps.find(step => step.id === 'business-0')
    if (first) {
      first.groups = structuredClone(annual(id, 'scope-a', 'confirmed').process.steps[0]!.groups)
      if (changed) for (const group of first.groups) {
        for (const decision of group.existingCorrespondences) Object.assign(decision, { status: 'unlinked', revision: 3, endedAt: '2026-10-24' })
        for (const observation of group.observationRefs) for (const decision of observation.existingCorrespondences) Object.assign(decision, { status: 'unlinked', revision: 3, endedAt: '2026-10-24' })
      }
    }
    return value
  }
  const fetch = readonlyPages((id, number) => Promise.resolve(currentPage(id, number)))
  mountReview(7); await flushPromises()
  const firstObservation = () => wrapper.findComponent(AnnualProcessTimeline).props('view').steps.find(step => step.id === 'business-0')!.sources[0]!.observations[0]!
  expect(firstObservation().revision).toBe(2)
  await click('加载更多过程')
  expect(ids()).toHaveLength(51)
  changed = true
  const { refreshCorrespondenceViews } = await import('../../../composables/useCorrespondenceReadback')
  await refreshCorrespondenceViews(); await flushPromises()
  expect(posts(fetch)).toHaveLength(0)
  const expected = currentPage(7, 1).process.steps[0]!.groups[0]!.observationRefs[0]!.existingCorrespondences[0]!
  console.log(JSON.stringify({ reads: reads(fetch), loaded: ids().length, generation: wrapper.findComponent(AnnualProcessTimeline).props('view').generation, expected: {status:expected.status, revision:expected.revision}, actual: firstObservation() }))
  expect(firstObservation().revision).toBe(3)
  expect(firstObservation().decision).toContain('已取消对应')
})

function observationPage(id: number, generation: string, number: number, revision = 2) {
  const value = page(id, generation, number)
  const first = value.process.steps.find(step => step.id === 'business-0')
  if (first) {
    first.groups = structuredClone(annual(id, generation, 'confirmed').process.steps[0]!.groups)
    for (const group of first.groups) {
      for (const decision of [...group.existingCorrespondences, ...group.observationRefs.flatMap(ref => ref.existingCorrespondences)]) {
        Object.assign(decision, { status: revision === 2 ? 'confirmed' : 'unlinked', revision, endedAt: revision === 2 ? null : '2026-10-24' })
      }
    }
  }
  return value
}
const firstObservation = () => wrapper.findComponent(AnnualProcessTimeline).props('view').steps.find(step => step.id === 'business-0')!.sources[0]!.observations[0]!
const sharedReadback = async () => (await import('../../../composables/useCorrespondenceReadback')).refreshCorrespondenceViews()

it('keeps reset intent through repeated readback failures without submitting another job', async () => {
  let fail = false
  const fetch = fixture((url, options) => url.endsWith('/annual-process')
    ? fail ? Promise.reject(new Error('reset still unavailable')) : Promise.resolve(page(7, 'scope-a', options.query.page)) : undefined)
  mountReview(7); await flushPromises(); await click('加载更多过程')
  expect(ids()).toHaveLength(100)
  fail = true; await click('刷新并核对年度过程'); await click('重试读回')
  expect(ids()).toHaveLength(100)
  expect(wrapper.get('[data-annual-summary]').text()).toContain('尚无已确认最终结果')
  const beforeRetry = reads(fetch).length
  fail = false; await click('重试读回')
  expect(ids()).toEqual(Array.from({ length: 50 }, (_, i) => `business-${i}`))
  expect(reads(fetch).slice(beforeRetry)).toEqual([{ page: 1, pageSize: 50 }])
  expect(posts(fetch)).toHaveLength(1)
})

it('publishes refreshed batches atomically and retries a failed displayed batch first', async () => {
  let changed = false, fail = true
  const fetch = readonlyPages((id, number) => changed && number === 2 && fail
    ? Promise.reject(new Error('middle displayed batch unavailable')) : Promise.resolve(observationPage(id, 'scope-a', number, changed ? 3 : 2)))
  mountReview(7); await flushPromises(); await click('加载更多过程'); await click('加载更多过程')
  expect(ids()).toHaveLength(121); expect(firstObservation().revision).toBe(2)
  const before = reads(fetch).length
  changed = true
  await expect(sharedReadback()).rejects.toThrow('readback_failed'); await flushPromises()
  expect(reads(fetch).slice(before).map(read => read.page)).toEqual([3, 1, 2])
  expect(ids()).toHaveLength(121); expect(firstObservation().revision).toBe(2)
  expect(wrapper.get('[data-annual-summary]').text()).toContain('尚无已确认最终结果')
  fail = false
  const retryStart = reads(fetch).length
  await wrapper.get('[data-testid="annual-process-review"] [data-testid="table-retry"]').trigger('click'); await flushPromises()
  expect(reads(fetch).slice(retryStart).map(read => read.page)).toEqual([2, 1, 3])
  expect(ids()).toHaveLength(121); expect(firstObservation().revision).toBe(3)
  expect(firstObservation().decision).toContain('已取消对应')
  expect(wrapper.get('[data-annual-summary]').text()).toContain('已有最终结果')
  expect(posts(fetch)).toHaveLength(0)
})

it.each(['total', 'page', 'size', 'event'] as const)('rejects inconsistent %s in a displayed batch and retains facts until same-target recovery', async fault => {
  let invalid = false
  const fetch = readonlyPages((id, number) => {
    const value = observationPage(id, 'scope-a', number, invalid ? 3 : 2)
    if (invalid && number === 1) {
      if (fault === 'total') value.total++
      else if (fault === 'page') value.page = 99
      else if (fault === 'size') value.pageSize = 25
      else value.process.event.id = 8
    }
    return Promise.resolve(value)
  })
  mountReview(7); await flushPromises(); await click('加载更多过程')
  invalid = true
  const before = reads(fetch).length
  await expect(sharedReadback()).rejects.toThrow('readback_failed'); await flushPromises()
  expect(reads(fetch).slice(before).map(read => read.page)).toEqual([2, 1])
  expect(ids()).toHaveLength(100); expect(firstObservation().revision).toBe(2)
  expect(wrapper.get('[data-annual-summary]').text()).toContain('尚无已确认最终结果')
  invalid = false
  const retryStart = reads(fetch).length
  await wrapper.get('[data-testid="annual-process-review"] [data-testid="table-retry"]').trigger('click'); await flushPromises()
  expect(reads(fetch).slice(retryStart).map(read => read.page)).toEqual([1, 2])
  expect(ids()).toHaveLength(100)
  expect(wrapper.get('[data-annual-summary]').text()).toContain('已有最终结果')
  expect(posts(fetch)).toHaveLength(0)
})

it('stops a changing-source sweep and reads at most one extra first batch', async () => {
  let sweeping = false, changed = false
  const fetch = readonlyPages((id, number) => {
    if (sweeping && number === 2) changed = true
    return Promise.resolve(page(id, changed ? 'scope-b' : 'scope-a', number))
  })
  mountReview(7); await flushPromises(); await click('加载更多过程'); await click('加载更多过程')
  const before = reads(fetch).length
  sweeping = true
  await sharedReadback(); await flushPromises()
  expect(reads(fetch).slice(before)).toEqual([3, 1, 2, 1].map(page => ({ page, pageSize: 50 })))
  expect(ids()).toHaveLength(50)
  const view = wrapper.findComponent(AnnualProcessTimeline).props('view')
  expect(view.generation).toBe('scope-b')
  expect(view.steps.every(step => step.businessKey?.startsWith('scope-b-'))).toBe(true)
})

it('continues from the highest displayed batch after a shared sweep ends on the first batch', async () => {
  const fetch = readonlyPages()
  mountReview(7); await flushPromises(); await click('加载更多过程')
  await sharedReadback(); await flushPromises()
  expect(ids()).toHaveLength(100)
  await click('加载更多过程')
  expect(ids()).toHaveLength(121)
  expect(reads(fetch).map(read => read.page)).toEqual([1, 2, 2, 1, 3])
})

it('abandons a displayed-batch sweep when selection changes and never appends its late observations', async () => {
  const late = deferred<EventAnnualProcessPage>(); let delay = false
  const fetch = readonlyPages((id, number) => id === 7 && number === 2 && delay ? late.promise : Promise.resolve(page(id, `scope-${id}`, number)))
  mountReview(7); await flushPromises(); await click('加载更多过程')
  delay = true
  const reading = sharedReadback(); await flushPromises()
  await open(8)
  late.resolve(page(7, 'scope-7', 2)); await reading; await flushPromises()
  const view = wrapper.findComponent(AnnualProcessTimeline).props('view')
  expect(view.eventId).toBe(8); expect(view.generation).toBe('scope-8'); expect(ids()).toHaveLength(50)
  expect(view.steps.every(step => step.businessKey?.startsWith('scope-8-'))).toBe(true)
  expect(fetch.mock.calls.filter(([url]) => url.endsWith('/events/7/annual-process')).map(([, options]) => options.query.page)).toEqual([1, 2, 2])
  expect(posts(fetch)).toHaveLength(0)
})

it('ignores a superseded sweep while the newest readback refreshes all displayed decisions', async () => {
  const late = deferred<EventAnnualProcessPage>(); let changed = false, delayed = false
  const fetch = readonlyPages((id, number) => {
    if (changed && number === 2 && !delayed) { delayed = true; return late.promise }
    return Promise.resolve(observationPage(id, 'scope-a', number, changed ? 3 : 2))
  })
  mountReview(7); await flushPromises(); await click('加载更多过程'); changed = true
  const oldRead = sharedReadback().catch(error => error.message); await flushPromises()
  await sharedReadback(); await flushPromises()
  expect(ids()).toHaveLength(100); expect(firstObservation().revision).toBe(3)
  late.resolve(observationPage(7, 'scope-a', 2)); expect(await oldRead).toBe('readback_failed'); await flushPromises()
  expect(ids()).toHaveLength(100); expect(firstObservation().revision).toBe(3)
  expect(wrapper.get('[data-annual-summary]').text()).toContain('已有最终结果')
  expect(posts(fetch)).toHaveLength(0)
})

it('retains the explicitly requested append target after a later displayed-batch failure', async () => {
  let appendFails = false, displayedFails = false
  const fetch = readonlyPages((id, number) => {
    if (appendFails && number === 3) return Promise.reject(new Error('synthetic append unavailable'))
    if (displayedFails && number === 1) return Promise.reject(new Error('synthetic displayed batch unavailable'))
    return Promise.resolve(page(id, 'scope-a', number))
  })
  mountReview(7); await flushPromises(); await click('加载更多过程')
  expect(ids()).toHaveLength(100)
  appendFails = true; await click('加载更多过程')
  expect(ids()).toHaveLength(100)
  appendFails = false; displayedFails = true
  const { refreshCorrespondenceViews } = await import('../../../composables/useCorrespondenceReadback')
  const sweepStart = reads(fetch).length
  await expect(refreshCorrespondenceViews()).rejects.toThrow('readback_failed'); await flushPromises()
  expect(reads(fetch).slice(sweepStart).map(read => read.page)).toEqual([3, 1])
  expect(ids()).toHaveLength(100)
  expect(wrapper.get('[data-annual-summary]').text()).toContain('尚无已确认最终结果')
  displayedFails = false
  const retryStart = reads(fetch).length
  await wrapper.get('[data-testid="annual-process-review"] [data-testid="table-retry"]').trigger('click'); await flushPromises()
  console.log(JSON.stringify({ allReads: reads(fetch), retryPages: reads(fetch).slice(retryStart), displayed: ids().length, postCount: posts(fetch).length, summary: wrapper.get('[data-annual-summary]').text() }))
  expect(posts(fetch)).toHaveLength(0)
  expect(ids(), 'The explicitly requested third batch was never published and must remain in the atomic recovery plan').toHaveLength(121)
  expect(reads(fetch).slice(retryStart).map(read => read.page)).toEqual([1, 2, 3])
})

it("E08 failed append remains in the recovery plan after a later displayed page fails", async () => {
  let stage: 'initial' | 'append-fails' | 'sweep-fails' | 'recover' = 'initial'
  const fetch = readonlyPages((id, number) => {
    if (stage === 'append-fails' && number === 2) return Promise.reject(new Error('explicit append unavailable'))
    if (stage === 'sweep-fails' && number === 1) return Promise.reject(new Error('displayed page unavailable after append read'))
    return Promise.resolve(page(id, 'scope-a', number))
  })
  mountReview(7); await flushPromises(); stage = 'append-fails'; await click('加载更多过程')
  expect(ids()).toHaveLength(50); expectNoAnnualFinal()
  stage = 'sweep-fails'; const firstSweep = reads(fetch).length
  await expect(sharedReadback()).rejects.toThrow('readback_failed'); await flushPromises()
  expect(reads(fetch).slice(firstSweep).map(v => v.page)).toEqual([2, 1])
  expect(ids()).toHaveLength(50); expectNoAnnualFinal()
  stage = 'recover'; const retryStart = reads(fetch).length
  await retryAnnualRead()
  const actual = { pages: reads(fetch).slice(retryStart).map(v => v.page), loaded: ids().length, summary: wrapper.get('[data-annual-summary]').text() }
  console.log('E08 actual recovery', JSON.stringify(actual))
  expect(actual.pages, 'Retry failed displayed page first, then retain the previously explicit append target in the complete atomic plan').toEqual([1, 2])
  expect(actual.loaded).toBe(100)
  expect(posts(fetch)).toHaveLength(0)
})

const expectNoAnnualFinal = () => expect(wrapper.get('[data-annual-summary]').text()).toContain('尚无已确认最终结果')
const retryAnnualRead = async () => { await wrapper.get('[data-testid="annual-process-review"] [data-testid="table-retry"]').trigger('click'); await flushPromises() }

it.each([
  { loaded: 50, failure: 2, position: 'first' },
  { loaded: 50, failure: 1, position: 'last' },
  { loaded: 100, failure: 3, position: 'first' },
  { loaded: 100, failure: 1, position: 'middle' },
  { loaded: 100, failure: 2, position: 'last' },
])('preserves the unpublished append from $loaded rows when recovery fails at its $position page', async ({ loaded, failure }) => {
  const tail = loaded / 50 + 1
  let stage: 'initial' | 'append' | 'sweep' | 'recover' = 'initial'
  const fetch = readonlyPages((id, number) => (stage === 'append' && number === tail || stage === 'sweep' && number === failure)
    ? Promise.reject(new Error('planned failure')) : Promise.resolve(observationPage(id, 'scope-a', number, stage === 'initial' ? 2 : 3)))
  mountReview(7); await flushPromises()
  if (loaded === 100) await click('加载更多过程')
  stage = 'append'; await click('加载更多过程')
  expect(ids()).toHaveLength(loaded); expectNoAnnualFinal()
  stage = 'sweep'
  const before = reads(fetch).length
  await expect(sharedReadback()).rejects.toThrow('readback_failed'); await flushPromises()
  const order = [tail, ...Array.from({ length: tail - 1 }, (_, i) => i + 1)]
  expect(reads(fetch).slice(before).map(read => read.page)).toEqual(order.slice(0, order.indexOf(failure) + 1))
  expect(ids()).toHaveLength(loaded); expect(firstObservation().revision).toBe(2); expectNoAnnualFinal()
  stage = 'recover'
  const retryStart = reads(fetch).length
  await retryAnnualRead()
  expect(reads(fetch).slice(retryStart).map(read => read.page)).toEqual([failure, ...Array.from({ length: tail }, (_, i) => i + 1).filter(page => page !== failure)])
  expect(ids()).toHaveLength(Math.min(tail * 50, 121)); expect(firstObservation().revision).toBe(3)
  expect(reads(fetch).every(read => read.page <= tail && read.pageSize === 50)).toBe(true)
  expect(posts(fetch)).toHaveLength(0)
})

it('keeps the complete unpublished plan through failures that move between first middle and last pages', async () => {
  let failure: number | null = null, changed = false
  const fetch = readonlyPages((id, number) => number === failure ? Promise.reject(new Error('moving failure cursor')) : Promise.resolve(observationPage(id, 'scope-a', number, changed ? 3 : 2)))
  mountReview(7); await flushPromises(); await click('加载更多过程')
  failure = 3; await click('加载更多过程'); changed = true
  failure = 1; await expect(sharedReadback()).rejects.toThrow('readback_failed'); await flushPromises()
  let priorFailure = 1
  for (const nextFailure of [3, 1, 2]) {
    failure = nextFailure
    const before = reads(fetch).length
    await retryAnnualRead()
    const order = [priorFailure, ...[1, 2, 3].filter(page => page !== priorFailure)]
    expect(reads(fetch).slice(before).map(read => read.page)).toEqual(order.slice(0, order.indexOf(nextFailure) + 1))
    expect(ids()).toHaveLength(100); expect(firstObservation().revision).toBe(2); expectNoAnnualFinal()
    priorFailure = nextFailure
  }
  failure = null
  const before = reads(fetch).length
  await retryAnnualRead()
  expect(reads(fetch).slice(before).map(read => read.page)).toEqual([2, 1, 3])
  expect(ids()).toHaveLength(121); expect(firstObservation().revision).toBe(3)
  expect(posts(fetch)).toHaveLength(0)
})

it.each([50, 100])('replaces a pending append from %i rows with an explicit reset and ignores its late sweep', async loaded => {
  const tail = loaded / 50 + 1, late = deferred<EventAnnualProcessPage>()
  let stage: 'initial' | 'append' | 'sweep' | 'reset' = 'initial'
  const fetch = readonlyPages((id, number) => stage === 'append' && number === tail ? Promise.reject(new Error('append failed'))
    : stage === 'sweep' && number === tail ? late.promise : Promise.resolve(page(id, 'scope-a', number)))
  mountReview(7); await flushPromises(); if (loaded === 100) await click('加载更多过程')
  stage = 'append'; await click('加载更多过程'); stage = 'sweep'
  const abandoned = sharedReadback().catch(error => error.message); await flushPromises()
  stage = 'reset'
  wrapper.findComponent({ name: 'AnnualProcessReview' }).vm.$emit('refresh'); await flushPromises()
  expect(ids()).toHaveLength(50)
  late.resolve(page(7, 'scope-a', tail)); expect(await abandoned).toBe('readback_failed'); await flushPromises()
  const before = reads(fetch).length
  await sharedReadback(); await flushPromises()
  expect(reads(fetch).slice(before)).toEqual([{ page: 1, pageSize: 50 }])
  expect(ids()).toHaveLength(50)
  expect(wrapper.get('[data-annual-summary]').text()).toContain('已有最终结果')
})

it.each([50, 100])('restarts the source after a pending append from %i rows without retaining its old pages', async loaded => {
  const tail = loaded / 50 + 1
  let stage: 'initial' | 'append' | 'new-source' | 'recover' = 'initial'
  const fetch = readonlyPages((id, number) => stage === 'append' && number === tail || stage === 'new-source' && number === 1
    ? Promise.reject(new Error('append or new first batch unavailable')) : Promise.resolve(page(id, stage === 'recover' ? 'scope-c' : stage === 'new-source' ? 'scope-b' : 'scope-a', number)))
  mountReview(7); await flushPromises(); if (loaded === 100) await click('加载更多过程')
  stage = 'append'; await click('加载更多过程'); stage = 'new-source'
  const before = reads(fetch).length
  await expect(sharedReadback()).rejects.toThrow('readback_failed'); await flushPromises()
  expect(reads(fetch).slice(before).map(read => read.page)).toEqual([tail, 1])
  expect(ids()).toHaveLength(loaded); expectNoAnnualFinal()
  stage = 'recover'
  const retryStart = reads(fetch).length
  await retryAnnualRead()
  expect(reads(fetch).slice(retryStart)).toEqual([{ page: 1, pageSize: 50 }])
  expect(ids()).toHaveLength(50)
  expect(wrapper.findComponent(AnnualProcessTimeline).props('view').generation).toBe('scope-c')
  const sharedStart = reads(fetch).length
  await sharedReadback(); await flushPromises()
  expect(reads(fetch).slice(sharedStart)).toEqual([{ page: 1, pageSize: 50 }])
})

it.each([50, 100])('cancels the old pending append from %i rows across A-B-A selection', async loaded => {
  const tail = loaded / 50 + 1, late = deferred<EventAnnualProcessPage>()
  let stage: 'initial' | 'append' | 'sweep' | 'new-selection' = 'initial'
  const fetch = readonlyPages((id, number) => id === 7 && number === tail && stage === 'append' ? Promise.reject(new Error('old append failed'))
    : id === 7 && number === tail && stage === 'sweep' ? late.promise : Promise.resolve(page(id, `scope-${id}`, number)))
  mountReview(7); await flushPromises(); if (loaded === 100) await click('加载更多过程')
  stage = 'append'; await click('加载更多过程'); stage = 'sweep'
  const abandoned = sharedReadback().catch(error => error.message); await flushPromises()
  stage = 'new-selection'; await open(8); await open(7)
  late.resolve(page(7, 'scope-7', tail)); await abandoned; await flushPromises()
  expect(ids()).toHaveLength(50)
  const before = reads(fetch).length
  await sharedReadback(); await flushPromises()
  expect(reads(fetch).slice(before)).toEqual([{ page: 1, pageSize: 50 }])
  expect(wrapper.findComponent(AnnualProcessTimeline).props('view').eventId).toBe(7)
  expect(posts(fetch)).toHaveLength(0)
}, 10000)
