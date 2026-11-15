import { submitNativePlatformQuery } from '../../platform/fixtures/native-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { listCurrentQualified } from '../../../lib/roster/current-qualified-query'
import { readCurrentQualificationAssessment } from '../../../lib/roster/current-qualification'
import { AS_OF_408, currentQualificationFixture } from '../fixtures/qualification-matrix'

let fixture: ReturnType<typeof currentQualificationFixture>
beforeEach(() => {
  // Only Date is frozen: SQL, transactions and the event loop remain real.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(AS_OF_408))
  fixture = currentQualificationFixture()
})
afterEach(() => {
  try { fixture?.close() } finally { vi.useRealTimers() }
})

it('expired_review_keeps_current_and_legacy_pending_totals_empty_408', () => {
  const name = 'synthetic_408_pending_review'
  const { enterprise, review, reviewEvidence } = fixture.formalEnterprise(name, true)
  expect(review).toMatchObject({ year: 2022, batchSeq: 1, decidedYear: null, reviewOutcome: null })
  expect(reviewEvidence).toMatchObject({ recordEventId: review!.id })
  expect(fixture.sqlite.prepare(`select
    (select count(*) from enterprise) as enterprises,
    (select count(*) from record_event) as events,
    (select count(*) from record_evidence) as evidence`).get())
    .toEqual({ enterprises: 1, events: 2, evidence: 2 })

  fixture.sqlite.pragma('query_only = ON')
  expect(fixture.sqlite.pragma('query_only', { simple: true })).toBe(1)
  const changesBefore = fixture.totalChanges()
  const shared = readCurrentQualificationAssessment(fixture.sqlite, enterprise.id, Date.parse(AS_OF_408))
  expect(shared).toMatchObject({
    enterpriseId: enterprise.id, asOf: AS_OF_408,
    ruleVersion: 'current-roster-116-v11', assessmentVersion: 'enterprise-qualification-687-v4',
  })
  expect(shared.titles.map(title => title.titleCode).sort())
    .toEqual(['innovative_sme', 'little_giant', 'specialized_sme'])
  const innovative = shared.titles.find(title => title.titleCode === 'innovative_sme')!
  expect(innovative.group).toBe('excluded')
  expect(innovative.evidence).toContainEqual(expect.objectContaining({
    eventId: review!.id, eventType: 'review', evidenceIds: [reviewEvidence!.id],
    year: 2022, decidedYear: null, reviewOutcome: null,
  }))
  expect(innovative.completeness.fieldGaps).toEqual([
    { eventId: review!.id, field: 'decidedYear', valueState: 'unknown', inputState: 'null' },
    { eventId: review!.id, field: 'reviewOutcome', valueState: 'unknown', inputState: 'null' },
  ])
  expect(fixture.totalChanges()).toBe(changesBefore)

  const result = listCurrentQualified(fixture.sqlite, {
    titleCode: 'innovative_sme', q: name, district: '鄞州区', page: 1, pageSize: 25,
  })
  // Both current and retired pending channels remain empty, with zero writes.
  expect(result).toMatchObject({ rows: [], total: 0, uncertainTotal: 0, snapshotStartedAt: AS_OF_408 })
  expect(fixture.totalChanges()).toBe(changesBefore)
  expect(fixture.sqlite.pragma('query_only', { simple: true })).toBe(1)

  // Expired formal cycles remain excluded even when the review fields are incomplete.
  expect(innovative.effectiveQualification).toMatchObject({ status: 'expired' })
  expect(result).toMatchObject({ responseVersion: 'current-qualified-478-v2', publishedPending: {
    requested: true, total: 0, page: 1, pageSize: 25, rows: [],
  } })
})

it('formal_eligible_survives_platform_query_failure_408', () => {
  const name = 'synthetic_408_formal_eligible'
  const { enterprise } = fixture.formalEnterprise(name, false)
  const query = fixture.failedNameQuery(name)
  fixture.sqlite.pragma('query_only = ON')
  expect(fixture.sqlite.pragma('query_only', { simple: true })).toBe(1)
  const changesBefore = fixture.totalChanges()
  const shared = readCurrentQualificationAssessment(fixture.sqlite, enterprise.id, Date.parse(AS_OF_408))
  const innovative = shared.titles.find(title => title.titleCode === 'innovative_sme')!
  expect(innovative.group).toBe('eligible')
  expect(innovative.officialQualification.group).toBe('eligible')
  expect(innovative.platform).toMatchObject({
    status: 'query_failed', comparison: 'not_established', observations: [{
      queryId: query.id, queryStatus: 'failed', status: 'failed', outcome: 'unknown', rows: [],
    }],
  })
  expect(fixture.totalChanges()).toBe(changesBefore)

  const result = listCurrentQualified(fixture.sqlite, {
    titleCode: 'innovative_sme', q: name, district: '鄞州区',
  })
  // Independent literal eligible set; not derived from the production assessment.
  expect(result.total).toBe(1)
  expect(result.uncertainTotal).toBe(0)
  expect(result.rows.map(row => ({ enterpriseId: row.enterpriseId, group: row.group })))
    .toEqual([{ enterpriseId: enterprise.id, group: 'eligible' }])
  expect(result.snapshotStartedAt).toBe(AS_OF_408)
  expect(fixture.totalChanges()).toBe(changesBefore)
  expect(fixture.sqlite.pragma('query_only', { simple: true })).toBe(1)
})

// Current-contract matrix controls retain the original source facts.
import { createHash } from 'node:crypto'
import { createCurrentQualificationAssessmentReader } from '../../../lib/roster/current-qualification'
import type { CurrentQualifiedFilter } from '../../../lib/roster/current-qualified-query'
import type { PlatformRow } from '../../../lib/platform/types'
import { qualificationMatrix, qualificationFileFixture, type MatrixEvent408 } from '../fixtures/qualification-matrix'

const pendingEvents408: MatrixEvent408[] = [
  { eventType: 'award', year: 2022, decidedYear: 2022, batchSeq: 1 },
  { eventType: 'review', year: 2022, decidedYear: null, batchSeq: 1, reviewOutcome: null },
]
function query408(filter: Omit<CurrentQualifiedFilter, 'titleCode'> & { titleCode?: CurrentQualifiedFilter['titleCode'] } = {}) {
  fixture.sqlite.pragma('query_only = ON')
  const changes = fixture.totalChanges()
  const result = listCurrentQualified(fixture.sqlite, { titleCode: 'innovative_sme', ...filter })
  expect(fixture.totalChanges()).toBe(changes)
  expect(fixture.sqlite.pragma('query_only', { simple: true })).toBe(1)
  return result
}
function independentDigest408(snapshot: ReturnType<typeof readCurrentQualificationAssessment>) {
  const scope = { enterpriseId: snapshot.enterpriseId, asOf: snapshot.asOf, ruleVersion: snapshot.ruleVersion, assessmentVersion: snapshot.assessmentVersion }
  return createHash('sha256').update(JSON.stringify([scope, snapshot.titles])).digest('hex')
}

