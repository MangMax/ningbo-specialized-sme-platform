import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { initializeDb, schema } from '../../../db/client'
import { submitNativePlatformQuery } from '../../platform/fixtures/native-query'
import { getRecordComparison } from '../../../layers/sme-roster/server/utils/record-comparison'
import { commitRecordCorrespondences, preflightRecordCorrespondences } from '../../../layers/sme-roster/server/utils/record-correspondence'
import { groupComparisonBusinessObservations } from '../../../layers/sme-roster/lib/roster/record-comparison'

const cleanups: Array<() => void> = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'comparison-business-'))
  const db = initializeDb({ create: true,  dbPath: join(dir, 'roster.db') })
  cleanups.push(() => { db.$client.close(); rmSync(dir, { recursive: true, force: true }) })
  const doc = db.insert(schema.sourceDocument).values({ source: 'jxj', title: 'Synthetic official', path: 'synthetic.pdf', issueDate: '2024-01-01' }).returning().get()
  const enterprise = db.insert(schema.enterprise).values({ name: 'Synthetic', nameNorm: 'Synthetic', usccNorm: '91330211255994457P' }).returning().get()
  const record = db.insert(schema.record).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', source: 'jxj' }).returning().get()
  const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2024 }).returning().get()
  db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: doc.path, page: 1 }).run()
  let n = 0
  const observation = (raw: Record<string, unknown> | null = { id: 'SQ1', value: 'A' }, options: { interface?: 'business_list' | 'apply_list' | 'recognized_list'; key?: string | null; owner?: number | null; at?: string } = {}) => {
    const result = submitNativePlatformQuery(db, { interface: options.interface ?? 'business_list', queryKey: `synthetic:${++n}`, rdjb: '2', titleCode: 'specialized_sme', status: 'partial', queriedAt: options.at ?? `2026-10-${String(10 + n).padStart(2, '0')}T00:00:00Z`, rawResponse: JSON.stringify(raw), relations: [{ sequenceNo: 1, relationKey: options.key === undefined ? 'SQ1' : options.key, rawFields: raw, enterpriseId: options.owner === undefined ? enterprise.id : options.owner, usccRaw: enterprise.usccNorm, verificationStatus: 'confirmed', matchBasis: 'uscc', year: 2024, declareKind: 'apply', status: '终审通过' }] })
    return { relation: { id: result.relationIds[0]! }, query: { id: result.queryId } }
  }
  const input = (queryIds: number[]) => ({ queryIds, exportBatchIds: [], officialSourceDocumentIds: [doc.id], page: 1, pageSize: 1 })
  const link = (relationId: number) => {
    const request = { idempotencyKey: `synthetic-link-${relationId}`, sourceIdentity: 'synthetic', actor: { type: 'user' as const, id: 'fixture' }, basis: 'Synthetic exact row checked', ruleId: 'manual', ruleVersion: '1', operations: [{ action: 'create' as const, status: 'confirmed' as const, edge: { type: 'event_process' as const, eventId: event.id, relationId, role: 'supports_award' as const } }] }
    return commitRecordCorrespondences(db, request, preflightRecordCorrespondences(db, request).planHash).correspondenceIds[0]!
  }
  return { db, enterprise, event, observation, input, link }
}

