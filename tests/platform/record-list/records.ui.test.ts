// @vitest-environment jsdom
import { mount, flushPromises } from '@vue/test-utils'
import { expect, it } from 'vitest'
import Provenance from '../../../layers/sme-roster/app/components/PlatformQueryProvenance.vue'
import type { PlatformCollectionCoverage } from '../../../layers/sme-roster/lib/platform/read'

it('shows retained pagination and complete query scope in historical provenance', async () => {
  const queriedAt = '2026-11-06T02:08:47.038Z'
  const coverage: PlatformCollectionCoverage = {
    source: 'businessList',
    status: 'success',
    queriedAt,
    completedAt: '2026-11-06T02:09:00.000Z',
    completeness: 'complete',
    fullRange: true,
    fetchedCount: 7,
    declaredTotal: 7,
    titleScope: { mode: 'selected', rdjb: ['1', '2', '3'] },
    effectiveConditions: { uscc: '91330211255994457P', combination: 'and' },
    pages: [{ source: 'businessList', rdjb: '3', page: 2, status: 'success', fetchedCount: 7, declaredTotal: 7, error: null }],
    limits: { maxRequests: 10, maxRows: 200, maxDurationMs: 1000, pageSize: 50 },
    unfinished: [],
    error: null,
  }
  const view = mount(Provenance, { props: {
    sourceLabel: '关联记录',
    queries: [{ id: 1, interface: 'business_list', queryKey: '91330211255994457P', rdjb: '1,2,3', queriedAt,
      status: 'success', relationCount: 7, failureReason: null, collectionEvidence: coverage }],
  } })
  try {
    await view.get('button').trigger('click')
    await flushPromises()
    const details = view.get('[data-testid="platform-query-provenance"]')
    expect(details.text()).toContain('所请求范围完整')
    expect(details.text()).toContain('第 2 页')
    expect(details.text()).toContain('已采集 7 条')
    expect(details.text()).not.toContain('完整性未知')
  } finally {
    view.unmount()
  }
})
