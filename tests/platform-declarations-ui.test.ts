// @vitest-environment happy-dom
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PlatformDeclarationTable from '../components/PlatformDeclarationTable.vue'
import PlatformDeclarationDetailDialog from '../components/PlatformDeclarationDetailDialog.vue'

const record = {
  kind: 'record' as const,
  record: { id: 7, platformKey: 'SQ-2024-1', interface: 'apply_list' as const },
  matchedVersion: {
    versionId: 12, titleRaw: '2', declareKind: 'apply', declarationYear: 2024, appliedAt: '2024-03-01 09:00:00',
    status: '终审通过', nameRaw: '甲合成企业', usccRaw: '91330211255994457P', ruleVersion: 'platform-apply-v1',
  },
  matchedVersionCount: 2,
  versionCount: 2,
  observationCount: 3,
  latestObservationAt: '2026-10-02T00:00:00Z',
  enterpriseIds: [11],
  enterpriseNames: ['甲合成企业'],
  conflicts: ['enterprise_assignment_conflict'],
}
const isolated = {
  kind: 'observation' as const,
  relationId: 21, queryId: 31, queriedAt: '2026-10-01T00:00:00Z', queryKey: 'name:无编号企业', queryStatus: 'success', sequenceNo: 1,
  identityState: 'missing_key' as const, contentState: 'unverifiable' as const,
  titleRaw: '3', nameRaw: '无编号企业', usccRaw: null, declareKind: '补充申报', declarationYear: null, appliedAt: null, status: '待补充',
  enterpriseId: null, enterpriseName: null,
}
const stubs = { NuxtLink: { template: '<a><slot /></a>' } }
afterEach(() => vi.unstubAllGlobals())

describe('申报记录表格', () => {
  it('shows source fields, version counts, conflict and emits record selection', async () => {
    const view = mount(PlatformDeclarationTable, { props: { view: 'records', rows: [record] }, global: { stubs } })
    try {
      const row = view.get('[data-testid="platform-declaration-row"]')
      expect(row.text()).not.toContain('SQ-2024-1')
      expect(row.text()).toContain('甲合成企业')
      expect(row.text()).toContain('专精特新中小企业')
      expect(view.get('[data-testid=platform-declaration-card]').text()).toContain('专精特新中小企业')
      expect(row.text()).toContain('91330211255994457P')
      expect(row.text()).toContain('申请')
      expect(row.text()).toContain('2024')
      expect(row.text()).toContain('终审通过')
      expect(row.text()).not.toContain('2 / 3')
      expect(row.text()).toContain('版本详情')
      expect(row.text()).toContain('匹配 2 个版本')
      expect(row.text()).toContain('企业归属冲突')
      await row.findAll('button').find(button => button.text().includes('版本详情'))!.trigger('click')
      expect(view.emitted('open-record')).toEqual([[7]])
    } finally { view.unmount() }
  })

  it('keeps unknown values explicit instead of guessing a year or declaration kind', () => {
    const view = mount(PlatformDeclarationTable, {
      props: { view: 'records', rows: [{ ...record, matchedVersion: { ...record.matchedVersion, titleRaw: null, declareKind: null, declarationYear: null, status: null, usccRaw: null }, conflicts: [] }] },
      global: { stubs },
    })
    try {
      const row = view.get('[data-testid="platform-declaration-row"]')
      const cells = row.findAll('td').map(cell => cell.text())
      expect(cells[1]).toBe('未提供')
      expect(cells[2]).toBe('未提供')
      expect(cells[3]).toBe('未提供')
    } finally { view.unmount() }
  })

  it('shows isolated observations with their isolation reason', () => {
    const view = mount(PlatformDeclarationTable, { props: { view: 'isolated', rows: [isolated] }, global: { stubs } })
    try {
      const row = view.get('[data-testid="platform-declaration-isolated-row"]')
      expect(row.text()).toContain('行 #21 · 查询 #31')
      expect(row.text()).toContain('无编号企业')
      expect(row.text()).toContain('专精特新“小巨人”')
      expect(row.text()).toContain('补充申报')
      expect(row.text()).toContain('缺少平台业务编号')
      expect(row.text()).toContain('原文内容无法核实')
      expect(row.text()).toContain('查看原查询')
    } finally { view.unmount() }
  })
})

describe('申报记录详情', () => {
  it('renders content versions and collection times without repeated observation rows', async () => {
    const detail = {
      record: { id: 7, platformKey: 'SQ-2024-1', interface: 'apply_list', identityRuleVersion: 'platform-observation-v1', createdAt: '2026-10-01T00:00:00Z' },
      versions: [
        { versionId: 12, hashAlgorithm: 'platform-row-json-v1', contentHash: 'abc', createdAt: '2026-10-01T00:00:00Z', declareKind: 'apply', declarationYear: 2024, appliedAt: '2024-03-01', status: '终审通过', nameRaw: '甲合成企业', usccRaw: '91330211255994457P', ruleVersion: 'platform-apply-v1', observationCount: 2, firstObservedAt: '2026-10-01T00:00:00Z', lastObservedAt: '2026-10-02T00:00:00Z' },
        { versionId: 11, hashAlgorithm: 'platform-row-json-v1', contentHash: 'def', createdAt: '2026-09-01T00:00:00Z', declareKind: null, declarationYear: null, appliedAt: null, status: null, nameRaw: null, usccRaw: null, ruleVersion: null, observationCount: 1, firstObservedAt: '2026-09-01T00:00:00Z', lastObservedAt: '2026-09-01T00:00:00Z' },
      ],
      observations: [
        { relationId: 21, queryId: 31, queriedAt: '2026-10-02T00:00:00Z', queryKey: 'q', queryStatus: 'success', sequenceNo: 1, enterpriseId: 11, enterpriseName: '甲合成企业', identityState: 'resolved', contentState: 'verified', keySource: 'both', projectionRuleVersion: 'platform-observation-v1', versionId: 12, version: null },
      ],
      counts: { versions: 2, observations: 1, versionsTruncated: false, observationsTruncated: false },
    }
    const fetch = vi.fn(async () => detail)
    vi.stubGlobal('$fetch', fetch)
    const view = mount(PlatformDeclarationDetailDialog, { attachTo: document.body, props: { recordId: 7, open: true } })
    try {
      await flushPromises()
      const dialog = new DOMWrapper(document.body).get('[data-testid="platform-declaration-detail"]')
      expect(fetch).toHaveBeenCalledWith('/api/platform/declarations/7', { retry: 0 })
      expect(dialog.text()).toContain('申报记录 · 版本详情')
      expect(dialog.text()).not.toContain('申报编号')
      expect(dialog.text()).not.toContain('SQ-2024-1')
      expect(dialog.text()).toContain('版本 #12')
      expect(dialog.text()).toContain('申请')
      expect(dialog.text()).toContain('2024')
      expect(dialog.text()).toContain('版本 #11')
      expect(dialog.text()).toContain('未提供')
      expect(dialog.text()).toContain('最近 2026-10-02')
      expect(dialog.text()).not.toContain('行 #21 · 查询 #31')
      expect(dialog.text()).toContain('甲合成企业')
    } finally { view.unmount() }
  })
})
