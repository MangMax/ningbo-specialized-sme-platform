import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { seedPostgresPlatformQuery } from '../../platform/fixtures/postgres-query'
import { readPostgresPlatformQueries } from '../../../layers/sme-roster/lib/platform/postgres-query-read'
import { readPostgresRecordComparison } from '../../../layers/sme-roster/server/utils/record-comparison-postgres'
import { commitPostgresCorrespondences, preflightPostgresCorrespondences } from '../../../layers/sme-roster/server/utils/record-correspondence-write-postgres'
import { groupComparisonBusinessObservations } from '../../../layers/sme-roster/lib/roster/record-comparison'
import * as schema from '../fixtures/postgres-tables'
import { useIsolatedPostgresCases, singlePostgresFixtureRow } from '../../support/isolated-postgres-cases'
import { sourceDocument } from '../../../db/postgresql/official-evidence-tables'

const openDatabase = useIsolatedPostgresCases()

async function fixture() {
  const db = openDatabase()
  const doc = singlePostgresFixtureRow(await db.insert(sourceDocument).values({ source: 'jxj', title: 'Synthetic official', path: 'synthetic.pdf', issueDate: '2024-01-01' }).returning())
  const enterprise = singlePostgresFixtureRow(await db.insert(schema.enterprise).values({ name: 'Synthetic', nameNorm: 'Synthetic', usccNorm: '91330211255994457P' }).returning())
  const record = singlePostgresFixtureRow(await db.insert(schema.record).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', source: 'jxj' }).returning())
  const event = singlePostgresFixtureRow(await db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2024 }).returning())
  await db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: doc.path, page: 1 })
  let n = 0
  const observation = async (raw: Record<string, unknown> | null = { id: 'SQ1', value: 'A' }, options: { interface?: 'business_list' | 'apply_list' | 'recognized_list'; key?: string | null; owner?: number | null; at?: string } = {}) => {
    const result = await seedPostgresPlatformQuery(db, { interface: options.interface ?? 'business_list', queryKey: `synthetic:${++n}`, rdjb: '2', titleCode: 'specialized_sme', status: 'partial', queriedAt: options.at ?? `2026-10-${String(10 + n).padStart(2, '0')}T00:00:00Z`, rawResponse: JSON.stringify(raw), relations: [{ sequenceNo: 1, relationKey: options.key === undefined ? 'SQ1' : options.key, rawFields: raw, enterpriseId: options.owner === undefined ? enterprise.id : options.owner, usccRaw: enterprise.usccNorm, verificationStatus: 'confirmed', matchBasis: 'uscc', year: 2024, declareKind: 'apply', status: '终审通过' }] })
    return { relation: { id: result.relationIds[0]! }, query: { id: result.queryId } }
  }
  const input = (queryIds: number[]) => ({ queryIds, exportBatchIds: [], officialSourceDocumentIds: [doc.id], page: 1, pageSize: 1 })
  const link = async (relationId: number) => {
    const request = { idempotencyKey: `synthetic-link-${relationId}`, sourceIdentity: 'synthetic', actor: { type: 'user' as const, id: 'fixture' }, basis: 'Synthetic exact row checked', ruleId: 'manual', ruleVersion: '1', operations: [{ action: 'create' as const, status: 'confirmed' as const, edge: { type: 'event_process' as const, eventId: event.id, relationId, role: 'supports_award' as const } }] }
    return (await commitPostgresCorrespondences(db, request, (await preflightPostgresCorrespondences(db, request)).planHash)).correspondenceIds[0]!
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

  it('compares only the last capture when a business record returns to its original content', async () => {
    const f = await fixture(), a = await f.observation(), b = await f.observation({ id: 'SQ1', value: 'B' }), again = await f.observation()
    const out = await readPostgresRecordComparison(f.db, f.input([a.query.id, b.query.id, again.query.id]))
    expect(out.businessCounts).toMatchObject({ records: 1, versions: 1, observations: 1, unknownObservations: 0 })
    expect(out.businessGroups.total).toBe(1)
    const group = out.businessGroups.rows[0]!
    expect(group.versions.map(v => v.observations.map(o => o.relation.id))).toEqual([[again.relation.id]])
    expect(out.counts.distinctPlatformRows).toBe(1)
    expect(out.platformWithoutOfficial.rows.map(o => o.relation.id)).toEqual([again.relation.id])
  })
  it('separates interface business identities and preserves missing-key observations', async () => {
    const f = await fixture(), rows = [await f.observation(), await f.observation(undefined, { interface: 'apply_list' }), await f.observation({}, { key: null }), await f.observation({}, { key: null })]
    const out = await readPostgresRecordComparison(f.db, f.input(rows.map(r => r.query.id)))
    expect(out.businessCounts).toMatchObject({ records: 2, versions: 2, observations: 4, unknownObservations: 2, unknownByState: { missing_key: 2 } })
    expect(out.businessGroups.rows.map(g => g.groupState)).toEqual(['resolved', 'resolved', 'missing_key', 'missing_key'])
  })
  it('preserves official facts and never applies a prior correspondence to changed platform content', async () => {
    const f = await fixture(), old = await f.observation(), edge = await f.link(old.relation.id)
    const before = await readPostgresRecordComparison(f.db, f.input([old.query.id]))
    expect(before.businessGroups.rows[0]).toMatchObject({ linkState: 'linked', versions: [{ observations: [{ correspondences: [{ id: edge, relationId: old.relation.id }] }] }] })
    const fresh = await f.observation({ id: 'SQ1', value: 'B' })
    const out = await readPostgresRecordComparison(f.db, f.input([old.query.id, fresh.query.id]))
    expect(out.businessGroups.rows[0]).toMatchObject({ linkState: 'unlinked', versions: [{ observations: [{ relation: { id: fresh.relation.id }, correspondences: [] }] }] })
    const selected = await readPostgresRecordComparison(f.db, f.input([fresh.query.id]))
    expect(selected.businessGroups.rows).toEqual(out.businessGroups.rows)
    const superseded = await readPostgresRecordComparison(f.db, f.input([old.query.id]))
    expect(superseded.counts.distinctPlatformRows).toBe(0)
    for (const comparison of [out, selected, superseded]) {
      expect(comparison.rows).toMatchObject([{ event: { id: f.event.id }, correspondences: [] }])
    }
  })
  it('pages business groups independently without dropping other current observations', async () => {
    const f = await fixture(), a = await f.observation(), b = await f.observation(), c = await f.observation({ id: 'SQ2' }, { key: 'SQ2' })
    const input = f.input([a.query.id, b.query.id, c.query.id])
    const first = await readPostgresRecordComparison(f.db, { ...input, businessPage: 1, businessPageSize: 1 })
    const second = await readPostgresRecordComparison(f.db, { ...input, businessPage: 2, businessPageSize: 1 })
    expect(first.businessGroups.total).toBe(2)
    expect(first.businessCounts).toMatchObject({ records: 2, versions: 2, observations: 2 })
    expect(first.businessCounts).toEqual(second.businessCounts)
    expect(first.platformWithoutOfficial.rows.map(o => o.relation.id)).toEqual([b.relation.id, c.relation.id])
    expect(second.platformWithoutOfficial.rows).toEqual(first.platformWithoutOfficial.rows)
    expect(first.businessGroups.rows[0]!.key).not.toBe(second.businessGroups.rows[0]!.key)
    expect((await readPostgresRecordComparison(f.db, { ...input, enterpriseId: 99999 })).businessCounts.observations).toBe(0)
  })
  it('keeps unknown enterprise identity null while grouping verified canonical records', async () => {
    const f = await fixture(), a = await f.observation(undefined, { owner: null }), b = await f.observation(undefined, { owner: null })
    const out = await readPostgresRecordComparison(f.db, f.input([a.query.id, b.query.id]))
    expect(out.businessCounts.records).toBe(1)
    expect(out.businessGroups.rows[0]!.versions[0]!.observations).toMatchObject([{ relation: { id: b.relation.id, enterpriseId: null } }])
  })
  it('does not leak future observations or revised decisions through business groups at asOf', async () => {
    const f = await fixture(), a = await f.observation(undefined, { at: '2026-10-11T00:00:00Z' }), edge = await f.link(a.relation.id)
    const future = await f.observation({ id: 'SQ2' }, { key: 'SQ2', at: '2026-10-20T00:00:00Z' })
    await f.db.update(schema.recordCorrespondence).set({ createdAt: '2026-10-11T00:01:00Z', decidedAt: '2026-10-19T00:00:00Z' }).where(eq(schema.recordCorrespondence.id, edge))
    const input = { ...f.input([a.query.id]), asOf: '2026-10-18T00:00:00Z' }
    const out = await readPostgresRecordComparison(f.db, input)
    expect(out.businessCounts.observations).toBe(1)
    expect(out.businessGroups.rows[0]).toMatchObject({ linkState: 'unlinked', versions: [{ observations: [{ correspondences: [], historicalDecisionUnavailable: [{ id: edge, relationId: a.relation.id }] }] }] })
    expect(JSON.stringify(out.businessGroups)).not.toContain('2026-10-19')
    await expect(readPostgresRecordComparison(f.db, { ...input, queryIds: [a.query.id, future.query.id] })).rejects.toThrow('source_set_missing_or_out_of_scope')
    const replacement = await f.observation({ id: 'SQ1', value: 'B' }, { at: '2026-10-21T00:00:00Z' })
    expect(await readPostgresRecordComparison(f.db, input)).toMatchObject({ businessGroups: { rows: [] }, rows: [{ event: { id: f.event.id }, correspondences: [] }] })
    await expect(readPostgresRecordComparison(f.db, { ...input, queryIds: [replacement.query.id] })).rejects.toThrow('source_set_missing_or_out_of_scope')
  })
  it('keeps keyed unverifiable input as query metadata without producing current business evidence', async () => {
    const f = await fixture(), a = await f.observation(null), b = await f.observation(null)
    const out = await readPostgresRecordComparison(f.db, f.input([a.query.id, b.query.id]))
    expect(out.businessCounts).toMatchObject({ records: 0, versions: 0, observations: 0, unknownObservations: 0 })
    expect(out.businessGroups.total).toBe(0)
    expect(out.rows).toMatchObject([{ event: { id: f.event.id }, classification: 'unresolved' }])
    expect((await readPostgresPlatformQueries(f.db, { queryId: b.query.id })).rows).toMatchObject([{ query: { id: b.query.id, status: 'partial' } }])
  })

})
