// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import { afterEach, expect, it, vi } from 'vitest'
import ComparisonExplanation from '../components/evidence-review/ComparisonExplanation.vue'
import EnterpriseExplanations from '../components/evidence-review/EnterpriseExplanations.vue'
const assessment = { enterpriseId: 7, titleCode: 'specialized_sme', direction: 'missing_in_miit', queryCoverage: { status: 'complete', sources: [], truncated: false }, currentDecision: { enterpriseId: 7, titleCode: 'specialized_sme', direction: 'missing_in_miit', versionId: null, current: null }, explanationValidity: { status: 'not_applicable' }, assessment: 'queried_unjudged' }
const global = () => ({ plugins: [createPinia(), PiniaColada], stubs: { NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' } } })
afterEach(() => vi.unstubAllGlobals())
it('comparison reads the frozen enterprise assessment for the exact title and direction', async () => {
  const fetcher = vi.fn().mockResolvedValue({ titleAssessments: [assessment, { ...assessment, titleCode: 'little_giant', assessment: 'not_queried', queryCoverage: { status: 'not_queried', sources: [], truncated: false } }] })
  vi.stubGlobal('$fetch', fetcher)
  const view = mount(ComparisonExplanation, { props: { enterpriseId: 7, titleCode: 'specialized_sme', direction: 'missing_in_miit' }, global: global() }); await flushPromises()
  expect(fetcher).toHaveBeenCalledWith('/api/roster/enterprises/7')
  expect(view.text()).toContain('已查询，尚未判断')
  expect(view.text()).not.toContain('未查询')
  expect(view.get('a').attributes('href')).toBe('/enterprises/7?titleCode=specialized_sme&direction=missing_in_miit')
  await view.setProps({ titleCode: 'little_giant' })
  expect(view.text()).toContain('尚未查询，尚未判断')
  view.unmount()
})
it('enterprise keeps old current decision and pending validity visible at the focused scope', () => {
  const view = mount(EnterpriseExplanations, { props: { enterpriseId: 7, assessments: [{ ...assessment, assessment: 'decided', currentDecision: { ...assessment.currentDecision, versionId: 82, current: { id: 82, status: 'confirmed_reason', reasonCode: 'other', reasonNote: '用户确认的原决定', measureCode: 'none' } }, explanationValidity: { status: 'evidence_changed' } }] as any, titleCode: 'specialized_sme', direction: 'missing_in_miit' }, global: global() })
  expect(view.text()).toContain('用户确认的原决定')
  expect(view.text()).toContain('证据已变化 · 待复核')
  expect(view.get('[data-testid="assessment-scope"]').attributes('id')).toBe('explanation-specialized_sme-missing_in_miit')
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
