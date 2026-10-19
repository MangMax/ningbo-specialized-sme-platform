// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { createPinia } from 'pinia'
import { PiniaColada, useQuery } from '@pinia/colada'
import { afterEach, expect, it, vi } from 'vitest'
import EvidenceReviewForm from '../components/evidence-review/EvidenceReviewForm.vue'
const detail = { id: 4, enterpriseId: 7, titleCode: 'specialized_sme', direction: 'missing_in_miit', decisionId: 82, lineage: 'current', pending: true, oldDecision: { id: 82 }, gaps: {}, currentDecision: { versionId: 82, current: { id: 82 } }, evidenceToken: { latestRevisionId: 9, decisionId: 82, projectionReady: true } }
// Real Colada consumers, no cache-invalidation mock; HTTP boundary is simulated here only.
const prefixes = ['evidence-impacts', 'evidence-impact', 'evidence-impact-sources', 'evidence-revision-events', 'decision-history', 'decision-version', 'roster-enterprise', 'ledger-drawer', 'ledger-enterprises', 'roster-differences', 'comparison', 'stats']
afterEach(() => vi.unstubAllGlobals())
it('refreshes every affected active list detail and history cache only after a committed save', async () => {
  let committed = false, fail = true
  const fetcher = vi.fn(async (url: string, options?: { method?: string }) => {
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
  for (const [label, value] of [['写入凭证', 'synthetic'], ['复核人', 'tester'], ['复核依据', 'explicit review'], ['规则版本', 'manual-v1']]) await view.get(`[aria-label="${label}"]`).setValue(value)
  await view.get('form').trigger('submit'); await flushPromises()
  expect(view.findAll('output').every(v => v.text() === 'pending')).toBe(true)
  expect(fetcher.mock.calls.filter(c => c[1]?.method !== 'POST')).toHaveLength(12)
  fail = false
  await view.get('form').trigger('submit'); await flushPromises()
  for (const prefix of prefixes) expect(view.get(`[data-cache="${prefix}"]`).text()).toBe('reviewed')
  view.unmount()
})
