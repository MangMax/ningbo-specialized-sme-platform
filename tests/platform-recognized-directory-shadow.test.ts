import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { useDb, schema } from '../db'
import { ensurePlatformObservation } from '../server/utils/platform-business-record'
import { readPlatformBusinessDetails } from '../server/utils/platform-business-detail-read'
import { getPlatformRecognizedRecord, listPlatformRecognizedDirectory } from '../server/utils/platform-recognized-directory'
import { hasKnownPlatformBusiness } from '../lib/roster/platform-business-detail'

const dir = mkdtempSync(join(tmpdir(), 'recognized-directory-shadow-'))
const db = useDb({ dbPath: join(dir, 'shadow.sqlite') })
afterAll(() => { db.$client.close(); rmSync(dir, { recursive: true, force: true }) })

function recognizedEvidence(rdjb: string, queriedAt: string, rows: Record<string, unknown>[], scope: string[] = [rdjb]) {
  return {
    source: 'queryBusList' as const, status: 'success' as const,
    effectiveConditions: { combination: 'and' as const },
    titleScope: { mode: 'selected' as const, rdjb: scope },
    queriedAt, completedAt: queriedAt, rows,
    pages: [{ source: 'queryBusList' as const, rdjb, page: 1, status: 'success' as const, fetchedCount: rows.length, declaredTotal: rows.length, maxPage: 1, error: null }],
    fetchedCount: rows.length, declaredTotal: rows.length, completeness: 'complete' as const, fullRange: true, unfinished: [], error: null,
    limits: { maxRequests: 1, maxRows: 50, maxDurationMs: 1000, pageSize: 50 },
  }
}

function seed(queryKey: string, rdjb: string, at: string, raw: Record<string, unknown>, relationKey: string | null | undefined = typeof raw.id === 'string' ? raw.id : null) {
  const query = db.insert(schema.platformQuery).values({ interface: 'recognized_list', queryKey, rdjb, queriedAt: at, status: 'success', collectionEvidence: recognizedEvidence(rdjb, at, [raw]) as never }).returning().get()
  const relation = db.insert(schema.platformRelation).values({
    queryId: query.id, sequenceNo: 1, relationKey,
    nameRaw: typeof raw.qymc === 'string' ? raw.qymc : null, usccRaw: typeof raw.tyshxydm === 'string' ? raw.tyshxydm : null,
    rawFields: raw,
  }).returning().get()
  return { query, relation }
}

