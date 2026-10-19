// @vitest-environment happy-dom
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import EvidenceReviewForm from '../components/evidence-review/EvidenceReviewForm.vue'
import { Select } from '../components/ui/select'
const detail = { id: 4, enterpriseId: 7, titleCode: 'specialized_sme', direction: 'missing_in_miit', decisionId: 82, lineage: 'current', pending: true, oldDecision: { id: 82, reasonNote: '原决定' }, currentDecision: { versionId: 82, current: { id: 82 } }, evidenceToken: { latestRevisionId: 9, decisionId: 82, projectionReady: true }, gaps: {} }
enableAutoUnmount(afterEach)
let fetcher: ReturnType<typeof vi.fn>
beforeEach(() => { fetcher = vi.fn().mockResolvedValue({ reviewedRevisionId: 9 }); vi.stubGlobal('$fetch', fetcher) })
afterEach(() => vi.unstubAllGlobals())
function render(patch = {}) {
  const pinia = createPinia()
  return mount(EvidenceReviewForm, { props: { detail: { ...detail, ...patch } as any }, global: { plugins: [pinia, PiniaColada] } })
}
function selectByLabel(view: ReturnType<typeof render>, label: string) {
  const select = view.findAllComponents(Select).find(candidate => candidate.find(`[aria-label="${label}"]`).exists())
  if (!select) throw new Error(`Select not found: ${label}`)
  return select
}
async function fill(view: ReturnType<typeof render>) {
  await view.get('[aria-label="写入凭证"]').setValue('synthetic-token')
  await view.get('[aria-label="复核人"]').setValue('reviewer-7')
  await view.get('[aria-label="复核依据"]').setValue('核对新查询并保留原业务判断')
  await view.get('[aria-label="规则版本"]').setValue('manual-2026')
}
it('keeps public review unsubmittable until a write credential and explicit review inputs exist', async () => {
  const view = render()
  expect(view.text()).toContain('当前不可提交')
  await view.get('form').trigger('submit')
  expect(fetcher).not.toHaveBeenCalled()
  expect(view.get('button[type="submit"]').attributes('disabled')).toBeDefined()
})
it('maintains the exact decision with live evidence and no replacement reason', async () => {
  const view = render(); await fill(view)
  await view.get('form').trigger('submit'); await flushPromises()
  expect(fetcher).toHaveBeenCalledWith('/api/roster/decision-lifecycle/commands', expect.objectContaining({ method: 'POST', headers: { authorization: 'Bearer synthetic-token' }, body: expect.objectContaining({ action: 'maintain', enterpriseId: 7, titleCode: 'specialized_sme', direction: 'missing_in_miit', expectedCurrentId: 82, reviewedEvidence: { latestRevisionId: 9, projectionReady: true }, actor: { type: 'user', id: 'reviewer-7' } }) }))
  expect(fetcher.mock.calls[0]![1].body).not.toHaveProperty('decision')
  expect(view.emitted('saved')).toHaveLength(1)
  expect(view.html()).not.toContain('Bearer synthetic-token')
})
it('preserves pending and the draft on failure and reuses the same retry envelope', async () => {
  fetcher.mockRejectedValueOnce({ data: { error: { code: 'transaction_failed', message: 'Bearer synthetic-token' } } })
  const view = render(); await fill(view)
  await view.get('form').trigger('submit'); await flushPromises()
  expect(view.text()).toContain('待复核状态保留')
  expect(view.text()).not.toContain('Bearer synthetic-token')
  expect(view.emitted('saved')).toBeUndefined()
  expect((view.get('[aria-label="复核依据"]').element as HTMLTextAreaElement).value).toContain('核对新查询')
  const first = fetcher.mock.calls[0]![1].body
  await view.get('form').trigger('submit'); await flushPromises()
  expect(fetcher.mock.calls[1]![1].body).toEqual(first)
  expect(view.emitted('saved')).toHaveLength(1)
})
it.each([{ code: 'stale_version', message: '决定版本冲突' }, { code: 'stale_evidence', message: '证据版本冲突' }])('requires a live reread after $code without completing the pending item', async ({ code, message }) => {
  fetcher.mockRejectedValueOnce({ data: { error: { code } } })
  const view = render(); await fill(view); await view.get('form').trigger('submit'); await flushPromises()
  expect(view.text()).toContain(message)
  expect(view.emitted('saved')).toBeUndefined()
  expect(view.get('button[type="submit"]').attributes('disabled')).toBeDefined()
  await view.get('button[type="button"]').trigger('click')
  expect(view.emitted('reload')).toHaveLength(1)
  await view.setProps({ detail: { ...detail, evidenceToken: { ...detail.evidenceToken, latestRevisionId: 10 } } as any })
  expect((view.get('[aria-label="复核依据"]').element as HTMLTextAreaElement).value).toContain('核对新查询')
  await view.get('form').trigger('submit'); await flushPromises()
  expect(fetcher.mock.calls[1]![1].body.reviewedEvidence.latestRevisionId).toBe(10)
})
it('appends an explicit correction without selecting a reason automatically', async () => {
  const view = render(); await fill(view)
  await view.get('[value="replace"]').setValue(true)
  expect(selectByLabel(view, '更正原因').props('modelValue')).toBe('__unset')
  expect(view.get('button[type="submit"]').attributes('disabled')).toBeDefined()
  // 两个 Select 各自通过 defineModel 回写同一 draft；分两次刷新，避免后一次用旧对象覆盖前一次。
  selectByLabel(view, '更正原因').vm.$emit('update:modelValue', 'other')
  await flushPromises()
  selectByLabel(view, '更正措施').vm.$emit('update:modelValue', 'none')
  await flushPromises()
  await view.get('[aria-label="原因说明"]').setValue('人工核验后的更正')
  await view.get('form').trigger('submit'); await flushPromises()
  expect(fetcher.mock.calls[0]![1].body).toMatchObject({ action: 'replace', expectedCurrentId: 82, reviewedEvidence: { latestRevisionId: 9, projectionReady: true }, decision: { status: 'confirmed_reason', reasonCode: 'other', reasonNote: '人工核验后的更正', measureCode: 'none', verificationStatus: 'confirmed' } })
})
it('clears rejected credentials and leaves public reads intact', async () => {
  fetcher.mockRejectedValueOnce({ data: { error: { code: 'unauthorized', message: 'synthetic-token' } } })
  const view = render(); await fill(view); await view.get('form').trigger('submit'); await flushPromises()
  expect(view.text()).toContain('没有改判权限')
  expect((view.get('[aria-label="写入凭证"]').element as HTMLInputElement).value).toBe('')
  expect(view.emitted('saved')).toBeUndefined()
})
it.each([{ lineage: 'historical' }, { lineage: 'withdrawn' }, { lineage: 'merged' }])('does not submit a $lineage owner even with a credential', async ({ lineage }) => {
  const view = render({ lineage }); await fill(view); await view.get('form').trigger('submit')
  expect(fetcher).not.toHaveBeenCalled()
})
it('drops the in-memory credential when the page is hidden for navigation or browser cache', async () => {
  const view = render(); await fill(view)
  window.dispatchEvent(new Event('pagehide'))
  await flushPromises()
  expect((view.get('[aria-label="写入凭证"]').element as HTMLInputElement).value).toBe('')
  await view.get('form').trigger('submit')
  expect(fetcher).not.toHaveBeenCalled()
  view.unmount()
})
it('keeps unprocessed evidence read-only even when a write credential is supplied', async () => {
  const view = render({ evidenceToken: { ...detail.evidenceToken, projectionReady: false } }); await fill(view)
  await view.get('form').trigger('submit')
  expect(fetcher).not.toHaveBeenCalled()
  expect(view.text()).toContain('尚未完成影响检查')
  expect(view.get('button[type="submit"]').attributes('disabled')).toBeDefined()
})
