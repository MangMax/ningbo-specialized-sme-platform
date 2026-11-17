import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { assertEnterpriseDetailSnapshotEqual } from '../assertions/enterprise-detail-snapshot'

// Literal business results: no production reader, qualification oracle, DB or HTTP.
function detail(asOf = '2026-10-27T12:00:00.000Z') {
  const scope = { enterpriseId: 7, asOf, ruleVersion: 'current-roster-116-v8', assessmentVersion: 'enterprise-qualification-406-v1' }
  const title = {
    titleCode: 'innovative_sme', group: 'eligible',
    cycles: [{ originYear: 2024, batchSeq: null as number | null, precision: 'year' }],
    versions: { facts: 'fact-v1', sources: 'source-v1', decisions: 'decision-v1', observations: 'observation-v1' },
    officialQualification: { group: 'eligible', message: '正式有效', basis: '公布', notes: [] },
    subject: { status: 'not_established', message: '未建立终止事实', decisionIds: [] },
    region: { status: 'ningbo', message: '已确认地域', decisionIds: [31] },
    platform: { status: 'requires_verification', comparison: 'not_established', message: '待核', truncated: false,
      observations: [{ applicability: 'unknown_time', rows: [{ relationId: 41, status: null, year: null, batch: null }] }] },
    correspondence: { status: 'confirmed', message: '已对应', refs: [{ id: 51, revision: 1 }] },
    completeness: { status: 'incomplete', message: '公布名未知', gaps: ['name_unknown'], eventIds: [11],
      publishedNames: [{ evidenceId: 21, availability: 'available', nameKnown: false }] },
    evidence: [{ eventId: 11, revision: 1, eventType: 'recognition', year: 2024, batchSeq: null, decidedYear: null, reviewOutcome: null, evidenceIds: [21] }],
    sourceVersions: [{ evidenceId: 21, eventId: 11, sourceFile: 'literal.pdf', storedFileId: 61, sha256: 'source-hash', bytes: 123,
      removedAt: null, capturedRevision: 1, capturedSha256: 'capture-hash' }],
    references: ['event:11'], notes: [], shadow: { legacyGroup: 'eligible', difference: null },
  }
  const titles = [title, { ...structuredClone(title), titleCode: 'specialized_sme' }, { ...structuredClone(title), titleCode: 'little_giant' }]
  return { enterprise: { enterpriseId: 7, name: '字面企业', uscc: null }, records: [{ id: 9, legacy: null }],
    qualificationAssessment: { ...scope, snapshotId: digest(scope, titles), titles } }
}

// Independent metadata digest only; business expectations above remain literal.
function digest(scope: unknown, titles: unknown) {
  return createHash('sha256').update(JSON.stringify([scope, titles])).digest('hex')
}
function reseal(value: ReturnType<typeof detail>) {
  const q = value.qualificationAssessment
  q.snapshotId = digest({ enterpriseId: q.enterpriseId, asOf: q.asOf, ruleVersion: q.ruleVersion, assessmentVersion: q.assessmentVersion }, q.titles)
}

