// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterAll, beforeAll, expect, it } from 'vitest'
import PlatformRecords from '../components/PlatformRecords.vue'
import type { PlatformRecord, PlatformRecordQuery } from '../lib/roster/platform-records'

const nativeAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')
beforeAll(() => { Reflect.deleteProperty(Element.prototype, 'animate') })
afterAll(() => { if (nativeAnimate) Object.defineProperty(Element.prototype, 'animate', nativeAnimate) })

const metadata = (interfaceName: string, recordId: number, versionId: number) => ({
  recordId, versionId, interface: interfaceName, platformKey: '', groupState: 'verified',
  identityState: 'resolved', contentState: 'verified', keySource: 'both', projectionRuleVersion: 'platform-observation-v1',
  hashAlgorithm: 'platform-row-json-v1', contentHash: `hash-${versionId}`,
})
const ref = (relationId: number, queryId: number, interfaceName: string, recordId: number, versionId: number, typedFields: unknown) => ({
  relationId, queryId, queriedAt: '2026-10-01T00:00:00Z', businessRecord: metadata(interfaceName, recordId, versionId),
  existingCorrespondenceIds: [], existingCorrespondences: [], conflicts: [], titleCode: 'specialized_sme',
  enterpriseId: 1, nameRaw: `stored-name-${relationId}`, usccRaw: `stored-uscc-${relationId}`, typedFields,
})
const business = (observationRefs: unknown[]) => ({
  businessRecord: (observationRefs[0] as any).businessRecord, representativeRelationId: (observationRefs[0] as any).relationId,
  observationRefs, versions: [], versionCount: 0, observationCount: observationRefs.length,
  existingCorrespondenceIds: [], existingCorrespondences: [], conflicts: [],
})
const row = (id: number, queryId: number, rawFields: Record<string, unknown>, stored: Partial<PlatformRecord> = {}): PlatformRecord => ({
  id, queryId, sequenceNo: 1, relationKey: '', nameRaw: `stored-name-${id}`, usccRaw: `stored-uscc-${id}`,
  province: `stored-province-${id}`, status: `stored-status-${id}`, batch: `stored-batch-${id}`, declareKind: 'apply',
  appliedAt: `2020-01-0${id % 10}`, awardBatchLabel: null, year: 2020, matchBasis: 'uscc', verificationStatus: 'confirmed',
  rawFields, ...stored,
})

