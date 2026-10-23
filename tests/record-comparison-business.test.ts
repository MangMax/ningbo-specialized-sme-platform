import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { useDb, schema } from '../db/client'
import { ensurePlatformObservation } from '../server/utils/platform-business-record'
import { getRecordComparison, queryProofFingerprint } from '../server/utils/record-comparison'
import { commitRecordCorrespondences, preflightRecordCorrespondences } from '../server/utils/record-correspondence'

const cleanups: Array<() => void> = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'comparison-business-'))
  const db = useDb({ dbPath: join(dir, 'roster.db') })
  cleanups.push(() => { db.$client.close(); rmSync(dir, { recursive: true, force: true }) })
  const doc = db.insert(schema.sourceDocument).values({ source: 'jxj', title: 'Synthetic official', path: 'synthetic.pdf', issueDate: '2024-01-01' }).returning().get()
  const enterprise = db.insert(schema.enterprise).values({ name: 'Synthetic', nameNorm: 'Synthetic', usccNorm: '91330211255994457P' }).returning().get()
  const record = db.insert(schema.record).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', source: 'jxj' }).returning().get()
  const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2024 }).returning().get()
  db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: doc.path, page: 1 }).run()
  let n = 0
  const observation = (raw: Record<string, unknown> | null = { id: 'SQ1', value: 'A' }, options: { interface?: 'business_list' | 'apply_list' | 'recognized_list'; key?: string | null; indexed?: boolean; owner?: number | null; at?: string } = {}) => {
    const query = db.insert(schema.platformQuery).values({ interface: options.interface ?? 'business_list', queryKey: `synthetic:${++n}`, rdjb: '2', titleCode: 'specialized_sme', status: 'partial', queriedAt: options.at ?? `2026-10-${String(10 + n).padStart(2, '0')}T00:00:00Z` }).returning().get()
    const relation = db.insert(schema.platformRelation).values({ queryId: query.id, sequenceNo: 1, relationKey: options.key === undefined ? 'SQ1' : options.key, rawFields: raw, enterpriseId: options.owner === undefined ? enterprise.id : options.owner, usccRaw: enterprise.usccNorm, verificationStatus: 'confirmed', matchBasis: 'uscc', year: 2024, declareKind: 'apply', status: '终审通过' }).returning().get()
    if (options.indexed !== false) ensurePlatformObservation(db, relation.id)
    return { relation, query }
  }
  const input = (queryIds: number[]) => ({ queryIds, exportBatchIds: [], officialSourceDocumentIds: [doc.id], page: 1, pageSize: 1 })
  const link = (relationId: number) => {
    const request = { idempotencyKey: `synthetic-link-${relationId}`, sourceIdentity: 'synthetic', actor: { type: 'user' as const, id: 'fixture' }, basis: 'Synthetic exact row checked', ruleId: 'manual', ruleVersion: '1', operations: [{ action: 'create' as const, status: 'confirmed' as const, edge: { type: 'event_process' as const, eventId: event.id, relationId, role: 'supports_award' as const } }] }
    return commitRecordCorrespondences(db, request, preflightRecordCorrespondences(db, request).planHash).correspondenceIds[0]!
  }
  return { db, enterprise, event, observation, input, link }
}
const oldFields = (result: ReturnType<typeof getRecordComparison>) => {
  const { businessGroups, businessCounts, ...old } = result
  return old
}