it.each([
  { id: 'unqueried', state: 'unqueried', groups: ['excluded', 'excluded', 'eligible'] },
  { id: 'platform_absent', state: 'no_record', groups: ['excluded', 'excluded', 'eligible'] },
  { id: 'platform_failed', state: 'failed', groups: ['excluded', 'excluded', 'eligible'] },
  { id: 'platform_not_queried', state: 'not_queried', groups: ['excluded', 'excluded', 'eligible'] },
  { id: 'platform_not_approved', state: 'not_approved', groups: ['excluded', 'excluded', 'eligible'] },
  { id: 'moved_out', state: 'moved_out', groups: ['excluded', 'excluded', 'eligible'] },
  { id: 'terminated_then_returned', state: 'terminated_then_returned', groups: ['excluded', 'excluded', 'eligible'] },
  { id: 'review_failed', state: 'review_failed', groups: ['excluded', 'excluded', 'excluded'] },
])('complete_t2_and_scan_parity_408_$id', ({ state, groups }) => {
  const m = qualificationMatrix(fixture.sqlite)
  const events: MatrixEvent408[] = state === 'review_failed' ? [
    { eventType: 'award', year: 2022, decidedYear: 2022, batchSeq: 1 },
    { eventType: 'review', year: 2022, decidedYear: 2025, batchSeq: 1, reviewOutcome: 'failed' },
  ] : [{ eventType: 'award', year: 2025, decidedYear: 2025, batchSeq: 1 }]
  const { enterprise } = m.formal('synthetic_408_parity', events)
  if (state === 'moved_out') m.subject(enterprise.id, 'moved_out', 'specialized_sme')
  if (state === 'terminated_then_returned') {
    m.subject(enterprise.id, 'deregistered')
    m.subject(enterprise.id, 'moved_in', 'specialized_sme', '2026-03-01T00:00:00Z')
  }
  if (state === 'no_record' || state === 'failed' || state === 'not_queried') m.platform(enterprise.id, state)
  if (state === 'not_approved') m.platform(enterprise.id, 'success', '不通过')
  fixture.sqlite.pragma('query_only = ON')
  const changes = fixture.totalChanges()
  const defaults = readCurrentQualificationAssessment(fixture.sqlite, enterprise.id, Date.parse(AS_OF_408))
  const factory = createCurrentQualificationAssessmentReader(fixture.sqlite)
  const optimized = factory.read(enterprise.id, Date.parse(AS_OF_408), {}, 'innovative_sme').snapshot
  expect(optimized).toEqual(defaults)
  expect(defaults).toMatchObject({ enterpriseId: enterprise.id, asOf: AS_OF_408, ruleVersion: 'current-roster-116-v11', assessmentVersion: 'enterprise-qualification-687-v4' })
  expect(defaults.titles.map(t => t.titleCode)).toEqual(['little_giant', 'specialized_sme', 'innovative_sme'])
  expect(defaults.titles.map(t => t.group)).toEqual(groups)
  expect(defaults.snapshotId).toBe(independentDigest408(defaults))
  for (const title of defaults.titles) {
    expect(factory.readTitle(enterprise.id, title.titleCode, Date.parse(AS_OF_408)).group).toBe(title.group)
    for (const digest of Object.values(title.versions)) expect(digest).toMatch(/^[a-f0-9]{64}$/)
  }
  const innovative = defaults.titles[2]!
  if (state === 'failed') expect(innovative.platform.status).toBe('query_failed')
  if (state === 'unqueried' || state === 'not_queried') expect(innovative.platform.status).toBe('not_queried')
  if (state === 'no_record') expect(innovative.platform.observations).toMatchObject([{ queryStatus: 'no_record' }])
  if (state === 'not_approved') expect(innovative.platform.observations[0]!.rows).toMatchObject([{ status: '不通过' }])
  expect(fixture.totalChanges()).toBe(changes)
  const current = query408({ q: enterprise.name })
  expect(current.total).toBe(groups[2] === 'eligible' ? 1 : 0)
  expect(current.publishedPending.total).toBe(0)
  if (groups[2] === 'eligible') expect(current.rows[0]!.qualificationAssessment).toEqual(defaults)
})

it.each([
  { id: 'omitted', q: undefined, requested: false },
  { id: 'spaces', q: ' \t\n ', requested: false },
  { id: 'invisible', q: '\u200B\uFEFF', requested: false },
  { id: 'identity', q: 'synthetic_408_q', requested: true },
  { id: 'absent', q: 'synthetic_408_missing', requested: true },
])('expired_cycles_keep_pending_channel_empty_with_request_scope_408_$id', ({ q, requested }) => {
  const m = qualificationMatrix(fixture.sqlite)
  const a = m.formal('synthetic_408_q', pendingEvents408)
  const result = query408({ q })
  expect(result).toMatchObject({ rows: [], total: 0, uncertainTotal: 0 })
  const expectedIds: number[] = []
  expect(readCurrentQualificationAssessment(fixture.sqlite, a.enterprise.id).titles[2]!.effectiveQualification?.status).toBe('expired')
  expect(result.publishedPending).toMatchObject({ requested, total: expectedIds.length, page: 1, pageSize: 25 })
  expect(result.publishedPending.rows.map(row => row.enterpriseId)).toEqual(expectedIds)
})

it.each(['id_asc', 'name_asc', 'name_desc'] as const)('eligible_pages_keep_complete_counts_and_stable_ties_while_expired_rows_stay_out_408_%s', sort => {
  const m = qualificationMatrix(fixture.sqlite)
  const e1 = m.formal('synthetic_408_tie'), p1 = m.formal('synthetic_408_tie', pendingEvents408)
  const e2 = m.formal('synthetic_408_tie'), p2 = m.formal('synthetic_408_tie', pendingEvents408)
  const eligible: number[] = [], pending: number[] = []
  for (const page of [1, 2, 3, 100]) {
    const result = query408({ q: 'synthetic_408_tie', sort, page, pageSize: 1 })
    expect(result.total).toBe(2)
    expect(result.publishedPending.total).toBe(0)
    expect(result.uncertainTotal).toBe(0)
    expect(result.rows.map(row => row.enterpriseId)).toEqual(page === 1 ? [e1.enterprise.id] : page === 2 ? [e2.enterprise.id] : [])
    expect(result.publishedPending.rows.map(row => row.enterpriseId)).toEqual([])
    eligible.push(...result.rows.map(row => row.enterpriseId)); pending.push(...result.publishedPending.rows.map(row => row.enterpriseId))
  }
  expect(eligible).toEqual([e1.enterprise.id, e2.enterprise.id])
  expect(pending).toEqual([])
  expect([p1.enterprise.id, p2.enterprise.id].every(id => !eligible.includes(id))).toBe(true)
})

