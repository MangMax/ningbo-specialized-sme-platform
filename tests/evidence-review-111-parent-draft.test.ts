// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import { afterEach, expect, it, vi } from 'vitest'
import EnterpriseExplanations from '../components/evidence-review/EnterpriseExplanations.vue'

const assessment = {
  enterpriseId: 7,
  titleCode: 'specialized_sme',
  direction: 'missing_in_miit',
  queryCoverage: { status: 'complete', sources: [], truncated: false },
  currentDecision: { enterpriseId: 7, titleCode: 'specialized_sme', direction: 'missing_in_miit', versionId: 82, current: { id: 82, status: 'confirmed_reason', reasonCode: 'other', reasonNote: '当前原因', measureCode: 'none' } },
  explanationValidity: { status: 'not_applicable' },
  assessment: 'decided',
}
const row = {
  id: 4, enterpriseId: 7, titleCode: 'specialized_sme', direction: 'missing_in_miit',
  decisionId: 82, latestRevisionId: 9, reviewedRevisionId: null, classification: 'evidence_changed',
  pending: true, lineage: 'current',
  oldDecision: { id: 82, status: 'confirmed_reason', reasonCode: 'other', measureCode: 'none', reasonNote: '待复核原因' },
}
const detail = {
  ...row,
  currentDecision: { versionId: 82, current: row.oldDecision },
  evidenceToken: { decisionId: 82, latestRevisionId: 9, projectionReady: true },
  queryCoverage: null,
  gaps: { subjectUnknown: false, projectionReady: true },
  reviewedBaseline: null,
}
const dialogStubs = {
  Dialog: { props: ['open'], template: '<div v-if="open"><slot /></div>' },
  DialogContent: { template: '<div data-testid="dialog-content"><slot /></div>' },
  DialogHeader: { template: '<div><slot /></div>' },
  DialogTitle: { template: '<h2><slot /></h2>' },
  DialogDescription: { template: '<p><slot /></p>' },
  DialogFooter: { template: '<div><slot /></div>' },
}

afterEach(() => vi.unstubAllGlobals())

async function mountParent() {
  vi.stubGlobal('$fetch', vi.fn(async (url: string, options?: any) => {
    if (url.endsWith('/profile')) return { profile: { enterpriseId: 7, name: '合成企业7' } }
    if (url === '/api/roster/evidence-impacts') return { rows: [row], nextCursor: null, asOf: { revision: 9 }, projectionReady: true }
    if (url === '/api/roster/evidence-impacts/4') return detail
    if (url.endsWith('/sources')) return { rows: [], nextCursor: null, asOf: {} }
    if (url.endsWith('/history')) return { rows: [], total: 0, page: 1, pageSize: 25 }
    throw new Error('Unexpected request: ' + url)
  }))
  const view = mount(EnterpriseExplanations, {
    props: { enterpriseId: 7, assessments: [assessment] as any },
    global: { plugins: [createPinia(), PiniaColada], stubs: { NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' }, ...dialogStubs } },
  })
  const trigger = () => view.findAll('button').find(button => button.text().includes('企业全部复核记录'))!
  await trigger().trigger('click')
  await flushPromises(); await flushPromises()
  return { view, trigger }
}
function clickText(view: ReturnType<typeof mount>, text: string) {
  const button = view.findAll('button').find(candidate => candidate.text() === text)
  if (!button) throw new Error(`Button not found: ${text}`)
  return button
}

it('keeps the inline draft mounted across parent collapse and clears it only on explicit discard', async () => {
  const { view, trigger } = await mountParent()
  await view.get('[aria-label="处理这一项 4"]').trigger('click'); await flushPromises()
  for (const [label, value] of [['写入凭证', 'synthetic-token'], ['复核人', 'parent-reviewer'], ['复核依据', '父级折叠前填写的依据'], ['规则版本', 'parent-rule']]) {
    await view.get(`[aria-label="${label}"]`).setValue(value)
  }
  await flushPromises()

  await trigger().trigger('click'); await flushPromises()
  expect(trigger().attributes('aria-expanded')).toBe('false')
  expect(view.find('[aria-label="复核依据"]').exists()).toBe(true)
  expect((view.get('[aria-label="复核依据"]').element as HTMLTextAreaElement).value).toBe('父级折叠前填写的依据')

  await trigger().trigger('click'); await flushPromises()
  expect(trigger().attributes('aria-expanded')).toBe('true')
  expect(view.get('[aria-label="收起复核项 4"]').attributes('aria-expanded')).toBe('true')
  expect((view.get('[aria-label="复核人"]').element as HTMLInputElement).value).toBe('parent-reviewer')
  expect((view.get('[aria-label="规则版本"]').element as HTMLInputElement).value).toBe('parent-rule')

  await view.get('[aria-label="收起复核项 4"]').trigger('click'); await flushPromises()
  expect(view.text()).toContain('收起会丢弃未提交内容')
  await clickText(view, '收起并丢弃').trigger('click'); await flushPromises()
  expect(view.find('[aria-label="复核依据"]').exists()).toBe(false)

  await view.get('[aria-label="处理这一项 4"]').trigger('click'); await flushPromises()
  expect((view.get('[aria-label="复核依据"]').element as HTMLTextAreaElement).value).toBe('')
  expect((view.get('[aria-label="复核人"]').element as HTMLInputElement).value).toBe('')
  view.unmount()
})
