// @vitest-environment happy-dom
import { createHash } from 'node:crypto'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { createPinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import { createMemoryHistory, createRouter, RouterLink, useRoute, useRouter } from 'vue-router'
import Page from '../pages/current-enterprises.vue'
import TablePagination from '../components/TablePagination.vue'
import type { CurrentTitle } from '../lib/roster/current-titles'
import type { CurrentQualificationAssessment, CurrentQualificationSnapshot } from '../lib/roster/current-qualification'
import type { CurrentQualifiedResult, CurrentQualifiedRow, CurrentFilterMatch } from '../lib/roster/current-qualified-query'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const asOf = '2026-06-01T00:00:00.000Z'
// Independent wire literals, not DB/reader-generated expected qualification.
function snapshot(id: number, pending: boolean, selectedTitle: CurrentTitle = 'innovative_sme'): CurrentQualificationSnapshot {
  const titles: CurrentQualificationAssessment[] = (['little_giant', 'specialized_sme', 'innovative_sme'] as const).map((titleCode): CurrentQualificationAssessment => {
    const selected = titleCode === selectedTitle
    const group = selected && !pending ? 'eligible' : 'pending'
    const eventId = id + 1000, evidenceId = id + 2000
    const evidence: CurrentQualificationAssessment['evidence'] = selected ? [{ eventId, revision: 1, eventType: pending ? 'review' : 'award', year: pending ? 2022 : 2025, batchSeq: 1, decidedYear: pending ? null : 2025, reviewOutcome: null, evidenceIds: [evidenceId] }] : []
    const sourceVersions: CurrentQualificationAssessment['sourceVersions'] = selected ? [{ evidenceId, eventId, sourceFile: 'synthetic/ui408/formal.pdf', storedFileId: 71, sha256: digest('synthetic ui formal bytes'), bytes: 25, removedAt: null, capturedRevision: 1, capturedSha256: digest('synthetic ui row') }] : []
    return {
      titleCode, group, cycles: selected ? [{ originYear: pending ? 2022 : 2025, batchSeq: 1, precision: 'year' }] : [],
      versions: { facts: digest([id, evidence]), sources: digest(sourceVersions), decisions: digest([]), observations: digest([]) },
      officialQualification: { group, message: selected ? pending ? '正式资格待核，已保留公布事实' : '正式资格当前有效' : '尚无本称号正式依据', basis: selected ? '合成正式公布' : '', notes: [] },
      subject: { status: 'not_established', message: '未见主体终止事实', decisionIds: [] },
      region: { status: 'not_established', message: '沿用正式公布地域范围', decisionIds: [] },
      platform: { status: 'not_queried', comparison: 'not_established', message: '未查询不否定正式资格', truncated: false, observations: [] },
      correspondence: { status: 'unmatched', message: '对应不等于资格', refs: [] },
      completeness: { status: pending && selected ? 'incomplete' : 'recorded', message: pending && selected ? '复核结论与结论年待补' : '合成资料已记录', gaps: pending && selected ? ['missing_cycle_semantics'] : [], eventIds: pending && selected ? [eventId] : [],
        fieldGaps: pending && selected ? [
          { eventId, field: 'decidedYear', valueState: 'unknown', inputState: 'null' },
          { eventId, field: 'reviewOutcome', valueState: 'unknown', inputState: 'null' },
        ] : [], publishedNames: selected ? [{ evidenceId, availability: 'captured', nameKnown: true }] : [] },
      evidence, sourceVersions, references: selected ? [`evidence:${evidenceId}`] : [], notes: [], shadow: { legacyGroup: group, difference: null },
    }
  })
  const scope = { enterpriseId: id, asOf, ruleVersion: 'current-roster-116-v8', assessmentVersion: 'enterprise-qualification-407-v1' }
  return { ...scope, titles, snapshotId: digest([scope, titles]) }
}
function row(id: number, name: string, pending: boolean, selectedTitle: CurrentTitle = 'innovative_sme'): CurrentQualifiedRow {
  return { enterpriseId: id, name, uscc: null, district: '鄞州区', publishedNames: [name], aliases: [], firstYear: pending ? 2022 : 2025,
    basis: 'synthetic formal basis', reviews: pending ? '复核结论未知' : '', publication: '已见本称号宁波公布记录', notes: [], references: [], group: pending ? 'pending' : 'eligible',
    recognition: pending ? null : { precision: 'year', year: 2025 }, qualificationWitnesses: pending ? [] : [{ cycle: { originYear: 2025, batchSeq: 1 }, awardEventId: id + 1000, recognition: { precision: 'year', year: 2025 }, matchedValidYear: null, matchedMaintenance: null, correspondenceId: null, conditionQueryId: null }], matchedValidYears: [], matchedMaintenance: [],
    publishedPresentation: { availability: 'available', error: null, facts: [{ evidenceId: id + 2000, eventId: id + 1000, revision: 1, availability: 'captured', nameRaw: name, sourceBindingKnown: true }] }, qualificationAssessment: snapshot(id, pending, selectedTitle) }
}
function wire(options: { titleCode?: CurrentTitle; requested?: boolean; eligible?: boolean; pending?: boolean; page?: number; total?: number; pendingTotal?: number; match?: CurrentFilterMatch; suffix?: string } = {}): CurrentQualifiedResult {
  const page = options.page ?? 2
  return { responseVersion: 'current-qualified-408-v1', titleCode: options.titleCode ?? 'innovative_sme', ruleVersion: 'current-roster-116-v8', snapshotStartedAt: asOf,
    rows: options.eligible === false ? [] : [row(801, `synthetic_408_有效${options.suffix ?? ''}`, false, options.titleCode)], total: options.total ?? 3, uncertainTotal: 0,
    publishedPending: { requested: options.requested ?? true, rows: options.pending === false ? [] : [{ ...row(802, `synthetic_408_公布待核${options.suffix ?? ''}`, true, options.titleCode), filterMatch: options.match ?? { status: 'matched', checks: [] } }], total: options.pendingTotal ?? 5, page, pageSize: 1 },
    options: { recognitionYears: [2025], validYears: [], maintenanceYears: [], maintenanceBatchesByYear: {} }, page, pageSize: 1 }
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const views: ReturnType<typeof mount>[] = []
afterEach(() => { views.splice(0).forEach(view => view.unmount()); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function setup(query: Record<string, string> = {}, narrow = false) {
  const requests: { query: Record<string, string | number | undefined>; result: ReturnType<typeof deferred<CurrentQualifiedResult>> }[] = []
  vi.spyOn(window, 'matchMedia').mockImplementation(media => ({ matches: narrow && media === '(max-width: 639px)', media, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() }))
  vi.stubGlobal('$fetch', vi.fn((url: string, options?: { query: Record<string, string | number | undefined> }) => {
    if (url === '/api/roster/exports/current/capabilities') return Promise.resolve({ exports: [] })
    if (url === '/api/task-center') return Promise.resolve({ authorized: false })
    if (url !== '/api/roster/current-enterprises' || !options) throw new Error('Unexpected UI transport request')
    const result = deferred<CurrentQualifiedResult>(); requests.push({ query: { ...options.query }, result }); return result.promise
  }))
  vi.stubGlobal('useRoute', useRoute); vi.stubGlobal('useRouter', useRouter); vi.stubGlobal('useHead', () => {})
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/current-enterprises', component: Page }, { path: '/enterprises/:id', component: { template: '<p>详情</p>' } }] })
  await router.push({ path: '/current-enterprises', query: { titleCode: 'innovative_sme', q: 'synthetic_408', page: '2', pageSize: '1', ...query } })
  const view = mount(Page, { global: { plugins: [router, createPinia(), PiniaColada], components: { NuxtLink: RouterLink } } })
  views.push(view); await flushPromises()
  return { view, router, requests }
}
const pendingRegion = '[aria-label="已公布待核企业"]'

it('published_pending_region_after_legacy_guards_408', async () => {
  const { view, requests } = await setup()
  expect(view.find(pendingRegion).exists()).toBe(false)
  expect(view.text()).not.toContain('共 0')
  requests[0]!.result.resolve(wire()); await flushPromises()
  // Legacy guards must reach PASS before the new-region business RED.
  expect(view.text()).toContain('synthetic_408_有效')
  expect(view.text()).toContain('共 3 家企业')
  expect(view.text()).toContain('搜索：synthetic_408')
  expect(view.text()).toContain('第 2 页，每页 1 家')
  expect(requests[0]!.query).toMatchObject({ titleCode: 'innovative_sme', q: 'synthetic_408', page: 2, pageSize: 1 })
  expect(view.findAllComponents(TablePagination)[0]!.props('total')).toBe(3)
  // First intended failure: current page has no published-pending region.
  expect(view.find(pendingRegion).exists()).toBe(true)
  expect(view.get(pendingRegion).text()).toContain('synthetic_408_公布待核')
  expect(view.get(pendingRegion).text()).toContain('复核结论')
  expect(view.get(pendingRegion).text()).not.toContain('已确认有效')
})

it.each<{ id: string; match: CurrentFilterMatch; message: string; query: Record<string, string> }>([
  { id: 'matched', query: {}, match: { status: 'matched', checks: [] }, message: '符合已选筛选' },
  { id: 'not_matched', query: { recognitionFrom: '2025-01-01', recognitionTo: '2025-12-31' }, match: { status: 'not_matched', checks: [{ field: 'recognitionRange', status: 'not_matched' }] }, message: '不符合已选筛选' },
  { id: 'not_established', query: { validYear: '2028' }, match: { status: 'not_established', checks: [{ field: 'validYear', status: 'not_established' }] }, message: '尚不能确认满足已选筛选' },
])('pending_filter_explanation_is_not_qualification_408_$id', async ({ match, message, query }) => {
  const { view, requests } = await setup(query)
  requests[0]!.result.resolve(wire({ eligible: false, total: 0, match })); await flushPromises()
  const section = view.get(pendingRegion)
  expect(section.text()).toContain('synthetic_408_公布待核')
  expect(section.text()).toContain(message)
  expect(section.text()).toContain('复核结论')
  expect(section.text()).not.toContain('已确认有效')
})

it('unrequested_pending_is_not_a_zero_published_census_408', async () => {
  const { view, requests } = await setup({ q: '' })
  requests[0]!.result.resolve(wire({ requested: false, pending: false, pendingTotal: 0 })); await flushPromises()
  expect(view.find(pendingRegion).exists()).toBe(false)
  expect(view.text()).not.toContain('没有正式公布')
  expect(view.text()).not.toContain('待核企业共 0')
  expect(view.text()).toContain('synthetic_408_有效')
})

it('initial_failure_and_settled_empty_are_distinct_408', async () => {
  const { view, requests } = await setup()
  expect(view.findAllComponents(TablePagination)).toHaveLength(0)
  requests[0]!.result.reject(new Error('synthetic initial unavailable')); await flushPromises()
  expect(view.text()).toContain('当前有效企业查询失败')
  expect(view.text()).not.toContain('共 0')
  await view.findAll('button').find(button => button.text().includes('重新加载'))!.trigger('click'); await flushPromises()
  requests.at(-1)!.result.resolve(wire({ eligible: false, pending: false, total: 0, pendingTotal: 0 })); await flushPromises()
  expect(view.text()).toContain('共 0 家企业')
  expect(view.text()).toContain('没有符合条件的当前有效企业')
})

it.each([false, true])('both_groups_retain_request_through_loading_failure_retry_and_late_response_408_%s', async narrow => {
  const q = 'synthetic_408_完整搜索条件与已确认曾用名'.repeat(2)
  const source = { q, district: '鄞州区', recognitionFrom: '2025-01-01', recognitionTo: '2025-12-31', sort: 'name_desc', page: '2', pageSize: '1' }
  const { view, router, requests } = await setup(source, narrow)
  requests[0]!.result.resolve(wire()); await flushPromises()
  await router.replace({ path: '/current-enterprises', query: { titleCode: 'innovative_sme', q: 'synthetic_408_slow' } }); await flushPromises()
  const slow = requests.at(-1)!
  expect(view.text()).toContain('synthetic_408_有效')
  expect(view.get(pendingRegion).text()).toContain('synthetic_408_公布待核')
  expect(view.findAllComponents(TablePagination).every(pager => pager.props('loading'))).toBe(true)
  await router.replace({ path: '/current-enterprises', query: { titleCode: 'specialized_sme', q: 'synthetic_408_failed', validYear: '2028', maintenanceYear: '2024', maintenanceBatch: '2' } }); await flushPromises()
  requests.at(-1)!.result.reject(new Error('synthetic failed target')); await flushPromises()
  expect(view.text()).toContain(q)
  expect(view.text()).toContain('2025-01-01 至 2025-12-31')
  expect(view.text()).toContain('第 2 页')
  expect(view.text()).toContain('synthetic_408_failed')
  const href = view.get(pendingRegion).findAll('a').find(link => link.attributes('href')?.includes('/enterprises/802'))!.attributes('href')!
  const back = new URL(href, 'http://localhost').searchParams.get('currentBack')!
  expect(Object.fromEntries(new URLSearchParams(back))).toEqual({ titleCode: 'innovative_sme', ...source })
  await view.findAll('button').find(button => button.text().includes('重新加载'))!.trigger('click'); await flushPromises()
  requests.at(-1)!.result.resolve(wire({ titleCode: 'specialized_sme', page: 1, eligible: false, total: 0, suffix: '_retried', match: { status: 'not_established', checks: [{ field: 'validYear', status: 'not_established' }, { field: 'maintenanceYear', status: 'not_established' }, { field: 'maintenanceBatch', status: 'not_established' }] } })); await flushPromises()
  expect(view.get(pendingRegion).text()).toContain('synthetic_408_公布待核_retried')
  await router.replace({ path: '/current-enterprises', query: { titleCode: 'innovative_sme', q: 'synthetic_408_new', page: '2', pageSize: '1' } }); await flushPromises()
  requests.at(-1)!.result.resolve(wire({ suffix: '_new' })); await flushPromises()
  slow.result.resolve(wire({ suffix: '_late' })); await flushPromises()
  expect(view.text()).toContain('synthetic_408_有效_new')
  expect(view.get(pendingRegion).text()).toContain('synthetic_408_公布待核_new')
  expect(view.text()).not.toContain('_late')
  expect(view.findAllComponents(TablePagination).map(pager => pager.props('total'))).toEqual([3, 5])
})

it('each_group_pages_its_own_total_using_the_shared_request_408', async () => {
  const { view, router, requests } = await setup()
  requests[0]!.result.resolve(wire()); await flushPromises()
  const pagers = view.findAllComponents(TablePagination)
  expect(pagers).toHaveLength(2)
  expect(pagers.map(pager => [pager.props('page'), pager.props('pageSize'), pager.props('total')])).toEqual([[2, 1, 3], [2, 1, 5]])
  pagers[1]!.vm.$emit('update:page', 4); await flushPromises()
  expect(router.currentRoute.value.query.page).toBe('4')
  expect(requests.at(-1)!.query.page).toBe(4)
  expect(view.findAllComponents(TablePagination).every(pager => pager.props('loading'))).toBe(true)
  requests.at(-1)!.result.resolve(wire({ page: 4, eligible: false })); await flushPromises()
  expect(view.findAllComponents(TablePagination).map(pager => pager.props('total'))).toEqual([3, 5])
})

it('legacy_response_keeps_eligible_and_marks_pending_unknown_408', async () => {
  const { view, requests } = await setup()
  const legacy = wire({ suffix: '_legacy', pending: false, pendingTotal: 0 })
  // Model only the additive legacy-wire absence; keep every qualification field.
  Reflect.deleteProperty(legacy, 'responseVersion')
  Reflect.deleteProperty(legacy, 'publishedPending')
  expect(Object.hasOwn(legacy, 'responseVersion')).toBe(false)
  expect(Object.hasOwn(legacy, 'publishedPending')).toBe(false)
  expect(legacy.rows[0]!.qualificationAssessment.titles.map(title => title.titleCode)).toEqual(['little_giant', 'specialized_sme', 'innovative_sme'])
  requests[0]!.result.resolve(legacy); await flushPromises()
  expect(view.text()).toContain('synthetic_408_有效_legacy')
  expect(view.text()).toContain('共 3 家企业')
  expect(view.text()).toContain('搜索：synthetic_408')
  expect(view.text()).toContain('第 2 页，每页 1 家')
  expect(view.findAllComponents(TablePagination)).toHaveLength(1)
  expect(view.findComponent(TablePagination).props()).toMatchObject({ page: 2, pageSize: 1, total: 3, loading: false })
  expect(view.find(pendingRegion).exists()).toBe(false)
  expect(view.text()).toContain('本次响应未提供公布待核查询信息')
  expect(view.text()).toContain('不能据此判断是否存在已公布待核企业')
  expect(view.text()).not.toContain('待核企业共 0')
  expect(view.text()).not.toContain('没有正式公布')
  expect(view.text()).not.toContain('总量为零')
})

it('pending_names_unavailable_retains_both_groups_request_and_retry_408', async () => {
  const source = { q: 'synthetic_408_public_names_source'.repeat(3), district: '鄞州区', recognitionFrom: '2025-01-01', recognitionTo: '2025-12-31', sort: 'name_desc', page: '2', pageSize: '1' }
  const { view, router, requests } = await setup(source)
  requests[0]!.result.resolve(wire({ suffix: '_source', match: { status: 'not_established', checks: [{ field: 'recognitionRange', status: 'not_established' }] } })); await flushPromises()
  const expectBack = (id: number, query: Record<string, string>) => {
    const links = view.findAll('a').filter(link => link.attributes('href')?.startsWith(`/enterprises/${id}?`))
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) {
      const back = new URL(link.attributes('href')!, 'http://localhost').searchParams.get('currentBack')!
      expect(Object.fromEntries(new URLSearchParams(back))).toEqual(query)
    }
  }
  expect(view.text()).toContain('synthetic_408_有效_source')
  expect(view.get(pendingRegion).text()).toContain('synthetic_408_公布待核_source')
  expectBack(801, { titleCode: 'innovative_sme', ...source })
  expectBack(802, { titleCode: 'innovative_sme', ...source })

  const target = { titleCode: 'specialized_sme', q: 'synthetic_408_public_names_target', district: '鄞州区', sort: 'name_asc', page: '1', pageSize: '1' }
  await router.replace({ path: '/current-enterprises', query: target }); await flushPromises()
  const failedRequest = requests.at(-1)!
  expect(failedRequest.query).toMatchObject({ titleCode: 'specialized_sme', q: target.q, district: '鄞州区', sort: 'name_asc', page: 1, pageSize: 1 })
  expect(view.findAllComponents(TablePagination).every(pager => pager.props('loading'))).toBe(true)
  const unavailable = wire({ titleCode: 'specialized_sme', page: 1, suffix: '_rejected_dto', total: 7, pendingTotal: 11 })
  unavailable.publishedPending.rows[0]!.publishedPresentation = { availability: 'unavailable', error: 'read_failed', facts: [] }
  // Fulfil transport successfully: the real page's pending-name guard must fail.
  failedRequest.result.resolve(unavailable); await flushPromises()
  expect(view.text()).toContain('当前有效企业查询失败')
  expect(view.text()).toContain('synthetic_408_有效_source')
  expect(view.get(pendingRegion).text()).toContain('synthetic_408_公布待核_source')
  expect(view.text()).toContain(source.q)
  expect(view.text()).toContain('2025-01-01 至 2025-12-31')
  expect(view.text()).toContain(target.q)
  expect(view.text()).toContain('第 2 页，每页 1 家')
  expect(view.text()).not.toContain('synthetic_408_有效_rejected_dto')
  expect(view.text()).not.toContain('synthetic_408_公布待核_rejected_dto')
  expect(view.findAllComponents(TablePagination).map(pager => [pager.props('page'), pager.props('pageSize'), pager.props('total'), pager.props('loading')])).toEqual([[2, 1, 3, true], [2, 1, 5, true]])
  expectBack(801, { titleCode: 'innovative_sme', ...source })
  expectBack(802, { titleCode: 'innovative_sme', ...source })

  await view.findAll('button').find(button => button.text().includes('重新加载'))!.trigger('click'); await flushPromises()
  expect(requests).toHaveLength(3)
  expect(requests.at(-1)!.query).toEqual(failedRequest.query)
  requests.at(-1)!.result.resolve(wire({ titleCode: 'specialized_sme', page: 1, suffix: '_recovered', total: 7, pendingTotal: 11 })); await flushPromises()
  expect(view.text()).not.toContain('当前有效企业查询失败')
  expect(view.text()).not.toContain('synthetic_408_有效_source')
  expect(view.text()).not.toContain('synthetic_408_公布待核_source')
  expect(view.text()).toContain('synthetic_408_有效_recovered')
  expect(view.get(pendingRegion).text()).toContain('synthetic_408_公布待核_recovered')
  expect(view.text()).not.toContain('synthetic_408_有效_rejected_dto')
  expect(view.text()).not.toContain('synthetic_408_公布待核_rejected_dto')
  expect(view.findAllComponents(TablePagination).map(pager => [pager.props('page'), pager.props('pageSize'), pager.props('total'), pager.props('loading')])).toEqual([[1, 1, 7, false], [1, 1, 11, false]])
  expectBack(801, target)
  expectBack(802, target)
})
