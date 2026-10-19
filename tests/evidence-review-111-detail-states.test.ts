// @vitest-environment happy-dom
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import { defineComponent, nextTick } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import EvidenceReviewDetail from '../components/evidence-review/EvidenceReviewDetail.vue'

enableAutoUnmount(afterEach)

type DetailSource = Record<string, unknown> | (() => Record<string, unknown>)

const decision = (id: number, patch: Record<string, unknown> = {}) => ({
  id,
  status: 'confirmed_reason',
  reasonCode: 'other',
  reasonNote: `原原因 #${id}`,
  measureCode: 'none',
  measureNote: `原措施 #${id}`,
  ruleVersion: 'rule-v1',
  effectiveAt: '2026-10-19T00:00:00.000Z',
  recordedAt: '2026-10-19T00:00:00.000Z',
  ...patch,
})

const baseDetail = (patch: Record<string, unknown> = {}) => ({
  id: 4,
  enterpriseId: 7,
  titleCode: 'specialized_sme',
  direction: 'missing_in_miit',
  decisionId: 82,
  latestRevisionId: 9,
  reviewedRevisionId: null,
  classification: 'premise_invalid',
  pending: true,
  lineage: 'current',
  oldDecision: decision(82),
  currentDecision: { versionId: 82, current: decision(82) },
  evidenceToken: { decisionId: 82, latestRevisionId: 9, projectionReady: true },
  queryCoverage: null,
  gaps: { subjectUnknown: false, projectionReady: true },
  reviewedBaseline: null,
  ...patch,
})

const reviewedMaintain = baseDetail({
  pending: false,
  decisionId: 12,
  latestRevisionId: 14,
  reviewedRevisionId: 14,
  oldDecision: decision(12),
  currentDecision: { versionId: 12, current: decision(12) },
  evidenceToken: { decisionId: 12, latestRevisionId: 14, projectionReady: true },
  reviewedBaseline: {
    reviewedRevisionId: 14,
    actor: { type: 'user', id: 'baseline-reviewer' },
    basis: '已核验新证据，维持原决定',
    ruleVersion: 'review-rule-2026',
    effectiveAt: '2026-10-19T09:00:00.000Z',
    recordedAt: '2026-10-19T09:01:00.000Z',
  },
})

const reviewedReplace = baseDetail({
  pending: false,
  decisionId: 11,
  latestRevisionId: 13,
  reviewedRevisionId: 13,
  oldDecision: decision(11),
  currentDecision: {
    versionId: 36,
    current: decision(36, { lifecycleAction: 'replace', previousId: 11 }),
  },
  evidenceToken: { decisionId: 11, latestRevisionId: 13, projectionReady: true },
  reviewedBaseline: {
    reviewedRevisionId: 13,
    actor: { type: 'user', id: 'replace-reviewer' },
    basis: '人工核验后追加更正',
    ruleVersion: 'review-rule-2026',
    effectiveAt: '2026-10-19T10:00:00.000Z',
    recordedAt: '2026-10-19T10:01:00.000Z',
  },
})

const sourceRow = {
  revisionId: 9,
  sourceKind: 'platform_query',
  sourceKey: 'query-9',
  sourceVersion: 'v2',
  classification: 'premise_invalid',
  eventId: null,
  coverageChanged: true,
  factChanged: false,
}

function resolve(source: DetailSource) {
  return typeof source === 'function' ? source() : source
}

