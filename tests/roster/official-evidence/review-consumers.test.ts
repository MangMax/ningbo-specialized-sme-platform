// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { PiniaColada, useQuery } from '@pinia/colada'
import { defineComponent, h } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import EnterpriseExplanations from '../../../components/evidence-review/EnterpriseExplanations.vue'
import { useEnterprisePendingImpacts } from '../../../composables/useEnterprisePendingImpacts'
const assessment = { enterpriseId: 7, titleCode: 'specialized_sme', direction: 'missing_in_miit', queryCoverage: { status: 'complete', sources: [], truncated: false }, currentDecision: { enterpriseId: 7, titleCode: 'specialized_sme', direction: 'missing_in_miit', versionId: null, current: null }, explanationValidity: { status: 'not_applicable' }, assessment: 'queried_unjudged' }
const global = () => ({ plugins: [createPinia(), PiniaColada], stubs: { NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' } } })
afterEach(() => vi.unstubAllGlobals())
it('enterprise keeps old current decision and pending validity visible at the focused scope', () => {
  const view = mount(EnterpriseExplanations, { props: { enterpriseId: 7, assessments: [{ ...assessment, assessment: 'decided', currentDecision: { ...assessment.currentDecision, versionId: 82, current: { id: 82, status: 'confirmed_reason', reasonCode: 'other', reasonNote: '用户确认的原决定', measureCode: 'none' } }, explanationValidity: { status: 'evidence_changed' } }] as any, titleCode: 'specialized_sme', direction: 'missing_in_miit' }, global: global() })
  expect(view.text()).toContain('用户确认的原决定')
  expect(view.text()).toContain('原决定保留 · 待复核')
  expect(view.get('[data-testid="assessment-scope"]').attributes('id')).toBe('explanation-specialized_sme-missing_in_miit')
  view.unmount()
})
it('gives each stacked direction a visible label instead of relying on aria-label', () => {
  const missing = { ...assessment, assessment: 'queried_unjudged' }
  const extra = { ...assessment, direction: 'extra_in_miit', assessment: 'queried_unjudged' }
  const view = mount(EnterpriseExplanations, {
    props: { enterpriseId: 7, assessments: [missing, extra] as any },
    global: global(),
  })
  expect(view.findAll('[data-testid="direction-label"]').map(label => label.text()))
    .toEqual(['应纳未纳', '平台多出'])
  expect(view.get('[data-testid="assessment-scope"] button').attributes('aria-label'))
    .toContain('应纳未纳')
  view.unmount()
})
const embeddedRow = { id: 4, enterpriseId: 7, titleCode: 'specialized_sme', direction: 'missing_in_miit', decisionId: 82, latestRevisionId: 9, reviewedRevisionId: null, classification: 'premise_invalid', pending: true, lineage: 'current', oldDecision: { id: 82, status: 'not_queried', reasonCode: 'other', measureCode: 'none', reasonNote: '页面预取待复核项' } }
const reviewedRow = { ...embeddedRow, id: 34, decisionId: 34, pending: false, reviewedRevisionId: 9, oldDecision: { ...embeddedRow.oldDecision, id: 34, reasonNote: '已复核记录 #34' } }
const historicalRow = { ...reviewedRow, id: 35, decisionId: 35, lineage: 'historical', oldDecision: { ...reviewedRow.oldDecision, id: 35, reasonNote: '历史决定 #35' } }
it.each([
  { name: 'reviewed', allRows: [reviewedRow], expected: '已复核记录 #34', absent: '页面预取待复核项' },
  { name: 'historical-only', allRows: [historicalRow], expected: '历史决定 #35', absent: '页面预取待复核项' },
  { name: 'empty', allRows: [], expected: '该企业没有复核记录', absent: '页面预取待复核项' },
])('expands the embedded all-records list with all/all while the page pending prefetch stays cached ($name)', async ({ allRows, expected, absent }) => {
  const pendingPage = { rows: [embeddedRow], nextCursor: null, asOf: { revision: 9 }, projectionReady: true }
  const allPage = { rows: allRows, nextCursor: null, asOf: { revision: 9 }, projectionReady: true }
  const fetcher = vi.fn(async (url: string, options?: any) => {
    if (url.endsWith('/profile')) return { profile: { enterpriseId: 7, name: '合成企业7' } }
    if (url === '/api/roster/evidence-impacts') {
      if (options?.query?.state === 'all' && options?.query?.view === 'all') return allPage
      if (options?.query?.state === 'pending' && options?.query?.view === 'current') return pendingPage
      throw new Error('Unexpected queue query: ' + JSON.stringify(options?.query))
    }
    throw new Error('Unexpected request: ' + url)
  })
  vi.stubGlobal('$fetch', fetcher)
  // The page prefetch keeps its own pending/current key; the expanded enterprise
  // list must fetch all/all and must not overwrite that cache entry.
  const PendingQueuePrefetch = defineComponent({
    setup() {
      const { data } = useEnterprisePendingImpacts(7)
      return () => h('div', { 'data-testid': 'pending-prefetch', 'data-rows': data.value?.rows.length ?? -1 })
    },
  })
  const view = mount(defineComponent({
    setup: () => () => h('div', [
      h(PendingQueuePrefetch),
      h(EnterpriseExplanations, { enterpriseId: 7, assessments: [assessment] as any }),
    ]),
  }), { global: global() })
  await flushPromises()
  expect(view.get('[data-testid="pending-prefetch"]').attributes('data-rows')).toBe('1')
  const trigger = view.findAll('button').find(button => button.text().includes('企业全部复核记录'))
  expect(trigger).toBeTruthy()
  await trigger!.trigger('click')
  await flushPromises()
  await flushPromises()
  expect(fetcher).toHaveBeenCalledWith('/api/roster/evidence-impacts', { query: expect.objectContaining({ enterpriseId: 7, state: 'all', view: 'all', limit: 25 }) })
  expect(fetcher).toHaveBeenCalledWith('/api/roster/evidence-impacts', { query: expect.objectContaining({ enterpriseId: 7, state: 'pending', view: 'current', limit: 25 }) })
  expect(view.get('[data-testid="pending-prefetch"]').attributes('data-rows')).toBe('1')
  expect(view.text()).toContain('全部复核记录')
  expect(view.text()).toContain(expected)
  expect(view.text()).not.toContain(absent)
  view.unmount()
})
it('locates the focused explanation only after the surrounding detail is ready', async () => {
  const scroll = vi.fn()
  const previous = HTMLElement.prototype.scrollIntoView
  HTMLElement.prototype.scrollIntoView = scroll
  const view = mount(EnterpriseExplanations, { attachTo: document.body, props: { enterpriseId: 7, assessments: [assessment] as any, titleCode: 'specialized_sme', direction: 'missing_in_miit', locate: false }, global: global() })
  try {
    await flushPromises(); expect(scroll).not.toHaveBeenCalled()
    await view.setProps({ locate: true }); await flushPromises()
    expect(scroll).toHaveBeenCalledWith({ block: 'start' })
    expect(view.get('[data-testid="assessment-scope"]').attributes('id')).toBe('explanation-specialized_sme-missing_in_miit')
  } finally { view.unmount(); HTMLElement.prototype.scrollIntoView = previous }
})

it('reopens the exact source change on repeated explicit requests even when the deep link is unchanged', async () => {
  const fetcher = vi.fn(async () => ({ rows: [], total: 0 }))
  vi.stubGlobal('$fetch', fetcher)
  const request = { id: 4, titleCode: 'specialized_sme', direction: 'missing_in_miit' }
  const view = mount(EnterpriseExplanations, { attachTo: document.body, props: { enterpriseId: 7, assessments: [], openImpactRequest: request } as any, global: { ...global(), stubs: { ...global().stubs, EvidenceReviewDetail: { props: ['impactId'], template: '<p>恢复来源变化 #{{ impactId }}</p>' } } } })
  await flushPromises()
  expect(document.body.textContent).toContain('恢复来源变化 #4')
  ;(document.querySelector('[role="dialog"] button[aria-label="Close"]') ?? [...document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent?.trim() === 'Close'))?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await flushPromises()
  await view.setProps({ openImpactRequest: { ...request } } as any); await flushPromises()
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('恢复来源变化 #4')
  view.unmount()
})
