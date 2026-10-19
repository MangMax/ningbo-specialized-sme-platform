// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import EvidenceReviewList from '../components/evidence-review/EvidenceReviewList.vue'
const row = { id: 4, enterpriseId: 7, titleCode: 'specialized_sme', direction: 'missing_in_miit', decisionId: 82, latestRevisionId: 9, reviewedRevisionId: null, classification: 'premise_invalid', pending: true, lineage: 'current', oldDecision: { id: 82, status: 'not_queried', reasonNote: '原依据缺代码' } }
let fetcher: ReturnType<typeof vi.fn>
beforeEach(() => { fetcher = vi.fn().mockResolvedValue({ rows: [row], nextCursor: 'signed-page-2', asOf: { revision: 9 }, projectionReady: true }); vi.stubGlobal('$fetch', fetcher) })
afterEach(() => vi.unstubAllGlobals())
const render = () => mount(EvidenceReviewList, { global: { plugins: [createPinia(), PiniaColada], stubs: { NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' } } } })
it('filters the bounded review view by exact enterprise title direction and event', async () => {
  const view = render(); await flushPromises()
  expect(view.text()).toContain('原依据缺代码')
  expect(view.text()).toContain('待复核')
  await view.get('[aria-label="企业 ID"]').setValue('7')
  await view.get('[aria-label="称号筛选"]').setValue('specialized_sme')
  await view.get('[aria-label="方向筛选"]').setValue('missing_in_miit')
  await view.get('[aria-label="事件 ID"]').setValue('33')
  await view.get('form').trigger('submit'); await flushPromises()
  expect(fetcher).toHaveBeenLastCalledWith('/api/roster/evidence-impacts', { query: { enterpriseId: 7, titleCode: 'specialized_sme', direction: 'missing_in_miit', eventId: 33, view: 'current', state: 'pending', limit: 25 } })
  expect(view.get('[data-testid="review-enterprise-link"]').attributes('href')).toContain('titleCode=specialized_sme')
  expect(view.get('[data-testid="review-enterprise-link"]').attributes('href')).toContain('eventId=33')
  view.unmount()
})
it('follows opaque cursor pages and retains the previous page with explicit retry on failure', async () => {
  const view = render(); await flushPromises()
  fetcher.mockRejectedValueOnce(new Error('private response must not be displayed'))
  await view.get('[aria-label="下一页复核项"]').trigger('click'); await flushPromises()
  expect(fetcher).toHaveBeenLastCalledWith('/api/roster/evidence-impacts', { query: { view: 'current', state: 'pending', limit: 25, cursor: 'signed-page-2' } })
  expect(view.text()).toContain('原依据缺代码')
  expect(view.text()).toContain('第 1 页')
  expect(view.text()).toContain('读取失败')
  expect(view.text()).not.toContain('private response')
  expect(view.get('[aria-label="下一页复核项"]').attributes('disabled')).toBeDefined()
  await view.get('[data-testid="retry-review-page"]').trigger('click'); await flushPromises()
  expect(view.text()).toContain('第 2 页')
  view.unmount()
})
it('opens the exact impact and its separate committed source and event pages', async () => {
  fetcher.mockImplementation(async (url: string) => {
    if (url === '/api/roster/evidence-impacts') return { rows: [row], nextCursor: null, asOf: {}, projectionReady: true }
    if (url === '/api/roster/evidence-impacts/4') return { ...row, currentDecision: { versionId: 82, current: row.oldDecision }, evidenceToken: { decisionId: 82, latestRevisionId: 9, projectionReady: true }, queryCoverage: { status: 'partial', sources: [], truncated: false }, gaps: { subjectUnknown: true, projectionReady: true } }
    if (url === '/api/roster/evidence-impacts/4/sources') return { rows: [{ revisionId: 9, sourceKind: 'platform_query', sourceKey: 'query-9', sourceVersion: 'v2', eventId: null, classification: 'premise_invalid', coverageChanged: true, factChanged: false }], nextCursor: 'sources-next', asOf: {} }
    if (url === '/api/roster/evidence-impacts/revisions/9/events') return { rows: [{ revisionId: 9, eventId: 33, enterpriseId: 7, titleCode: 'specialized_sme' }], nextCursor: null, asOf: {} }
    if (url === '/api/roster/decision-lifecycle/history') return { rows: [], total: 0, page: 1, pageSize: 25 }
    throw new Error('Unexpected request: ' + url)
  })
  const view = render(); await flushPromises()
  await view.get('[aria-label="查看复核项 4"]').trigger('click'); await flushPromises()
  expect(view.text()).toContain('主体未确认，不能推断为零记录')
  expect(view.text()).toContain('原决定 #82')
  expect(view.text()).toContain('query-9')
  expect(fetcher).toHaveBeenCalledWith('/api/roster/evidence-impacts/4/sources', { query: { limit: 25 } })
  await view.get('[aria-label="查看修订 9 关联事件"]').trigger('click'); await flushPromises()
  expect(fetcher).toHaveBeenCalledWith('/api/roster/evidence-impacts/revisions/9/events', { query: { enterpriseId: 7, limit: 25 } })
  expect(view.get('[data-testid="revision-event-link"]').attributes('href')).toBe('/enterprises/7?eventId=33&titleCode=specialized_sme')
  view.unmount()
})
it('reads immutable decision history and full old audit details without a write token', async () => {
  fetcher.mockImplementation(async (url: string) => {
    if (url === '/api/roster/evidence-impacts') return { rows: [row], nextCursor: null, asOf: {}, projectionReady: true }
    if (url === '/api/roster/evidence-impacts/4') return { ...row, lineage: 'historical', currentDecision: { versionId: 90, current: { id: 90, reasonNote: '新决定仍保留' } }, evidenceToken: { decisionId: 90, latestRevisionId: 9, projectionReady: true }, queryCoverage: null, gaps: { subjectUnknown: false, projectionReady: true } }
    if (url === '/api/roster/decision-lifecycle/history') return { rows: [{ id: 82, status: 'not_queried', recordedAt: '2026-10-01', lifecycleAction: null, isCurrent: false }], total: 1, page: 1, pageSize: 25 }
    if (url === '/api/roster/decision-lifecycle/82') return { ...row.oldDecision, basis: '历史人工依据', actor: { type: 'user', id: 'reviewer-original' }, ruleVersion: 'original-rule', measureCode: 'none' }
    if (url.endsWith('/sources')) return { rows: [], nextCursor: null, asOf: {} }
    throw new Error('Unexpected request: ' + url)
  })
  const view = render(); await flushPromises()
  await view.get('[aria-label="查看复核项 4"]').trigger('click'); await flushPromises()
  expect(view.text()).toContain('新决定仍保留')
  await view.get('[aria-label="查看历史决定 82"]').trigger('click'); await flushPromises()
  expect(fetcher).toHaveBeenCalledWith('/api/roster/decision-lifecycle/history', { query: { enterpriseId: 7, titleCode: 'specialized_sme', direction: 'missing_in_miit', page: 1, pageSize: 25 } })
  expect(view.text()).toContain('历史人工依据')
  expect(view.text()).toContain('reviewer-original')
  expect(view.text()).toContain('original-rule')
  expect(view.findAll('button[type="submit"]').at(-1)!.attributes('disabled')).toBeDefined()
  view.unmount()
})
