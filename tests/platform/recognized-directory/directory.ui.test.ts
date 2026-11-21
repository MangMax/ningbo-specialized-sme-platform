// @vitest-environment happy-dom
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import PlatformRecognizedDirectoryTable from '../../../layers/sme-roster/app/components/PlatformRecognizedDirectoryTable.vue'
import PlatformRecognizedDirectoryDetailDialog from '../../../layers/sme-roster/app/components/PlatformRecognizedDirectoryDetailDialog.vue'
import type { RecognizedDirectoryDetail, RecognizedDirectoryRow } from '../../../layers/sme-roster/lib/platform/recognized-directory'

const nativeAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')
beforeAll(() => { Reflect.deleteProperty(Element.prototype, 'animate') })
afterAll(() => { if (nativeAnimate) Object.defineProperty(Element.prototype, 'animate', nativeAnimate) })

const stubs = {
  NuxtLink: { props: ['to'], template: '<a :href="typeof to === \'string\' ? to : to.path" :data-to="JSON.stringify(to)"><slot /></a>' },
}
const version = {
  versionId: 12, validityDateRaw: '2027-12-31', maintenanceYear: 2024, maintenanceBatch: '2024-2',
  district: '33020000', awardNote: '原认定说明', titleRaw: '2', nameRaw: '甲目录企业',
  usccRaw: '91330211AAAAAAAA1X', ruleVersion: 'platform-recognized-v1',
}
const record: RecognizedDirectoryRow = {
  kind: 'record',
  record: { id: 7, platformKey: 'DIR-2024-1', interface: 'recognized_list' },
  matchedVersion: version,
  matchedVersionCount: 1,
  versionCount: 1,
  observationCount: 2,
  latestObservationAt: '2026-10-02T00:00:00Z',
  enterpriseIds: [11],
  enterpriseNames: ['甲目录企业'],
  titleScopes: ['2'],
  conflicts: [],
}
const conflict: RecognizedDirectoryRow = {
  ...record,
  record: { id: 8, platformKey: 'DIR-CONFLICT', interface: 'recognized_list' },
  matchedVersion: { ...version, versionId: 13, titleRaw: '3' },
  titleScopes: ['1'],
  conflicts: ['title_conflict'],
}
const isolated: RecognizedDirectoryRow = {
  kind: 'observation', titleRaw: '3', relationId: 9, queryId: 4, queriedAt: '2026-10-03T00:00:00Z', queryKey: 'name:无编号目录企业',
  queryStatus: 'success', sequenceNo: 1, identityState: 'missing_key', contentState: 'unverifiable',
  nameRaw: '无编号目录企业', usccRaw: null, titleScopes: ['2'], enterpriseId: null, enterpriseName: null,
}
const detail: RecognizedDirectoryDetail = {
  record: { id: 7, platformKey: 'DIR-2024-1', interface: 'recognized_list', identityRuleVersion: 'platform-observation-v1', createdAt: '2026-10-01T00:00:00Z' },
  versions: [{ ...version, hashAlgorithm: 'platform-row-json-v1', contentHash: 'a'.repeat(64), createdAt: '2026-10-01T00:00:00Z', observationCount: 2, firstObservedAt: '2026-10-01T00:00:00Z', lastObservedAt: '2026-10-02T00:00:00Z', titleScopes: ['2'] }],
  observations: [{
    relationId: 9, queryId: 4, queriedAt: '2026-10-01T00:00:00Z', queryKey: '91330211AAAAAAAA1X', queryStatus: 'success',
    sequenceNo: 1, enterpriseId: 11, enterpriseName: '甲目录企业', identityState: 'resolved', contentState: 'verified',
    keySource: 'both', projectionRuleVersion: 'platform-observation-v1', versionId: 12, titleScopes: ['2'],
    titleConflict: false, correspondenceRefs: [{ id: 1, status: 'confirmed', revision: 2 }], version,
  }],
  counts: { versions: 1, observations: 2, versionsTruncated: false, observationsTruncated: true },
  conflicts: ['title_conflict'],
}