it('recognized columns prefer typed projection values, keep projected nulls empty, and fall back for historical rows', () => {
  const query: PlatformRecordQuery = { id: 60, interface: 'recognized_list', queryKey: 'SYN455', rdjb: '2', queriedAt: '2026-10-01T00:00:00Z', status: 'success', relationCount: 3, failureReason: null }
  const typed = ref(100, 60, 'recognized_list', 1, 11, {
    interface: 'recognized_list', ruleVersion: 'platform-recognized-v1',
    nameRaw: 'typed-name', usccRaw: 'typed-uscc', validityDateRaw: '2030-01-01', maintenanceYear: 2025,
    maintenanceBatch: '2025-2', district: 'typed-district', awardNote: 'typed-note',
  })
  const legacy = ref(101, 60, 'recognized_list', 2, 12, null)
  const empty = ref(102, 60, 'recognized_list', 3, 13, {
    interface: 'recognized_list', ruleVersion: 'platform-recognized-v1',
    nameRaw: null, usccRaw: null, validityDateRaw: null, maintenanceYear: null,
    maintenanceBatch: null, district: null, awardNote: null,
  })
  const relations = [
    row(100, 60, { id: 'KEY-100', qymc: 'raw-name', tyshxydm: 'raw-uscc', szq: 'raw-district', rdxx: 'raw-note', rddqrq: 'raw-validity', whpcyear: '1999', whpc: 'raw-batch' }),
    row(101, 60, { id: 'KEY-101', qymc: 'raw-name-2', tyshxydm: 'raw-uscc-2', szq: 'raw-district-2', rdxx: 'raw-note-2', rddqrq: 'raw-validity-2', whpcyear: '1998', whpc: 'raw-batch-2' }),
    row(102, 60, { id: 'KEY-102', qymc: 'raw-name-3', tyshxydm: 'raw-uscc-3', szq: 'raw-district-3', rdxx: 'raw-note-3', rddqrq: 'raw-validity-3', whpcyear: '1997', whpc: 'raw-batch-3' }),
  ]
  const view = mount(PlatformRecords, { props: { queries: [query], relations, businessRecords: [business([typed]), business([legacy]), business([empty])] } as never })
  try {
    const table = view.get('table[aria-label="已认定企业列表"]')
    expect(table.findAll('thead th').map(th => th.text())).toEqual(['序号', '企业名称', '信用代码', '平台属地（原值/代码）', '平台认定信息', '有效期（原值）', '维护年份', '维护批次', '出处 / 原字段'])
    const cells = table.findAll('[data-testid="platform-relation"]').map(r => r.findAll('td').slice(1, 8).map(td => td.text()))
    expect(cells[0]).toEqual(['typed-name', 'typed-uscc', 'typed-district', 'typed-note', '2030-01-01', '2025', '2025-2'])
    expect(cells[1]).toEqual(['stored-name-101', 'stored-uscc-101', 'raw-district-2', 'raw-note-2', 'raw-validity-2', '1998', 'raw-batch-2'])
    expect(cells[2]).toEqual(['未提供', '未提供', '未提供', '未提供', '未提供', '未提供', '未提供'])
    const scroller = table.element.parentElement
    expect(scroller?.className).toContain('overflow-x-auto')
    expect(table.element.className).toContain('min-w-[960px]')
    expect(view.find('details').exists()).toBe(false)
    expect(view.find('select').exists()).toBe(false)
  } finally { view.unmount() }
})

it('process columns prefer typed fields, keep unmodeled apply columns on the legacy read, and fall back without a projection', () => {
  const businessQuery: PlatformRecordQuery = { id: 61, interface: 'business_list', queryKey: 'SYN455', rdjb: '2', queriedAt: '2026-10-01T00:00:00Z', status: 'success', relationCount: 2, failureReason: null }
  const applyQuery: PlatformRecordQuery = { id: 62, interface: 'apply_list', queryKey: 'SYN455', rdjb: '2', queriedAt: '2026-10-02T00:00:00Z', status: 'success', relationCount: 1, failureReason: null }
  const typedBusiness = ref(200, 61, 'business_list', 20, 21, {
    interface: 'business_list', ruleVersion: 'platform-business-v1',
    nameRaw: 'typed-name', usccRaw: 'typed-uscc', declareKind: 'review', year: 2025,
    appliedAt: '2030-02-02', status: 'typed-status', batch: 'typed-batch', province: 'typed-province',
  })
  const legacyBusiness = ref(201, 61, 'business_list', 21, 22, null)
  const typedApply = ref(202, 62, 'apply_list', 22, 23, {
    interface: 'apply_list', ruleVersion: 'platform-apply-v1',
    nameRaw: 'typed-apply-name', usccRaw: 'typed-apply-uscc', declareKind: 'apply', year: 2025,
    appliedAt: '2031-03-03', status: 'typed-apply-status',
  })
  const relations = [
    row(200, 61, { id: 'KEY-200', qymc: 'raw-name', tyshxydm: 'raw-uscc', sblx: '申请', sqsj: '2020-01-01', cszt: 'raw-status', whpc: 'raw-batch', szsfmc: 'raw-province' }),
    row(201, 61, { id: 'KEY-201', qymc: 'raw-name-2', tyshxydm: 'raw-uscc-2', sblx: '更新', sqsj: '2020-01-02', cszt: 'raw-status-2', whpc: 'raw-batch-2', szsfmc: 'raw-province-2' }),
    row(202, 62, { id: 'KEY-202', qymc: 'raw-apply-name', tyshxydm: 'raw-apply-uscc', sblx: '复核', sqsj: '2020-01-03', cszt: 'raw-apply-status', whpc: 'raw-apply-batch', szsfmc: 'raw-apply-province' }),
  ]
  const view = mount(PlatformRecords, { props: { queries: [businessQuery, applyQuery], relations, businessRecords: [business([typedBusiness]), business([legacyBusiness]), business([typedApply])] } as never })
  try {
    const businessRows = view.get('table[aria-label="关联记录"]').findAll('[data-testid="platform-relation"]')
    expect(businessRows[0]!.findAll('td').slice(1, 8).map(td => td.text())).toEqual(['typed-name', 'typed-uscc', 'typed-province', '复核', 'typed-status', '2030-02-02', 'typed-batch'])
    expect(businessRows[1]!.findAll('td').slice(1, 8).map(td => td.text())).toEqual(['stored-name-201', 'stored-uscc-201', 'stored-province-201', '申请', 'stored-status-201', '2020-01-01', 'stored-batch-201'])
    // apply projection does not model batch/province: those columns keep the legacy read, not a guessed typed null.
    const applyCells = view.get('table[aria-label="申报记录"]').get('[data-testid="platform-relation"]').findAll('td').slice(1, 8).map(td => td.text())
    expect(applyCells).toEqual(['typed-apply-name', 'typed-apply-uscc', 'stored-province-202', '申请', 'typed-apply-status', '2031-03-03', 'stored-batch-202'])
  } finally { view.unmount() }
})