describe('enterprise detail snapshot comparison', () => {
  it('C01 legacy strict equality preserves all fields', () => {
    const a = { enterprise: { enterpriseId: 7 }, records: [{ unknown: null }], extra: undefined }
    expect(() => assertEnterpriseDetailSnapshotEqual(a, structuredClone(a))).not.toThrow()
    expect(() => assertEnterpriseDetailSnapshotEqual(a, { enterprise: { enterpriseId: 7 }, records: [{ unknown: null }] })).toThrow()
    expect(() => assertEnterpriseDetailSnapshotEqual(a, { ...a, records: [{ unknown: '' }] })).toThrow()
  })
  it('C02 identical facts at two valid execution times compare', () => {
    const a = detail(), b = detail('2026-10-27T12:00:01.000Z')
    expect(a.qualificationAssessment.snapshotId).not.toBe(b.qualificationAssessment.snapshotId)
    expect(() => assertEnterpriseDetailSnapshotEqual(a, b)).not.toThrow()
    expect(() => assertEnterpriseDetailSnapshotEqual(a, structuredClone(a))).not.toThrow()
  })
  it('C03 forged or copied snapshot identity is rejected on either side', () => {
    const a = detail(), b = detail('2026-10-27T12:00:01.000Z')
    b.qualificationAssessment.snapshotId = a.qualificationAssessment.snapshotId
    expect(() => assertEnterpriseDetailSnapshotEqual(a, b)).toThrow(/snapshotId/)
    a.qualificationAssessment.snapshotId = 'forged'
    expect(() => assertEnterpriseDetailSnapshotEqual(a, detail())).toThrow(/snapshotId/)
    expect(() => assertEnterpriseDetailSnapshotEqual(a, structuredClone(a))).toThrow(/snapshotId/)
  })
  it.each([
  ])('$id', ({ time }) => {
    const a = detail() as unknown as { qualificationAssessment: Record<string, unknown> }
    if (time === undefined) delete a.qualificationAssessment.asOf
    else a.qualificationAssessment.asOf = time
    expect(() => assertEnterpriseDetailSnapshotEqual(a, structuredClone(a))).toThrow(/asOf/)
  })
  it('C08 missing or invalid assessment is rejected', () => {
    const a = detail(), { qualificationAssessment: _q, ...legacy } = a
    expect(() => assertEnterpriseDetailSnapshotEqual(a, legacy)).toThrow()
    expect(() => assertEnterpriseDetailSnapshotEqual(legacy, a)).toThrow()
    for (const value of [undefined, null, [], {}]) {
      expect(() => assertEnterpriseDetailSnapshotEqual({ ...legacy, qualificationAssessment: value }, { ...legacy, qualificationAssessment: value })).toThrow()
    }
  })
  it('C09 legacy field change survives new envelope comparison', () => {
    const a = detail(), b = detail('2026-10-27T12:00:01.000Z')
    b.records[0]!.id = 10
    expect(() => assertEnterpriseDetailSnapshotEqual(a, b)).toThrow()
  })
  it.each([
    { id: 'C10 title result', change: (q: ReturnType<typeof detail>['qualificationAssessment']) => { q.titles[0]!.group = 'excluded' } },
    { id: 'C15 unknown versus no record', change: (q: ReturnType<typeof detail>['qualificationAssessment']) => { q.titles[0]!.platform.observations[0]!.rows = [] } },
  ])('$id', ({ change }) => {
    const a = detail(), b = detail('2026-10-27T12:00:01.000Z')
    change(b.qualificationAssessment)
    reseal(b) // Valid identity must not hide a changed business result.
    expect(() => assertEnterpriseDetailSnapshotEqual(a, b)).toThrow()
  })
  it('C25 validity boundary changes cannot be ignored', () => {
    const before = detail('2026-10-27T23:59:59.999Z'), after = detail('2026-10-28T00:00:00.000Z')
    after.qualificationAssessment.titles[0]!.officialQualification = { group: 'excluded', message: '有效期已结束', basis: '明确有效期', notes: [] }
    after.qualificationAssessment.titles[0]!.group = 'excluded'
    reseal(after)
    expect(() => assertEnterpriseDetailSnapshotEqual(before, after)).toThrow()
  })
  it('C26 extra and missing fields at every DTO level remain strict', () => {
    const a = detail()
    for (const target of ['detail', 'assessment', 'title'] as const) {
      const b = detail('2026-10-27T12:00:01.000Z')
      const obj = target === 'detail' ? b : target === 'assessment' ? b.qualificationAssessment : b.qualificationAssessment.titles[0]!
      Object.assign(obj, { future: null })
      reseal(b)
      expect(() => assertEnterpriseDetailSnapshotEqual(a, b)).toThrow()
      expect(() => assertEnterpriseDetailSnapshotEqual(b, a)).toThrow()
    }
    const b = detail()
    Reflect.deleteProperty(b.qualificationAssessment.titles[0]!, 'notes')
    reseal(b)
    expect(() => assertEnterpriseDetailSnapshotEqual(a, b)).toThrow()
  })
  it('C27 enterprise scope and required envelope fields are validated', () => {
    const a = detail(), b = detail()
    b.qualificationAssessment.enterpriseId = 8
    reseal(b)
    expect(() => assertEnterpriseDetailSnapshotEqual(b, structuredClone(b))).toThrow(/enterprise/)
    for (const field of ['enterpriseId', 'ruleVersion', 'assessmentVersion', 'snapshotId', 'titles']) {
      const invalid = detail()
      Reflect.deleteProperty(invalid.qualificationAssessment, field)
      expect(() => assertEnterpriseDetailSnapshotEqual(invalid, structuredClone(invalid))).toThrow()
    }
    b.enterprise.enterpriseId = 8
    expect(() => assertEnterpriseDetailSnapshotEqual(a, b)).toThrow()
  })
  it('C29 digest binds all scope fields and complete titles', () => {
    for (const change of [
      (v: ReturnType<typeof detail>) => { v.qualificationAssessment.asOf = '2026-10-27T12:00:01.000Z' },
      (v: ReturnType<typeof detail>) => { v.qualificationAssessment.ruleVersion = 'another-rule' },
      (v: ReturnType<typeof detail>) => { v.qualificationAssessment.assessmentVersion = 'another-assessment' },
      (v: ReturnType<typeof detail>) => { v.enterprise.enterpriseId = 8; v.qualificationAssessment.enterpriseId = 8 },
      (v: ReturnType<typeof detail>) => { v.qualificationAssessment.titles[2]!.versions.observations = 'changed' },
      (v: ReturnType<typeof detail>) => { Object.assign(v.qualificationAssessment.titles[0]!, { future: 'changed' }) },
    ]) {
      const invalid = detail()
      change(invalid) // Deliberately retain the prior digest, on both sides.
      expect(() => assertEnterpriseDetailSnapshotEqual(invalid, structuredClone(invalid))).toThrow(/snapshotId/)
    }
  })
  it('C28 success and rejection leave inputs unchanged', () => {
    const a = detail(), b = detail('2026-10-27T12:00:01.000Z')
    const beforeA = structuredClone(a), beforeB = structuredClone(b)
    assertEnterpriseDetailSnapshotEqual(a, b)
    expect(a).toStrictEqual(beforeA)
    expect(b).toStrictEqual(beforeB)
    b.qualificationAssessment.snapshotId = 'tampered'
    const invalid = structuredClone(b)
    expect(() => assertEnterpriseDetailSnapshotEqual(a, b)).toThrow()
    expect(a).toStrictEqual(beforeA)
    expect(b).toStrictEqual(invalid)
  })
})