describe('平台认定目录表格', () => {
  it('shows the response title and navigates by it instead of query scope', async () => {
    const view = mount(PlatformRecognizedDirectoryTable, { props: { view: 'records', rows: [record, conflict] }, global: { stubs } })
    try {
      const row = view.get('[data-testid="platform-recognized-directory-row"]')
      expect(row.text()).toContain('甲目录企业')
      expect(row.text()).toContain('2027-12-31')
      expect(row.text()).toContain('2024-2')
      expect(row.text()).toContain('33020000')
      expect(row.text()).toContain('专精特新中小企业')
      expect(row.text()).not.toContain('1 / 2')
      expect(row.text()).toContain('版本详情')
      expect(view.text()).not.toContain('行称号与查询范围不一致')
      await row.get('button').trigger('click')
      expect(view.emitted('open-record')?.[0]).toEqual([7])
      expect(view.find('[data-testid="platform-recognized-directory-card"]').exists()).toBe(true)

      const link = row.get('[data-testid="platform-recognized-current-link"]')
      expect(JSON.parse(link.attributes('data-to')!)).toEqual({ path: '/current-enterprises', query: { titleCode: 'specialized_sme', q: '甲目录企业' } })
      // The response row title wins over the query condition.
      const conflictRow = view.get('[data-testid="platform-recognized-directory-row"][data-record-id="8"]')
      expect(conflictRow.text()).toContain('专精特新“小巨人”')
      expect(conflictRow.text()).not.toContain('创新型中小企业')
      const conflictLink = conflictRow.get('[data-testid="platform-recognized-current-link"]')
      expect(JSON.parse(conflictLink.attributes('data-to')!).query).toEqual({ titleCode: 'little_giant', q: '甲目录企业' })
    } finally { view.unmount() }
  })

  it('uses the actual row title despite multiple query title scopes', () => {
    const view = mount(PlatformRecognizedDirectoryTable, { props: { view: 'records', rows: [{ ...record, titleScopes: ['1', '2'] }] }, global: { stubs } })
    try {
      const link = view.get('[data-testid="platform-recognized-current-link"]')
      expect(JSON.parse(link.attributes('data-to')!).query).toEqual({ titleCode: 'specialized_sme', q: '甲目录企业' })
    } finally { view.unmount() }
  })

  it('keeps a real datetime validity value intact and never shows the directory business id', () => {
    const realKey: RecognizedDirectoryRow = {
      ...record,
      record: { ...record.record, platformKey: 'f251d3e6-fcb0-43ce-b2fb-55de9992ee45' },
      matchedVersion: { ...version, validityDateRaw: '2024-03-28 10:33:22' },
    }
    const view = mount(PlatformRecognizedDirectoryTable, { props: { view: 'records', rows: [realKey] }, global: { stubs } })
    try {
      expect(view.text()).toContain('2024-03-28 10:33:22')
      expect(view.text()).not.toContain('f251d3e6-fcb0-43ce-b2fb-55de9992ee45')
      expect(view.text()).not.toContain('目录业务ID')
      expect(view.text()).not.toContain('维护年')
    } finally { view.unmount() }
  })

  it('separates missing-key observations and links to the original query', () => {
    const view = mount(PlatformRecognizedDirectoryTable, { props: { view: 'isolated', rows: [isolated] }, global: { stubs } })
    try {
      expect(view.text()).toContain('缺少平台业务编号')
      expect(view.text()).toContain('原文内容无法核实')
      expect(view.get('[data-testid="platform-recognized-directory-isolated-row"] a').attributes('href')).toBe('/platform-queries')
      expect(view.find('[data-testid="platform-recognized-directory-isolated-card"]').exists()).toBe(true)
    } finally { view.unmount() }
  })
})

describe('平台认定目录详情', () => {
  it('renders versions, validity and scopes without observation rows or raw JSON', async () => {
    const fetch = vi.fn(async () => detail)
    vi.stubGlobal('$fetch', fetch)
    const view = mount(PlatformRecognizedDirectoryDetailDialog, { attachTo: document.body, props: { recordId: 7, open: true }, global: { stubs } })
    try {
      await flushPromises()
      expect(fetch).toHaveBeenCalledWith('/api/platform/recognized-directory/7', { retry: 0 })
      const dialog = new DOMWrapper(document.body).get('[data-testid="platform-recognized-directory-detail"]')
      expect(dialog.text()).toContain('平台认定目录 · 版本详情')
      expect(dialog.findAll('[data-testid="platform-recognized-directory-version"]')).toHaveLength(1)
      expect(dialog.text()).toContain('有效期')
      expect(dialog.text()).toContain('2027-12-31')
      expect(dialog.text()).toContain('称号')
      expect(dialog.text()).not.toContain('称号范围')
      expect(dialog.text()).toContain('专精特新中小企业')
      expect(dialog.text()).not.toMatch(/版本 #|最近采集/)
      expect(dialog.text()).not.toContain('实际观察')
      expect(dialog.text()).not.toContain('行称号与查询范围不一致')
      expect(dialog.findAll('button').some(button => button.text().includes('原行与对应'))).toBe(false)
      expect(dialog.text()).not.toContain('secretRaw')
      expect(dialog.text()).not.toContain('目录业务ID')
    } finally { view.unmount(); vi.unstubAllGlobals() }
  })

  it('shows missing projection for the exact historical version', async () => {
    const legacy = {
      ...detail,
      versions: [{ ...detail.versions[0]!, versionId: 3, ruleVersion: null, validityDateRaw: null, maintenanceYear: null, maintenanceBatch: null, district: null, awardNote: null, titleRaw: null }],
      observations: [{ ...detail.observations[0]!, versionId: null, version: null, titleConflict: false }],
    }
    vi.stubGlobal('$fetch', vi.fn(async () => legacy))
    const view = mount(PlatformRecognizedDirectoryDetailDialog, { attachTo: document.body, props: { recordId: 7, open: true }, global: { stubs } })
    try {
      await flushPromises()
      const dialog = new DOMWrapper(document.body).get('[data-testid="platform-recognized-directory-detail"]')
      expect(dialog.text()).not.toContain('typed')
      expect(dialog.get('[data-testid="platform-recognized-directory-version"]').text()).toBe('该版本暂无可核对的业务内容')
    } finally { view.unmount(); vi.unstubAllGlobals() }
  })
})
