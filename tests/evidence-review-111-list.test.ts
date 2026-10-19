// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import EvidenceReviewList from '../components/evidence-review/EvidenceReviewList.vue'
import { Select } from '../components/ui/select'
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
const dialogStubs = {
  Dialog: { props: ['open'], template: '<div v-if="open"><slot /></div>' },
  DialogContent: { template: '<div data-testid="dialog-content"><slot /></div>' },
  DialogHeader: { template: '<div><slot /></div>' },
  DialogTitle: { template: '<h2><slot /></h2>' },
  DialogDescription: { template: '<p><slot /></p>' },
  DialogFooter: { template: '<div><slot /></div>' },
}
const stubs = {
  NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
  ...dialogStubs,
}
const render = () => mount(EvidenceReviewList, { global: { plugins: [createPinia(), PiniaColada], stubs } })
const renderEnterprise = () => mount(EvidenceReviewList, {
  props: { enterpriseId: 7, defaultState: 'all', defaultView: 'all' },
  global: { plugins: [createPinia(), PiniaColada], stubs },
})
function choose(view: ReturnType<typeof render>, label: string, value: string) {
  const select = view.findAllComponents(Select).find(candidate => candidate.find(`[aria-label="${label}"]`).exists())
  if (!select) throw new Error(`Select not found: ${label}`)
  select.vm.$emit('update:modelValue', value)
}
it('filters the bounded review view by exact enterprise title direction and event', async () => {
  const view = render(); await flushPromises()
  expect(view.text()).toContain('原依据缺代码')
  expect(view.text()).toContain('待复核')
  await view.findAll('[data-slot="accordion-trigger"]').find(button => button.text().includes('更多筛选与名称定位'))!.trigger('click')
  await flushPromises()
  await view.get('[aria-label="企业 ID"]').setValue('7')
  choose(view, '称号筛选', 'specialized_sme')
  choose(view, '方向筛选', 'missing_in_miit')
  await view.get('[aria-label="事件 ID"]').setValue('33')
  await view.get('form').trigger('submit'); await flushPromises()
  expect(fetcher).toHaveBeenLastCalledWith('/api/roster/evidence-impacts', { query: { enterpriseId: 7, titleCode: 'specialized_sme', direction: 'missing_in_miit', eventId: 33, view: 'current', state: 'pending', limit: 25 } })
  expect(view.get('[data-testid="review-enterprise-link"]').attributes('href')).toContain('titleCode=specialized_sme')
  expect(view.get('[data-testid="review-enterprise-link"]').attributes('href')).toContain('eventId=33')
  view.unmount()
})
it('keeps queue filters in the URL and returns detail links to the same filtered queue', async () => {
  const replace = vi.fn()
  vi.stubGlobal('useRoute', () => ({ query: { mode: 'review', reviewState: 'reviewed' }, path: '/comparison' }))
  vi.stubGlobal('useRouter', () => ({ replace }))
  const view = mount(EvidenceReviewList, { props: { syncQuery: true }, global: { plugins: [createPinia(), PiniaColada], stubs } })
  await flushPromises()
  expect(fetcher).toHaveBeenCalledWith('/api/roster/evidence-impacts', { query: { view: 'current', state: 'reviewed', limit: 25 } })
  const href = decodeURIComponent(view.get('[data-testid="review-enterprise-link"]').attributes('href')!)
  expect(href).toContain('returnTo=/comparison?mode=review&reviewState=reviewed')
  choose(view, '复核状态', 'all')
  await view.get('form').trigger('submit'); await flushPromises()
  const target = replace.mock.calls.at(-1)![0]
  expect(target).toMatchObject({ path: '/comparison', query: { mode: 'review', reviewState: 'all' } })
  const updated = decodeURIComponent(view.get('[data-testid="review-enterprise-link"]').attributes('href')!)
  expect(updated).toContain('returnTo=/comparison?mode=review&reviewState=all')
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
  await view.get('[aria-label="处理这一项 4"]').trigger('click'); await flushPromises()
  expect(view.text()).toContain('主体未确认，不能推断为零记录')
  expect(view.text()).toContain('待复核的当前决定 #82')
  expect(view.text()).toContain('query-9')
  expect(fetcher).toHaveBeenCalledWith('/api/roster/evidence-impacts/4/sources', { query: { limit: 25 } })
  await view.get('[aria-label="查看修订 9 关联事件"]').trigger('click'); await flushPromises()
  expect(fetcher).toHaveBeenCalledWith('/api/roster/evidence-impacts/revisions/9/events', { query: { enterpriseId: 7, limit: 25 } })
  expect(view.get('[data-testid="revision-event-link"]').attributes('href')).toBe('/enterprises/7?tab=records&eventId=33&titleCode=specialized_sme')
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
  await view.get('[aria-label="处理这一项 4"]').trigger('click'); await flushPromises()
  expect(view.text()).toContain('新决定仍保留')
  await view.get('[aria-label="查看历史决定 82"]').trigger('click'); await flushPromises()
  expect(fetcher).toHaveBeenCalledWith('/api/roster/decision-lifecycle/history', { query: { enterpriseId: 7, titleCode: 'specialized_sme', direction: 'missing_in_miit', page: 1, pageSize: 25 } })
  expect(view.text()).toContain('历史人工依据')
  expect(view.text()).toContain('reviewer-original')
  expect(view.text()).toContain('original-rule')
  expect(view.get('[data-testid="review-readonly"]').text()).toContain('历史、撤回或归并')
  const readonlyForm = view.findAll('form').find(form => form.text().includes('当前只读'))!
  expect(readonlyForm.find('button[type="submit"]').attributes('disabled')).toBeDefined()
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
  await view.get('[aria-label="处理这一项 4"]').trigger('click'); await flushPromises()
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
  await view.get('[aria-label="处理这一项 4"]').trigger('click'); await flushPromises()
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
  expect(view.text()).toContain('归并前决定 #82')
  await view.get('[aria-label="查看历史项 4"]').trigger('click'); await flushPromises()
  expect(view.text()).toContain('历史决定原文不可用')
  expect(view.text()).toContain('merge-7')
  expect(view.text()).toContain('企业 #7')
  expect(view.text()).not.toContain('历史决定读取失败')
  expect(view.get('[data-testid="review-readonly"]').text()).toContain('历史、撤回或归并')
  const readonlyForm = view.findAll('form').find(form => form.text().includes('当前只读'))!
  expect(readonlyForm.find('button[type="submit"]').attributes('disabled')).toBeDefined()
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
  await view.get('[aria-label="处理这一项 4"]').trigger('click'); await flushPromises()
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
it('distinguishes the reviewed-before decision from the current append correction in a reviewed queue row', async () => {
  mockRoutes(() => ({
    rows: [{
      ...row,
      pending: false,
      decisionId: 35,
      oldDecision: { ...row.oldDecision, id: 35, lifecycleAction: 'replace', previousId: 10, status: 'confirmed_reason', reasonCode: 'other', measureCode: 'none' },
    }],
    nextCursor: null,
    asOf: {},
    projectionReady: true,
  }))
  const view = render(); await flushPromises()
  const item = view.get('[data-testid="review-queue-item"]')
  expect(item.text()).toContain('当前决定 #35（追加更正）')
  expect(item.text()).toContain('复核前决定 #10 保留')
  expect(item.text()).not.toContain('原决定 #35')
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
  choose(view, '复核状态', 'reviewed')
  await view.get('form').trigger('submit'); await flushPromises()
  expect(view.text()).toContain('已复核记录')
  expect(view.text()).not.toContain('待复核队列')
  view.unmount()
})
it('labels a merged historical row as a history item', async () => {
  mockRoutes(() => ({ rows: [{ ...row, lineage: 'merged', oldDecision: null }], nextCursor: null, asOf: {}, projectionReady: true }))
  const view = render(); await flushPromises()
  expect(view.get('[aria-label="查看历史项 4"]').text()).toContain('查看历史项')
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

const detailFor = (impact: typeof row, patch: Record<string, unknown> = {}) => ({
  ...impact,
  currentDecision: { versionId: impact.decisionId, current: impact.oldDecision },
  evidenceToken: { decisionId: impact.decisionId, latestRevisionId: impact.latestRevisionId, projectionReady: true },
  queryCoverage: null,
  gaps: {},
  reviewedBaseline: null,
  ...patch,
})

async function openAndFill(view: ReturnType<typeof render>, impactId = 4) {
  await view.get('[aria-label="处理这一项 ' + impactId + '"]').trigger('click')
  await flushPromises()
  for (const [label, value] of [['写入凭证', 'synthetic-token'], ['复核人', 'reviewer-7'], ['复核依据', '核对新查询并保留原业务判断'], ['规则版本', 'manual-2026']]) {
    await view.get(`[aria-label="${label}"]`).setValue(value)
  }
  await flushPromises()
}

function clickText(view: ReturnType<typeof render>, text: string) {
  const button = view.findAll('button').find(candidate => candidate.text() === text)
  if (!button) throw new Error(`Button not found: ${text}`)
  return button
}

it('states only the actual query scope for enterprise, filtered, page and unconfirmed empty results', async () => {
  mockRoutes(() => ({ rows: [], nextCursor: null, asOf: {}, projectionReady: true }))
  const enterprise = renderEnterprise(); await flushPromises()
  expect(enterprise.get('[data-testid="review-empty"]').text()).toContain('该企业没有复核记录')
  enterprise.unmount()

  mockRoutes(() => ({ rows: [], nextCursor: null, asOf: {}, projectionReady: true }))
  const filtered = renderEnterprise(); await flushPromises()
  choose(filtered, '称号筛选', 'specialized_sme')
  await filtered.get('form').trigger('submit'); await flushPromises()
  expect(filtered.get('[data-testid="review-empty"]').text()).toContain('当前筛选下没有复核项')
  expect(filtered.get('[data-testid="review-empty"]').text()).not.toContain('该企业没有复核记录')
  filtered.unmount()

  mockRoutes((_url, options) => options?.query?.cursor
    ? { rows: [], nextCursor: null, asOf: {}, projectionReady: true }
    : { rows: [row], nextCursor: 'page-2', asOf: {}, projectionReady: true })
  const paged = renderEnterprise(); await flushPromises()
  await paged.get('[aria-label="下一页复核项"]').trigger('click'); await flushPromises()
  expect(paged.get('[data-testid="review-empty"]').text()).toContain('本页没有复核项')
  expect(paged.get('[data-testid="review-empty"]').text()).not.toMatch(/^该企业没有复核记录/)
  expect(paged.text()).toContain('显示来源：第 2 页')
  paged.unmount()

  mockRoutes(() => ({ rows: [], nextCursor: null, asOf: {}, projectionReady: false }))
  const pendingProjection = renderEnterprise(); await flushPromises()
  expect(pendingProjection.get('[data-testid="review-empty"]').text()).toContain('复核记录尚不能确认')
  pendingProjection.unmount()

  mockRoutes((_url, options) => options?.query?.cursor
    ? { rows: [], nextCursor: null, asOf: {}, projectionReady: true }
    : { rows: [], nextCursor: 'page-2', asOf: {}, projectionReady: true })
  const failed = renderEnterprise(); await flushPromises()
  fetcher.mockRejectedValueOnce(new Error('private upstream failure'))
  await failed.get('[aria-label="下一页复核项"]').trigger('click'); await flushPromises()
  expect(failed.get('[data-testid="review-empty"]').text()).toContain('复核记录尚不能确认')
  expect(failed.get('[data-testid="review-empty"]').text()).not.toMatch(/^该企业没有复核记录/)
  expect(failed.text()).toContain('显示来源：第 1 页')
  expect(failed.text()).not.toContain('private upstream failure')
  expect(failed.find('[data-testid="retry-review-page"]').exists()).toBe(true)
  failed.unmount()
})

it('lets an empty page with nextCursor continue instead of treating rows.length as the end', async () => {
  mockRoutes((_url, options) => options?.query?.cursor
    ? { rows: [row], nextCursor: null, asOf: {}, projectionReady: true }
    : { rows: [], nextCursor: 'page-2', asOf: {}, projectionReady: true })
  const view = renderEnterprise(); await flushPromises()
  expect(view.get('[data-testid="review-empty"]').text()).toContain('本页没有复核项')
  const next = view.get('[aria-label="下一页复核项"]')
  expect(next.attributes('disabled')).toBeUndefined()
  await next.trigger('click'); await flushPromises()
  expect(view.text()).toContain('显示来源：第 2 页')
  expect(view.text()).toContain('原依据缺代码')
  view.unmount()
})

it('syncs button aria-label with the visible history/view/collapse action and expanded state', async () => {
  mockRoutes(async (url: string) => {
    if (url === '/api/roster/evidence-impacts') return { rows: [row], nextCursor: null, asOf: {}, projectionReady: true }
    if (url === '/api/roster/evidence-impacts/4') return detailFor(row)
    if (url.endsWith('/sources')) return { rows: [], nextCursor: null, asOf: {} }
    if (url.endsWith('/history')) return { rows: [], total: 0, page: 1, pageSize: 25 }
    throw new Error('Unexpected request')
  })
  const view = renderEnterprise(); await flushPromises()
  const action = view.get('[aria-label="处理这一项 4"]')
  expect(action.attributes('aria-expanded')).toBe('false')
  expect(action.attributes('aria-controls')).toBeUndefined()
  await action.trigger('click'); await flushPromises()
  const collapse = view.get('[aria-label="收起复核项 4"]')
  expect(collapse.text()).toBe('收起复核项')
  expect(collapse.attributes('aria-expanded')).toBe('true')
  expect(collapse.attributes('aria-controls')).toBe('review-detail-4')
  view.unmount()

  mockRoutes(() => ({ rows: [{ ...row, lineage: 'historical', oldDecision: { ...row.oldDecision, isCurrent: false } }], nextCursor: null, asOf: {}, projectionReady: true }))
  const history = renderEnterprise(); await flushPromises()
  expect(history.get('[aria-label="查看历史项 4"]').text()).toBe('查看历史项')
  history.unmount()
})

it('offers continue/discard before collapsing or reselecting an inline draft and keeps the original item on continue', async () => {
  mockRoutes(async (url: string) => {
    if (url === '/api/roster/evidence-impacts') return { rows: [row, { ...row, id: 5, decisionId: 83, oldDecision: { ...row.oldDecision, id: 83, reasonNote: '第二项原依据' } }], nextCursor: null, asOf: {}, projectionReady: true }
    if (url === '/api/roster/evidence-impacts/4') return detailFor(row)
    if (url === '/api/roster/evidence-impacts/5') return detailFor({ ...row, id: 5, decisionId: 83, oldDecision: { ...row.oldDecision, id: 83 } })
    if (url.endsWith('/sources')) return { rows: [], nextCursor: null, asOf: {} }
    if (url.endsWith('/history')) return { rows: [], total: 0, page: 1, pageSize: 25 }
    throw new Error('Unexpected request: ' + url)
  })
  const view = renderEnterprise(); await flushPromises()
  await openAndFill(view)
  expect((view.get('[aria-label="复核依据"]').element as HTMLTextAreaElement).value).toContain('核对新查询')

  await view.get('[aria-label="收起复核项 4"]').trigger('click'); await flushPromises()
  expect(view.text()).toContain('收起会丢弃未提交内容')
  await clickText(view, '继续填写').trigger('click'); await flushPromises()
  expect(view.get('[aria-label="收起复核项 4"]').attributes('aria-expanded')).toBe('true')
  expect((view.get('[aria-label="复核依据"]').element as HTMLTextAreaElement).value).toContain('核对新查询')

  await view.get('[aria-label="处理这一项 5"]').trigger('click'); await flushPromises()
  expect(view.text()).toContain('切换复核项会丢弃未提交内容')
  await clickText(view, '继续填写').trigger('click'); await flushPromises()
  expect(view.get('[aria-label="收起复核项 4"]').attributes('aria-expanded')).toBe('true')
  expect(view.get('[aria-label="处理这一项 5"]').attributes('aria-expanded')).toBe('false')

  await view.get('[aria-label="处理这一项 5"]').trigger('click'); await flushPromises()
  await clickText(view, '切换并丢弃').trigger('click'); await flushPromises()
  expect(view.get('[aria-label="收起复核项 5"]').attributes('aria-expanded')).toBe('true')
  expect(view.get('[aria-label="处理这一项 4"]').attributes('aria-expanded')).toBe('false')

  await view.get('[aria-label="复核依据"]').setValue('第五项未提交草稿')
  await flushPromises()
  await view.get('[aria-label="收起复核项 5"]').trigger('click'); await flushPromises()
  await clickText(view, '收起并丢弃').trigger('click'); await flushPromises()
  expect(view.find('[aria-label="收起复核项 5"]').exists()).toBe(false)
  await view.get('[aria-label="处理这一项 5"]').trigger('click'); await flushPromises()
  expect((view.get('[aria-label="复核依据"]').element as HTMLTextAreaElement).value).toBe('')
  view.unmount()
})

it('guards filter and page changes, keeping the original query when the user continues editing', async () => {
  mockRoutes(async (url: string, options: any) => {
    if (url === '/api/roster/evidence-impacts') {
      if (options.query.state === 'reviewed') return { rows: [], nextCursor: null, asOf: {}, projectionReady: true }
      if (options.query.cursor === 'page-2') return { rows: [], nextCursor: null, asOf: {}, projectionReady: true }
      return { rows: [row], nextCursor: 'page-2', asOf: {}, projectionReady: true }
    }
    if (url === '/api/roster/evidence-impacts/4') return detailFor(row)
    if (url.endsWith('/sources')) return { rows: [], nextCursor: null, asOf: {} }
    if (url.endsWith('/history')) return { rows: [], total: 0, page: 1, pageSize: 25 }
    throw new Error('Unexpected request: ' + url)
  })
  const view = renderEnterprise(); await flushPromises()
  await openAndFill(view)
  choose(view, '复核状态', 'reviewed')
  await view.get('form').trigger('submit'); await flushPromises()
  expect(view.text()).toContain('更改筛选会丢弃未提交内容')
  await clickText(view, '继续填写').trigger('click'); await flushPromises()
  expect(view.text()).toContain('显示来源：第 1 页 · 企业 #7 · 全部称号 · 全部方向 · 事件 全部')
  expect(view.find('[aria-label="收起复核项 4"]').exists()).toBe(true)
  expect(fetcher.mock.calls.some(call => call[1]?.query?.state === 'reviewed')).toBe(false)

  await view.get('form').trigger('submit'); await flushPromises()
  await clickText(view, '应用筛选并丢弃').trigger('click'); await flushPromises()
  expect(fetcher.mock.calls.some(call => call[1]?.query?.state === 'reviewed')).toBe(true)
  expect(view.get('[data-testid="review-empty"]').text()).toContain('当前筛选下没有复核项')
  view.unmount()

  mockRoutes(async (url: string, options: any) => {
    if (url === '/api/roster/evidence-impacts') {
      if (options.query.cursor === 'page-2') return { rows: [], nextCursor: null, asOf: {}, projectionReady: true }
      return { rows: [row], nextCursor: 'page-2', asOf: {}, projectionReady: true }
    }
    if (url === '/api/roster/evidence-impacts/4') return detailFor(row)
    if (url.endsWith('/sources')) return { rows: [], nextCursor: null, asOf: {} }
    if (url.endsWith('/history')) return { rows: [], total: 0, page: 1, pageSize: 25 }
    throw new Error('Unexpected request: ' + url)
  })
  const paged = renderEnterprise(); await flushPromises()
  await openAndFill(paged)
  await paged.get('[aria-label="下一页复核项"]').trigger('click'); await flushPromises()
  expect(paged.text()).toContain('翻页会丢弃未提交内容')
  await clickText(paged, '继续填写').trigger('click'); await flushPromises()
  expect(paged.text()).toContain('显示来源：第 1 页')
  await paged.get('[aria-label="下一页复核项"]').trigger('click'); await flushPromises()
  await clickText(paged, '下一页并丢弃').trigger('click'); await flushPromises()
  expect(paged.text()).toContain('显示来源：第 2 页')
  expect(paged.get('[data-testid="review-empty"]').text()).toContain('本页没有复核项')
  paged.unmount()
})

it('hides the whole pager on a successful single page but keeps it for multiple pages and failures', async () => {
  mockRoutes(() => ({ rows: [row], nextCursor: null, asOf: {}, projectionReady: true }))
  const single = renderEnterprise(); await flushPromises()
  expect(single.text()).not.toContain('每页最多 25 项')
  expect(single.findAll('button').some(button => button.text() === '上一页')).toBe(false)
  expect(single.findAll('button').some(button => button.text() === '下一页')).toBe(false)
  expect(single.findAll('button').some(button => button.text() === '重新读取清单')).toBe(true)
  single.unmount()

  mockRoutes(() => ({ rows: [row], nextCursor: 'page-2', asOf: {}, projectionReady: true }))
  const multi = renderEnterprise(); await flushPromises()
  expect(multi.text().split('每页最多 25 项')).toHaveLength(2)
  expect(multi.find('[aria-label="下一页复核项"]').exists()).toBe(true)
  multi.unmount()

  mockRoutes(() => { throw new Error('private failure') })
  const failed = renderEnterprise(); await flushPromises()
  expect(failed.find('[data-testid="retry-review-page"]').exists()).toBe(true)
  expect(failed.text()).toContain('每页最多 25 项')
  expect(failed.find('[aria-label="下一页复核项"]').exists()).toBe(true)
  failed.unmount()
})

it('guards an explicit restart and clears the visible draft only after discard', async () => {
  mockRoutes(async (url: string) => {
    if (url === '/api/roster/evidence-impacts') return { rows: [row], nextCursor: null, asOf: {}, projectionReady: true }
    if (url === '/api/roster/evidence-impacts/4') return detailFor(row)
    if (url.endsWith('/sources')) return { rows: [], nextCursor: null, asOf: {} }
    if (url.endsWith('/history')) return { rows: [], total: 0, page: 1, pageSize: 25 }
    throw new Error('Unexpected request: ' + url)
  })
  const view = render(); await flushPromises()
  await openAndFill(view)
  await clickText(view, '重新读取清单').trigger('click'); await flushPromises()
  expect(view.text()).toContain('翻页会丢弃未提交内容')
  await clickText(view, '继续填写').trigger('click'); await flushPromises()
  expect((view.get('[aria-label="复核依据"]').element as HTMLTextAreaElement).value).toContain('核对新查询')
  const before = fetcher.mock.calls.filter(call => call[0] === '/api/roster/evidence-impacts').length
  await clickText(view, '重新读取清单').trigger('click'); await flushPromises()
  await clickText(view, '重新读取并丢弃').trigger('click'); await flushPromises()
  expect(view.find('[aria-label="复核依据"]').exists()).toBe(false)
  expect(fetcher.mock.calls.filter(call => call[0] === '/api/roster/evidence-impacts').length).toBeGreaterThan(before)
  view.unmount()
})