// Separate current-response literals keep historical no-timeline fixtures intact.
function timelineDetail(asOf = '2026-10-27T12:00:00.000Z') {
  return { ...detail(asOf), businessTimeline: { asOf, sources: [{
    source: 'recognized_list', collectionStatus: 'success', collectedAt: '2026-10-26T09:00:00.000Z',
    events: [{ key: 'recognized_list:41', platformName: '原始企业名', title: 'innovative_sme',
      matter: 'recognition', matterRaw: '认定', conclusion: 'passed', statusRaw: '有效',
      businessTimeKind: 'recognition', businessYear: 2024,
      businessTime: { raw: '2024-01-01', value: '2024-01-01', precision: 'day' },
      period: { from: { raw: '2024-01-01', value: '2024-01-01', precision: 'day' },
        until: { raw: '2026-12-31', value: '2026-12-31', precision: 'day' } },
      collectedAt: '2026-10-26T09:00:00.000Z',
    }],
  }] } }
}

describe('enterprise detail timeline snapshot comparison', () => {
  it('T01 sequential response times preserve identical timeline business facts', () => {
    const a = timelineDetail(), b = timelineDetail('2026-10-27T12:00:01.000Z')
    expect(a.businessTimeline.asOf).not.toBe(b.businessTimeline.asOf)
    expect(a.qualificationAssessment.snapshotId).not.toBe(b.qualificationAssessment.snapshotId)
    expect(() => assertEnterpriseDetailSnapshotEqual(a, b)).not.toThrow()
    expect(() => assertEnterpriseDetailSnapshotEqual(a, structuredClone(a))).not.toThrow()
  })
  it('T02 each timeline must match its own assessment before comparison', () => {
    const a = timelineDetail(), b = timelineDetail('2026-10-27T12:00:01.000Z')
    b.businessTimeline.asOf = a.businessTimeline.asOf
    expect(() => assertEnterpriseDetailSnapshotEqual(a, b)).toThrow(/businessTimeline.asOf/)
    expect(() => assertEnterpriseDetailSnapshotEqual(b, a)).toThrow(/businessTimeline.asOf/)
    expect(() => assertEnterpriseDetailSnapshotEqual(b, structuredClone(b))).toThrow(/businessTimeline.asOf/)
  })
  it.each([
    { id: 'T03 invalid execution text', time: 'not-a-time' },
    { id: 'T04 noncanonical execution time', time: '2026-10-27T12:00:00Z' },
    { id: 'T05 offset execution time', time: '2026-10-27T20:00:00.000+08:00' },
  ])('$id', ({ time }) => {
    const a = timelineDetail(), invalid = timelineDetail(time)
    // Digest is valid for the malformed scope: format validation must reject it.
    expect(() => assertEnterpriseDetailSnapshotEqual(a, invalid)).toThrow(/asOf/)
    expect(() => assertEnterpriseDetailSnapshotEqual(invalid, a)).toThrow(/asOf/)
    expect(() => assertEnterpriseDetailSnapshotEqual(invalid, structuredClone(invalid))).toThrow(/asOf/)
    const timelineOnly = timelineDetail()
    timelineOnly.businessTimeline.asOf = time
    expect(() => assertEnterpriseDetailSnapshotEqual(a, timelineOnly)).toThrow(/businessTimeline.asOf/)
  })
  it('T06 missing or invalid timeline cannot become a historical fixture', () => {
    const a = timelineDetail()
    for (const value of [detail(), { ...detail(), businessTimeline: undefined },
      { ...detail(), businessTimeline: null }, { ...detail(), businessTimeline: [] },
      { ...detail(), businessTimeline: {} }]) {
      expect(() => assertEnterpriseDetailSnapshotEqual(a, value)).toThrow()
      expect(() => assertEnterpriseDetailSnapshotEqual(value, a)).toThrow()
    }
  })
  it.each([
    { id: 'T07 source status', change: (v: ReturnType<typeof timelineDetail>) => { v.businessTimeline.sources[0]!.collectionStatus = 'failed' } },
    { id: 'T08 event conclusion', change: (v: ReturnType<typeof timelineDetail>) => { v.businessTimeline.sources[0]!.events[0]!.conclusion = 'invalid' } },
    { id: 'T09 original name', change: (v: ReturnType<typeof timelineDetail>) => { v.businessTimeline.sources[0]!.events[0]!.platformName = '变更企业名' } },
    { id: 'T10 period start', change: (v: ReturnType<typeof timelineDetail>) => { v.businessTimeline.sources[0]!.events[0]!.period.from.value = '2025-01-01' } },
    { id: 'T11 period end', change: (v: ReturnType<typeof timelineDetail>) => { v.businessTimeline.sources[0]!.events[0]!.period.until.value = '2027-12-31' } },
    { id: 'T12 event collection time', change: (v: ReturnType<typeof timelineDetail>) => { v.businessTimeline.sources[0]!.events[0]!.collectedAt = '2026-10-26T09:00:01.000Z' } },
    { id: 'T13 source collection time', change: (v: ReturnType<typeof timelineDetail>) => { v.businessTimeline.sources[0]!.collectedAt = '2026-10-26T09:00:01.000Z' } },
    { id: 'T14 missing event', change: (v: ReturnType<typeof timelineDetail>) => { v.businessTimeline.sources[0]!.events = [] } },
    { id: 'T15 missing source', change: (v: ReturnType<typeof timelineDetail>) => { v.businessTimeline.sources = [] } },
    { id: 'T18 business time', change: (v: ReturnType<typeof timelineDetail>) => { v.businessTimeline.sources[0]!.events[0]!.businessTime = { raw: '2024-01-02', value: '2024-01-02', precision: 'day' } } },
  ])('$id', ({ change }) => {
    const a = timelineDetail(), b = timelineDetail('2026-10-27T12:00:01.000Z')
    change(b)
    expect(() => assertEnterpriseDetailSnapshotEqual(a, b)).toThrow()
    expect(() => assertEnterpriseDetailSnapshotEqual(b, a)).toThrow()
  })
  it('T16 unknown timeline source event and period fields remain strict', () => {
    const a = timelineDetail()
    for (const level of ['timeline', 'source', 'event', 'period'] as const) {
      const b = timelineDetail('2026-10-27T12:00:01.000Z')
      const source = b.businessTimeline.sources[0]!, event = source.events[0]!
      const target = level === 'timeline' ? b.businessTimeline : level === 'source' ? source : level === 'event' ? event : event.period
      Object.assign(target, { future: { asOf: '2026-10-27T12:00:00.000Z' } })
      const same = structuredClone(b)
      same.businessTimeline.asOf = a.businessTimeline.asOf
      same.qualificationAssessment = structuredClone(a.qualificationAssessment)
      expect(() => assertEnterpriseDetailSnapshotEqual(b, same)).not.toThrow()
      Object.assign(target, { future: { asOf: '2026-10-27T12:00:01.000Z' } })
      expect(() => assertEnterpriseDetailSnapshotEqual(b, same)).toThrow()
      expect(() => assertEnterpriseDetailSnapshotEqual(same, b)).toThrow()
      expect(() => assertEnterpriseDetailSnapshotEqual(a, b)).toThrow()
      expect(() => assertEnterpriseDetailSnapshotEqual(b, a)).toThrow()
    }
  })
  it('T17 timeline success and rejection preserve complete input bytes', () => {
    const a = timelineDetail(), b = timelineDetail('2026-10-27T12:00:01.000Z')
    const beforeA = JSON.stringify(a), beforeB = JSON.stringify(b)
    assertEnterpriseDetailSnapshotEqual(a, b)
    expect(JSON.stringify(a)).toBe(beforeA)
    expect(JSON.stringify(b)).toBe(beforeB)
    b.businessTimeline.asOf = a.businessTimeline.asOf
    const invalid = JSON.stringify(b)
    expect(() => assertEnterpriseDetailSnapshotEqual(a, b)).toThrow()
    expect(JSON.stringify(a)).toBe(beforeA)
    expect(JSON.stringify(b)).toBe(invalid)
    b.businessTimeline.asOf = b.qualificationAssessment.asOf
    b.businessTimeline.sources[0]!.events[0]!.period.until.value = '2027-12-31'
    const changed = JSON.stringify(b)
    expect(() => assertEnterpriseDetailSnapshotEqual(a, b)).toThrow()
    expect(JSON.stringify(a)).toBe(beforeA)
    expect(JSON.stringify(b)).toBe(changed)
  })
})
