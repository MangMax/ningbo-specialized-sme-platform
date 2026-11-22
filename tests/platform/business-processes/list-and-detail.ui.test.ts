// @vitest-environment jsdom
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import PlatformBusinessProcessTable from '../../../layers/sme-roster/app/components/PlatformBusinessProcessTable.vue'
import PlatformBusinessProcessDetailDialog from '../../../layers/sme-roster/app/components/PlatformBusinessProcessDetailDialog.vue'
import type { BusinessProcessRow } from '../../../layers/sme-roster/lib/platform/business-processes'

const stubs = { NuxtLink: { props: ['to'], template: '<a :href="typeof to === \'string\' ? to : to.path"><slot /></a>' } }
const version = {
  versionId: 12, titleRaw: '2', declareKind: 'review', businessYear: 2023, appliedAt: '2023-02-01 09:00:00', status: '终审通过',
  batch: '2023-2', awardBatchLabel: '第三批', province: '浙江省', nameRaw: '甲办理企业', usccRaw: '91330211255994457P', ruleVersion: 'platform-business-v1',
}
const record: BusinessProcessRow = {
  kind: 'record',
  record: { id: 7, platformKey: 'SQ-2023-1', interface: 'business_list' },
  matchedVersion: version,
  matchedVersionCount: 1,
  versionCount: 1,
  observationCount: 2,
  latestObservationAt: '2026-10-02T00:00:00Z',
  enterpriseIds: [11],
  enterpriseNames: ['甲办理企业'],
  titleScopes: ['1', '3'],
  conflicts: [],
}
const isolated: BusinessProcessRow = {
  kind: 'observation', relationId: 9, queryId: 4, queriedAt: '2026-10-03T00:00:00Z', queryKey: 'name:无编号',
  queryStatus: 'success', sequenceNo: 1, identityState: 'missing_key', contentState: 'unverifiable',
  titleRaw: 'unknown-title', nameRaw: '无编号办理企业', usccRaw: null, declareKind: '补录', businessYear: null, appliedAt: null,
  status: null, batch: null, awardBatchLabel: null, province: null, titleScopes: ['2'], enterpriseId: null, enterpriseName: null,
}
const detail = {
  record: { id: 7, platformKey: 'SQ-2023-1', interface: 'business_list' as const, identityRuleVersion: 'platform-observation-v1', createdAt: '2026-10-01T00:00:00Z' },
  versions: [{ ...version, hashAlgorithm: 'platform-row-json-v1', contentHash: 'a'.repeat(64), createdAt: '2026-10-01T00:00:00Z', observationCount: 2, firstObservedAt: '2026-10-01T00:00:00Z', lastObservedAt: '2026-10-02T00:00:00Z', titleScopes: ['2'] }],
  observations: [{ relationId: 9, queryId: 4, queriedAt: '2026-10-01T00:00:00Z', queryKey: '91330211255994457P', queryStatus: 'success', sequenceNo: 1, enterpriseId: 11, enterpriseName: '甲办理企业', identityState: 'resolved' as const, contentState: 'verified' as const, keySource: 'both' as const, projectionRuleVersion: 'platform-observation-v1', versionId: 12, titleScopes: ['2'], correspondenceRefs: [{ id: 1, status: 'confirmed', revision: 2 }], version }],
  counts: { versions: 1, observations: 2, versionsTruncated: false, observationsTruncated: true },
}

describe('关联办理表格', () => {
  it('shows the row title even when its query scopes differ, then opens the record', async () => {
    const view = mount(PlatformBusinessProcessTable, { props: { view: 'records', rows: [record] }, global: { stubs } })
    try {
      expect(view.text()).not.toContain('SQ-2023-1')
      expect(view.text()).toContain('甲办理企业')
      expect(view.get('[data-testid=platform-business-process-row]').text()).toContain('专精特新中小企业')
      expect(view.get('[data-testid=platform-business-process-card]').text()).toContain('专精特新中小企业')
      expect(view.text()).not.toContain('创新型中小企业、专精特新“小巨人”')
      expect(view.text()).toContain('终审通过')
      expect(view.text()).toContain('2023-2')
      expect(view.text()).toContain('版本 1')
      expect(view.text()).not.toContain('1 / 2')
      await view.get('[data-testid="platform-business-process-row"] button').trigger('click')
      expect(view.emitted('open-record')?.[0]).toEqual([7])
      expect(view.find('[data-testid="platform-business-process-card"]').exists()).toBe(true)
    } finally { view.unmount() }
  })

  it('separates missing-key observations and links to the original query', async () => {
    const view = mount(PlatformBusinessProcessTable, { props: { view: 'isolated', rows: [isolated] }, global: { stubs } })
    try {
      expect(view.text()).toContain('缺少平台业务编号')
      expect(view.text()).toContain('原文内容无法核实')
      expect(view.text()).toContain('补录')
      expect(view.get('[data-testid=platform-business-process-isolated-row]').text()).toContain('unknown-title')
      expect(view.get('[data-testid="platform-business-process-isolated-row"] a').attributes('href')).toBe('/platform-queries')
    } finally { view.unmount() }
  })
})

describe('关联办理详情', () => {
  it('renders versions and title scopes without observation rows or raw JSON', async () => {
    const fetch = vi.fn(async () => detail)
    vi.stubGlobal('$fetch', fetch)
    const view = mount(PlatformBusinessProcessDetailDialog, { attachTo: document.body, props: { recordId: 7, open: true }, global: { stubs } })
    try {
      await flushPromises()
      expect(fetch).toHaveBeenCalledWith('/api/platform/business-processes/7', { retry: 0 })
      const dialog = new DOMWrapper(document.body).get('[data-testid="platform-business-process-detail"]')
      expect(dialog.text()).not.toContain('办理编号')
      expect(dialog.text()).not.toContain('SQ-2023-1')
      expect(dialog.findAll('[data-testid="platform-business-process-version"]')).toHaveLength(1)
      expect(dialog.text()).not.toContain('称号范围')
      expect(dialog.text()).not.toMatch(/版本 #|记录身份|规则版本|采集时间|内容哈希|platform-observation-v1|business_list/)
      expect(dialog.text()).not.toContain('实际观察')
      expect(dialog.text()).toContain('第三批')
      expect(dialog.findAll('button').some(button => button.text().includes('原行与对应'))).toBe(false)
      expect(dialog.text()).not.toContain('secretRaw')
    } finally { view.unmount(); vi.unstubAllGlobals() }
  })
})