describe('comparison scoped canonical business groups', () => {
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
  it('separates interfaces and isolates each not-indexed missing-key conflict and unverifiable observation', () => {
    const f = fixture(), rows = [f.observation(), f.observation(undefined, { interface: 'apply_list' }), f.observation(undefined, { indexed: false }), f.observation({}, { key: null }), f.observation({}, { key: null }), f.observation({ id: 'DIFFERENT' }), f.observation(null), f.observation(null)]
    const out = getRecordComparison(f.db, f.input(rows.map(r => r.query.id)))
    expect(out.businessCounts).toMatchObject({ records: 2, versions: 2, observations: 8, unknownObservations: 6, unknownByState: { not_indexed: 1, missing_key: 2, conflict: 1, unverifiable: 2 } })
    expect(out.businessGroups.rows.map(g => g.groupState)).toEqual(['verified', 'verified', 'not_indexed', 'missing_key', 'missing_key', 'conflict', 'unverifiable', 'unverifiable'])
    expect(out.businessGroups.rows.slice(2).map(g => g.versions[0]!.observations.length)).toEqual([1, 1, 1, 1, 1, 1])
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
  it('retains all original comparison fields across projection and independent business pagination', () => {
    const f = fixture(), a = f.observation(undefined, { indexed: false }), b = f.observation(undefined, { indexed: false }), c = f.observation({ id: 'SQ2' }, { key: 'SQ2', indexed: false })
    f.link(a.relation.id)
    const input = f.input([a.query.id, b.query.id, c.query.id])
    const before = getRecordComparison(f.db, input)
    for (const row of [a, b, c]) ensurePlatformObservation(f.db, row.relation.id)
    const first = getRecordComparison(f.db, { ...input, businessPage: 1, businessPageSize: 1 })
    const second = getRecordComparison(f.db, { ...input, businessPage: 2, businessPageSize: 1 })
    expect(oldFields(first)).toEqual(oldFields(before))
    expect(oldFields(second)).toEqual(oldFields(before))
    expect(first.businessGroups.total).toBe(2)
    expect(first.businessCounts).toEqual(second.businessCounts)
    expect(first.businessGroups.rows[0]!.key).not.toBe(second.businessGroups.rows[0]!.key)
    expect(first.businessGroups.scope).toMatchObject({ queryIds: input.queryIds, enterpriseId: null, titleCode: null, classificationApplied: false, countsBeforePagination: true })
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
  it('preserves each observation qualification and proof pointer without qualifying its duplicate', () => {
    const f = fixture(), a = f.observation(undefined, { interface: 'recognized_list' }), b = f.observation(undefined, { interface: 'recognized_list' })
    const collectionEvidence = { completeness: 'complete', fullRange: true, effectiveConditions: { combination: 'and' }, titleScope: { rdjb: ['2'] }, pages: [{ rdjb: '2', page: 1, maxPage: 1, status: 'success', fetchedCount: 1 }], unfinished: [] } as never
    f.db.update(schema.platformQuery).set({ status: 'success', collectionEvidence }).run()
    const query = f.db.select().from(schema.platformQuery).where(eq(schema.platformQuery.id, a.query.id)).get()!
    const batch = f.db.insert(schema.platformExportBatch).values({ titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-13', originalFilename: 'synthetic.xlsx', sha256: 'a'.repeat(64), importStatus: 'imported' }).returning().get()
    const exported = f.db.insert(schema.platformExportRow).values({ batchId: batch.id, sourceRowNo: 1, usccRaw: f.enterprise.usccNorm }).returning().get()
    const input = { ...f.input([a.query.id, b.query.id]), exportBatchIds: [batch.id] }
    const proof = { officialScopes: [], currentScopes: [{ proofId: 'synthetic-proof-only-first-query', queryId: a.query.id, exportBatchId: batch.id, titleCode: 'specialized_sme', querySourceFingerprint: queryProofFingerprint(query), exportSha256: batch.sha256, scopeEquivalent: true as const, versionEquivalent: true as const, verifiedAt: '2026-10-13T01:00:00Z' }] }
    // Projection is independent of the older proof domain; remove only the new
    // fixture mappings to capture the exact pre-projection comparison result.
    f.db.delete(schema.platformBusinessObservation).run()
    const before = getRecordComparison(f.db, input, proof)
    for (const row of [a, b]) ensurePlatformObservation(f.db, row.relation.id)
    const out = getRecordComparison(f.db, input, proof)
    expect(oldFields(out)).toEqual(oldFields(before))
    expect(out.businessGroups.rows[0]).toMatchObject({ resultState: 'mixed', versions: [{ observations: [
      { currentSource: { qualification: 'matched', proofId: 'synthetic-proof-only-first-query', exportRows: [{ id: exported.id }] } },
      { currentSource: { qualification: 'not_comparable', proofId: null } },
    ] }] })
  })

})