it('search_identity_alias_region_and_title_isolation_408', () => {
  const m = qualificationMatrix(fixture.sqlite)
  // Checksum-valid synthetic literals, not a claim of registered real enterprises.
  const a = m.formal('synthetic_408_current', undefined, { uscc: '91330200000000408X' })
  const b = m.formal('synthetic_408_null_identity', undefined, { district: '海曙区' })
  m.alias(a.enterprise.id, 'synthetic_408_confirmed_alias', 'confirmed')
  m.alias(a.enterprise.id, 'synthetic_408_unconfirmed_alias', 'pending')
  m.formal('unused', undefined, { enterpriseId: a.enterprise.id, title: 'specialized_sme' })
  expect(query408({ q: 'synthetic_408_current' }).rows.map(row => row.enterpriseId)).toEqual([a.enterprise.id])
  expect(query408({ q: ' 91330200000000408x ' }).rows.map(row => row.enterpriseId)).toEqual([a.enterprise.id])
  expect(query408({ q: 'synthetic_408_confirmed_alias' }).rows.map(row => row.enterpriseId)).toEqual([a.enterprise.id])
  expect(query408({ q: 'synthetic_408_unconfirmed_alias' }).total).toBe(0)
  expect(query408({ q: 'synthetic_408', district: '海曙区' }).rows.map(row => row.enterpriseId)).toEqual([b.enterprise.id])
  const otherTitle = query408({ q: 'synthetic_408_current', titleCode: 'specialized_sme' })
  expect(otherTitle.rows.map(row => row.enterpriseId)).toEqual([a.enterprise.id])
  expect(otherTitle.publishedPending.total).toBe(0)
  expect(query408({ q: 'synthetic_408_current', titleCode: 'little_giant' })).toMatchObject({ rows: [], total: 0, publishedPending: { rows: [], total: 0 } })
})

it.each([
  { id: 'full_year', from: '2025-01-01', to: '2025-12-31', total: 1, uncertain: 0 },
  { id: 'partial_year', from: '2025-02-01', to: '2025-12-31', total: 0, uncertain: 1 },
  { id: 'disjoint_year', from: '2024-01-01', to: '2024-12-31', total: 0, uncertain: 0 },
])('recognition_precision_keeps_legacy_counts_408_$id', ({ from, to, total, uncertain }) => {
  const m = qualificationMatrix(fixture.sqlite)
  const a = m.formal('synthetic_408_recognition')
  const result = query408({ recognitionFrom: from, recognitionTo: to })
  expect(result.total).toBe(total); expect(result.uncertainTotal).toBe(uncertain)
  expect(result.rows.map(row => row.enterpriseId)).toEqual(total ? [a.enterprise.id] : [])
  expect(result.options).toEqual({ recognitionYears: [2025], validYears: [], maintenanceYears: [], maintenanceBatchesByYear: {} })
})

it.each<{ id: string; filter: Partial<CurrentQualifiedFilter>; raw: PlatformRow; status: string }>([
  { id: 'no_selected_fields', filter: {}, raw: {}, status: 'matched' },
  { id: 'recognition_full', filter: { recognitionFrom: '2022-01-01', recognitionTo: '2022-12-31' }, raw: {}, status: 'matched' },
  { id: 'recognition_partial', filter: { recognitionFrom: '2022-02-01', recognitionTo: '2022-12-31' }, raw: {}, status: 'not_established' },
  { id: 'recognition_disjoint', filter: { recognitionFrom: '2025-01-01', recognitionTo: '2025-12-31' }, raw: {}, status: 'not_matched' },
  { id: 'valid_known', filter: { validYear: 2028 }, raw: { rddqrq: '2028-06-01' }, status: 'matched' },
  { id: 'valid_different', filter: { validYear: 2027 }, raw: { rddqrq: '2028-06-01' }, status: 'not_matched' },
  { id: 'valid_unknown', filter: { validYear: 2028 }, raw: {}, status: 'not_established' },
  { id: 'maintenance_known', filter: { maintenanceYear: 2024 }, raw: { whpc: '2024-2' }, status: 'matched' },
  { id: 'maintenance_different', filter: { maintenanceYear: 2023 }, raw: { whpc: '2024-2' }, status: 'not_matched' },
  { id: 'maintenance_unknown', filter: { maintenanceYear: 2024 }, raw: {}, status: 'not_established' },
  { id: 'batch_not_inferred', filter: { maintenanceYear: 2024, maintenanceBatch: 2 }, raw: { whpc: '2024-2' }, status: 'not_established' },
])('current_filter_checks_preserve_literal_witness_partitions_408_$id', ({ filter, raw, status }) => {
  // At 2024 the 2022 formal cycle is current; incomplete review fields remain diagnostics.
  vi.setSystemTime(new Date('2024-06-01T00:00:00.000Z'))
  const m = qualificationMatrix(fixture.sqlite)
  const a = m.formal('synthetic_408_filter_current', pendingEvents408, { uscc: '91330200000000408X' })
  if (Object.keys(raw).length) m.recognized(a.enterprise.id, a.events[0]!.id, raw)
  const result = query408({ q: a.enterprise.name, ...filter })
  expect(result).toMatchObject({ total: status === 'matched' ? 1 : 0,
    uncertainTotal: filter.recognitionFrom === '2022-02-01' ? 1 : 0,
    publishedPending: { rows: [], total: 0 } })
  expect(result.rows.map(row => row.enterpriseId)).toEqual(status === 'matched' ? [a.enterprise.id] : [])
  const assessment = readCurrentQualificationAssessment(fixture.sqlite, a.enterprise.id)
  expect(assessment.titles[2]).toMatchObject({ group: 'eligible', completeness: { fieldGaps: [
    { eventId: a.events[1]!.id, field: 'decidedYear', valueState: 'unknown', inputState: 'null' },
    { eventId: a.events[1]!.id, field: 'reviewOutcome', valueState: 'unknown', inputState: 'null' },
  ] } })
})

it.each([
  { id: 'same_row', split: false },
  { id: 'different_rows', split: true },
])('source_row_and_witnesses_do_not_cross_join_408_$id', ({ split }) => {
  const m = qualificationMatrix(fixture.sqlite)
  const a = m.formal('synthetic_408_and_pending', pendingEvents408, { uscc: '91330200000000408X' })
  const e = m.formal('synthetic_408_and_eligible', undefined, { uscc: '913302000000004091' })
  for (const item of [a, e]) {
    m.recognized(item.enterprise.id, item.events[0]!.id, split ? { rddqrq: '2028-06-01' } : { rddqrq: '2028-06-01', whpc: '2024-2' })
    if (split) m.recognized(item.enterprise.id, item.events[0]!.id, { whpc: '2024-2' })
  }
  const result = query408({ q: 'synthetic_408_and', validYear: 2028, maintenanceYear: 2024 })
  expect(result.total).toBe(split ? 0 : 1)
  expect(result.rows.map(row => row.enterpriseId)).toEqual(split ? [] : [e.enterprise.id])
  expect(result.publishedPending).toMatchObject({ total: 0, rows: [] })
  expect(readCurrentQualificationAssessment(fixture.sqlite, a.enterprise.id).titles[2]!.effectiveQualification?.status).toBe('expired')
  expect(result.options).toEqual({ recognitionYears: [2025], validYears: [2028], maintenanceYears: [2024], maintenanceBatchesByYear: {} })
})

