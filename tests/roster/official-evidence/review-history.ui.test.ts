// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import { afterEach, expect, it, vi } from 'vitest'
import DecisionHistory from '../../../components/evidence-review/DecisionHistory.vue'

afterEach(() => vi.unstubAllGlobals())

it('shows how each decision version was formed from actual history fields', async () => {
  const fetcher = vi.fn().mockResolvedValue({
    rows: [
      { id: 5, recordedAt: '2026-10-19T17:58:00Z', status: 'confirmed_reason', reasonCode: 'other', measureCode: 'none', lifecycleAction: 'replace', previousId: 2, isCurrent: true, origin: 'lifecycle' },
      { id: 2, recordedAt: '2026-10-19T17:50:00Z', status: 'confirmed_reason', reasonCode: 'other', measureCode: 'manual_review', lifecycleAction: 'replace', previousId: null, isCurrent: false, origin: 'lifecycle' },
      { id: 1, recordedAt: '2026-10-01T00:00:00Z', status: 'not_queried', reasonCode: null, measureCode: 'manual_review', lifecycleAction: null, previousId: null, isCurrent: false, origin: 'legacy_import' },
    ],
    total: 3,
    page: 1,
    pageSize: 25,
  })
  vi.stubGlobal('$fetch', fetcher)
  const view = mount(DecisionHistory, {
    props: { scope: { enterpriseId: 4, titleCode: 'specialized_sme', direction: 'missing_in_miit' } },
    global: { plugins: [createPinia(), PiniaColada] },
  })
  await flushPromises()

  expect(fetcher).toHaveBeenCalledWith('/api/roster/decision-lifecycle/history', {
    query: { enterpriseId: 4, titleCode: 'specialized_sme', direction: 'missing_in_miit', page: 1, pageSize: 25 },
  })
  expect(view.text()).toContain('追加更正 · 原决定 #2 保留')
  expect(view.text()).toContain('首次决定')
  expect(view.text()).toContain('历史导入 · 未纳入受管生命周期')
  expect(view.text()).toContain('已确认原因 · 其他 · 无需措施')
  expect(view.text()).toContain('维持原决定只登记复核，不新增决定版本')
  // 三个决定版本，没有把 maintain 伪造成第四个版本。
  expect(view.get('section[aria-label="决定历史"] ul').findAll('li')).toHaveLength(3)
  view.unmount()
})
