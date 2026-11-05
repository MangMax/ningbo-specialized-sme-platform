import { initializeDb } from '../db/client'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { schema, useDb } from '../db'
import { ensurePlatformObservation } from '../server/utils/platform-business-record'
import { generateCandidates } from '../server/utils/record-correspondence-candidates'
import { readPlatformBusinessGroups, readPlatformBusinessMetadata } from '../server/utils/platform-business-record-read'
import type { ScopedPlatformObservation } from '../lib/platform/business-record'

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'business-candidates246-'))
  const db = initializeDb({ create: true, dbPath: join(dir, 'roster.db') })
  cleanup.push(() => { db.$client.close(); rmSync(dir, { recursive: true, force: true }) })
  const enterprise = db.insert(schema.enterprise).values({ name: '合成候选企业', nameNorm: '合成候选企业', usccNorm: '91330211255994457P' }).returning().get()
  const record = db.insert(schema.record).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', source: 'jxj', usccRaw: enterprise.usccNorm }).returning().get()
  const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2025, batchSeq: 1 }).returning().get()
  let counter = 0
  const queries: number[] = []
  function row(options: { source?: 'business_list' | 'apply_list' | 'recognized_list'; key?: string | null; raw?: Record<string, unknown> | null; indexed?: boolean; stored?: Partial<typeof schema.platformRelation.$inferInsert>; query?: Partial<typeof schema.platformQuery.$inferInsert> } = {}) {
    const source = options.source ?? 'business_list', key = options.key === undefined ? 'SQ246' : options.key
    const rawFields = options.raw === undefined ? { id: key, year: '2025', sblx: '申请', whpc: '2025-1', tyshxydm: enterprise.usccNorm } : options.raw
    const query = db.insert(schema.platformQuery).values({ interface: source, queryKey: enterprise.usccNorm!, rdjb: '2', titleCode: 'specialized_sme', queriedAt: `2026-10-${String(++counter).padStart(2, '0')}T00:00:00Z`, status: 'success', ...options.query }).returning().get()
    queries.push(query.id)
    const relation = db.insert(schema.platformRelation).values({ queryId: query.id, sequenceNo: 1, relationKey: key, enterpriseId: enterprise.id, usccRaw: enterprise.usccNorm, nameRaw: enterprise.name, verificationStatus: 'confirmed', matchBasis: 'uscc', rawFields, ...options.stored }).returning().get()
    const projection = options.indexed === false ? null : ensurePlatformObservation(db, relation.id)
    return { query, relation, projection }
  }
  function prior(relationId: number, status: 'confirmed' | 'rejected' | 'candidate' | 'unlinked', overrides: Partial<typeof schema.recordCorrespondence.$inferInsert> = {}) {
    return db.insert(schema.recordCorrespondence).values({ edgeKey: `synthetic-${relationId}-${status}-${counter++}`, type: 'event_process', role: 'context_only', eventId: event.id, relationId, enterpriseId: enterprise.id, titleCode: 'specialized_sme', status, revision: status === 'candidate' ? 1 : 2, targetIdentity: {}, provenance: {}, sourceFingerprint: 'unchanged-source', ruleId: 'manual', ruleVersion: 'old-rule', createdAt: '2026-10-01', ...overrides }).returning().get()
  }
  function candidates(overrides: Record<string, unknown> = {}) {
    return generateCandidates(db, { eventId: event.id, queryIds: queries, exportBatchIds: [], ruleVersion: '246', page: 1, pageSize: 200, ...overrides }) as any
  }
  return { db, enterprise, event, record, queries, row, prior, candidates }
}