describe('comparison scoped canonical business groups', () => {
  it.each(['eventId', 'predecessorEventId', 'exportRowId'] as const)('marks different correspondence %s targets mixed while retaining equal-target observations as uniform', field => {
    const observation = (id: number, target: number) => ({
      relation: { id, interface: 'business_list' },
      businessRecord: { recordId: 1, versionId: 1, interface: 'business_list', platformKey: 'SQ1', groupState: 'verified' as const, identityState: 'resolved' as const, contentState: 'verified' as const, keySource: 'both' as const, projectionRuleVersion: 'platform-observation-v1', hashAlgorithm: 'platform-row-json-v1', contentHash: 'same-content' },
      linkState: 'later_process' as const,
      correspondences: [{ relationId: id, type: 'later_process', role: 'followup_apply', eventId: null as number | null, predecessorEventId: null as number | null, exportRowId: null as number | null, status: 'confirmed', requiresRevalidation: false, [field]: target }],
      historicalDecisionUnavailable: [], currentSource: null, withoutOfficial: null,
    })
    const first = observation(1, 11), different = observation(2, 22)
    const mixed = groupComparisonBusinessObservations([first, different])
    expect(mixed.businessGroups.rows[0]).toMatchObject({ resultState: 'mixed', versions: [{ resultState: 'mixed' }] })
    expect(mixed.businessGroups.rows[0]!.versions[0]!.observations.map(row => row.correspondences[0]![field])).toEqual([11, 22])
    // Observation endpoints differ even when both decisions have the same target.
    const equal = groupComparisonBusinessObservations([first, observation(2, 11)])
    expect(equal.businessGroups.rows[0]).toMatchObject({ resultState: 'uniform', versions: [{ resultState: 'uniform' }] })
  })

  it('combines identical observations and preserves A-B-A as two versions and three observations', () => {
    const f = fixture(), a = f.observation(), b = f.observation({ id: 'SQ1', value: 'B' }), again = f.observation()
    const out = getRecordComparison(f.db, f.input([a.query.id, b.query.id, again.query.id]))
    expect(out.businessCounts).toMatchObject({ records: 1, versions: 2, observations: 3, unknownObservations: 0 })
    expect(out.businessGroups.total).toBe(1)
    const group = out.businessGroups.rows[0]!
    expect(group.versions.map(v => v.observations.map(o => o.relation.id))).toEqual([[a.relation.id, again.relation.id], [b.relation.id]])
    expect(out.counts.distinctPlatformRows).toBe(3)
    expect(out.platformWithoutOfficial.rows.map(o => o.relation.id)).toEqual([a.relation.id, b.relation.id, again.relation.id])
  })
  it('separates interface business identities and preserves missing-key observations', () => {
    const f = fixture(), rows = [f.observation(), f.observation(undefined, { interface: 'apply_list' }), f.observation({}, { key: null }), f.observation({}, { key: null })]
    const out = getRecordComparison(f.db, f.input(rows.map(r => r.query.id)))
    expect(out.businessCounts).toMatchObject({ records: 2, versions: 2, observations: 4, unknownObservations: 2, unknownByState: { missing_key: 2 } })
    expect(out.businessGroups.rows.map(g => g.groupState)).toEqual(['resolved', 'resolved', 'missing_key', 'missing_key'])
  })
  it('keeps partial linked state mixed and never borrows old decisions for a newly selected query', () => {
    const f = fixture(), old = f.observation(), fresh = f.observation(), edge = f.link(old.relation.id)
    const out = getRecordComparison(f.db, f.input([old.query.id, fresh.query.id]))
    expect(out.businessGroups.rows[0]).toMatchObject({ linkState: 'mixed', resultState: 'mixed', versions: [{ observations: [{ relation: { id: old.relation.id }, linkState: 'linked', correspondences: [{ id: edge, relationId: old.relation.id }] }, { relation: { id: fresh.relation.id }, linkState: 'unlinked', correspondences: [] }] }] })
    const selected = getRecordComparison(f.db, f.input([fresh.query.id]))
    expect(selected.businessGroups.rows[0]).toMatchObject({ linkState: 'unlinked', versions: [{ observations: [{ correspondences: [] }] }] })
    expect(JSON.stringify(selected.businessGroups)).not.toContain(`"id":${edge},"type"`)
    expect(selected.rows[0]?.correspondences).toEqual([])
  })
  it('pages business groups independently without dropping original observations', () => {
    const f = fixture(), a = f.observation(), b = f.observation(), c = f.observation({ id: 'SQ2' }, { key: 'SQ2' })
    const input = f.input([a.query.id, b.query.id, c.query.id])
    const first = getRecordComparison(f.db, { ...input, businessPage: 1, businessPageSize: 1 })
    const second = getRecordComparison(f.db, { ...input, businessPage: 2, businessPageSize: 1 })
    expect(first.businessGroups.total).toBe(2)
    expect(first.businessCounts).toMatchObject({ records: 2, versions: 2, observations: 3 })
    expect(first.businessCounts).toEqual(second.businessCounts)
    expect(first.platformWithoutOfficial.rows.map(o => o.relation.id)).toEqual([a.relation.id, b.relation.id, c.relation.id])
    expect(second.platformWithoutOfficial.rows).toEqual(first.platformWithoutOfficial.rows)
    expect(first.businessGroups.rows[0]!.key).not.toBe(second.businessGroups.rows[0]!.key)
    expect(getRecordComparison(f.db, { ...input, enterpriseId: 99999 }).businessCounts.observations).toBe(0)
  })
  it('keeps unknown enterprise identity null while grouping verified canonical records', () => {
    const f = fixture(), a = f.observation(undefined, { owner: null }), b = f.observation(undefined, { owner: null })
    const out = getRecordComparison(f.db, f.input([a.query.id, b.query.id]))
    expect(out.businessCounts.records).toBe(1)
    expect(out.businessGroups.rows[0]!.versions[0]!.observations.map(o => o.relation.enterpriseId)).toEqual([null, null])
  })
  it('does not leak future observations or revised decisions through business groups at asOf', () => {
    const f = fixture(), a = f.observation(undefined, { at: '2026-10-11T00:00:00Z' }), future = f.observation(undefined, { at: '2026-10-20T00:00:00Z' }), edge = f.link(a.relation.id)
    f.db.update(schema.recordCorrespondence).set({ createdAt: '2026-10-11T00:01:00Z', decidedAt: '2026-10-19T00:00:00Z' }).where(eq(schema.recordCorrespondence.id, edge)).run()
    const input = { ...f.input([a.query.id]), asOf: '2026-10-18T00:00:00Z' }
    const out = getRecordComparison(f.db, input)
    expect(out.businessCounts.observations).toBe(1)
    expect(out.businessGroups.rows[0]).toMatchObject({ linkState: 'unlinked', versions: [{ observations: [{ correspondences: [], historicalDecisionUnavailable: [{ id: edge, relationId: a.relation.id }] }] }] })
    expect(JSON.stringify(out.businessGroups)).not.toContain('2026-10-19')
    expect(() => getRecordComparison(f.db, { ...input, queryIds: [a.query.id, future.query.id] })).toThrow('source_set_missing_or_out_of_scope')
  })
  it('keeps a known business with only unverifiable content as one record with zero version nodes', () => {
    const f = fixture(), a = f.observation(null), b = f.observation(null)
    const out = getRecordComparison(f.db, f.input([a.query.id, b.query.id]))
    expect(out.businessCounts).toMatchObject({ records: 1, versions: 0, observations: 2, unknownObservations: 2, unknownContentObservations: 2, unknownIdentityObservations: 0 })
    expect(out.businessGroups.total).toBe(1)
    expect(out.businessGroups.rows[0]).toMatchObject({ groupState: 'resolved', versions: [], unknownObservations: [{ relation: { id: a.relation.id } }, { relation: { id: b.relation.id } }] })
  })

})
