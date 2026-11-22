// @vitest-environment jsdom
import { createHash } from 'node:crypto'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { createPinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import { createMemoryHistory, createRouter, RouterLink, useRoute, useRouter } from 'vue-router'
import Page from '../../../layers/sme-roster/app/pages/current-enterprises.vue'
import TablePagination from '../../../layers/core/app/components/TablePagination.vue'
import type { CurrentTitle } from '../../../layers/sme-roster/lib/roster/current-titles'
import type { CurrentQualificationAssessment, CurrentQualificationSnapshot } from '../../../layers/sme-roster/lib/roster/current-qualification-model'
import { Select } from '../../../layers/core/app/components/ui/select'
import type { CurrentStatus } from '../../../layers/sme-roster/lib/roster/current-status'
import type { CurrentQualifiedResult, CurrentQualifiedRow } from '../../../layers/sme-roster/lib/roster/current-qualified-page'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const asOf = '2026-06-01T00:00:00.000Z'
// Independent wire literals, not DB/reader-generated expected qualification.
function snapshot(id: number, pending: boolean, selectedTitle: CurrentTitle = 'innovative_sme'): CurrentQualificationSnapshot {
  const titles: CurrentQualificationAssessment[] = (['little_giant', 'specialized_sme', 'innovative_sme'] as const).map((titleCode): CurrentQualificationAssessment => {
    const selected = titleCode === selectedTitle
    const group = selected && !pending ? 'eligible' : 'excluded'
    const eventId = id + 1000, evidenceId = id + 2000
    const evidence: CurrentQualificationAssessment['evidence'] = selected ? [{ eventId, revision: 1, eventType: pending ? 'review' : 'award', year: pending ? 2022 : 2025, batchSeq: 1, decidedYear: pending ? null : 2025, reviewOutcome: null, evidenceIds: [evidenceId] }] : []
    const sourceVersions: CurrentQualificationAssessment['sourceVersions'] = selected ? [{ evidenceId, eventId, sourceFile: 'synthetic/ui408/formal.pdf', storedFileId: 71, sha256: digest('synthetic ui formal bytes'), bytes: 25, removedAt: null, capturedRevision: 1, capturedSha256: digest('synthetic ui row') }] : []
    return {
      titleCode, group, cycles: selected && !pending ? [{ originYear: 2025, batchSeq: 1, precision: 'year' }] : [],
      effectiveQualification: { status: selected && !pending ? 'effective' : 'unrecognized', basis: selected ? '合成正式公布' : '', notes: [] },
      versions: { facts: digest([id, evidence]), sources: digest(sourceVersions), decisions: digest([]), observations: digest([]) },
      officialQualification: { group, message: selected ? pending ? '缺少认定事实，复核事实保留' : '正式资格当前有效' : '尚无本称号正式依据', basis: selected ? '合成正式公布' : '', notes: [] },
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
  const scope = { enterpriseId: id, asOf, ruleVersion: 'current-roster-116-v11', assessmentVersion: 'enterprise-qualification-687-v4' }
  return { ...scope, titles, snapshotId: digest([scope, titles]) }
}
function row(id: number, name: string, pending: boolean, selectedTitle: CurrentTitle = 'innovative_sme'): CurrentQualifiedRow {
  return { enterpriseId: id, name, uscc: null, district: '鄞州区', publishedNames: [name], aliases: [], firstYear: pending ? 2022 : 2025,
    basis: 'synthetic formal basis', reviews: pending ? '复核结论未知' : '', publication: '已见本称号宁波公布记录', notes: [], references: [], group: pending ? 'excluded' : 'eligible',
    recognition: pending ? null : { precision: 'year', year: 2025 }, qualificationWitnesses: pending ? [] : [{ cycle: { originYear: 2025, batchSeq: 1 }, awardEventId: id + 1000, recognition: { precision: 'year', year: 2025 }, matchedValidYear: null, matchedMaintenance: null, correspondenceId: null, conditionQueryId: null }], matchedValidYears: [], matchedMaintenance: [],
    publishedPresentation: { availability: 'available', error: null, facts: [{ evidenceId: id + 2000, eventId: id + 1000, revision: 1, availability: 'captured', nameRaw: name, sourceBindingKnown: true }] }, qualificationAssessment: snapshot(id, pending, selectedTitle) }
}
// Five-state responses have one rowset. Each fixture is literal wire data;
// qualification readers and presentation helpers never supply the oracle.
function wire(options: { titleCode?: CurrentTitle; status?: CurrentStatus; empty?: boolean; page?: number; total?: number; suffix?: string } = {}): CurrentQualifiedResult {
  const titleCode = options.titleCode ?? 'innovative_sme', status = options.status ?? 'effective'
  const item = row(801, 'synthetic_408_' + status + (options.suffix ?? ''), false, titleCode)
  const selected = item.qualificationAssessment.titles.find(title => title.titleCode === titleCode)!
  selected.effectiveQualification = { status, basis: '合成正式依据', notes: [] }
  selected.group = item.group = status === 'effective' ? 'eligible' : 'excluded'
  if (status === 'terminated') selected.subject = { status: 'terminated', message: '已确认主体注销', decisionIds: [91] }
  if (status === 'moved_out') selected.region = { status: 'outside_ningbo', message: '已确认迁出宁波', decisionIds: [92] }
  if (status === 'expired') {
    selected.evidence[0] = { ...selected.evidence[0]!, year: 2020, decidedYear: 2020 }
    selected.cycles = [{ originYear: 2020, batchSeq: 1, precision: 'year' }]
    item.firstYear = 2020
  }
  if (status !== 'effective') { item.qualificationWitnesses = []; item.recognition = null }
  if (status === 'expired' || status === 'unrecognized') selected.officialQualification = { group: 'excluded', message: '本称号未纳入当前有效资格', basis: '合成正式依据', notes: [] }
  if (status === 'unrecognized') { selected.evidence = []; selected.cycles = []; item.qualificationWitnesses = []; item.recognition = null }
  selected.versions.facts = digest([item.enterpriseId, selected.evidence])
  const { snapshotId: _, titles, ...scope } = item.qualificationAssessment
  item.qualificationAssessment.snapshotId = digest([scope, titles])
  const page = options.page ?? 2
  return { responseVersion: 'current-qualified-478-v2', titleCode, ruleVersion: 'current-roster-116-v11', snapshotStartedAt: asOf,
    rows: options.empty ? [] : [item], total: options.total ?? 3, uncertainTotal: 0,
    publishedPending: { requested: false, rows: [], total: 0, page, pageSize: 1 },
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
function expectBack(view: ReturnType<typeof mount>, query: Record<string, string>) {
  const links = view.findAll('a').filter(link => link.attributes('href')?.startsWith('/enterprises/801?'))
  expect(links).toHaveLength(2)
  for (const link of links) {
    const back = new URL(link.attributes('href')!, 'http://localhost').searchParams.get('currentBack')!
    expect(Object.fromEntries(new URLSearchParams(back))).toEqual(query)
  }
}
const states: { id: CurrentStatus; label: string; timeline: string[] }[] = [
  { id: 'effective', label: '有效企业', timeline: ['2025 认定'] },
  { id: 'expired', label: '已到期', timeline: ['2020 认定'] },
  { id: 'terminated', label: '已注销（吊销）', timeline: ['2025 认定'] },
  { id: 'moved_out', label: '已迁出', timeline: ['2025 认定'] },
  { id: 'unrecognized', label: '未认定', timeline: [] },
]

it.each(states)("single_table_status_and_timeline_$id", async ({ id, label, timeline }) => {
  const { view, router, requests } = await setup()
  expect(view.findAllComponents(TablePagination)).toHaveLength(0)
  expect(view.text()).not.toContain('共 0')
  // Exercise the actual select model: changing state resets page, preserving search.
  view.findAllComponents(Select).find(select => select.find('[aria-label="按有效状态筛选"]').exists())!.vm.$emit('update:modelValue', id)
  await flushPromises()
  expect(router.currentRoute.value.query).toEqual({ titleCode: 'innovative_sme', status: id, q: 'synthetic_408', pageSize: '1' })
  expect(requests.at(-1)!.query).toMatchObject({ titleCode: 'innovative_sme', status: id, q: 'synthetic_408', page: 1, pageSize: 1 })
  const response = wire({ status: id, page: 1 }), before = JSON.stringify(response)
  requests.at(-1)!.result.resolve(response); await flushPromises()
  expect(view.findAll('table')).toHaveLength(1)
  expect(view.findAll('tbody tr')).toHaveLength(1)
  expect(view.get('tbody tr').text()).toContain('synthetic_408_' + id)
  expect(view.get('[data-testid="current-enterprise-card"]').text()).toContain('synthetic_408_' + id)
  expect(view.get('[aria-label="按有效状态筛选"]').text()).toContain(id === 'effective' ? '有效' : label)
  expect(view.find('ul[aria-label="企业资格查询结果"]').exists()).toBe(true)
  expect(view.find('p[aria-live="polite"]').exists()).toBe(false)
  expect(view.find('[aria-label="已公布待核企业"]').exists()).toBe(false)
  const surfaces = [view.get('tbody tr'), view.get('[data-testid="current-enterprise-card"]')]
  for (const surface of surfaces) {
    expect(surface.findAll('ol li').map(step => step.text().replace(/^→/, '').trim())).toEqual(timeline)
    if (!timeline.length) expect(surface.text()).toContain('暂无认定与复核记录')
  }
  expect(view.findComponent(TablePagination).props()).toMatchObject({ page: 1, pageSize: 1, total: 3, loading: false })
  expectBack(view, { titleCode: 'innovative_sme', status: id, q: 'synthetic_408', sort: 'id_asc', page: '1', pageSize: '1' })
  expect(JSON.stringify(response)).toBe(before)
})

it('keeps the full search label in its removable chip and resets a non-default status separately', async () => {
  const search = '合成企业长名称'.repeat(18)
  const { view, router, requests } = await setup({ q: search, status: 'expired' }, true)
  expect(view.get('[aria-live="polite"]').text()).toBe('正在查询企业资格…')
  const chips = view.get('[aria-label="已选筛选条件"]')
  expect(chips.find('button[aria-label$="状态：已到期"]').exists()).toBe(true)
  expect(chips.find(`button[aria-label$="搜索：${search}"]`).exists()).toBe(true)
  expect(chips.text()).toContain(search)
  await chips.get('button[aria-label$="状态：已到期"]').trigger('click')
  await flushPromises()
  expect(router.currentRoute.value.query).toMatchObject({ q: search })
  expect(requests.at(-1)!.query.status).toBe('effective')
  expect(chips.find('button[aria-label$="状态：已到期"]').exists()).toBe(false)
})

it("initial_failure_and_settled_empty_are_distinct", async () => {
  const { view, requests } = await setup()
  expect(requests[0]!.query.status).toBe('effective')
  expect(view.findAllComponents(TablePagination)).toHaveLength(0)
  requests[0]!.result.reject(new Error('synthetic initial unavailable')); await flushPromises()
  expect(view.text()).toContain('企业资格查询失败')
  expect(view.text()).not.toContain('共 0')
  await view.findAll('button').find(button => button.text().includes('重新加载'))!.trigger('click'); await flushPromises()
  expect(requests.at(-1)!.query).toEqual(requests[0]!.query)
  requests.at(-1)!.result.resolve(wire({ empty: true, total: 0 })); await flushPromises()
  expect(view.findAll('[data-slot="empty-title"]').map(title => title.text())).toEqual(['没有符合条件的企业', '没有符合条件的企业'])
  expect(view.findComponent(TablePagination).props()).toMatchObject({ page: 2, pageSize: 1, total: 0, loading: false })
  expect(view.get('[data-testid="table-total"]').text()).toBe('共 0 家')
})

it("effective_row_with_review_gaps_keeps_unknown_timeline_facts_without_pending_region", async () => {
  const { view, requests } = await setup()
  const response = wire()
  const selected = response.rows[0]!.qualificationAssessment.titles.find(title => title.titleCode === 'innovative_sme')!
  selected.evidence.push({ eventId: 9002, revision: 1, eventType: 'review', year: 2022, decidedYear: null, batchSeq: 1, reviewOutcome: null, evidenceIds: [2002] })
  selected.completeness = { ...selected.completeness, status: 'incomplete', gaps: ['missing_cycle_semantics'], eventIds: [9002], fieldGaps: [
    { eventId: 9002, field: 'decidedYear', valueState: 'unknown', inputState: 'null' },
    { eventId: 9002, field: 'reviewOutcome', valueState: 'unknown', inputState: 'null' },
  ] }
  selected.versions.facts = digest([801, selected.evidence])
  const { snapshotId: _, titles, ...scope } = response.rows[0]!.qualificationAssessment
  response.rows[0]!.qualificationAssessment.snapshotId = digest([scope, titles])
  const before = JSON.stringify(response)
  requests[0]!.result.resolve(response); await flushPromises()
  expect(view.get('[aria-label="按有效状态筛选"]').text()).toContain('有效')
  for (const surface of [view.get('tbody tr'), view.get('[data-testid="current-enterprise-card"]')]) {
    expect(surface.findAll('ol li').map(step => step.text())).toEqual(['2025 认定', '→年份未记录 复核（结论待核）'])
    expect(surface.text()).not.toContain('2022 复核')
  }
  expect(view.find('[aria-label="已公布待核企业"]').exists()).toBe(false)
  expect(view.findAllComponents(TablePagination)).toHaveLength(1)
  expect(JSON.stringify(response)).toBe(before)
})

it.each([{ id: 'desktop', narrow: false }, { id: 'mobile', narrow: true }])("single_table_retains_scope_retry_and_ignores_late_response_$id", async ({ narrow }) => {
  const q = 'synthetic_408_完整搜索条件与已确认曾用名'.repeat(2)
  const source = { status: 'expired', q, district: '鄞州区', recognitionFrom: '2025-01-01', recognitionTo: '2025-12-31', sort: 'name_desc', page: '2', pageSize: '1' }
  const { view, router, requests } = await setup(source, narrow)
  requests[0]!.result.resolve(wire({ status: 'expired' })); await flushPromises()
  await router.replace({ path: '/current-enterprises', query: { titleCode: 'innovative_sme', status: 'moved_out', q: 'synthetic_408_slow' } }); await flushPromises()
  const slow = requests.at(-1)!
  expect(view.get('tbody tr').text()).toContain('synthetic_408_expired')
  expect(view.findComponent(TablePagination).props()).toMatchObject({ page: 2, pageSize: 1, total: 3, loading: true })
  const target = { titleCode: 'specialized_sme', status: 'terminated', q: 'synthetic_408_failed', validYear: '2028', maintenanceYear: '2024', maintenanceBatch: '2' }
  await router.replace({ path: '/current-enterprises', query: target }); await flushPromises()
  requests.at(-1)!.result.reject(new Error('synthetic failed target')); await flushPromises()
  expect(view.text()).toContain('企业资格查询失败')
  const description = view.get('[data-testid="table-failure-state"]').text()
  expect(description).toContain('创新型中小企业；已到期；搜索：' + q + '；区县：鄞州区；认定时间：2025-01-01 至 2025-12-31')
  expect(description).toContain('第 2 页，每页 1 家')
  expect(view.text()).toContain('请求目标：专精特新中小企业；已注销（吊销）；搜索：synthetic_408_failed；有效年份：2028；维护年份：2024 第 2 批')
  expectBack(view, { titleCode: 'innovative_sme', ...source })
  const requestCount = requests.length
  view.findComponent(TablePagination).vm.$emit('update:page', 3); await flushPromises()
  expect(requests).toHaveLength(requestCount)
  expect(router.currentRoute.value.query).toEqual(target)
  await view.findAll('button').find(button => button.text().includes('重新加载'))!.trigger('click'); await flushPromises()
  expect(requests.at(-1)!.query).toEqual(requests.at(-2)!.query)
  requests.at(-1)!.result.resolve(wire({ titleCode: 'specialized_sme', status: 'terminated', page: 1, suffix: '_retried' })); await flushPromises()
  expect(view.get('tbody tr').text()).toContain('synthetic_408_terminated_retried')
  expect(view.text()).not.toContain('企业资格查询失败')
  await router.replace({ path: '/current-enterprises', query: { titleCode: 'innovative_sme', status: 'effective', q: 'synthetic_408_new', page: '2', pageSize: '1' } }); await flushPromises()
  requests.at(-1)!.result.resolve(wire({ suffix: '_new' })); await flushPromises()
  slow.result.resolve(wire({ status: 'moved_out', suffix: '_late' })); await flushPromises()
  expect(view.get('tbody tr').text()).toContain('synthetic_408_effective_new')
  expect(view.text()).not.toContain('_late')
  expect(view.text()).not.toContain('_retried')
  expect(view.findComponent(TablePagination).props()).toMatchObject({ page: 2, pageSize: 1, total: 3, loading: false })
})

it("single_table_pages_selected_status_and_preserves_filters", async () => {
  const { view, router, requests } = await setup({ status: 'expired', district: '鄞州区', sort: 'name_desc' })
  requests[0]!.result.resolve(wire({ status: 'expired', total: 5 })); await flushPromises()
  expect(view.findAllComponents(TablePagination)).toHaveLength(1)
  expect(view.findComponent(TablePagination).props()).toMatchObject({ page: 2, pageSize: 1, total: 5 })
  view.findComponent(TablePagination).vm.$emit('update:page', 4); await flushPromises()
  expect(router.currentRoute.value.query).toEqual({ titleCode: 'innovative_sme', status: 'expired', q: 'synthetic_408', district: '鄞州区', sort: 'name_desc', page: '4', pageSize: '1' })
  expect(requests.at(-1)!.query).toMatchObject({ status: 'expired', district: '鄞州区', sort: 'name_desc', page: 4, pageSize: 1 })
  expect(view.findComponent(TablePagination).props('loading')).toBe(true)
  requests.at(-1)!.result.resolve(wire({ status: 'expired', page: 4, total: 5 })); await flushPromises()
  expect(view.findComponent(TablePagination).props()).toMatchObject({ page: 4, pageSize: 1, total: 5, loading: false })
  view.findComponent(TablePagination).vm.$emit('update:page-size', 2); await flushPromises()
  expect(requests.at(-1)!.query).toMatchObject({ status: 'expired', district: '鄞州区', sort: 'name_desc', page: 1, pageSize: 2 })
})

it("legacy_effective_response_preserves_rows_and_marks_five_states_unknown", async () => {
  const { view, requests } = await setup()
  const legacy = wire({ suffix: '_legacy' })
  Reflect.deleteProperty(legacy, 'responseVersion'); Reflect.deleteProperty(legacy, 'publishedPending')
  requests[0]!.result.resolve(legacy); await flushPromises()
  expect(view.get('tbody tr').text()).toContain('synthetic_408_effective_legacy')
  expect(view.findAllComponents(TablePagination)).toHaveLength(1)
  expect(view.findComponent(TablePagination).props()).toMatchObject({ page: 2, pageSize: 1, total: 3, loading: false })
  expect(view.findAll('[role="status"]').map(status => status.text())).toContain('旧版响应未提供五类有效状态；请刷新后核对，不能据此将资料缺口认作待核。')
  expect(view.find('[aria-label="已公布待核企业"]').exists()).toBe(false)
  expectBack(view, { titleCode: 'innovative_sme', status: 'effective', q: 'synthetic_408', sort: 'id_asc', page: '2', pageSize: '1' })
})

it("legacy_non_effective_response_is_rejected_and_modern_retry_recovers", async () => {
  const { view, requests } = await setup({ status: 'unrecognized' })
  const legacy = wire({ status: 'unrecognized' }); legacy.responseVersion = 'current-qualified-408-v1'
  requests[0]!.result.resolve(legacy); await flushPromises()
  expect(view.text()).toContain('企业资格查询失败')
  expect(view.findAll('tbody tr')).toHaveLength(0)
  expect(view.findAllComponents(TablePagination)).toHaveLength(0)
  expect(view.text()).not.toContain('共 0')
  await view.findAll('button').find(button => button.text().includes('重新加载'))!.trigger('click'); await flushPromises()
  expect(requests.at(-1)!.query).toEqual(requests[0]!.query)
  requests.at(-1)!.result.resolve(wire({ status: 'unrecognized' })); await flushPromises()
  expect(view.text()).not.toContain('企业资格查询失败')
  expect(view.get('tbody tr').text()).toContain('synthetic_408_unrecognized')
})

it.each([{ id: 'main_rows', pending: false }, { id: 'legacy_pending_wire', pending: true }])("unavailable_published_names_retain_scope_and_retry_$id", async ({ pending }) => {
  const source = { status: 'expired', q: 'synthetic_408_public_names_source'.repeat(3), district: '鄞州区', recognitionFrom: '2025-01-01', recognitionTo: '2025-12-31', sort: 'name_desc', page: '2', pageSize: '1' }
  const { view, router, requests } = await setup(source)
  requests[0]!.result.resolve(wire({ status: 'expired', suffix: '_source' })); await flushPromises()
  const target = { titleCode: 'specialized_sme', status: 'moved_out', q: 'synthetic_408_public_names_target', district: '鄞州区', sort: 'name_asc', page: '1', pageSize: '1' }
  await router.replace({ path: '/current-enterprises', query: target }); await flushPromises()
  const failedRequest = requests.at(-1)!
  const unavailable = wire({ titleCode: 'specialized_sme', status: 'moved_out', page: 1, suffix: '_rejected_dto', total: 7 })
  const bad = { ...row(802, 'synthetic_unavailable', true, 'specialized_sme'), publishedPresentation: { availability: 'unavailable' as const, error: 'read_failed' as const, facts: [] as [] } }
  if (pending) unavailable.publishedPending = { requested: true, rows: [{ ...bad, filterMatch: { status: 'not_established', checks: [] } }], total: 1, page: 1, pageSize: 1 }
  else unavailable.rows = [bad]
  failedRequest.result.resolve(unavailable); await flushPromises()
  expect(view.text()).toContain('企业资格查询失败')
  expect(view.get('tbody tr').text()).toContain('synthetic_408_expired_source')
  expect(view.text()).not.toContain('_rejected_dto')
  expect(view.text()).not.toContain('synthetic_unavailable')
  expect(view.findComponent(TablePagination).props()).toMatchObject({ page: 2, pageSize: 1, total: 3, loading: true })
  expectBack(view, { titleCode: 'innovative_sme', ...source })
  await view.findAll('button').find(button => button.text().includes('重新加载'))!.trigger('click'); await flushPromises()
  expect(requests).toHaveLength(3)
  expect(requests.at(-1)!.query).toEqual(failedRequest.query)
  requests.at(-1)!.result.resolve(wire({ titleCode: 'specialized_sme', status: 'moved_out', page: 1, suffix: '_recovered', total: 7 })); await flushPromises()
  expect(view.text()).not.toContain('企业资格查询失败')
  expect(view.get('tbody tr').text()).toContain('synthetic_408_moved_out_recovered')
  expect(view.text()).not.toContain('_source')
  expect(view.findComponent(TablePagination).props()).toMatchObject({ page: 1, pageSize: 1, total: 7, loading: false })
  expectBack(view, target)
})

it.each([{ id: 'little_giant', label: '专精特新“小巨人”' }, { id: 'specialized_sme', label: '专精特新中小企业' }, { id: 'innovative_sme', label: '创新型中小企业' }] as const)("timeline_uses_displayed_title_without_cross_title_facts_$id", async ({ id, label }) => {
  const { view, requests } = await setup({ titleCode: id })
  const response = wire({ titleCode: id })
  const titles = response.rows[0]!.qualificationAssessment.titles
  for (const title of titles) title.evidence = title.titleCode === id
    ? [{ eventId: 9001, revision: 1, eventType: 'review', year: 2021, decidedYear: 2024, batchSeq: 1, reviewOutcome: 'passed', evidenceIds: [2001] }, { eventId: 9000, revision: 1, eventType: 'award', year: 2021, decidedYear: 2021, batchSeq: 1, reviewOutcome: null, evidenceIds: [2000] }]
    : [{ eventId: 9999, revision: 1, eventType: 'award', year: 1999, decidedYear: 1999, batchSeq: 1, reviewOutcome: null, evidenceIds: [2999] }]
  for (const title of titles) {
    title.cycles = [{ originYear: title.titleCode === id ? 2021 : 1999, batchSeq: 1, precision: 'year' }]
    if (title.titleCode !== id) title.effectiveQualification = { status: 'expired', basis: '合成其它称号历史认定', notes: [] }
    title.versions.facts = digest([801, title.evidence])
  }
  const { snapshotId: _, titles: sealedTitles, ...scope } = response.rows[0]!.qualificationAssessment
  response.rows[0]!.qualificationAssessment.snapshotId = digest([scope, sealedTitles])
  const before = JSON.stringify(response)
  requests[0]!.result.resolve(response); await flushPromises()
  expect(view.findAll('[role="tab"]').find(tab => tab.attributes('aria-selected') === 'true')!.text()).toContain(label)
  for (const surface of [view.get('tbody tr'), view.get('[data-testid="current-enterprise-card"]')]) {
    expect(surface.findAll('ol li').map(step => step.text())).toEqual(['2021 认定', '→2024 复核'])
    expect(surface.text()).not.toContain('1999')
  }
  expect(JSON.stringify(response)).toBe(before)
})

// Probe the real page/router lifecycle, including the 300ms search debounce.
it.each([false, true])('route_search_sync_does_not_navigate_after_unmount_narrow_%s', async narrow => {
  const { view, router } = await setup({}, narrow)
  const push = vi.spyOn(router, 'push')
  await router.replace({ path: '/current-enterprises', query: { q: 'synthetic_unmount' } })
  await flushPromises()
  view.unmount()
  views.splice(views.indexOf(view), 1)
  await new Promise(resolve => setTimeout(resolve, 350))
  expect(push).not.toHaveBeenCalled()
})

it('mounted_search_debounces_and_preserves_scope_then_cancels_pending_input_on_unmount', async () => {
  const { view, router } = await setup({ status: 'expired', district: '鄞州区' })
  const push = vi.spyOn(router, 'push')
  const search = view.get('input[aria-label="搜索企业名称、已确认曾用名或统一社会信用代码"]')
  await search.setValue('  synthetic_search  ')
  expect(push).not.toHaveBeenCalled()
  await new Promise(resolve => setTimeout(resolve, 350))
  await flushPromises()
  expect(router.currentRoute.value.query).toEqual({ titleCode: 'innovative_sme', status: 'expired', district: '鄞州区', q: 'synthetic_search', pageSize: '1' })
  expect(push).toHaveBeenCalledTimes(1)
  await search.setValue('synthetic_pending_input')
  view.unmount()
  views.splice(views.indexOf(view), 1)
  await new Promise(resolve => setTimeout(resolve, 350))
  expect(push).toHaveBeenCalledTimes(1)
})
