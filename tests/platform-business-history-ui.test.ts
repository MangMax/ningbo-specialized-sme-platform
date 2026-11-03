// @vitest-environment happy-dom
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import PlatformRecords from '../components/PlatformRecords.vue'
import type { PlatformCorrespondenceRef } from '../lib/platform/business-record'

const nativeAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')
beforeAll(() => { Reflect.deleteProperty(Element.prototype, 'animate') })
afterAll(() => { if (nativeAnimate) Object.defineProperty(Element.prototype, 'animate', nativeAnimate) })
const queries = [1, 2, 3].map(id => ({ id, interface: 'business_list', queryKey: 'SYN246', rdjb: id === 2 ? '1' : '2', queriedAt: `2026-10-0${id}T00:00:00Z`, status: 'success', failureReason: null, relationCount: 1 }))
const relations = [1, 2, 3].map(id => ({ id: 100 + id, queryId: id, sequenceNo: 1, relationKey: 'SQ246', nameRaw: '平台原名', usccRaw: 'SYN246', province: '浙江', status: `状态${id}`, batch: '2025-1', declareKind: 'apply', appliedAt: null, awardBatchLabel: null, year: 2025, matchBasis: 'uscc', verificationStatus: id === 1 ? 'confirmed' : 'pending', rawFields: { id: 'SQ246', year: id === 2 ? '2024' : '2025', content: id === 2 ? '内容B' : '内容A' } }))
const metadata = (versionId: number | null = 1, groupState = 'verified') => ({ recordId: 1, versionId, interface: 'business_list', platformKey: 'SQ246', groupState, identityState: 'resolved', contentState: versionId ? 'verified' : 'unverifiable', keySource: 'both', projectionRuleVersion: 'v1', hashAlgorithm: versionId ? 'platform-row-json-v1' : null, contentHash: versionId ? `hash${versionId}` : null })
const refs = relations.map((r, index) => ({ relationId: r.id, queryId: r.queryId, queriedAt: queries[index]!.queriedAt, businessRecord: metadata(index === 1 ? 2 : 1), titleCode: index === 1 ? 'innovative_sme' : 'specialized_sme', enterpriseId: 1, usccRaw: 'SYN246', nameRaw: r.nameRaw, existingCorrespondenceIds: [], existingCorrespondences: [], conflicts: [] }))
const decision: PlatformCorrespondenceRef = { id: 329, relationId: 101, exportRowId: null, eventId: 200, predecessorEventId: null, enterpriseId: 1, titleCode: 'specialized_sme', type: 'event_process', role: 'context_only', status: 'confirmed', revision: 2, ruleId: 'manual', ruleVersion: 'old', createdAt: '2026-10-01', decidedAt: '2026-10-02', endedAt: null }
refs[0] = { ...refs[0]!, existingCorrespondenceIds: [329], existingCorrespondences: [decision] } as typeof refs[number]
const businessRecords = [{ businessRecord: metadata(), representativeRelationId: 103, observationRefs: refs, versions: [{ businessRecord: metadata(), representativeRelationId: 103, observationRefs: [refs[0], refs[2]] }, { businessRecord: metadata(2), representativeRelationId: 102, observationRefs: [refs[1]] }], versionCount: 2, observationCount: 3, existingCorrespondenceIds: [], existingCorrespondences: [], conflicts: ['title_conflict'] }]
const stubs = { NuxtLink: { props: ['to'], template: '<a :data-to="JSON.stringify(to)"><slot /></a>' } }
function view() { return mount(PlatformRecords, { attachTo: document.body, props: { queries, relations, businessRecords } as never, global: { stubs } }) }
const body = () => new DOMWrapper(document.body)

it('links the existing platform evidence row to the local business-process page by exact platformKey', () => {
  const wrapper = view()
  try {
    const link = wrapper.get('[data-testid="platform-relation"] a')
    expect(link.text()).toBe('本地办理记录')
    expect(JSON.parse(link.attributes('data-to')!)).toEqual({ path: '/platform-business-processes', query: { platformKey: 'SQ246' } })
  } finally { wrapper.unmount() }
})