it('shadow-compares the old enterprise platform history reader with the new typed directory reader on the same observations', () => {
  const enterprise = db.insert(schema.enterprise).values({ name: '目录影子企业', nameNorm: '目录影子企业', usccNorm: '91330211EEEEEEEE5X' }).returning().get()
  const uscc = enterprise.usccNorm!
  const rawK1 = { id: 'DIR-SHADOW-1', qymc: '目录影子企业', tyshxydm: uscc, rdjb: '2', rddqrq: '2027-12-31', whpcyear: '2024', whpc: '2024-2', szq: '33020000', rdxx: '原认定说明', secretRaw: 'UNEXPOSED_RECOGNIZED_RAW' }
  const rawK2 = { id: 'DIR-SHADOW-2', qymc: '目录影子企业', tyshxydm: uscc, rdjb: '1' }
  const rawK3 = { id: 'DIR-SHADOW-3', qymc: '目录影子企业', tyshxydm: uscc, rdjb: '3', rddqrq: '2028', whpcyear: '不是年份' }
  const one = seed(uscc, '2', '2026-10-01T00:00:00Z', rawK1)
  const replay = seed(uscc, '2', '2026-10-02T00:00:00Z', rawK1)
  const two = seed(uscc, '1', '2026-10-03T00:00:00Z', rawK2)
  const three = seed(uscc, '2', '2026-10-04T00:00:00Z', rawK3)
  const missing = seed('name:目录影子无编号', '2', '2026-10-05T00:00:00Z', { qymc: '目录影子无编号', rddqrq: '2029-01-01' }, null)
  const conflict = seed('name:目录影子冲突', '1', '2026-10-06T00:00:00Z', { id: 'RAW-CONFLICT', qymc: '目录影子冲突' }, 'REL-CONFLICT')
  for (const relation of [one, replay, two, three, missing, conflict]) {
    db.update(schema.platformRelation).set({ enterpriseId: enterprise.id }).where(eq(schema.platformRelation.id, relation.relation.id)).run()
    ensurePlatformObservation(db, relation.relation.id)
  }
  const decision = db.insert(schema.recordCorrespondence).values({
    edgeKey: 'directory-shadow-decision', type: 'event_recognized', role: 'recognized_corrob', relationId: one.relation.id, enterpriseId: enterprise.id,
    titleCode: 'specialized_sme', status: 'confirmed', revision: 2, targetIdentity: {}, provenance: {},
    sourceFingerprint: 'synthetic', ruleId: 'manual', ruleVersion: '1', createdAt: '2026-10-02T00:00:00Z', decidedAt: '2026-10-02T00:00:00Z',
  }).returning().get()
  // Same directory business id under another interface must never merge into this reader.
  const businessQuery = db.insert(schema.platformQuery).values({ interface: 'business_list', queryKey: uscc, rdjb: '2', queriedAt: '2026-10-07T00:00:00Z', status: 'success' }).returning().get()
  const businessRelation = db.insert(schema.platformRelation).values({
    queryId: businessQuery.id, sequenceNo: 1, relationKey: 'DIR-SHADOW-1', enterpriseId: enterprise.id, usccRaw: uscc, nameRaw: enterprise.name,
    rawFields: { id: 'DIR-SHADOW-1', qymc: enterprise.name, tyshxydm: uscc, sblx: '复核', year: 2023, cszt: '终审通过', whpc: '2023-2' },
  }).returning().get()
  const businessProjection = ensurePlatformObservation(db, businessRelation.id)

  const queries = db.select().from(schema.platformQuery).all().map(query => ({ ...query, relationCount: 0 }))
  const relations = db.select().from(schema.platformRelation).all()
  const old = readPlatformBusinessDetails(db, enterprise.id, queries, relations).filter(detail => detail.businessRecord.interface === 'recognized_list')
  const oldResolved = old.filter(detail => hasKnownPlatformBusiness(detail.businessRecord))
  const oldIsolated = old.filter(detail => !hasKnownPlatformBusiness(detail.businessRecord))
  const fresh = listPlatformRecognizedDirectory({ enterpriseId: enterprise.id }, db)
  const isolated = listPlatformRecognizedDirectory({ enterpriseId: enterprise.id, view: 'isolated' }, db)

  // Record identity, version/observation counts and old ID locations agree, not merely "a diff was not pushed".
  expect(fresh.rows.map(row => row.kind === 'record' ? row.record.platformKey : '').sort()).toEqual(oldResolved.map(detail => detail.businessRecord.platformKey).sort())
  expect(fresh.total).toBe(oldResolved.length)
  for (const detail of oldResolved) {
    const row = fresh.rows.find(candidate => candidate.kind === 'record' && candidate.record.platformKey === detail.businessRecord.platformKey)
    expect(row?.kind, detail.businessRecord.platformKey ?? '').toBe('record')
    if (row?.kind !== 'record') continue
    expect(row.versionCount, detail.businessRecord.platformKey ?? '').toBe(detail.versionCount)
    expect(row.observationCount, detail.businessRecord.platformKey ?? '').toBe(detail.observationCount)
    const freshDetail = getPlatformRecognizedRecord(db, row.record.id)
    expect(freshDetail.observations.map(observation => observation.relationId).sort((a, b) => a - b)).toEqual(detail.observationRefs.map(observation => observation.relationId).sort((a, b) => a - b))
    expect(freshDetail.versions.map(version => version.versionId).sort((a, b) => a - b)).toEqual(detail.versions.map(version => version.businessRecord.versionId!).sort((a, b) => a! - b!))
  }
  expect(fresh.rows.filter(row => row.kind === 'record' && row.record.platformKey === 'DIR-SHADOW-1')).toHaveLength(1)
  expect(businessProjection.recordId).not.toBeNull()

  // Pagination and filters agree with the old reader's membership.
  const firstPage = listPlatformRecognizedDirectory({ enterpriseId: enterprise.id, page: 1, pageSize: 1 }, db)
  const secondPage = listPlatformRecognizedDirectory({ enterpriseId: enterprise.id, page: 2, pageSize: 1 }, db)
  expect(firstPage.total).toBe(oldResolved.length)
  expect(firstPage.rows).toHaveLength(1)
  expect(secondPage.rows).toHaveLength(1)
  // The two pages are the two most recently observed records, computed from the old reader's own observation times.
  const latest = (detail: (typeof oldResolved)[number]) => Math.max(...detail.observationRefs.map(observation => Date.parse(observation.queriedAt) || 0))
  const newestTwo = [...oldResolved].sort((a, b) => latest(b) - latest(a) || b.businessRecord.recordId! - a.businessRecord.recordId!).slice(0, 2).map(detail => detail.businessRecord.platformKey).sort()
  expect([...firstPage.rows, ...secondPage.rows].map(row => row.kind === 'record' ? row.record.platformKey : '').sort()).toEqual(newestTwo)
  expect(listPlatformRecognizedDirectory({ enterpriseId: enterprise.id, platformKey: 'DIR-SHADOW-1' }, db).rows).toHaveLength(1)
  expect(listPlatformRecognizedDirectory({ enterpriseId: enterprise.id, rdjb: '1' }, db).rows.map(row => row.kind === 'record' ? row.record.platformKey : '')).toEqual(['DIR-SHADOW-2'])
  expect(oldResolved.filter(detail => detail.observationRefs.some(observation => observation.titleCode === 'innovative_sme')).map(detail => detail.businessRecord.platformKey)).toEqual(['DIR-SHADOW-2'])

  // Raw validity/year/batch/district filters are new typed capabilities, matched exactly as stored.
  expect(listPlatformRecognizedDirectory({ enterpriseId: enterprise.id, rddqrq: '2027-12-31' }, db).rows.map(row => row.kind === 'record' ? row.record.platformKey : '')).toEqual(['DIR-SHADOW-1'])
  expect(listPlatformRecognizedDirectory({ enterpriseId: enterprise.id, rddqrq: '2027' }, db).rows).toEqual([])
  expect(listPlatformRecognizedDirectory({ enterpriseId: enterprise.id, whpcyear: 2024 }, db).rows.map(row => row.kind === 'record' ? row.record.platformKey : '')).toEqual(['DIR-SHADOW-1'])
  expect(listPlatformRecognizedDirectory({ enterpriseId: enterprise.id, whpc: '2024-2' }, db).rows.map(row => row.kind === 'record' ? row.record.platformKey : '')).toEqual(['DIR-SHADOW-1'])
  expect(listPlatformRecognizedDirectory({ enterpriseId: enterprise.id, szq: '33020000' }, db).rows.map(row => row.kind === 'record' ? row.record.platformKey : '')).toEqual(['DIR-SHADOW-1'])
  const unknown = listPlatformRecognizedDirectory({ enterpriseId: enterprise.id, platformKey: 'DIR-SHADOW-2' }, db).rows[0]
  expect(unknown).toMatchObject({ matchedVersion: { validityDateRaw: null, maintenanceYear: null, maintenanceBatch: null, district: null, awardNote: null, titleRaw: '1' } })

  // Observation-scoped decisions survive on both sides without propagating to other observations.
  expect(oldResolved.find(detail => detail.businessRecord.platformKey === 'DIR-SHADOW-1')!.observationRefs.some(observation => observation.existingCorrespondenceIds.includes(decision.id))).toBe(true)
  const freshK1 = getPlatformRecognizedRecord(db, (fresh.rows.find(row => row.kind === 'record' && row.record.platformKey === 'DIR-SHADOW-1') as Extract<typeof fresh.rows[number], { kind: 'record' }>).record.id)
  expect(freshK1.observations.find(observation => observation.relationId === one.relation.id)?.correspondenceRefs).toEqual([{ id: decision.id, status: 'confirmed', revision: 2 }])
  expect(freshK1.observations.filter(observation => observation.relationId !== one.relation.id).every(observation => observation.correspondenceRefs.length === 0)).toBe(true)

  // A raw title contradicting the explicit query scope is a structured conflict on both readers.
  const oldThree = oldResolved.find(detail => detail.businessRecord.platformKey === 'DIR-SHADOW-3')!
  expect(oldThree.observationRefs.some(observation => observation.conflicts.includes('title_conflict'))).toBe(true)
  const freshThree = fresh.rows.find(row => row.kind === 'record' && row.record.platformKey === 'DIR-SHADOW-3')
  expect(freshThree).toMatchObject({ conflicts: ['title_conflict'] })
  if (freshThree?.kind !== 'record') throw new Error('missing directory record DIR-SHADOW-3')

  // Approved semantic differences: isolation is explicit, typed fields and query scopes are additive.
  expect(isolated.rows.every(row => row.kind === 'observation')).toBe(true)
  expect(isolated.rows.filter(row => row.kind === 'observation').map(row => row.identityState).sort()).toEqual(['conflict', 'missing_key'])
  expect(oldIsolated).toHaveLength(2)
  expect(fresh.rows.every(row => row.kind === 'record' && Array.isArray(row.titleScopes))).toBe(true)
  expect(oldResolved.every(detail => !('validityDateRaw' in detail.businessRecord))).toBe(true)
  expect(oldResolved.every(detail => !('titleScopes' in detail.businessRecord))).toBe(true)
  expect(JSON.stringify(fresh)).not.toContain('UNEXPOSED_RECOGNIZED_RAW')
  expect(JSON.stringify(getPlatformRecognizedRecord(db, freshThree.record.id))).not.toContain('UNEXPOSED_RECOGNIZED_RAW')

  console.log('SHADOW_DIFF', JSON.stringify([
    'isolated_observations_are_explicit_view_rows',
    'typed_validity_year_batch_district_are_additive_fields',
    'observed_query_title_scope_is_an_additive_record_field',
    'title_conflict_is_reported_at_record_level_instead_of_observation_conflicts',
  ]))
})
