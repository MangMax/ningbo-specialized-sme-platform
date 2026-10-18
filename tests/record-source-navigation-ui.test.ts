// @vitest-environment happy-dom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { createMemoryHistory, createRouter, RouterLink, RouterView, useRoute } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import EnterprisePage from '../pages/enterprises/[id].vue'
import SourceReader from '../components/record-correspondence/SourceReader.vue'
import ComparisonEventRow from '../components/record-correspondence/ComparisonEventRow.vue'
import ComparisonEvidence from '../components/record-correspondence/ComparisonEvidence.vue'
import type { RecordComparisonResult } from '../lib/roster/record-comparison-view'

const query = { id: 20, interface: 'business_list', queryKey: 'synthetic', rdjb: '2', queriedAt: '2026-10-18', status: 'success', failureReason: null, relationCount: 1 }
const relation = { id: 30, queryId: 20, enterpriseId: 91, sequenceNo: 1, nameRaw: '合成企业', status: '终审不通过', rawFields: {}, query }
const record = { id: 1, enterpriseId: 91, titleCode: 'specialized_sme', source: 'jxj', district: null, nameRaw: '合成企业' }
const event = { id: 10, recordId: 1, eventType: 'review', year: 2021, batchSeq: 1, decidedYear: 2024, reviewOutcome: 'failed', record, evidence: [], correspondences: [] }
const edge = { id: 1, type: 'event_process', role: 'supports_review', status: 'confirmed', revision: 1, requiresRevalidation: false, eventId: 10, predecessorEventId: null, relationId: 30, exportRowId: null, enterpriseId: 91, titleCode: 'specialized_sme', ruleId: 'fixture', ruleVersion: '1', decidedAt: null, event, relation, exportRow: null }
const detail = { enterprise: { enterpriseId: 91, name: '合成企业', uscc: null }, records: [record], events: [event, { ...event, id: 11 }], evidence: [], platform: { queries: [query], relations: [relation] } }
vi.mock('@pinia/colada', () => ({ useQuery: () => ({ data: ref(detail), isLoading: ref(false), error: ref(null) }) }))
const returnTo = '/comparison?mode=record&queryIds=20&exportBatchIds=6&page=2'
const startTo = (eventId: number, withReturn = true) => ({ path: '/enterprises/91', query: { eventId: String(eventId), ...(withReturn ? { returnTo } : {}) } })
const stubs = { NuxtLink: RouterLink, PageHeader: { template: '<header><slot name="breadcrumb" /></header>' }, FilePreviewDialog: true, EnterpriseLaterProcesses: true, TitleBadge: true, SourceChip: true, EventChip: true }
const preventNativeNavigation = (event: Event) => event.preventDefault()
let wrapper: VueWrapper | undefined
let originalAnimate: PropertyDescriptor | undefined
beforeEach(() => {
  originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')
  Reflect.deleteProperty(Element.prototype, 'animate')
  document.addEventListener('click', preventNativeNavigation)
  sessionStorage.clear()
  vi.stubGlobal('useRoute', useRoute)
  vi.stubGlobal('useHead', vi.fn())
  vi.stubGlobal('definePageMeta', vi.fn())
  vi.stubGlobal('$fetch', vi.fn(async (url: string) => ({ source: url.includes('/events/') ? event : relation, correspondences: [edge] })))
})
afterEach(async () => {
  document.removeEventListener('click', preventNativeNavigation)
  wrapper?.unmount()
  wrapper = undefined
  await flushPromises()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  if (originalAnimate) Object.defineProperty(Element.prototype, 'animate', originalAnimate)
})
async function enterprise(eventId: number, withReturn = true) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/enterprises/:id', component: EnterprisePage }, { path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
  await router.push(startTo(eventId, withReturn))
  wrapper = mount(defineComponent({ render: () => h(RouterView) }), { attachTo: document.body, global: { plugins: [router], stubs } })
  await flushPromises()
  return router
}
async function openPlatformSource() {
  const button = wrapper!.findAll('button').find(button => button.text() === '对应事件/出处')!
  ;(button.element as HTMLButtonElement).focus()
  await button.trigger('click')
  await flushPromises()
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  return document.querySelector('[role="dialog"] a') as HTMLAnchorElement
}
async function settleDialog() {
  await flushPromises()
  // Reka FocusScope dispatches close autofocus in a nextTick callback.
  await nextTick()
  await flushPromises()
}
describe('source modal reverse event navigation', () => {
  it.each([{ name: 'same event URL without return target', initial: 10, withReturn: false }, { name: 'same event URL with source query', initial: 10, withReturn: true }, { name: 'different event route reuse', initial: 11, withReturn: true }])('closes and arrives at the event for $name', async ({ initial, withReturn }) => {
    const router = await enterprise(initial, withReturn)
    const page = wrapper!.findComponent(EnterprisePage).vm.$.uid
    const target = wrapper!.get('#record-event-10')
    const collapsible = target.findComponent({ name: 'Collapsible' })
    // Same-URL navigation must also reopen an event the user has collapsed.
    collapsible.vm.$emit('update:open', false)
    await nextTick()
    const scroll = vi.spyOn(target.element, 'scrollIntoView')
    const link = await openPlatformSource()
    expect(link.getAttribute('href')).toBe(router.resolve(startTo(10, withReturn)).href)
    link.dispatchEvent(new MouseEvent('click', { button: 0, bubbles: true, cancelable: true }))
    await settleDialog()
    expect(router.currentRoute.value.fullPath).toBe(router.resolve(startTo(10, withReturn)).fullPath)
    expect(wrapper!.findComponent(EnterprisePage).vm.$.uid).toBe(page)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(collapsible.props('open')).toBe(true)
    expect(scroll).toHaveBeenLastCalledWith({ block: 'center' })
    expect(router.currentRoute.value.query.returnTo).toBe(withReturn ? returnTo : undefined)
  })

  it.each([
    { name: 'control', options: { ctrlKey: true } }, { name: 'command', options: { metaKey: true } },
    { name: 'shift', options: { shiftKey: true } }, { name: 'alt', options: { altKey: true } },
    { name: 'middle button', options: { button: 1 } }, { name: 'new tab target', options: {}, target: '_blank' },
  ])('keeps the current source dialog for $name activation', async ({ options, target }) => {
    const router = await enterprise(11)
    const before = router.currentRoute.value.fullPath
    const link = await openPlatformSource()
    if (target) link.setAttribute('target', target)
    link.dispatchEvent(new MouseEvent('click', { button: 0, bubbles: true, cancelable: true, ...options }))
    await settleDialog()
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(router.currentRoute.value.fullPath).toBe(before)
    expect(link.getAttribute('href')).toBe(router.resolve(startTo(10)).href)
  })

  it('keeps an inline source reader mounted after ordinary event navigation', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
    await router.push('/comparison')
    wrapper = mount(SourceReader, { props: { kind: 'relation', id: 30, returnTo }, global: { plugins: [router], stubs } })
    await flushPromises()
    await wrapper.get('a').trigger('click', { button: 0 })
    await flushPromises()
    expect(wrapper.emitted('event-navigate')).toEqual([[10]])
    expect(wrapper.get('[data-testid="record-source-reader"]').text()).toContain('已确认')
    expect(router.currentRoute.value.query.returnTo).toBe(returnTo)
  })

  it.each(['event row', 'comparison evidence'])('closes the %s source owner on event navigation', async (owner) => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
    await router.push('/comparison')
    const row = { event, record, evidence: [], classification: 'historical_aligned', reasons: [], correspondences: [], platformRows: [{ ...relation, interface: 'business_list' }], laterProcesses: [] } as unknown as RecordComparisonResult['rows'][number]
    const result = { counts: {}, coverage: [], officialCoverage: { reasons: [] }, historicalDecisionUnavailable: [], currentSourceConsistency: { reasons: [], recognizedObservations: [], exportObservations: [] }, platformWithoutOfficial: { rows: [{ relation, qualification: 'unresolved', reasons: [] }], total: 1 }, laterProcessPlatformRows: [] } as unknown as RecordComparisonResult
    wrapper = owner === 'event row'
      ? mount(ComparisonEventRow, { props: { row, returnTo }, attachTo: document.body, global: { plugins: [router], stubs } })
      : mount(ComparisonEvidence, { props: { result, returnTo }, attachTo: document.body, global: { plugins: [router], stubs } })
    await wrapper.findAll('button').find(button => button.text().includes('查看原行'))!.trigger('click')
    await flushPromises()
    const link = document.querySelector('[role="dialog"] a') as HTMLAnchorElement
    expect(link).not.toBeNull()
    link.dispatchEvent(new MouseEvent('click', { button: 0, bubbles: true, cancelable: true }))
    await settleDialog()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(router.currentRoute.value.query).toMatchObject({ eventId: '10', returnTo })
  })
})