it('one business expands all versions and observation times and opens the exact original source without nested dialogs', async () => {
  const fetch = vi.fn(async () => ({ source: { ...relations[0], nameRaw: '原观察1', query: queries[0] }, normalizationConflicts: [], correspondences: [], candidates: [], audit: [] }))
  vi.stubGlobal('$fetch', fetch)
  const wrapper = view()
  try {
    expect(wrapper.findAll('[data-testid="platform-relation"]')).toHaveLength(1)
    expect(wrapper.get('[data-record-kind="business_list"]').text()).toContain('1 条已知业务')
    expect(wrapper.get('[data-testid="platform-relation"]').text()).toContain('状态3')
    expect(wrapper.text()).toContain('2 个内容版本 · 3 次采集')
    expect(wrapper.text()).toContain('称号冲突')
    await wrapper.get('[data-testid="platform-business-history"] button[aria-expanded]').trigger('click')
    await flushPromises()
    const history = wrapper.get('[data-testid="platform-business-history"]')
    expect(history.findAll('[data-testid="platform-content-version"]')).toHaveLength(2)
    expect(history.findAll('[data-testid="platform-observation"]').map(row => row.attributes('data-relation-id')).sort()).toEqual(['101', '102', '103'])
    for (const q of queries) expect(history.text()).toContain(q.queriedAt.slice(0, 10))
    const observation = history.get('[data-relation-id="101"]')
    expect(observation.text()).toContain('对应 #329 · 已确认')
    expect(history.get('[data-relation-id="103"]').text()).toContain('此原行暂无对应决定')
    expect(history.get('[data-relation-id="102"]').text()).toContain('此原行暂无对应决定')
    await observation.get('[data-testid="platform-row-details-toggle"]').trigger('click'); await flushPromises()
    expect(body().get('[data-testid="platform-row-details"]').text()).toContain('内容A')
    await body().get('[data-testid="platform-row-details"] [data-slot="dialog-close"]').trigger('click'); await flushPromises()
    await observation.findAll('button').find(button => button.text() === '对应事件/出处')!.trigger('click'); await flushPromises()
    expect(fetch).toHaveBeenLastCalledWith('/api/roster/correspondences/relations/101')
    expect(body().findAll('[role="dialog"]')).toHaveLength(1)
    expect(body().get('[data-testid="platform-correspondence-dialog"]').text()).toContain('原观察1')
  } finally { wrapper.unmount(); vi.unstubAllGlobals() }
})

it('title and source filters select observations before grouping so older title versions remain reachable', async () => {
  const wrapper = view()
  try {
    await wrapper.findAll('[role="tab"]').find(tab => tab.text() === '创新型中小企业')!.trigger('keydown', { key: 'Enter' })
    expect(wrapper.findAll('[data-testid="platform-relation"]')).toHaveLength(1)
    expect(wrapper.get('[data-testid="platform-relation"]').attributes('data-record-id')).toBe('102')
    expect(wrapper.text()).toContain('1 个内容版本 · 1 次采集')
    expect(wrapper.text()).not.toContain('称号冲突')
    await wrapper.get('[data-testid="platform-business-history"] button[aria-expanded]').trigger('click'); await flushPromises()
    expect(wrapper.findAll('[data-testid="platform-observation"]').map(row => row.attributes('data-relation-id'))).toEqual(['102'])
    await wrapper.findAll('[role="tab"]').find(tab => tab.text() === '专精特新中小企业')!.trigger('keydown', { key: 'Enter' })
    expect(wrapper.text()).toContain('1 个内容版本 · 2 次采集')
    expect(wrapper.get('[data-testid="platform-relation"]').attributes('data-record-id')).toBe('103')
    await wrapper.get('[aria-label="记录来源"]').trigger('keydown', { key: 'ArrowDown' }); await flushPromises()
    await body().findAll('[role="option"]').find(option => option.text() === '申报记录')!.trigger('keydown', { key: 'Enter' }); await flushPromises()
    expect(wrapper.findAll('[data-testid="platform-relation"]')).toHaveLength(0)
    expect(wrapper.text()).toContain('尚未查询此来源 / 称号')
  } finally { wrapper.unmount() }
})

it.each([
  { state: 'not_indexed', label: '尚未建立业务映射' },
  { state: 'missing_key', label: '缺少平台业务编号' },
  { state: 'conflict', label: '平台编号冲突' },
])('unknown content stays independent without confirmed versions for $state', async ({ state, label }) => {
  const unknown = [refs[0]!, { ...refs[0]!, relationId: 104 }].map(o => ({ ...o, businessRecord: { ...metadata(null, state), recordId: null, identityState: state } }))
  const wrapper = mount(PlatformRecords, { props: { queries: [queries[0]], relations: [relations[0], { ...relations[0], id: 104 }], businessRecords: unknown.map(o => ({ ...businessRecords[0], observationRefs: [o], versions: [], versionCount: 0, observationCount: 1, conflicts: [] })) } as never })
  try {
    expect(wrapper.findAll('[data-testid="platform-relation"]')).toHaveLength(2)
    expect(wrapper.text()).toContain('0 个内容版本 · 1 次采集')
    await wrapper.findAll('[data-testid="platform-business-history"] button[aria-expanded]')[0]!.trigger('click'); await flushPromises()
    expect(wrapper.text()).toContain(label)
    expect(wrapper.findAll('[data-testid="platform-content-version"]')).toHaveLength(0)
    expect(wrapper.get('[data-testid="platform-observation"]').attributes('data-relation-id')).toBe('101')
  } finally { wrapper.unmount() }
})

