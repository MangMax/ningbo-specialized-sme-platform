// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { PiniaColada, useQueryCache } from '@pinia/colada'
import { afterEach, expect, it, vi } from 'vitest'
import DecisionHistory from '../components/evidence-review/DecisionHistory.vue'
const scope = { enterpriseId: 7, titleCode: 'specialized_sme', direction: 'missing_in_miit' } as const
const original = { id: 82, status: 'confirmed_reason', reasonNote: '已读出的原原因', measureNote: '已读出的原措施', actor: { type: 'user', id: 'original-author' }, basis: '原审计依据', ruleVersion: 'original-rule', recordedAt: '2026-10-01' }
afterEach(() => vi.unstubAllGlobals())
it('retains immutable text ID and audit after same-version background failure and retries the selected version', async () => {
  let fail = false
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith('/history')) return { rows: [{ id: 82 }, { id: 90 }], total: 2, page: 1, pageSize: 25 }
    if (fail) throw new Error('private transport diagnostic')
    return url.endsWith('/82') ? original : { ...original, id: 90, reasonNote: '另一个版本原文' }
  })
  vi.stubGlobal('$fetch', fetcher)
  const pinia = createPinia(), view = mount(DecisionHistory, { props: { scope }, global: { plugins: [pinia, PiniaColada] } })
  const cache = useQueryCache(pinia)
  await flushPromises()
  await view.get('[aria-label="查看历史决定 82"]').trigger('click'); await flushPromises()
  expect(view.text()).toContain('已读出的原原因')
  fail = true
  await cache.invalidateQueries({ key: ['decision-version', 82] }).catch(() => undefined); await flushPromises()
  expect(view.text()).toContain('历史决定原文读取失败')
  for (const text of ['历史决定 #82', '已读出的原原因', '已读出的原措施', 'original-author', '原审计依据', 'original-rule']) expect(view.text()).toContain(text)
  expect(view.text()).not.toContain('private transport diagnostic')
  fail = false
  await view.get('[data-testid="table-retry"]').trigger('click'); await flushPromises()
  expect(view.text()).not.toContain('历史决定原文读取失败')
  expect(fetcher).toHaveBeenLastCalledWith('/api/roster/decision-lifecycle/82')
  view.unmount()
})
it('hides the full pager when a scope has only one history page', async () => {
  vi.stubGlobal('$fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/history')) return { rows: [{ id: 82, recordedAt: '2026-10-01', lifecycleAction: null }], total: 1, page: 1, pageSize: 25 }
    throw new Error('Unexpected request: ' + url)
  }))
  const view = mount(DecisionHistory, { props: { scope }, global: { plugins: [createPinia(), PiniaColada] } })
  await flushPromises()
  expect(view.text()).toContain('共 1 个版本')
  expect(view.find('[data-testid="table-pagination"]').exists()).toBe(false)
  view.unmount()
})
it('labels the retained successful source separately from a changed failed target and clears it on scope navigation', async () => {
  let fail = true
  vi.stubGlobal('$fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/history')) return { rows: [{ id: 82 }, { id: 90 }], total: 2, page: 1, pageSize: 25 }
    if (url.endsWith('/90') && fail) throw new Error('unavailable')
    return url.endsWith('/82') ? original : { ...original, id: 90, reasonNote: '另一个版本原文' }
  }))
  const view = mount(DecisionHistory, { props: { scope }, global: { plugins: [createPinia(), PiniaColada] } }); await flushPromises()
  await view.get('[aria-label="查看历史决定 82"]').trigger('click'); await flushPromises()
  await view.get('[aria-label="查看历史决定 90"]').trigger('click'); await flushPromises()
  expect(view.text()).toContain('读取目标：历史决定 #90')
  expect(view.text()).toContain('显示来源：历史决定 #82')
  expect(view.text()).toContain('已读出的原原因')
  fail = false
  await view.get('[data-testid="table-retry"]').trigger('click'); await flushPromises()
  expect(view.text()).toContain('历史决定 #90')
  expect(view.text()).toContain('另一个版本原文')
  expect(view.text()).not.toContain('已读出的原原因')
  await view.setProps({ scope: { ...scope, enterpriseId: 8 } }); await flushPromises()
  expect(view.text()).not.toContain('另一个版本原文')
  view.unmount()
})
