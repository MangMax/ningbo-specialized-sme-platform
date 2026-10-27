import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { assertEnterpriseDetailSnapshotEqual } from './helpers/enterprise-detail-snapshot'

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
    { id: 'C04 invalid timestamp', time: 'not-a-time' },
    { id: 'C05 invalid calendar day', time: '2026-02-30T12:00:00.000Z' },
    { id: 'C06 non ISO timestamp', time: '2026-10-27' },
    { id: 'C07 missing timestamp', time: undefined },
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
    { id: 'C11 fact version', change: (q: ReturnType<typeof detail>['qualificationAssessment']) => { q.titles[0]!.versions.facts = 'fact-v2' } },
    { id: 'C12 source version', change: (q: ReturnType<typeof detail>['qualificationAssessment']) => { q.titles[0]!.versions.sources = 'source-v2' } },
    { id: 'C13 decision version', change: (q: ReturnType<typeof detail>['qualificationAssessment']) => { q.titles[0]!.versions.decisions = 'decision-v2' } },
    { id: 'C14 observation version', change: (q: ReturnType<typeof detail>['qualificationAssessment']) => { q.titles[0]!.versions.observations = 'observation-v2' } },
    { id: 'C15 unknown versus no record', change: (q: ReturnType<typeof detail>['qualificationAssessment']) => { q.titles[0]!.platform.observations[0]!.rows = [] } },
    { id: 'C16 rule version', change: (q: ReturnType<typeof detail>['qualificationAssessment']) => { q.ruleVersion = 'current-roster-next' } },
    { id: 'C17 assessment version', change: (q: ReturnType<typeof detail>['qualificationAssessment']) => { q.assessmentVersion = 'enterprise-next' } },
    { id: 'C18 original cycle', change: (q: ReturnType<typeof detail>['qualificationAssessment']) => { q.titles[0]!.cycles[0]!.batchSeq = 1 } },
    { id: 'C19 subject', change: (q: ReturnType<typeof detail>['qualificationAssessment']) => { q.titles[0]!.subject.status = 'terminated' } },
    { id: 'C20 region', change: (q: ReturnType<typeof detail>['qualificationAssessment']) => { q.titles[0]!.region.status = 'outside_ningbo' } },
    { id: 'C21 correspondence', change: (q: ReturnType<typeof detail>['qualificationAssessment']) => { q.titles[0]!.correspondence.refs[0]!.revision = 2 } },
    { id: 'C22 completeness', change: (q: ReturnType<typeof detail>['qualificationAssessment']) => { q.titles[0]!.completeness.publishedNames[0]!.nameKnown = true } },
    { id: 'C23 evidence revision', change: (q: ReturnType<typeof detail>['qualificationAssessment']) => { q.titles[0]!.evidence[0]!.revision = 2 } },
    { id: 'C24 source capture', change: (q: ReturnType<typeof detail>['qualificationAssessment']) => { q.titles[0]!.sourceVersions[0]!.capturedRevision = 2 } },
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