it('observation history prefers typed name/uscc and keeps projected nulls empty instead of falling back to the relation column', async () => {
  const query: PlatformRecordQuery = { id: 63, interface: 'business_list', queryKey: 'SYN455', rdjb: '2', queriedAt: '2026-10-01T00:00:00Z', status: 'success', relationCount: 2, failureReason: null }
  const typedRef = ref(300, 63, 'business_list', 30, 31, {
    interface: 'business_list', ruleVersion: 'platform-business-v1',
    nameRaw: 'typed-history-name', usccRaw: 'typed-history-uscc', declareKind: 'apply', year: 2025,
    appliedAt: '2025-01-01', status: '已受理', batch: '2025-1', province: '浙江省',
  })
  const emptyRef = ref(301, 63, 'business_list', 30, 31, {
    interface: 'business_list', ruleVersion: 'platform-business-v1',
    nameRaw: null, usccRaw: null, declareKind: null, year: null,
    appliedAt: null, status: null, batch: null, province: null,
  })
  const relations = [
    row(300, 63, { id: 'KEY-300', qymc: 'raw-name-300', tyshxydm: 'raw-uscc-300' }),
    row(301, 63, { id: 'KEY-301', qymc: 'raw-name-301', tyshxydm: 'raw-uscc-301' }),
  ]
  const single = business([typedRef, emptyRef])
  const withVersion = { ...single, versions: [{ businessRecord: (typedRef as any).businessRecord, representativeRelationId: 300, observationRefs: [typedRef, emptyRef] }], versionCount: 1, observationCount: 2 }
  const view = mount(PlatformRecords, { props: { queries: [query], relations, businessRecords: [withVersion] } as never })
  try {
    await view.get('[data-testid="platform-business-history"] button[aria-expanded]').trigger('click')
    await flushPromises()
    const history = view.get('[data-testid="platform-business-history"]')
    expect(history.text()).toContain('typed-history-name')
    expect(history.text()).toContain('typed-history-uscc')
    expect(history.text()).toContain('名称未提供')
    expect(history.text()).toContain('信用代码未提供')
    expect(history.text()).not.toContain('stored-name-300')
    expect(history.text()).not.toContain('stored-name-301')
  } finally { view.unmount() }
})
