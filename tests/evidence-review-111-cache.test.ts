// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { createPinia } from 'pinia'
import { PiniaColada, useQuery } from '@pinia/colada'
import { afterEach, expect, it, vi } from 'vitest'
import EvidenceReviewForm from '../components/evidence-review/EvidenceReviewForm.vue'
const CONTEXT = '/api/roster/evidence-review/browser-context'
const detail = { id: 4, enterpriseId: 7, titleCode: 'specialized_sme', direction: 'missing_in_miit', decisionId: 82, lineage: 'current', pending: true, oldDecision: { id: 82 }, gaps: {}, currentDecision: { versionId: 82, current: { id: 82 } }, evidenceToken: { latestRevisionId: 9, decisionId: 82, projectionReady: true } }
// Real Colada consumers, no cache-invalidation mock; HTTP boundary is simulated here only.
const prefixes = ['evidence-impacts', 'evidence-impact', 'evidence-impact-sources', 'evidence-revision-events', 'decision-history', 'decision-version', 'roster-enterprise', 'ledger-drawer', 'ledger-enterprises', 'stats']
afterEach(() => vi.unstubAllGlobals())
it('refreshes every affected active list detail and history cache only after a committed save', async () => {
  let committed = false, fail = true
  const fetcher = vi.fn(async (url: string, options?: { method?: string }) => {
    if (url === CONTEXT) return { writeEnabled: true }
    if (options?.method === 'POST') {
      if (fail) throw { data: { error: { code: 'transaction_failed' } } }
      committed = true; return { reviewedRevisionId: 9 }
    }
    return { state: committed ? 'reviewed' : 'pending' }
  })
  vi.stubGlobal('$fetch', fetcher)
  const Harness = defineComponent({ setup() {
    const queries = prefixes.map(prefix => ({ prefix, ...useQuery({ key: [prefix, 'synthetic'], query: () => fetcher('/read/' + prefix) }) }))
    return () => h('div', [
      ...queries.map(q => h('output', { 'data-cache': q.prefix }, q.data.value?.state)),
      h(EvidenceReviewForm, { detail: detail as any }),
    ])
  } })
  const view = mount(Harness, { global: { plugins: [createPinia(), PiniaColada] } }); await flushPromises()
  expect(view.findAll('output').every(v => v.text() === 'pending')).toBe(true)
  await view.get('[aria-label="复核依据"]').setValue('explicit review')
  await view.get('form').trigger('submit'); await flushPromises()
  expect(view.findAll('output').every(v => v.text() === 'pending')).toBe(true)
  expect(fetcher.mock.calls.filter(c => c[1]?.method !== 'POST' && c[0] !== CONTEXT)).toHaveLength(10)
  fail = false
  await view.get('form').trigger('submit'); await flushPromises()
  for (const prefix of prefixes) expect(view.get(`[data-cache="${prefix}"]`).text()).toBe('reviewed')
  view.unmount()
})
it('explicit conflict reread refreshes the current assessment and history while keeping the review draft', async () => {
  const { default: EvidenceReviewDetail } = await import('../components/evidence-review/EvidenceReviewDetail.vue')
  let currentId = 82
  const decision = () => ({ id: currentId, status: 'confirmed_reason', reasonCode: 'other', reasonNote: currentId === 82 ? '原决定' : '并发更正', measureCode: 'none' })
  vi.stubGlobal('$fetch', vi.fn(async (url: string, options?: any) => {
    if (url === CONTEXT) return { writeEnabled: true }
    if (options?.method === 'POST') { currentId = 90; throw { data: { error: { code: 'stale_version' } } } }
    if (url === '/api/roster/enterprises/7') return { titleAssessments: [{ titleCode: 'specialized_sme', direction: 'missing_in_miit', assessment: 'decided', queryCoverage: { status: 'complete', sources: [], truncated: false }, currentDecision: { versionId: currentId, current: decision() }, explanationValidity: { status: 'evidence_changed' } }] }
    if (url === '/api/roster/evidence-impacts/4') return { ...detail, oldDecision: { id: 82, reasonNote: '原决定' }, currentDecision: { versionId: currentId, current: decision() }, queryCoverage: null, gaps: {}, lineage: currentId === 82 ? 'current' : 'historical', evidenceToken: { ...detail.evidenceToken, decisionId: currentId } }
    if (url.endsWith('/sources')) return { rows: [], nextCursor: null, asOf: {} }
    if (url.endsWith('/history')) return { rows: [{ id: currentId, recordedAt: '2026-10-19' }], total: 1, page: 1, pageSize: 25 }
    throw new Error('Unexpected public read')
  }))
  const Harness = defineComponent({ setup: () => () => h(EvidenceReviewDetail, { impactId: 4 }) })
  const view = mount(Harness, { global: { plugins: [createPinia(), PiniaColada], stubs: { NuxtLink: { template: '<a><slot /></a>' } } } }); await flushPromises()
  await view.get('[aria-label="复核依据"]').setValue('保留的草稿')
  await view.get('form').trigger('submit'); await flushPromises()
  expect(view.text()).toContain('决定版本冲突')
  await view.findAll('button').find(b => b.text() === '重新读取当前状态')!.trigger('click'); await flushPromises()
  expect(view.text()).toContain('当前版本 #90')
  expect(view.get('[aria-label="决定历史"]').text()).toContain('决定 #90')
  expect((view.get('[aria-label="复核依据"]').element as HTMLTextAreaElement).value).toBe('保留的草稿')
  view.unmount()
})