it('identical platform keys in different interfaces remain separate and absent mappings retain original rows', () => {
  const apply = { ...relations[0]!, id: 104, queryId: 4 }
  const applyRef = { ...refs[0]!, relationId: 104, queryId: 4, businessRecord: { ...metadata(), interface: 'apply_list', recordId: 2 } }
  const wrapper = mount(PlatformRecords, { props: { queries: [...queries, { ...queries[0], id: 4, interface: 'apply_list' }], relations: [...relations, apply, { ...relations[0], id: 105 }, { ...relations[0], id: 106 }], businessRecords: [...businessRecords, { ...businessRecords[0], observationRefs: [applyRef] }] } as never })
  try {
    expect(wrapper.get('[data-record-kind="business_list"]').findAll('[data-testid="platform-relation"]').map(row => row.attributes('data-record-id'))).toEqual(['103', '105', '106'])
    expect(wrapper.get('[data-record-kind="apply_list"]').findAll('[data-testid="platform-relation"]').map(row => row.attributes('data-record-id'))).toEqual(['104'])
  } finally { wrapper.unmount() }
})

it('inferred apply title keeps every selected query provenance after business grouping', async () => {
  const applyQueries = [4, 5].map(id => ({ ...queries[0]!, id, interface: 'apply_list', rdjb: '' }))
  const applyRows = applyQueries.map(q => ({ ...relations[0]!, id: 100 + q.id, queryId: q.id }))
  const applyRefs = applyRows.map(r => ({ ...refs[0]!, relationId: r.id, queryId: r.queryId, titleCode: '', existingCorrespondenceIds: [], existingCorrespondences: [], businessRecord: { ...metadata(), recordId: 2, interface: 'apply_list' } }))
  const wrapper = mount(PlatformRecords, { props: { queries: [queries[0], queries[2], ...applyQueries], relations: [relations[0], relations[2], ...applyRows], businessRecords: [{ ...businessRecords[0], observationRefs: [refs[0], refs[2]] }, { ...businessRecords[0], observationRefs: applyRefs }] } as never })
  try {
    await wrapper.findAll('[role="tab"]').find(tab => tab.text() === '专精特新中小企业')!.trigger('keydown', { key: 'Enter' })
    const apply = wrapper.get('[data-record-kind="apply_list"]')
    expect(apply.findAll('[data-testid="platform-relation"]')).toHaveLength(1)
    expect(apply.text()).toContain('查询出处与历史 · 2 次')
    expect(apply.text()).toContain('不作为认定事实')
  } finally { wrapper.unmount() }
})

it('known identity with unknown raw stays one business and every unknown observation remains accessible without version nodes', async () => {
  const unknownRefs = refs.slice(0, 2).map(o => ({ ...o, businessRecord: metadata(null, 'unverifiable') }))
  const wrapper = mount(PlatformRecords, { props: { queries: queries.slice(0, 2), relations: relations.slice(0, 2), businessRecords: unknownRefs.map(o => ({ ...businessRecords[0], observationRefs: [o] })) } as never })
  try {
    expect(wrapper.findAll('[data-testid="platform-relation"]')).toHaveLength(1)
    expect(wrapper.text()).toContain('0 个内容版本 · 2 次采集')
    expect(wrapper.text()).toContain('2 次内容未核实')
    await wrapper.get('[data-testid="platform-business-history"] h4 button').trigger('click'); await flushPromises()
    expect(wrapper.findAll('[data-testid="platform-content-version"]')).toHaveLength(0)
    expect(wrapper.findAll('[data-testid="platform-observation"]').map(row => row.attributes('data-relation-id'))).toEqual(['101', '102'])
    expect(wrapper.text()).toContain('原文内容无法核实')
    await wrapper.findAll('[role="tab"]').find(tab => tab.text() === '专精特新中小企业')!.trigger('keydown', { key: 'Enter' })
    expect(wrapper.text()).toContain('0 个内容版本 · 1 次采集')
    expect(wrapper.text()).toContain('1 次内容未核实')
  } finally { wrapper.unmount() }
})

it('known versions and unknown raw observations coexist without assigning unknown content to a version', async () => {
  const unknown = { ...refs[1]!, businessRecord: metadata(null, 'unverifiable') }
  const wrapper = mount(PlatformRecords, { props: { queries, relations, businessRecords: [{ ...businessRecords[0], observationRefs: [refs[0], unknown, refs[2]] }] } as never })
  try {
    expect(wrapper.findAll('[data-testid="platform-relation"]')).toHaveLength(1)
    expect(wrapper.text()).toContain('1 个内容版本 · 3 次采集')
    expect(wrapper.text()).toContain('1 次内容未核实')
    await wrapper.get('[data-testid="platform-business-history"] h4 button').trigger('click'); await flushPromises()
    expect(wrapper.findAll('[data-testid="platform-content-version"]')).toHaveLength(1)
    expect(wrapper.get('[data-testid="platform-content-version"]').findAll('[data-testid="platform-observation"]').map(row => row.attributes('data-relation-id'))).toEqual(['101', '103'])
    expect(wrapper.findAll('[data-testid="platform-observation"]').map(row => row.attributes('data-relation-id')).sort()).toEqual(['101', '102', '103'])
  } finally { wrapper.unmount() }
})