it.each([
  { id: 'before_shanghai_year', iso: '2025-12-31T15:59:59.999Z', local: 2026, eligible: 1 },
  { id: 'utc_previous_shanghai_next', iso: '2025-12-31T16:30:00.000Z', local: 2025, eligible: 0 },
  { id: 'utc_next_local_previous', iso: '2026-01-01T00:30:00.000Z', local: 2025, eligible: 0 },
])('evaluation_uses_shanghai_year_not_host_or_filter_year_408_$id', ({ iso, local, eligible }) => {
  const m = qualificationMatrix(fixture.sqlite)
  const a = m.formal('synthetic_408_utc', [{ eventType: 'award', year: 2023, decidedYear: 2023, batchSeq: 1 }])
  vi.setSystemTime(new Date(iso))
  // Model either local offset without changing the host timezone or event loop.
  const localYear = vi.spyOn(Date.prototype, 'getFullYear').mockReturnValue(local)
  try {
    const result = query408()
    expect(result.snapshotStartedAt).toBe(iso)
    expect(result.total).toBe(eligible)
    expect(result.rows.map(row => row.enterpriseId)).toEqual(eligible ? [a.enterprise.id] : [])
    if (eligible) expect(result.rows[0]!.qualificationAssessment.asOf).toBe(iso)
    const filtered = query408({ recognitionFrom: '2023-01-01', recognitionTo: '2023-12-31', validYear: 2025 })
    expect(filtered.total).toBe(0) // execution year does not supply missing source validYear
  } finally { localYear.mockRestore() }
})

