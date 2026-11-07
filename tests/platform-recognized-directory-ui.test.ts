// @vitest-environment happy-dom
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import PlatformRecognizedDirectoryTable from '../components/PlatformRecognizedDirectoryTable.vue'
import PlatformRecognizedDirectoryDetailDialog from '../components/PlatformRecognizedDirectoryDetailDialog.vue'
import PlatformRecords from '../components/PlatformRecords.vue'
import { groupPlatformBusinessDetails } from '../lib/roster/platform-business-detail'
import type { PlatformRecord, PlatformRecordQuery } from '../lib/roster/platform-records'
import type { RecognizedDirectoryDetail, RecognizedDirectoryRow } from '../lib/platform/recognized-directory'

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

describe('真实消费者深链', () => {
  it('links a recognized row of the platform evidence table to the local directory record by exact platform key', () => {
    const query: PlatformRecordQuery = {
      id: 60, interface: 'recognized_list', queryKey: '91330211AAAAAAAA1X', rdjb: '2',
      queriedAt: '2026-10-01T00:00:00Z', status: 'success', relationCount: 1, failureReason: null,
    }
    const relation: PlatformRecord = {
      id: 100, queryId: 60, sequenceNo: 1, relationKey: 'DIR-KEY', usccRaw: '91330211AAAAAAAA1X', nameRaw: '合成目录企业',
      province: null, status: null, batch: null, declareKind: null, appliedAt: null, awardBatchLabel: null, year: null,
      matchBasis: 'uscc', verificationStatus: 'confirmed', sourceRdjb: '2', sourcePage: 1,
      rawFields: { id: 'DIR-KEY', qymc: '合成目录企业', tyshxydm: '91330211AAAAAAAA1X', rddqrq: '2027-12-31' },
    }
    const business = groupPlatformBusinessDetails([{
      relationId: 100, queryId: 60, queriedAt: '2026-10-01T00:00:00Z',
      businessRecord: {
        recordId: 5, versionId: 9, interface: 'recognized_list', platformKey: 'DIR-KEY', groupState: 'verified',
        identityState: 'resolved', contentState: 'verified', keySource: 'both', projectionRuleVersion: 'platform-observation-v1',
        hashAlgorithm: 'platform-row-json-v1', contentHash: 'a'.repeat(64),
      },
      existingCorrespondenceIds: [], existingCorrespondences: [], conflicts: [],
      titleCode: 'specialized_sme', enterpriseId: 3, usccRaw: '91330211AAAAAAAA1X', nameRaw: '合成目录企业',
    }])[0]!
    const view = mount(PlatformRecords, { props: { queries: [query], relations: [relation], businessRecords: [business] }, global: { stubs } })
    try {
      const section = view.get('[data-record-kind="recognized_list"]')
      // The existing display, grouping and evidence reader stay in place.
      expect(section.text()).toContain('合成目录企业')
      expect(section.text()).toContain('2027-12-31')
      expect(section.findAll('button').some(button => button.text().includes('对应事件/出处'))).toBe(true)
      const link = section.get('[data-testid="platform-recognized-directory-link"]')
      expect(link.text()).toBe('本地目录记录')
      expect(JSON.parse(link.attributes('data-to')!)).toEqual({ path: '/platform-recognized-directory', query: { platformKey: 'DIR-KEY' } })
      // The business_list deep link is untouched: no business link for a recognized row.
      expect(section.findAll('a').some(anchor => anchor.text() === '本地办理记录')).toBe(false)
    } finally { view.unmount() }
  })

  it('never links an unresolved recognized row without an exact directory business id', () => {
    const query: PlatformRecordQuery = {
      id: 61, interface: 'recognized_list', queryKey: 'name:缺编号目录企业', rdjb: '2',
      queriedAt: '2026-10-01T00:00:00Z', status: 'success', relationCount: 1, failureReason: null,
    }
    const relation: PlatformRecord = {
      id: 101, queryId: 61, sequenceNo: 1, relationKey: 'REL-NO-KEY', usccRaw: null, nameRaw: '缺编号目录企业',
      province: null, status: null, batch: null, declareKind: null, appliedAt: null, awardBatchLabel: null, year: null,
      matchBasis: 'manual', verificationStatus: 'pending', sourceRdjb: '2', sourcePage: 1,
      rawFields: { qymc: '缺编号目录企业' },
    }
    for (const identityState of ['missing_key', 'conflict'] as const) {
      const business = groupPlatformBusinessDetails([{
        relationId: 101, queryId: 61, queriedAt: '2026-10-01T00:00:00Z',
        businessRecord: {
          recordId: null, versionId: null, interface: 'recognized_list', platformKey: null,
          groupState: identityState, identityState, contentState: identityState === 'missing_key' ? 'unverifiable' : 'verified',
          keySource: 'none', projectionRuleVersion: 'platform-observation-v1',
          hashAlgorithm: null, contentHash: null,
        },
        existingCorrespondenceIds: [], existingCorrespondences: [], conflicts: [],
        titleCode: 'specialized_sme', enterpriseId: null, usccRaw: null, nameRaw: '缺编号目录企业',
      }])[0]!
      const view = mount(PlatformRecords, { props: { queries: [query], relations: [relation], businessRecords: [business] }, global: { stubs } })
      try {
        const section = view.get('[data-record-kind="recognized_list"]')
        expect(section.text()).toContain('缺编号目录企业')
        expect(section.find('[data-testid="platform-recognized-directory-link"]').exists()).toBe(false)
      } finally { view.unmount() }
    }
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
      expect(dialog.text()).toContain('平台认定目录 #7 · 版本详情')
      expect(dialog.text()).toContain('版本 #12')
      expect(dialog.text()).toContain('有效期')
      expect(dialog.text()).toContain('2027-12-31')
      expect(dialog.text()).toContain('称号')
      expect(dialog.text()).not.toContain('称号范围')
      expect(dialog.text()).toContain('专精特新中小企业')
      expect(dialog.text()).toContain('最近')
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
      expect(dialog.text()).toContain('版本 #3')
      expect(dialog.text()).toContain('业务字段未同步')
    } finally { view.unmount(); vi.unstubAllGlobals() }
  })
})
