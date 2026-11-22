// @vitest-environment jsdom
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, expect, it } from 'vitest'
import ComparisonBusinessGroups from '../../../layers/sme-roster/app/components/record-correspondence/ComparisonBusinessGroups.vue'
import ComparisonBusinessObservation from '../../../layers/sme-roster/app/components/record-correspondence/ComparisonBusinessObservation.vue'
import type { RecordComparisonResult } from '../../../layers/sme-roster/lib/roster/record-comparison-view'

const observations = [1076, 3161].map((id, index) => ({
  relation: { id, queryId: index ? 2788 : 557, interface: 'business_list', nameRaw: '合成企业', sequenceNo: 1, queriedAt: '2026-10-18T00:00:00Z', status: '终审通过', titleCode: 'specialized_sme' },
  linkState: index ? 'unlinked' : 'linked',
  correspondences: index ? [] : [{ id: 329, eventId: 3, status: 'confirmed', requiresRevalidation: true }],
  historicalDecisionUnavailable: [], currentSource: null,
  withoutOfficial: index ? { qualification: 'unresolved', reasons: ['official_source_completeness_not_persisted'] } : null,
}))
const groups = {
  rows: [{ key: 'canonical:1', firstRelationId: 1076, unknownObservations: [], recordId: 1, interface: 'business_list', platformKey: 'SQ1', groupState: 'resolved', observationCount: 2, linkState: 'mixed', resultState: 'mixed', versions: [{ versionId: 1, observationCount: 2, linkState: 'mixed', resultState: 'mixed', observations }] }],
  page: 1, pageSize: 1, total: 2, scope: { queryIds: [557, 2788], enterpriseId: null, titleCode: null, asOf: null, classificationApplied: false, countsBeforePagination: true },
} as unknown as RecordComparisonResult['businessGroups']
const counts: RecordComparisonResult['businessCounts'] = { records: 1, versions: 1, observations: 3, unknownObservations: 1, unknownContentObservations: 0, unknownIdentityObservations: 1, unknownByState: { not_indexed: 1, missing_key: 0, conflict: 0, unverifiable: 0 } }
const mounted: ReturnType<typeof mount>[] = []
afterEach(() => mounted.splice(0).forEach(wrapper => wrapper.unmount()))
function render() {
  const wrapper = mount(ComparisonBusinessGroups, { props: { groups, counts, loading: false, returnTo: '/comparison?mode=record' }, global: { stubs: {
    RosterSourceReader: { props: ['id', 'kind'], template: '<div data-testid="source">{{ kind }}:{{ id }}</div>' },
    Dialog: { props: ['open'], template: '<div v-if="open"><slot /></div>' },
    DialogContent: { template: '<div><slot /></div>' },
    DialogTitle: { template: '<h3><slot /></h3>' },
    DialogDescription: { template: '<p><slot /></p>' },
    TablePagination: { props: ['page', 'pageSize', 'total'], emits: ['update:page', 'update:pageSize'], template: '<div><button @click="$emit(\'update:page\', 2)">业务下一页</button><button @click="$emit(\'update:pageSize\', 50)">业务每页50</button></div>' },
  } } })
  mounted.push(wrapper)
  return wrapper
}
it.each([
  ['predecessorEventId', '前序正式事件 #11'],
  ['exportRowId', '平台导出行 #11'],
] as const)('shows the correspondence %s target on its own observation', (field, text) => {
  const observation = { ...observations[0], correspondences: [{ id: 329, eventId: null, [field]: 11, status: 'confirmed', requiresRevalidation: false }] } as unknown as RecordComparisonResult['businessGroups']['rows'][number]['unknownObservations'][number]
  const wrapper = mount(ComparisonBusinessObservation, { props: { observation } })
  mounted.push(wrapper)
  expect(wrapper.text()).toContain(text)
  expect(wrapper.text()).toContain('原对应 #329')
})

it('expands one business version into its own mixed observations and opens the exact original row', async () => {
  const wrapper = render()
  expect(wrapper.get('[aria-label="业务粒度计数"]').text()).toContain('1 条已知业务 · 1 个已知内容版本 · 3 次采集观察 · 1 次身份或内容未知观察')
  expect(wrapper.findAll('[data-testid="comparison-business-group"]')).toHaveLength(1)
  expect(wrapper.text()).toContain('观察结果混合')
  await wrapper.get('[data-testid="comparison-business-group"] [data-slot="accordion-trigger"]').trigger('click')
  await wrapper.get('[data-testid="comparison-business-version"] [data-slot="accordion-trigger"]').trigger('click')
  await flushPromises()
  const rows = wrapper.findAll('[data-testid="comparison-business-observation"]')
  expect(rows).toHaveLength(2)
  expect(rows[0]!.text()).toContain('原对应 #329 · 已确认 · 正式事件 #3 · 需要重新核验')
  expect(rows[1]!.text()).toContain('同组其他观察的决定不适用于本观察')
  expect(rows[1]!.text()).not.toContain('#329')
  await rows[1]!.get('button').trigger('click')
  expect(wrapper.get('[data-testid="source"]').text()).toBe('relation:3161')
})
it('emits independent business page and size changes and retains the loaded scope', async () => {
  const wrapper = render()
  await wrapper.findAll('button').find(button => button.text() === '业务下一页')!.trigger('click')
  await wrapper.findAll('button').find(button => button.text() === '业务每页50')!.trigger('click')
  expect(wrapper.emitted('update:page')).toEqual([[2]])
  expect(wrapper.emitted('update:pageSize')).toEqual([[50]])
  expect(groups.page).toBe(1)
  expect(wrapper.text()).toContain('不随正式事件分类或事件翻页变化')
})


it('shows known business unknown-content observations without creating a version node', async () => {
  const wrapper = render()
  await wrapper.setProps({ groups: { ...groups, rows: [{ ...groups.rows[0]!, versions: [], unknownObservations: observations as unknown as typeof groups.rows[number]['unknownObservations'] }] }, counts: { ...counts, records: 1, versions: 0, observations: 2, unknownObservations: 2, unknownContentObservations: 2, unknownIdentityObservations: 0, unknownByState: { not_indexed: 0, missing_key: 0, conflict: 0, unverifiable: 2 } } })
  await wrapper.get('[data-testid="comparison-business-group"] [data-slot="accordion-trigger"]').trigger('click')
  await flushPromises()
  expect(wrapper.findAll('[data-testid="comparison-business-version"]')).toHaveLength(0)
  expect(wrapper.get('[aria-label="内容版本未知的观察"]').text()).toContain('业务身份已知')
  expect(wrapper.findAll('[data-testid="comparison-business-observation"]')).toHaveLength(2)
  expect(wrapper.get('[aria-label="业务粒度计数"]').text()).toContain('1 条已知业务 · 0 个已知内容版本')
})