it('wal_writer_changes_are_visible_only_on_next_current_snapshot_408', () => {
  const file = qualificationFileFixture()
  let injected = false
  let restore: (() => void) | undefined
  try {
    const a = file.formal('synthetic_408_pinned')
    const original = readCurrentQualificationAssessment(file.sqlite, a.enterprise.id, Date.parse(AS_OF_408))
    file.sqlite.pragma('query_only = ON')
    const changes = (file.sqlite.prepare('select total_changes() n').get() as { n: number }).n
    const prepare = file.sqlite.prepare.bind(file.sqlite)
    const spy = vi.spyOn(file.sqlite, 'prepare').mockImplementation((sql: string) => {
      const statement = prepare(sql)
      if (/\b(?:from|join)\s+["`]?record_event["`]?\b/i.test(sql)) {
        const all = statement.all.bind(statement)
        statement.all = ((...args: unknown[]) => {
          if (!injected) {
            injected = true
            const writer = file.writer()
            try { writer.prepare('update enterprise set district=? where id=?').run('海曙区', a.enterprise.id) } finally { writer.close() }
          }
          return all(...args)
        }) as typeof statement.all
      }
      return statement
    })
    restore = () => spy.mockRestore()
    const pinned = listCurrentQualified(file.sqlite, { titleCode: 'innovative_sme' })
    expect(injected).toBe(true)
    expect(pinned.rows[0]!.district).toBe('鄞州区')
    expect(pinned.rows[0]!.qualificationAssessment).toEqual(original)
    const fresh = listCurrentQualified(file.sqlite, { titleCode: 'innovative_sme' })
    expect(fresh.rows[0]!.district).toBe('海曙区')
    expect(fresh.rows[0]!.qualificationAssessment.asOf).toBe(AS_OF_408)
    expect(fresh.rows[0]!.qualificationAssessment.snapshotId).not.toBe(original.snapshotId)
    expect((file.sqlite.prepare('select total_changes() n').get() as { n: number }).n).toBe(changes)
  } finally { restore?.(); file.close() }
})

it('name_order_and_id_ties_apply_before_eligible_pages_with_expired_controls_408', () => {
  const m = qualificationMatrix(fixture.sqlite)
  const ez = m.formal('synthetic_408_sort_z'), ea = m.formal('synthetic_408_sort_a')
  const pz = m.formal('synthetic_408_sort_z', pendingEvents408), pa = m.formal('synthetic_408_sort_a', pendingEvents408)
  for (const [sort, expectedEligible, expectedPending] of [
    ['name_asc', [ea.enterprise.id, ez.enterprise.id], [pa.enterprise.id, pz.enterprise.id]],
    ['name_desc', [ez.enterprise.id, ea.enterprise.id], [pz.enterprise.id, pa.enterprise.id]],
  ] as const) {
    for (const page of [1, 2]) {
      const result = query408({ q: 'synthetic_408_sort', sort, page, pageSize: 1 })
      expect(result.rows.map(row => row.enterpriseId)).toEqual([expectedEligible[page - 1]])
      expect(result.publishedPending.rows.map(row => row.enterpriseId)).toEqual([])
      expect(expectedPending.every(id => !result.rows.some(row => row.enterpriseId === id))).toBe(true)
      expect(result.total).toBe(2); expect(result.publishedPending.total).toBe(0)
    }
  }
})

it('old_cycle_and_other_title_cannot_supply_current_filter_facts_408', () => {
  const m = qualificationMatrix(fixture.sqlite)
  const eligible = m.formal('synthetic_408_cycle_eligible', [
    { eventType: 'award', year: 2021, decidedYear: 2021, batchSeq: 1 },
    { eventType: 'award', year: 2025, decidedYear: 2025, batchSeq: 1 },
  ], { uscc: '91330200000000408X' })
  m.recognized(eligible.enterprise.id, eligible.events[0]!.id, { rddqrq: '2028-06-01' })
  m.recognized(eligible.enterprise.id, eligible.events[1]!.id, { whpc: '2024-2' })
  const pending = m.formal('synthetic_408_cycle_pending', [
    { eventType: 'award', year: 2019, decidedYear: 2019, batchSeq: 1 }, ...pendingEvents408,
  ], { uscc: '913302000000004091' })
  m.recognized(pending.enterprise.id, pending.events[0]!.id, { rddqrq: '2028-06-01' })
  m.recognized(pending.enterprise.id, pending.events[1]!.id, { whpc: '2024-2' })
  const specialized = m.formal('unused', undefined, { enterpriseId: pending.enterprise.id, title: 'specialized_sme' })
  m.recognized(pending.enterprise.id, specialized.events[0]!.id, { rddqrq: '2028-06-01', whpc: '2024-2' })
  const result = query408({ q: 'synthetic_408_cycle', validYear: 2028, maintenanceYear: 2024 })
  expect(result).toMatchObject({ rows: [], total: 0, uncertainTotal: 0, publishedPending: { total: 0, rows: [] } })
  expect(readCurrentQualificationAssessment(fixture.sqlite, pending.enterprise.id).titles[2]!.effectiveQualification?.status).toBe('expired')
  expect(result.options.validYears).toEqual([])
  expect(result.options.maintenanceYears).toEqual([2024])
})

it('empty_dataset_is_a_successful_empty_scope_not_an_unrequested_census_408', () => {
  const unrequested = query408()
  expect(unrequested).toMatchObject({ rows: [], total: 0, uncertainTotal: 0, publishedPending: { requested: false, rows: [], total: 0 } })
  expect(unrequested.options).toEqual({ recognitionYears: [], validYears: [], maintenanceYears: [], maintenanceBatchesByYear: {} })
  expect(query408({ q: 'synthetic_408_absent' })).toMatchObject({ rows: [], total: 0, uncertainTotal: 0, publishedPending: { requested: true, rows: [], total: 0 } })
})

// Independent nonempty reference controls appended after the frozen 41-case prefix.
import { qualificationReferenceLiterals } from '../fixtures/qualification-matrix'
import { createEnterpriseTitleCorrespondenceRefsReader, listRecordCorrespondenceRefs } from '../../../server/utils/record-correspondence'

type RefLiteral408 = { id: number; queryId: number; status: string | null; year: number | null; batch: string | null }
function assertRefSnapshot408(enterpriseId: number, refs: Record<'little_giant' | 'specialized_sme' | 'innovative_sme', RefLiteral408[]>, ownQueryIds?: number[]) {
  fixture.sqlite.pragma('query_only = ON')
  const changes = fixture.totalChanges()
  const options = ownQueryIds === undefined ? {} : { ownQueryIds }
  const defaults = readCurrentQualificationAssessment(fixture.sqlite, enterpriseId, Date.parse(AS_OF_408), options)
  const optimized = createCurrentQualificationAssessmentReader(fixture.sqlite).read(enterpriseId, Date.parse(AS_OF_408), options, 'innovative_sme').snapshot
  expect(optimized).toEqual(defaults)
  expect(defaults).toMatchObject({ enterpriseId, asOf: AS_OF_408, ruleVersion: 'current-roster-116-v11', assessmentVersion: 'enterprise-qualification-687-v4' })
  expect(defaults.titles.map(t => t.titleCode)).toEqual(['little_giant', 'specialized_sme', 'innovative_sme'])
  for (const title of defaults.titles) {
    const expected = refs[title.titleCode]
    expect(title.references.filter(ref => ref.startsWith('platform-relation:')))
      .toEqual(expected.map(ref => `platform-relation:${ref.id} query:${ref.queryId}`))
    // Query coverage order is descending query timestamp/ID; each query's row
    // order is ascending relation ID. Expectations come only from literal seeds.
    const selected = expected.filter(ref => ownQueryIds === undefined || ownQueryIds.includes(ref.queryId))
    const queries = [...new Set(selected.map(ref => ref.queryId))].sort((a, b) => b - a)
    expect(title.platform.observations.filter(source => source.rows.length).map(source => ({ queryId: source.queryId, rows: source.rows })))
      .toEqual(queries.map(queryId => ({ queryId, rows: selected.filter(ref => ref.queryId === queryId).map(ref => ({ relationId: ref.id, status: ref.status, year: ref.year, batch: ref.batch })) })))
  }
  expect(defaults.snapshotId).toBe(independentDigest408(defaults))
  expect(optimized.snapshotId).toBe(independentDigest408(optimized))
  expect(fixture.totalChanges()).toBe(changes)
  return defaults
}

it('prepared_refs_empty_and_alternating_bindings_preserve_nullable_projection_408', () => {
  const m = qualificationMatrix(fixture.sqlite), r = qualificationReferenceLiterals(fixture.sqlite)
  const a = m.formal('synthetic_408_ref_binding_a'), b = m.formal('synthetic_408_ref_binding_b')
  const prepared = createEnterpriseTitleCorrespondenceRefsReader(m.db)
  expect(prepared(a.enterprise.id, 'innovative_sme')).toEqual([])
  const candidate = r.legacyRef('binding_candidate', 'candidate', a.enterprise.id, 'innovative_sme')
  const rejected = r.legacyRef('binding_rejected', 'rejected', a.enterprise.id, 'innovative_sme')
  const unlinked = r.legacyRef('binding_unlinked', 'unlinked', a.enterprise.id, 'specialized_sme')
  const other = r.legacyRef('binding_other', 'candidate', b.enterprise.id, 'innovative_sme')
  const literal = (id: number, enterpriseId: number, titleCode: string, status: string) => ({ id, type: 'later_process', role: 'followup_review', status, eventId: null, predecessorEventId: null, relationId: null, exportRowId: null, enterpriseId, titleCode, revision: 1, requiresRevalidation: false })
  fixture.sqlite.pragma('query_only = ON')
  const changes = fixture.totalChanges()
  expect(prepared(a.enterprise.id, 'innovative_sme')).toEqual([literal(candidate.id, a.enterprise.id, 'innovative_sme', 'candidate'), literal(rejected.id, a.enterprise.id, 'innovative_sme', 'rejected')])
  expect(prepared(a.enterprise.id, 'specialized_sme')).toEqual([literal(unlinked.id, a.enterprise.id, 'specialized_sme', 'unlinked')])
  expect(prepared(b.enterprise.id, 'innovative_sme')).toEqual([literal(other.id, b.enterprise.id, 'innovative_sme', 'candidate')])
  expect(prepared(b.enterprise.id, 'little_giant')).toEqual([])
  expect(prepared(a.enterprise.id, 'innovative_sme')).toEqual(listRecordCorrespondenceRefs(m.db, { enterpriseId: a.enterprise.id, titleCode: 'innovative_sme' }))
  expect(fixture.totalChanges()).toBe(changes)
})

it('prepared_refs_refresh_new_confirmed_edges_and_source_revision_validity_408', () => {
  const m = qualificationMatrix(fixture.sqlite), r = qualificationReferenceLiterals(fixture.sqlite)
  const a = m.formal('synthetic_408_live_edges', undefined, { uscc: '91330200000000408X' })
  const file = r.officialFile()
  expect(file.sha256).toBe(createHash('sha256').update(Buffer.from('synthetic_408_formal_source_bytes')).digest('hex'))
  const prepared = createEnterpriseTitleCorrespondenceRefsReader(m.db)
  expect(prepared(a.enterprise.id, 'innovative_sme')).toEqual([])
  const one = m.recognized(a.enterprise.id, a.events[0]!.id, { rddqrq: '2028-06-01' })
  const id1 = (fixture.sqlite.prepare('select id,source_fingerprint as fingerprint from record_correspondence where observation_id=(select observation_id from platform_legacy_relation_alias where old_id=?)').get(one.id) as { id: number; fingerprint: string })
  expect(id1.fingerprint).toMatch(/^[a-f0-9]{64}$/)
  const literal = (id: number, relationId: number, requiresRevalidation: boolean) => ({ id, type: 'event_recognized', role: 'recognized_corrob', status: 'confirmed', eventId: a.events[0]!.id, predecessorEventId: null, relationId, exportRowId: null, enterpriseId: a.enterprise.id, titleCode: 'innovative_sme', revision: 2, requiresRevalidation })
  expect(prepared(a.enterprise.id, 'innovative_sme')).toEqual([literal(id1.id, one.id, false)])
  const two = m.recognized(a.enterprise.id, a.events[0]!.id, { whpc: '2024-2' })
  const id2 = (fixture.sqlite.prepare('select id from record_correspondence where observation_id=(select observation_id from platform_legacy_relation_alias where old_id=?)').get(two.id) as { id: number }).id
  expect(prepared(a.enterprise.id, 'innovative_sme')).toEqual([literal(id1.id, one.id, false), literal(id2, two.id, false)])
  // Genuine source revision drift, not a cached flag or a fabricated confirmed row.
  fixture.sqlite.prepare('update record_event set revision=revision+1 where id=?').run(a.events[0]!.id)
  fixture.sqlite.pragma('query_only = ON')
  const changes = fixture.totalChanges()
  const drifted = prepared(a.enterprise.id, 'innovative_sme')
  expect(drifted).toEqual([literal(id1.id, one.id, true), literal(id2, two.id, true)])
  expect(drifted).toEqual(listRecordCorrespondenceRefs(m.db, { enterpriseId: a.enterprise.id, titleCode: 'innovative_sme' }))
  expect(fixture.totalChanges()).toBe(changes)
})

// Independent JSON literals for the private cross-request assertion adapter.
import { assertQualificationRowsSnapshotEqual } from '../fixtures/qualification-matrix'
import type { CurrentQualifiedRow } from '../../../lib/roster/current-qualified-query'
import type { CurrentQualificationAssessment } from '../../../lib/roster/current-qualification'

function crossRequestLiteralRows408(asOf: string): CurrentQualifiedRow[] {
  return [4081, 4082].map(enterpriseId => {
    const titles: CurrentQualificationAssessment[] = ([
      { titleCode: 'little_giant', group: 'eligible', eventId: enterpriseId * 10 + 1 },
      { titleCode: 'specialized_sme', group: 'eligible', eventId: enterpriseId * 10 + 2 },
      { titleCode: 'innovative_sme', group: 'eligible', eventId: enterpriseId * 10 + 3 },
    ] as const).map(({ titleCode, group, eventId }): CurrentQualificationAssessment => ({
      titleCode, group, cycles: [{ originYear: 2025, batchSeq: 1, precision: 'year' }],
      versions: { facts: '1'.repeat(64), sources: '2'.repeat(64), decisions: '3'.repeat(64), observations: '4'.repeat(64) },
      officialQualification: { group, message: 'synthetic_408_formal_status', basis: 'synthetic_408_formal_basis', notes: [] },
      subject: { status: 'not_established', message: '未见主体终止事实', decisionIds: [] },
      region: { status: 'ningbo', message: '合成宁波正式范围', decisionIds: [enterpriseId * 10 + 401] },
      platform: { status: 'not_queried', comparison: 'not_established', message: '未查询不否定正式资格', truncated: false, observations: [] },
      correspondence: { status: 'unmatched', message: '对应不代替资格', refs: [] },
      completeness: { status: 'recorded', message: '合成字段已记录', gaps: [], eventIds: [], fieldGaps: [], publishedNames: [{ evidenceId: eventId + 100, availability: 'captured', nameKnown: true }] },
      evidence: [{ eventId, revision: 1, eventType: 'award', year: 2025, batchSeq: 1, decidedYear: 2025, reviewOutcome: null, evidenceIds: [eventId + 100] }],
      sourceVersions: [{ evidenceId: eventId + 100, eventId, sourceFile: 'synthetic/408/adapter-literal.pdf', storedFileId: null, sha256: null, bytes: null, removedAt: null, capturedRevision: 1, capturedSha256: '5'.repeat(64) }],
      references: [`evidence:${eventId + 100}`], notes: [], shadow: { legacyGroup: group, difference: null },
    }))
    const scope = { enterpriseId, asOf, ruleVersion: 'current-roster-116-v11', assessmentVersion: 'enterprise-qualification-687-v4' }
    return {
      enterpriseId, name: `synthetic_408_adapter_${enterpriseId}`, uscc: null, district: '鄞州区', publishedNames: [`synthetic_408_published_${enterpriseId}`], aliases: ['synthetic_408_confirmed_alias'], firstYear: 2025,
      basis: 'synthetic_408_basis', reviews: '', publication: '已见本称号宁波公布记录', notes: [], references: [`evidence:${enterpriseId * 10 + 103}`], group: 'eligible',
      recognition: { precision: 'year', year: 2025 }, matchedValidYears: [2028], matchedMaintenance: [{ year: 2024, batch: null }],
      qualificationWitnesses: [{ cycle: { originYear: 2025, batchSeq: 1 }, awardEventId: enterpriseId * 10 + 3, recognition: { precision: 'year', year: 2025 }, matchedValidYear: 2028, matchedMaintenance: { year: 2024, batch: null }, correspondenceId: enterpriseId * 10 + 201, conditionQueryId: enterpriseId * 10 + 301 }],
      workbookFacts: { events: [], evidence: [], migration: [{ basis: 'synthetic_408_validity', awardYear: 2025, validFrom: '2025-01-01', validUntil: '2028-12-31', publicationScope: '宁波市' }], platform: [], assessments: [], correspondenceNeedsRevalidation: false },
      publishedPresentation: { availability: 'available', error: null, facts: [{ evidenceId: enterpriseId * 10 + 103, eventId: enterpriseId * 10 + 3, revision: 1, availability: 'captured', nameRaw: `synthetic_408_published_${enterpriseId}`, sourceBindingKnown: true }] },
      qualificationAssessment: { ...scope, titles, snapshotId: createHash('sha256').update(JSON.stringify([scope, titles])).digest('hex') },
    }
  })
}
// Independently bind mutated input literals so business controls do not merely
// trip a stale digest. This is not a production assessment/expected generator.
function sealCrossRequestRows408(rows: CurrentQualifiedRow[]) {
  for (const { qualificationAssessment: snapshot } of rows) {
    const scope = { enterpriseId: snapshot.enterpriseId, asOf: snapshot.asOf, ruleVersion: snapshot.ruleVersion, assessmentVersion: snapshot.assessmentVersion }
    snapshot.snapshotId = createHash('sha256').update(JSON.stringify([scope, snapshot.titles])).digest('hex')
  }
}
const crossRequestTimes408 = ['2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.027Z'] as const

it('cross_request_rows_empty_arrays_remain_exact_408', () => {
  expect(() => assertQualificationRowsSnapshotEqual([], [])).not.toThrow()
})

it('cross_request_rows_validated_times_preserve_complete_input_408', () => {
  const actual = crossRequestLiteralRows408(crossRequestTimes408[1]), expected = crossRequestLiteralRows408(crossRequestTimes408[0])
  // Deliberate top-level collisions must remain nested, not be overwritten by wrapping.
  for (const rows of [actual, expected]) Object.assign(rows[0]!, { enterprise: { originalRowField: 'preserved' }, currentQualifiedRow: { originalRowField: 'preserved' }, futureField: { value: null } })
  const before = structuredClone({ actual, expected })
  expect(() => assertQualificationRowsSnapshotEqual(actual, expected)).not.toThrow()
  expect({ actual, expected }).toStrictEqual(before)
})

it.each<{ id: string; mutate: (rows: CurrentQualifiedRow[]) => void; seal?: boolean }>([
  { id: 'invalid_iso', mutate: rows => { rows[0]!.qualificationAssessment.asOf = 'not-an-iso' }, seal: true },
  { id: 'noncanonical_iso', mutate: rows => { rows[0]!.qualificationAssessment.asOf = '2026-06-01T00:00:00Z' }, seal: true },
  { id: 'invalid_digest', mutate: rows => { rows[0]!.qualificationAssessment.snapshotId = '0'.repeat(64) } },
  { id: 'later_row_digest', mutate: rows => { rows[1]!.qualificationAssessment.snapshotId = '0'.repeat(64) } },
  { id: 'identity_mismatch', mutate: rows => { rows[0]!.qualificationAssessment.enterpriseId = 9999 }, seal: true },
  { id: 'invalid_identity', mutate: rows => { rows[0]!.enterpriseId = 0; rows[0]!.qualificationAssessment.enterpriseId = 0 }, seal: true },
  { id: 'missing_assessment', mutate: rows => { Reflect.deleteProperty(rows[0]!, 'qualificationAssessment') } },
  { id: 'missing_title', mutate: rows => { rows[0]!.qualificationAssessment.titles.pop() }, seal: true },
  { id: 'duplicate_title', mutate: rows => { rows[0]!.qualificationAssessment.titles[1]!.titleCode = 'little_giant' }, seal: true },
  { id: 'title_order', mutate: rows => { rows[0]!.qualificationAssessment.titles.reverse() }, seal: true },
  { id: 'missing_version', mutate: rows => { Reflect.deleteProperty(rows[0]!.qualificationAssessment.titles[0]!.versions, 'sources') }, seal: true },
  { id: 'blank_version', mutate: rows => { rows[0]!.qualificationAssessment.titles[0]!.versions.observations = ' ' }, seal: true },
  { id: 'nonplain_row', mutate: rows => { Object.setPrototypeOf(rows[0]!, null) } },
])('cross_request_rows_reject_invalid_snapshot_408_$id', ({ mutate, seal }) => {
  const actual = crossRequestLiteralRows408(crossRequestTimes408[1]), expected = crossRequestLiteralRows408(crossRequestTimes408[0])
  mutate(actual)
  if (seal) sealCrossRequestRows408(actual)
  const invalidExpected = crossRequestLiteralRows408(crossRequestTimes408[0])
  mutate(invalidExpected)
  if (seal) sealCrossRequestRows408(invalidExpected)
  const before = JSON.stringify({ actual, expected, invalidExpected })
  expect(() => assertQualificationRowsSnapshotEqual(actual, expected)).toThrow()
  // Symmetric validation: neither expected nor actual may contain an invalid T2.
  expect(() => assertQualificationRowsSnapshotEqual(expected, actual)).toThrow()
  // Equally malformed inputs must also fail, rather than passing deep equality.
  expect(() => assertQualificationRowsSnapshotEqual(actual, invalidExpected)).toThrow()
  expect(JSON.stringify({ actual, expected, invalidExpected })).toBe(before)
})

it.each<{ id: string; mutate: (rows: CurrentQualifiedRow[]) => void }>([
  { id: 'row_references', mutate: rows => { rows[0]!.references.push('evidence:9999') } },
  { id: 'row_aliases', mutate: rows => { rows[0]!.aliases.push('synthetic_408_other_alias') } },
  { id: 'later_row_aliases', mutate: rows => { rows[1]!.aliases.push('synthetic_408_other_alias') } },
  { id: 'row_name', mutate: rows => { rows[0]!.name = 'synthetic_408_changed_name' } },
  { id: 'row_unknown_extra', mutate: rows => { Object.assign(rows[0]!, { futureContractField: { flag: true } }) } },
  { id: 'row_unknown_missing', mutate: rows => { Reflect.deleteProperty(rows[0]!, 'futureContractField') } },
  { id: 'row_missing_field', mutate: rows => { Reflect.deleteProperty(rows[0]!, 'firstYear') } },
  { id: 'row_enterprise_collision', mutate: rows => { Object.assign(rows[0]!, { enterprise: { originalRowField: 'new' } }) } },
  { id: 'row_wrapper_collision', mutate: rows => { Object.assign(rows[0]!, { currentQualifiedRow: { originalRowField: 'new' } }) } },
  { id: 'qualification_group', mutate: rows => { rows[0]!.qualificationAssessment.titles[2]!.group = 'excluded' } },
  { id: 'qualification_versions', mutate: rows => { rows[0]!.qualificationAssessment.titles[1]!.versions.decisions = '6'.repeat(64) } },
  { id: 'rule_version', mutate: rows => { rows[0]!.qualificationAssessment.ruleVersion = 'synthetic_408_changed_rule' } },
  { id: 'assessment_version', mutate: rows => { rows[0]!.qualificationAssessment.assessmentVersion = 'synthetic_408_changed_assessment' } },
  { id: 'qualification_detail', mutate: rows => { rows[0]!.qualificationAssessment.titles[0]!.completeness.message = 'synthetic_408_new_gap' } },
  { id: 'qualification_cycle', mutate: rows => { rows[0]!.qualificationAssessment.titles[2]!.cycles[0]!.originYear = 2024 } },
  { id: 'validity_interval', mutate: rows => { rows[0]!.workbookFacts!.migration[0]!.validUntil = '2027-12-31' } },
  { id: 'qualification_refs', mutate: rows => { rows[0]!.qualificationAssessment.titles[2]!.references.push('evidence:9999') } },
  { id: 'qualification_unknown_extra', mutate: rows => { Object.assign(rows[0]!.qualificationAssessment, { futureAssessmentField: { flag: true } }) } },
])('cross_request_rows_reject_business_change_408_$id', ({ id, mutate }) => {
  const actual = crossRequestLiteralRows408(crossRequestTimes408[1]), expected = crossRequestLiteralRows408(crossRequestTimes408[0])
  if (id === 'row_enterprise_collision' || id === 'row_wrapper_collision') {
    for (const rows of [actual, expected]) Object.assign(rows[0]!, { enterprise: { originalRowField: 'old' }, currentQualifiedRow: { originalRowField: 'old' } })
  }
  if (id === 'row_unknown_missing') for (const rows of [actual, expected]) Object.assign(rows[0]!, { futureContractField: { flag: true } })
  mutate(actual)
  sealCrossRequestRows408(actual)
  const before = structuredClone({ actual, expected })
  expect(() => assertQualificationRowsSnapshotEqual(actual, expected)).toThrow()
  expect({ actual, expected }).toStrictEqual(before)
})

it.each<{ id: string; mutate: (rows: CurrentQualifiedRow[]) => void }>([
  { id: 'missing_row', mutate: rows => { rows.pop() } },
  { id: 'extra_row', mutate: rows => { rows.push(structuredClone(rows[0]!)) } },
  { id: 'row_order', mutate: rows => { rows.reverse() } },
])('cross_request_rows_reject_array_difference_408_$id', ({ mutate }) => {
  const actual = crossRequestLiteralRows408(crossRequestTimes408[1]), expected = crossRequestLiteralRows408(crossRequestTimes408[0])
  mutate(actual)
  const before = structuredClone({ actual, expected })
  expect(() => assertQualificationRowsSnapshotEqual(actual, expected)).toThrow()
  expect({ actual, expected }).toStrictEqual(before)
})

it('prepared_refs_reuse_compilation_without_caching_source_validity_511', () => {
  const m = qualificationMatrix(fixture.sqlite), r = qualificationReferenceLiterals(fixture.sqlite)
  const a = m.formal('statistics_compilation_budget', undefined, { uscc: '91330200000000408X' })
  r.officialFile()
  m.recognized(a.enterprise.id, a.events[0]!.id, { rddqrq: '2028-06-01' })
  const prepare = vi.spyOn(fixture.sqlite, 'prepare')
  try {
    const read = createEnterpriseTitleCorrespondenceRefsReader(m.db)
    for (let i = 0; i < 4; i++) expect(read(a.enterprise.id, 'innovative_sme').map(row => row.requiresRevalidation)).toEqual([false])
    fixture.sqlite.prepare('update record_event set revision=revision+1 where id=?').run(a.events[0]!.id)
    expect(read(a.enterprise.id, 'innovative_sme').map(row => row.requiresRevalidation)).toEqual([true])
    // Guard the measured repeated compilation, not wall time on a CI machine.
    expect(prepare.mock.calls.filter(([sql]) => sql.includes('ref_owner')).length).toBe(1)
  } finally { prepare.mockRestore() }
})

it('effective_count_projection_preserves_status_and_basis_without_correspondence_reads_511', () => {
  const m = qualificationMatrix(fixture.sqlite), r = qualificationReferenceLiterals(fixture.sqlite)
  const a = m.formal('statistics_effective_projection', undefined, { uscc: '91330200000000408X' })
  r.officialFile()
  m.recognized(a.enterprise.id, a.events[0]!.id, { rddqrq: '2028-06-01' })
  const reader = createCurrentQualificationAssessmentReader(fixture.sqlite)
  const asOf = Date.parse(AS_OF_408)
  for (const drift of [false, true]) {
    if (drift) fixture.sqlite.prepare('update record_event set revision=revision+1 where id=?').run(a.events[0]!.id)
    const full = reader.readTitle(a.enterprise.id, 'innovative_sme', asOf)
    let correspondenceReads=0
    const originalPrepare=fixture.sqlite.prepare.bind(fixture.sqlite)
    const prepare = vi.spyOn(fixture.sqlite, 'prepare').mockImplementation(text=>{
      const statement=originalPrepare(text)
      if(/\bfrom\s+["`]?record_correspondence["`]?\b/i.test(text))for(const method of ['all','get','iterate'] as const){
        const run=statement[method].bind(statement)
        Object.assign(statement,{[method]:(...args:unknown[])=>{correspondenceReads++;return run(...args)}})
      }
      return statement
    })
    try {
      expect(createCurrentQualificationAssessmentReader(fixture.sqlite).readEffectiveTitle(a.enterprise.id, 'innovative_sme', asOf)).toEqual({ effectiveStatus: full.effectiveStatus, basis: full.row.basis })
      expect(correspondenceReads).toBe(0)
    } finally { prepare.mockRestore() }
  }
})

it('native complete recognized collections keep each title and source row in its own scope', () => {
  const m = qualificationMatrix(fixture.sqlite)
  const first = m.formal('native_three_title_source')
  const refs: Record<'little_giant' | 'specialized_sme' | 'innovative_sme', RefLiteral408[]> = { little_giant:[],specialized_sme:[],innovative_sme:[] }
  for (const title of ['little_giant','specialized_sme','innovative_sme'] as const) {
    const formal = title === 'innovative_sme' ? first : m.formal('native_three_title_source', undefined, {enterpriseId:first.enterprise.id,title})
    const row = m.recognized(first.enterprise.id,formal.events[0]!.id,{rddqrq:'2028-06-01',whpc:'2025-1'})
    refs[title].push({id:row.id,queryId:row.queryId,status:null,year:null,batch:null})
  }
  assertRefSnapshot408(first.enterprise.id,refs)
})

it('native recognized submission rejects ownership that conflicts with source identity atomically', () => {
  const m=qualificationMatrix(fixture.sqlite), first=m.formal('native_source_owner'), other=m.formal('native_wrong_owner')
  const raw={id:'native-owner-conflict',qymc:first.enterprise.name,tyshxydm:first.enterprise.usccNorm!,rdjb:'1',rddqrq:'2028-06-01'}
  const stamp='2026-05-20T00:00:00Z'
  const evidence={source:'queryBusList' as const,status:'success' as const,effectiveConditions:{uscc:first.enterprise.usccNorm!,combination:'and' as const},titleScope:{mode:'selected' as const,rdjb:['1']},queriedAt:stamp,completedAt:stamp,rows:[raw],pages:[{source:'queryBusList' as const,rdjb:'1',page:1,status:'success' as const,fetchedCount:1,declaredTotal:1,maxPage:1,error:null}],fetchedCount:1,declaredTotal:1,completeness:'complete' as const,fullRange:true,unfinished:[],error:null,limits:{maxRequests:1,maxRows:50,maxDurationMs:1000,pageSize:50}}
  const before=fixture.sqlite.prepare('select count(*) n from platform_collection').get()
  expect(()=>submitNativePlatformQuery(m.db,{interface:'recognized_list',queryKey:first.enterprise.usccNorm!,titleCode:'innovative_sme',rdjb:'1',queriedAt:stamp,status:'success',collectionEvidence:evidence,relations:[{sequenceNo:1,relationKey:raw.id,nameRaw:raw.qymc,usccRaw:raw.tyshxydm,rawFields:raw,enterpriseId:other.enterprise.id,matchBasis:'uscc',verificationStatus:'confirmed'}]})).toThrow('Explicit enterprise must match original row USCC')
  expect(fixture.sqlite.prepare('select count(*) n from platform_collection').get()).toEqual(before)
})