describe('scoped business version candidates', () => {
  it('collapses repeated raw observations and retains every source without false ambiguity', () => {
    const f = fixture(), a = f.row(), b = f.row({ stored: { year: 2025, declareKind: 'apply', batch: '2025-1' } })
    expect(a.projection!.versionId).toBe(b.projection!.versionId)
    const result = f.candidates()
    expect(result.total).toBe(1)
    expect(result.rows[0]).toMatchObject({ edge: { relationId: a.relation.id }, businessRecord: { recordId: a.projection!.recordId, versionId: a.projection!.versionId, groupState: 'verified' }, observationRefs: [{ relationId: a.relation.id, queryId: a.query.id, queriedAt: a.query.queriedAt }, { relationId: b.relation.id, queryId: b.query.id, queriedAt: b.query.queriedAt }], existingCorrespondenceIds: [], conflicts: [] })
    expect(result.rows[0].observationRefs.map((r: any) => r.evidence.temporal.relationYear)).toEqual([2025, 2025])
  })

  it('keeps two content versions for A B A and pages business groups', () => {
    const f = fixture(), a = f.row(), b = f.row({ raw: { id: 'SQ246', year: '2025', sblx: '申请', whpc: '2025-1', statusDetail: 'changed' } }), again = f.row()
    const result = f.candidates({ pageSize: 1 })
    expect(result).toMatchObject({ total: 2, page: 1, pageSize: 1 })
    expect(result.rows[0].observationRefs.map((r: any) => r.relationId)).toEqual([a.relation.id, again.relation.id])
    expect(result.rows[0].conflicts).toContain('multiple_candidate_rows')
    expect(f.candidates({ page: 2, pageSize: 1 }).rows[0]).toMatchObject({ edge: { relationId: b.relation.id }, businessRecord: { versionId: b.projection!.versionId } })
    expect(f.candidates({ page: 3, pageSize: 1 })).toMatchObject({ total: 2, rows: [] })
  })

  it('keeps interfaces independent including recognized UUID observations', () => {
    const f = fixture()
    for (const source of ['business_list', 'apply_list', 'recognized_list'] as const) for (let i = 0; i < 2; i++) f.row({ source, key: '550e8400-e29b-41d4-a716-446655440000' })
    const result = f.candidates()
    expect(result.total).toBe(3)
    expect(result.rows.map((r: any) => [r.businessRecord.interface, r.observationRefs.length, r.edge.type])).toEqual([['business_list', 2, 'event_process'], ['apply_list', 2, 'event_process'], ['recognized_list', 2, 'event_recognized']])
    expect(new Set(result.rows.map((r: any) => r.businessRecord.recordId)).size).toBe(3)
  })

  it.each([
    { name: 'not_indexed', options: { indexed: false } },
    { name: 'missing_key', options: { key: null, raw: { year: '2025', sblx: '申请' } } },
    { name: 'conflict', options: { key: 'SQ246', raw: { id: 'another', year: '2025', sblx: '申请' } } },
    { name: 'unverifiable', options: { raw: null } },
  ])('isolates each relation for $name instead of merging null identities', ({ name, options }) => {
    const f = fixture(), a = f.row(options), b = f.row(options)
    const result = f.candidates()
    expect(result.total).toBe(2)
    expect(result.rows.map((r: any) => [r.edge.relationId, r.businessRecord.groupState, r.observationRefs.length])).toEqual([[a.relation.id, name, 1], [b.relation.id, name, 1]])
    expect(result.rows.every((r: any) => r.conflicts.includes('multiple_candidate_rows'))).toBe(true)
  })

  it('derives target roles from the typed declareKind', () => {
    const f = fixture(), raw = { id: 'SQ246', year: '2025' }
    f.row({ raw: { ...raw, sblx: '申请' } }); f.row({ raw: { ...raw, sblx: '复核' } })
    const result = f.candidates({ eventId: undefined, enterpriseId: f.enterprise.id, titleCode: 'specialized_sme' })
    expect(result.total).toBe(2)
    expect(result.rows.map((r: any) => [r.edge.role, r.observationRefs.length])).toEqual([['followup_apply', 1], ['followup_review', 1]])
  })

  it('ignores legacy stored process columns when a typed projection exists', () => {
    const f = fixture(), raw = { id: 'SQ246', year: '2025', sblx: '申请' }
    f.row({ raw, stored: { declareKind: 'apply' } }); f.row({ raw, stored: { declareKind: 'review' } })
    const result = f.candidates({ eventId: undefined, enterpriseId: f.enterprise.id, titleCode: 'specialized_sme' })
    expect(result.total).toBe(1)
    expect(result.rows[0]).toMatchObject({ edge: { role: 'followup_apply' }, observationRefs: [{ evidence: { process: { declareKind: 'apply' } } }, { evidence: { process: { declareKind: 'apply' } } }] })
  })

  it('keeps distinct business identities even when complete raw content matches', () => {
    const f = fixture(), raw = { year: '2025', whpc: '2025-1', sblx: '申请' }
    const a = f.row({ key: 'SQ-A', raw }), b = f.row({ key: 'SQ-B', raw })
    const result = f.candidates()
    expect(result.total).toBe(2)
    expect(result.rows.map((r: any) => [r.businessRecord.recordId, r.businessRecord.platformKey, r.observationRefs[0].relationId])).toEqual([[a.projection!.recordId, 'SQ-A', a.relation.id], [b.projection!.recordId, 'SQ-B', b.relation.id]])
    expect(result.rows[0].businessRecord.contentHash).toBe(result.rows[1].businessRecord.contentHash)
  })

  it('retains opposite decisions and selects an existing endpoint without preferring confirmed', () => {
    const f = fixture(), unlinked = f.row(), rejected = f.row(), confirmed = f.row()
    const no = f.prior(rejected.relation.id, 'rejected'), yes = f.prior(confirmed.relation.id, 'confirmed')
    const result = f.candidates()
    expect(result.total).toBe(1)
    expect(result.rows[0]).toMatchObject({ edge: { relationId: rejected.relation.id }, status: 'candidate', existingCorrespondenceId: no.id, revision: 2, existingCorrespondenceIds: [no.id, yes.id] })
    expect(result.rows[0].existingCorrespondences.map((r: any) => [r.id, r.status, r.revision, r.ruleVersion])).toEqual([[no.id, 'rejected', 2, 'old-rule'], [yes.id, 'confirmed', 2, 'old-rule']])
    expect(result.rows[0].conflicts).toEqual(['correspondence_decision_conflict'])
    expect(result.rows[0].observationRefs.map((r: any) => [r.relationId, r.existingCorrespondenceIds])).toEqual([[unlinked.relation.id, []], [rejected.relation.id, [no.id]], [confirmed.relation.id, [yes.id]]])
  })

  it('retains different target decisions and all correspondence roles', () => {
    const f = fixture(), a = f.row(), b = f.row()
    const otherEvent = f.db.insert(schema.recordEvent).values({ recordId: f.record.id, eventType: 'review', year: 2025 }).returning().get()
    const one = f.prior(a.relation.id, 'confirmed'), two = f.prior(b.relation.id, 'confirmed', { eventId: otherEvent.id }), support = f.prior(b.relation.id, 'candidate', { role: 'supports_award' })
    const result = f.candidates().rows[0]
    expect(result.existingCorrespondenceIds).toEqual([one.id, two.id, support.id])
    expect(result.conflicts).toContain('correspondence_decision_conflict')
    expect(result.existingCorrespondences.map((r: any) => r.eventId)).toEqual([f.event.id, otherEvent.id, f.event.id])
  })

  it('does not borrow decisions or observations from unselected queries', () => {
    const f = fixture(), old = f.row(), fresh = f.row(), prior = f.prior(old.relation.id, 'confirmed')
    const selected = f.candidates({ queryIds: [fresh.query.id, fresh.query.id] })
    expect(selected).toMatchObject({ total: 1, rows: [{ edge: { relationId: fresh.relation.id }, existingCorrespondenceId: null, revision: null, existingCorrespondenceIds: [], observationRefs: [{ relationId: fresh.relation.id }] }] })
    expect(selected.rows[0].observationRefs).toHaveLength(1)
    expect(f.candidates().rows[0].existingCorrespondenceIds).toEqual([prior.id])
    expect(f.candidates().rows[0].edge.relationId).toBe(old.relation.id)
  })

  it('keeps stored-vs-raw conflicts visible while typed fields still win', () => {
    const f = fixture(), clean = f.row(), conflict = f.row({ stored: { year: 2024, status: '终审通过' } })
    const result = f.candidates()
    expect(result.total).toBe(1)
    expect(result.rows[0].businessRecord.versionId).toBe(clean.projection!.versionId)
    expect(result.rows[0].observationRefs[1]).toMatchObject({ relationId: conflict.relation.id, conflicts: ['platform_field_conflict'], evidence: { process: { status: null, normalizationConflicts: [{ field: 'year', storedValue: 2024, rawValue: 2025 }] }, temporal: { relationYear: 2025 } } })
    expect(result.rows[0].conflicts).toEqual(['platform_field_conflict'])
  })

  it('retains typed identity and recognized row-title conflicts across observations of one version', () => {
    const f = fixture(), raw = { id: 'SQ246', year: '2025', sblx: '申请', whpc: '2025-1', tyshxydm: '91330211000000001A', rdjb: '1' }
    const a = f.row({ source: 'recognized_list', raw }), b = f.row({ source: 'recognized_list', raw })
    const result = f.candidates()
    expect(result.total).toBe(1)
    expect(result.rows[0].conflicts).toEqual(expect.arrayContaining(['identity_conflict', 'title_conflict']))
    expect(result.rows[0].observationRefs.map((o: any) => [o.relationId, o.conflicts, o.evidence.identity.rawUscc, o.evidence.title.rawRdjb])).toEqual([
      [a.relation.id, expect.arrayContaining(['identity_conflict', 'title_conflict']), raw.tyshxydm, '1'],
      [b.relation.id, expect.arrayContaining(['identity_conflict', 'title_conflict']), raw.tyshxydm, '1'],
    ])
  })

  it('filters owner title status and recognized target before canonical reads', () => {
    const f = fixture(), a = f.row(), other = f.db.insert(schema.enterprise).values({ name: '其他', nameNorm: '其他' }).returning().get()
    const wrongOwner = f.row({ stored: { enterpriseId: other.id } }), wrongTitle = f.row({ query: { titleCode: 'innovative_sme', rdjb: '1' } }), failed = f.row({ query: { status: 'failed' } }), recognized = f.row({ source: 'recognized_list' })
    const meter = observeReads(f.db)
    const result = f.candidates({ eventId: undefined, enterpriseId: f.enterprise.id, titleCode: 'specialized_sme' })
    expect(result.total).toBe(1)
    expect(result.rows[0].observationRefs.map((r: any) => r.relationId)).toEqual([a.relation.id])
    const metadataReads = meter.calls.filter(c => c.sql.includes('left join "platform_business_observation"'))
    expect(metadataReads.flatMap(c => c.params)).toEqual([a.relation.id])
    expect([wrongOwner, wrongTitle, failed, recognized].every(r => !metadataReads.some(c => c.params.includes(r.relation.id)))).toBe(true)
    expect(f.candidates({ eventId: 999999 })).toBeNull()
    expect(f.candidates({ queryIds: [999999] })).toBeNull()
  })

  it('chooses the minimum original ID without priors despite reversed query order', () => {
    const f = fixture(), first = f.row(), second = f.row()
    // Move only the observation order; canonical identity/source inputs are kept intact.
    const observations = f.candidates().rows[0].observationRefs as ScopedPlatformObservation[]
    const result = readPlatformBusinessGroups(f.db, [...observations].reverse())
    expect(result[0]!.representativeRelationId).toBe(first.relation.id)
    expect(result[0]!.observationRefs.map(r => r.relationId)).toEqual([second.relation.id, first.relation.id])
  })

  it('shared grouping preserves scoped identity title conflicts and different targets', () => {
    const f = fixture(); f.row(); f.row()
    const observations = f.candidates().rows[0].observationRefs as ScopedPlatformObservation[]
    const changed = { ...observations[1]!, enterpriseId: 999, usccRaw: '91330211000000001A', titleCode: 'innovative_sme', conflicts: ['original_conflict'] }
    const grouped = readPlatformBusinessGroups(f.db, [observations[0]!, changed])
    expect(grouped).toHaveLength(1)
    expect(grouped[0]!.conflicts).toEqual(['original_conflict', 'identity_conflict', 'title_conflict'])
    const targets = readPlatformBusinessGroups(f.db, [observations[0]!, { ...observations[1]!, target: { ...observations[1]!.target, eventId: 999 } }, { ...observations[1]!, target: { ...observations[1]!.target, enterpriseId: 999 } }])
    expect(targets).toHaveLength(3)
    expect(targets.map(g => g.observationRefs.length)).toEqual([1, 1, 1])
  })

  it('handles malformed raw and empty selection without reading unrelated archives', () => {
    const f = fixture(), a = f.row({ indexed: false }), b = f.row({ indexed: false })
    f.db.$client.prepare('update platform_relation set raw_fields=? where id=?').run('{invalid', a.relation.id)
    f.db.$client.prepare('update platform_relation set raw_fields=? where id=?').run('[]', b.relation.id)
    ensurePlatformObservation(f.db, a.relation.id); ensurePlatformObservation(f.db, b.relation.id)
    expect(f.candidates().rows.map((r: any) => [r.businessRecord.groupState, r.observationRefs.length])).toEqual([['unverifiable', 1], ['unverifiable', 1]])
    const meter = observeReads(f.db)
    expect(readPlatformBusinessGroups(f.db, [])).toEqual([])
    expect([...readPlatformBusinessMetadata(f.db, [])]).toEqual([])
    expect(meter.calls).toEqual([])
  })

  it.each([399, 400, 401])('chunks selected metadata and decisions at the parameter boundary %i', count => {
    const f = fixture()
    f.db.transaction(() => { for (let i = 0; i < count; i++) f.row() })
    const meter = observeReads(f.db), result = f.candidates()
    expect(result.total).toBe(1)
    expect(result.rows[0].observationRefs).toHaveLength(count)
    const metadataReads = meter.calls.filter(c => c.sql.includes('left join "platform_business_observation"'))
    expect(metadataReads.map(c => c.params.length)).toEqual(count <= 400 ? [count] : [400, 1])
    const decisionReads = meter.calls.filter(c => c.sql.includes('from "record_correspondence"'))
    expect(decisionReads.map(c => c.params.length)).toEqual(count <= 400 ? [count] : [400, 1])
    expect(meter.calls.every(c => c.params.length <= 400)).toBe(true)
    expect(result.rows[0].observationRefs.map((r: any) => r.relationId)).toEqual(Array.from({ length: count }, (_, i) => i + 1))
  })

  it('reads lightweight canonical metadata without materializing large archived bodies', () => {
    const f = fixture(), original = 'LARGE-ARCHIVE-246'.repeat(65536)
    const raw = { id: 'SQ246', year: '2025', sblx: '申请', whpc: '2025-1', original }
    const a = f.row({ raw }), b = f.row({ raw })
    f.db.$client.prepare('update platform_query set raw_response=?').run(original)
    const meter = observeReads(f.db), result = f.candidates()
    expect(result.total).toBe(1)
    expect(result.rows[0].observationRefs.map((r: any) => r.relationId)).toEqual([a.relation.id, b.relation.id])
    expect(meter.bytes).toBeLessThan(32 * 1024)
    expect(meter.calls.some(c => c.sql.includes('canonical_raw_json'))).toBe(false)
    expect(meter.calls.some(c => /select\s+\*/i.test(c.sql))).toBe(false)
    expect(JSON.stringify(result)).not.toContain('LARGE-ARCHIVE-246')
    const metadata = readPlatformBusinessMetadata(f.db, [b.relation.id])
    expect([...metadata.keys()]).toEqual([b.relation.id])
    expect(metadata.get(b.relation.id)).toMatchObject({ recordId: a.projection!.recordId, versionId: a.projection!.versionId, hashAlgorithm: 'platform-row-json-v1' })
    expect(meter.bytes).toBeLessThan(32 * 1024)
  })
})

function observeReads(db: ReturnType<typeof useDb>) {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  let bytes = 0
  const prepare = db.$client.prepare.bind(db.$client)
  db.$client.prepare = ((query: string) => {
    const statement = prepare(query)
    for (const method of ['all', 'get'] as const) {
      const run = statement[method].bind(statement)
      Object.assign(statement, { [method]: (...params: unknown[]) => {
        const result = run(...params)
        calls.push({ sql: query, params })
        bytes += Buffer.byteLength(JSON.stringify(result) ?? '')
        return result
      } })
    }
    return statement
  }) as typeof prepare
  return { calls, get bytes() { return bytes } }
}
