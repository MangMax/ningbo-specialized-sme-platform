// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import EvidenceReviewList from '../components/evidence-review/EvidenceReviewList.vue'
import { resetEnterpriseNameCache } from '../composables/useEnterpriseNames'
const row = { id: 4, enterpriseId: 7, titleCode: 'specialized_sme', direction: 'missing_in_miit', decisionId: 82, latestRevisionId: 9, reviewedRevisionId: null, classification: 'premise_invalid', pending: true, lineage: 'current', oldDecision: { id: 82, status: 'not_queried', reasonNote: '原依据缺代码' } }
let fetcher: ReturnType<typeof vi.fn>
const nameOf = (id: number) => `合成企业${id}`
function profileFor(url: string) {
  const match = /\/api\/roster\/enterprises\/(\d+)\/profile$/.exec(url)
  return match ? { profile: { enterpriseId: Number(match[1]), name: nameOf(Number(match[1])) } } : null
}
/** Route profile reads separately so queue-page assertions stay about the queue call. */
function mockRoutes(routes: (url: string, options?: any) => unknown) {
  fetcher.mockImplementation(async (url: string, options?: any) => profileFor(url) ?? routes(url, options))
}
beforeEach(() => {
  resetEnterpriseNameCache()
  fetcher = vi.fn()
  mockRoutes(() => ({ rows: [row], nextCursor: 'signed-page-2', asOf: { revision: 9 }, projectionReady: true }))
  vi.stubGlobal('$fetch', fetcher)
})
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
  mockRoutes(async (url: string) => {
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
  await view.findAll('button').find(b => b.text() === '下一页来源')!.trigger('click'); await flushPromises()
  expect(fetcher).toHaveBeenCalledWith('/api/roster/evidence-impacts/4/sources', { query: { limit: 25, cursor: 'sources-next' } })
  view.unmount()
})
it('reads immutable decision history and full old audit details without a write token', async () => {
  mockRoutes(async (url: string) => {
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
it('restarts the frozen list cursor after successful review so completed items disappear from the fresh pending view', async () => {
  let committed = false
  mockRoutes(async (url: string, options?: any) => {
    if (options?.method === 'POST') { committed = true; return { reviewedRevisionId: 9 } }
    if (url === '/api/roster/evidence-impacts') return { rows: committed && !options.query.cursor ? [] : [row], nextCursor: 'frozen-old-page', asOf: {}, projectionReady: true }
    if (url === '/api/roster/evidence-impacts/4') return { ...row, pending: !committed, currentDecision: { versionId: 82, current: row.oldDecision }, evidenceToken: { decisionId: 82, latestRevisionId: 9, projectionReady: true }, queryCoverage: null, gaps: {} }
    if (url.endsWith('/sources')) return { rows: [], nextCursor: null, asOf: {} }
    if (url.endsWith('/history')) return { rows: [], total: 0, page: 1, pageSize: 25 }
    throw new Error('Unexpected request')
  })
  const view = render(); await flushPromises()
  await view.get('[aria-label="下一页复核项"]').trigger('click'); await flushPromises()
  expect(view.text()).toContain('第 2 页')
  await view.get('[aria-label="查看复核项 4"]').trigger('click'); await flushPromises()
  for (const [label, value] of [['写入凭证', 'synthetic'], ['复核人', 'tester'], ['复核依据', 'explicit review'], ['规则版本', 'manual-v1']]) await view.get(`[aria-label="${label}"]`).setValue(value)
  await view.findAll('form').at(-1)!.trigger('submit'); await flushPromises()
  expect(view.text()).toContain('显示来源：第 1 页')
  expect(view.text()).toContain('本页没有复核项')
  expect(view.text()).not.toContain('原依据缺代码')
  view.unmount()
})
it('shows the committed review baseline audit separately from the preserved original decision audit', async () => {
  mockRoutes(async (url: string) => {
    if (url === '/api/roster/evidence-impacts') return { rows: [row], nextCursor: null, asOf: {}, projectionReady: true }
    if (url === '/api/roster/evidence-impacts/4') return { ...row, pending: false, oldDecision: { ...row.oldDecision, actor: { type: 'user', id: 'original-author' }, basis: '原决定依据' }, currentDecision: { versionId: 82, current: row.oldDecision }, evidenceToken: { decisionId: 82, latestRevisionId: 9, projectionReady: true }, queryCoverage: null, gaps: {}, reviewedBaseline: { reviewedRevisionId: 9, actor: { type: 'user', id: 'baseline-reviewer' }, basis: '已核验新证据，维持原决定', ruleVersion: 'review-rule-2026', effectiveAt: '2026-10-19T09:00:00Z', recordedAt: '2026-10-19T09:01:00Z' } }
    if (url.endsWith('/sources')) return { rows: [], nextCursor: null, asOf: {} }
    if (url.endsWith('/history')) return { rows: [], total: 0, page: 1, pageSize: 25 }
    throw new Error('Unexpected request')
  })
  const view = render(); await flushPromises()
  await view.get('[aria-label="查看复核项 4"]').trigger('click'); await flushPromises()
  const audit = view.get('[data-testid="reviewed-baseline"]')
  expect(audit.text()).toContain('baseline-reviewer')
  expect(audit.text()).toContain('已核验新证据，维持原决定')
  expect(audit.text()).toContain('review-rule-2026')
  expect(audit.text()).toContain('2026-10-19T09:01:00Z')
  expect(view.text()).toContain('original-author')
  expect(view.text()).toContain('原决定依据')
  view.unmount()
})
it('keeps merged historical coordinates readable when the legacy decision is unavailable and never substitutes or completes another decision', async () => {
  const missing = { ...row, lineage: 'merged', oldDecision: null }
  mockRoutes(async (url: string) => {
    if (url === '/api/roster/evidence-impacts') return { rows: [missing], nextCursor: null, asOf: {}, projectionReady: true }
    if (url === '/api/roster/evidence-impacts/4') return { ...missing, currentDecision: null, evidenceToken: { decisionId: null, latestRevisionId: 9, projectionReady: true }, queryCoverage: null, gaps: { decisionUnavailable: true, subjectUnknown: true, projectionReady: true }, reviewedBaseline: null }
    if (url.endsWith('/sources')) return { rows: [{ revisionId: 9, sourceKind: 'identity', sourceKey: 'merge-7', sourceVersion: 'v2', classification: 'evidence_changed' }], nextCursor: null, asOf: {} }
    if (url.endsWith('/history')) throw new Error('Deleted owner history must not be requested')
    throw new Error('Unexpected request')
  })
  const view = render(); await flushPromises()
  expect(view.text()).toContain('历史决定原文不可用')
  expect(view.text()).toContain('原决定 #82')
  await view.get('[aria-label="查看复核项 4"]').trigger('click'); await flushPromises()
  expect(view.text()).toContain('历史决定原文不可用')
  expect(view.text()).toContain('merge-7')
  expect(view.text()).toContain('企业 #7')
  expect(view.text()).not.toContain('历史决定读取失败')
  expect(view.findAll('button[type="submit"]').at(-1)!.attributes('disabled')).toBeDefined()
  expect(fetcher.mock.calls.some(c => c[0].endsWith('/history'))).toBe(false)
  view.unmount()
})
it('explains expired snapshots while retaining their source page until an explicit fresh-list restart', async () => {
  const view = render(); await flushPromises()
  fetcher.mockRejectedValueOnce({ data: { error: { code: 'invalid_cursor' } } })
  await view.get('[aria-label="下一页复核项"]').trigger('click'); await flushPromises()
  expect(view.text()).toContain('分页快照已过期或失效')
  expect(view.text()).toContain('显示来源：第 1 页')
  expect(view.text()).toContain('原依据缺代码')
  fetcher.mockRejectedValueOnce({ data: { error: { code: 'invalid_cursor' } } })
  await view.get('[data-testid="retry-review-page"]').trigger('click'); await flushPromises()
  expect(fetcher).toHaveBeenLastCalledWith('/api/roster/evidence-impacts', { query: { view: 'current', state: 'pending', limit: 25, cursor: 'signed-page-2' } })
  await view.findAll('button').find(b => b.text() === '从第一页重新读取')!.trigger('click'); await flushPromises()
  expect(fetcher).toHaveBeenLastCalledWith('/api/roster/evidence-impacts', { query: { view: 'current', state: 'pending', limit: 25 } })
  expect(view.text()).not.toContain('分页快照已过期或失效')
  view.unmount()
})
it('retains a source page and explains an invalid source cursor until the user restarts that source read', async () => {
  let expireSource = false
  mockRoutes(async (url: string, options?: any) => {
    if (url === '/api/roster/evidence-impacts') return { rows: [row], nextCursor: null, asOf: {}, projectionReady: true }
    if (url === '/api/roster/evidence-impacts/4') return { ...row, currentDecision: null, evidenceToken: { decisionId: null, latestRevisionId: 9, projectionReady: true }, queryCoverage: null, gaps: {}, lineage: 'merged' }
    if (url.endsWith('/sources')) {
      if (expireSource && options.query.cursor) throw { data: { error: { code: 'invalid_cursor' } } }
      return { rows: [{ revisionId: 9, sourceKind: 'identity', sourceKey: 'retained-source', sourceVersion: 'v2', classification: 'evidence_changed' }], nextCursor: 'opaque-source-cursor', asOf: {} }
    }
    throw new Error('Unexpected request')
  })
  const view = render(); await flushPromises()
  await view.get('[aria-label="查看复核项 4"]').trigger('click'); await flushPromises()
  expireSource = true
  await view.findAll('button').find(b => b.text() === '下一页来源')!.trigger('click'); await flushPromises()
  expect(view.text()).toContain('分页快照已过期或失效')
  expect(view.text()).toContain('来源第 1 页')
  expect(view.text()).toContain('retained-source')
  await view.findAll('button').find(b => b.text() === '重新读取来源')!.trigger('click'); await flushPromises()
  expect(view.text()).not.toContain('分页快照已过期或失效')
  expect(fetcher).toHaveBeenCalledWith('/api/roster/evidence-impacts/4/sources', { query: { limit: 25 } })
  view.unmount()
})
it('labels reviewed historical impacts as reviewed while preserving their original change classification', async () => {
  mockRoutes(() => ({ rows: [{ ...row, pending: false, lineage: 'historical', classification: 'evidence_changed' }], nextCursor: null, asOf: {}, projectionReady: true }))
  const view = render(); await flushPromises()
  const item = view.get('[aria-label="解释复核清单"] > ul > li')
  expect(item.text()).toContain('已复核')
  expect(item.text()).toContain('证据变化')
  expect(item.text()).not.toContain('待复核')
  view.unmount()
})
it('resolves bounded names for the current queue page and never borrows a merged survivor name', async () => {
  mockRoutes(() => ({
    rows: [
      { ...row, id: 4, enterpriseId: 7 },
      { ...row, id: 5, enterpriseId: 7 },
      { ...row, id: 6, enterpriseId: 9, lineage: 'merged', oldDecision: null },
      { ...row, id: 7, enterpriseId: 10 },
    ],
    nextCursor: null,
    asOf: {},
    projectionReady: true,
  }))
  const view = render(); await flushPromises()
  const items = view.findAll('[data-testid="review-queue-item"]')
  expect(items[0]!.text()).toContain(nameOf(7))
  expect(items[0]!.text()).toContain('#7')
  expect(items[2]!.text()).toContain('原企业 #9（归并前坐标）')
  const profileCalls = fetcher.mock.calls
    .map(call => String(call[0]))
    .filter(url => url.endsWith('/profile'))
  expect(profileCalls).toEqual([
    '/api/roster/enterprises/7/profile',
    '/api/roster/enterprises/10/profile',
  ])
  view.unmount()
})
it('states that a queue enterprise name could not be read instead of presenting the ID as a name', async () => {
  fetcher.mockImplementation(async (url: string) => {
    if (url.endsWith('/profile')) throw new Error('profile endpoint unavailable')
    return { rows: [{ ...row, enterpriseId: 12 }], nextCursor: null, asOf: {}, projectionReady: true }
  })
  const view = render(); await flushPromises()
  const item = view.get('[data-testid="review-queue-item"]')
  expect(item.text()).toContain('企业 #12')
  expect(item.text()).toContain('名称未读取')
  expect(item.text()).not.toContain('profile endpoint unavailable')
  view.unmount()
})
it('calls the applied reviewed filter reviewed records rather than a pending queue', async () => {
  const view = render(); await flushPromises()
  await view.get('[aria-label="复核状态"]').setValue('reviewed')
  await view.get('form').trigger('submit'); await flushPromises()
  expect(view.text()).toContain('已复核记录')
  expect(view.text()).not.toContain('待复核队列')
  view.unmount()
})
it('labels a merged historical row as a history item', async () => {
  mockRoutes(() => ({ rows: [{ ...row, lineage: 'merged', oldDecision: null }], nextCursor: null, asOf: {}, projectionReady: true }))
  const view = render(); await flushPromises()
  expect(view.get('[aria-label="查看复核项 4"]').text()).toContain('查看历史项')
  view.unmount()
})
it('retries a failed name read without refetching the queue', async () => {
  let fail = true
  fetcher.mockImplementation(async (url: string) => {
    if (url.endsWith('/profile')) {
      if (fail) throw new Error('profile endpoint unavailable')
      return { profile: { enterpriseId: 12, name: '恢复企业' } }
    }
    return { rows: [{ ...row, enterpriseId: 12 }], nextCursor: null, asOf: {}, projectionReady: true }
  })
  const view = render(); await flushPromises()
  expect(view.text()).toContain('名称未读取')
  fail = false
  await view.findAll('button').find(button => button.text() === '重试读取企业名称')!.trigger('click')
  await flushPromises()
  expect(view.text()).toContain('恢复企业')
  expect(view.text()).not.toContain('名称未读取')
  expect(fetcher.mock.calls.filter(call => call[0] === '/api/roster/evidence-impacts')).toHaveLength(1)
  view.unmount()
})