function mountDetail(before: DetailSource, after: DetailSource = before, sources = [sourceRow]) {
  let posted = false
  const fetcher = vi.fn(async (url: string, options?: any) => {
    if (options?.method === 'POST') {
      posted = true
      return { reviewedRevisionId: 9 }
    }
    if (url === '/api/roster/evidence-impacts/4') return resolve(posted ? after : before)
    if (url === '/api/roster/evidence-impacts/4/sources') return { rows: sources, nextCursor: null, asOf: { revision: 9 } }
    if (url === '/api/roster/decision-lifecycle/history') {
      return {
        rows: [{ id: 12, status: 'confirmed_reason', reasonCode: 'other', measureCode: 'none', recordedAt: '2026-10-19T00:00:00.000Z', lifecycleAction: null, previousId: null, isCurrent: true }],
        total: 1,
        page: 1,
        pageSize: 25,
      }
    }
    throw new Error('Unexpected request: ' + url)
  })
  vi.stubGlobal('$fetch', fetcher)
  const Host = defineComponent({
    components: { EvidenceReviewDetail },
    template: '<div><div id="review-sheet-footer"></div><EvidenceReviewDetail :impact-id="4" form-footer /></div>',
  })
  const view = mount(Host, { attachTo: document.body, global: { plugins: [createPinia(), PiniaColada], stubs: { NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' } } } })
  return { view, fetcher }
}

async function fill(view: ReturnType<typeof mount>) {
  await view.get('[aria-label="写入凭证"]').setValue('synthetic-token')
  await view.get('[aria-label="复核人"]').setValue('reviewer-7')
  await view.get('[aria-label="复核依据"]').setValue('核对新查询并保留原业务判断')
  await view.get('[aria-label="规则版本"]').setValue('manual-2026')
}

async function submit(view: ReturnType<typeof mount>) {
  await view.get('form').trigger('submit')
  await flushPromises()
  await flushPromises()
  await nextTick()
}

beforeEach(() => { document.body.innerHTML = '' })
afterEach(() => vi.unstubAllGlobals())

it('shows a reviewed receipt and decision history before sources, with no disabled form or fake resubmit entry', async () => {
  const { view } = mountDetail(reviewedMaintain)
  await flushPromises()
  expect(view.find('form').exists()).toBe(false)
  expect(view.find('[data-testid="review-readonly"]').exists()).toBe(false)
  expect(view.get('[data-testid="reviewed-baseline"]').text()).toContain('复核至修订 #14')
  expect(view.get('[data-testid="reviewed-baseline"]').text()).toContain('baseline-reviewer')
  expect(view.find('button[type="submit"]').exists()).toBe(false)
  expect(view.get('#review-sheet-footer').element.childElementCount).toBe(0)
  const baseline = view.get('[data-testid="reviewed-baseline"]').element
  const history = view.get('[aria-label="决定历史"]').element
  const sources = view.get('[aria-label="证据变化来源"]').element
  expect(baseline.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(history.compareDocumentPosition(sources) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(view.text()).not.toContain('复核原决定')
})

it('does not invent a receipt or a resubmit entry when a reviewed item has no reviewedBaseline', async () => {
  const { view } = mountDetail({ ...reviewedMaintain, reviewedBaseline: null })
  await flushPromises()
  expect(view.find('form').exists()).toBe(false)
  expect(view.get('[data-testid="reviewed-without-receipt"]').text()).toContain('不提供再次提交入口')
  expect(view.find('[data-testid="reviewed-baseline"]').exists()).toBe(false)
  expect(view.find('button[type="submit"]').exists()).toBe(false)
})

it.each([
  { name: 'historical', patch: { lineage: 'historical' }, expected: '历史、撤回或归并' },
  { name: 'projection-not-ready', patch: { evidenceToken: { decisionId: 82, latestRevisionId: 9, projectionReady: false } }, expected: '影响检查尚未完成' },
])('keeps a pending $name item explicitly read-only with a disabled form that retains its draft', async ({ patch, expected }) => {
  const { view } = mountDetail(baseDetail(patch))
  await flushPromises()
  expect(view.find('form').exists()).toBe(true)
  expect(view.get('[data-testid="review-readonly"]').text()).toContain(expected)
  expect(view.get('#review-sheet-footer button[type="submit"]').attributes('disabled')).toBeDefined()
})

it('renders the form for a genuinely eligible current pending item', async () => {
  const { view } = mountDetail(baseDetail())
  await flushPromises()
  expect(view.find('form').exists()).toBe(true)
  expect(view.find('[data-testid="review-readonly"]').exists()).toBe(false)
})

it('reads maintain back and shows the receipt/current decision without claiming a refresh it did not read', async () => {
  const { view } = mountDetail(baseDetail(), reviewedMaintain)
  await flushPromises()
  await fill(view)
  await submit(view)
  expect(view.find('form').exists()).toBe(false)
  const notice = view.get('#review-sheet-footer [data-testid="review-save-notice"]')
  expect(notice.text()).toContain('复核已登记')
  expect(notice.text()).toContain('复核至修订 #14')
  expect(notice.text()).toContain('当前决定 #12 未变')
  expect(notice.text()).toContain('原原因与措施保留')
  expect(document.activeElement).toBe(notice.element)
  expect(view.get('[data-testid="reviewed-baseline"]').text()).toContain('baseline-reviewer')
})

it('reads replace back with the new current decision and preserves the previous decision coordinates', async () => {
  const { view } = mountDetail(baseDetail(), reviewedReplace)
  await flushPromises()
  await fill(view)
  await submit(view)
  const notice = view.get('#review-sheet-footer [data-testid="review-save-notice"]')
  expect(notice.text()).toContain('复核已登记')
  expect(notice.text()).toContain('复核至修订 #13')
  expect(notice.text()).toContain('当前决定 #36（追加更正）；复核前决定 #11 保留')
  expect(view.text()).toContain('原原因 #11')
  expect(view.text()).toContain('原措施 #11')
  expect(view.text()).toContain('当前决定 #36')
  expect(view.find('form').exists()).toBe(false)
})

it('does not call a successful write registered when the current state cannot be read back', async () => {
  const { view, fetcher } = mountDetail(baseDetail(), () => { throw new Error('readback unavailable') })
  await flushPromises()
  await fill(view)
  await submit(view)
  const notice = view.get('[data-testid="review-save-notice"]')
  expect(notice.text()).toContain('当前状态尚未确认')
  expect(notice.text()).toContain('未确认前不视为已登记复核')
  expect(view.text()).not.toContain('复核已登记')
  expect(fetcher.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(1)
  expect(view.get('#review-sheet-footer button[type="submit"]').attributes('disabled')).toBeDefined()
  await view.get('form').trigger('submit')
  await flushPromises()
  expect(fetcher.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(1)
})
