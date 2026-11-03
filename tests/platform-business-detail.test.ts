import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createApp, createError, createRouter, defineEventHandler, getRouterParam, setHeader, toNodeListener } from 'h3'
import { afterEach, expect, it, vi } from 'vitest'
import { schema, useDb } from '../db'
import { ensurePlatformObservation } from '../server/utils/platform-business-record'
import { getRosterEnterpriseDetail } from '../lib/roster/enterprise-roster'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers() })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'business-detail246-'))
  const db = useDb({ dbPath: join(dir, 'roster.db') })
  cleanup.push(() => { db.$client.close(); rmSync(dir, { recursive: true, force: true }) })
  const enterprise = db.insert(schema.enterprise).values({ name: '合成详情企业', nameNorm: '合成详情企业', usccNorm: 'SYN246' }).returning().get()
  let counter = 0
  function row(options: { source?: 'business_list' | 'apply_list'; raw?: Record<string, unknown> | null; key?: string | null; indexed?: boolean; rdjb?: string; queriedAt?: string; stored?: Partial<typeof schema.platformRelation.$inferInsert> } = {}) {
    const key = options.key === undefined ? 'SQ246' : options.key
    const query = db.insert(schema.platformQuery).values({ interface: options.source ?? 'business_list', queryKey: enterprise.usccNorm!, rdjb: options.rdjb ?? '2', queriedAt: options.queriedAt ?? `2026-10-${String(++counter).padStart(2, '0')}T00:00:00Z`, status: 'success' }).returning().get()
    const relation = db.insert(schema.platformRelation).values({ queryId: query.id, sequenceNo: 1, relationKey: key, enterpriseId: enterprise.id, nameRaw: enterprise.name, usccRaw: enterprise.usccNorm, rawFields: options.raw === undefined ? { id: key, year: '2025', sblx: '申请' } : options.raw, ...options.stored }).returning().get()
    const projection = options.indexed === false ? null : ensurePlatformObservation(db, relation.id)
    return { query, relation, projection }
  }
  function prior(relationId: number, status: 'confirmed' | 'rejected') {
    return db.insert(schema.recordCorrespondence).values({ edgeKey: `detail-${relationId}`, type: 'event_process', role: 'context_only', relationId, enterpriseId: enterprise.id, titleCode: 'specialized_sme', status, revision: 2, targetIdentity: {}, provenance: {}, sourceFingerprint: 'old-fingerprint', ruleId: 'manual', ruleVersion: 'old', createdAt: '2026-10-01' }).returning().get()
  }
  const detail = () => getRosterEnterpriseDetail(db, enterprise.id)! as any
  return { db, dir, enterprise, row, prior, detail }
}

it('detail groups A B A by business with two versions three observations and latest queried time representative', () => {
  const f = fixture(), a = f.row({ queriedAt: '2026-10-03T00:00:00Z' }), b = f.row({ raw: { id: 'SQ246', year: '2024' }, queriedAt: '2026-10-02T00:00:00Z' }), again = f.row({ queriedAt: '2026-10-01T00:00:00Z', stored: { year: 2025 } })
  const yes = f.prior(a.relation.id, 'confirmed'), no = f.prior(b.relation.id, 'rejected')
  const result = f.detail()
  expect(result.platform.relations.map((r: any) => r.id)).toEqual([a.relation.id, b.relation.id, again.relation.id])
  expect(result.platform.businessRecords).toHaveLength(1)
  const business = result.platform.businessRecords[0]
  expect(business).toMatchObject({ representativeRelationId: a.relation.id, versionCount: 2, observationCount: 3, existingCorrespondenceIds: [yes.id, no.id] })
  expect(business.versions.map((v: any) => [v.businessRecord.versionId, v.observationRefs.map((o: any) => o.relationId)])).toEqual([[a.projection!.versionId, [a.relation.id, again.relation.id]], [b.projection!.versionId, [b.relation.id]]])
  expect(business.observationRefs.map((o: any) => o.existingCorrespondenceIds)).toEqual([[yes.id], [no.id], []])
  expect(business.conflicts).toContain('correspondence_decision_conflict')
  expect(f.db.select().from(schema.recordCorrespondence).all().map(c => [c.id, c.relationId, c.status, c.sourceFingerprint])).toEqual([[yes.id, a.relation.id, 'confirmed', 'old-fingerprint'], [no.id, b.relation.id, 'rejected', 'old-fingerprint']])
})

it('detail isolates interfaces and unknown rows without inventing versions or merging null keys', () => {
  const f = fixture(); f.row(); f.row(); f.row({ source: 'apply_list' }); f.row({ source: 'apply_list' })
  for (let i = 0; i < 2; i++) { f.row({ indexed: false }); f.row({ key: null, raw: { year: '2025' } }); f.row({ raw: null }); f.row({ raw: { id: 'different' } }) }
  const records = f.detail().platform.businessRecords
  expect(records).toHaveLength(8)
  expect(records.slice(0, 2).map((r: any) => [r.businessRecord.interface, r.versionCount, r.observationCount, r.unknownContentObservationCount])).toEqual([['business_list', 1, 4, 2], ['apply_list', 1, 2, 0]])
  expect(records[0].versions[0].observationRefs.map((o: any) => o.relationId)).toEqual([1, 2])
  expect(records.slice(2).map((r: any) => [r.businessRecord.groupState, r.versionCount, r.observationCount, r.versions.length])).toEqual(Array.from({ length: 2 }, () => [['not_indexed', 0, 1, 0], ['missing_key', 0, 1, 0], ['conflict', 0, 1, 0]]).flat())
})

it('known business with only unknown content remains one business with zero versions and separate unknown observations', () => {
  const f = fixture(), a = f.row({ raw: null }), b = f.row({ raw: null })
  const records = f.detail().platform.businessRecords
  expect(records).toHaveLength(1)
  expect(records[0]).toMatchObject({ businessRecord: { recordId: a.projection!.recordId, identityState: 'resolved', versionId: null }, versionCount: 0, unknownContentObservationCount: 2, observationCount: 2, versions: [], representativeRelationId: b.relation.id })
  expect(records[0].observationRefs.map((o: any) => [o.relationId, o.businessRecord.versionId])).toEqual([[a.relation.id, null], [b.relation.id, null]])
})

it('detail keeps explicit title and identity conflicts across versions under one canonical business', () => {
  const f = fixture(), a = f.row(), b = f.row({ rdjb: '1', raw: { id: 'SQ246', year: '2024', rdjb: '3', tyshxydm: 'RAWOTHER' }, stored: { usccRaw: 'OTHER' } })
  const business = f.detail().platform.businessRecords[0]
  expect(business).toMatchObject({ representativeRelationId: b.relation.id, versionCount: 2, observationCount: 2 })
  expect(business.conflicts).toEqual(expect.arrayContaining(['identity_conflict', 'title_conflict']))
  expect(business.observationRefs.map((o: any) => [o.relationId, o.titleCode, o.usccRaw])).toEqual([[a.relation.id, 'specialized_sme', 'SYN246'], [b.relation.id, 'innovative_sme', 'OTHER']])
  expect(business.observationRefs[1].conflicts).toEqual(['title_conflict', 'identity_conflict'])
})

it('HTTP detail reads scoped lightweight canonical mappings inside the offmain detail snapshot and preserves legacy fields', async () => {
  const f = fixture(), a = f.row(), b = f.row(), decision = f.prior(a.relation.id, 'confirmed')
  const other = f.db.insert(schema.enterprise).values({ name: '无关', nameNorm: '无关' }).returning().get()
  const q = f.db.insert(schema.platformQuery).values({ interface: 'business_list', queryKey: 'unrelated', queriedAt: '2020-01-01', status: 'success' }).returning().get()
  const r = f.db.insert(schema.platformRelation).values({ queryId: q.id, sequenceNo: 1, enterpriseId: other.id }).returning().get()
  f.db.$client.prepare('update platform_relation set raw_fields=? where id=?').run('{invalid unrelated', r.id)
  f.db.$client.prepare('update platform_business_record_version set canonical_raw_json=?').run('DO-NOT-LOAD'.repeat(100000))
  const calls: string[] = [], canonicalReads: Array<{ transactional: boolean; ids: unknown[] }> = [], prepare = f.db.$client.prepare.bind(f.db.$client)
  f.db.$client.prepare = ((sql: string) => {
    calls.push(sql)
    const statement = prepare(sql)
    if (sql.includes('left join "platform_business_observation"')) {
      const all = statement.all.bind(statement)
      statement.all = ((...ids: unknown[]) => { canonicalReads.push({ transactional: f.db.$client.inTransaction, ids }); return all(...ids) }) as typeof statement.all
    }
    return statement
  }) as typeof prepare
  const direct = f.detail()
  expect(calls.some(sql => sql.includes('canonical_raw_json'))).toBe(false)
  expect(canonicalReads).toEqual([{ transactional: true, ids: [a.relation.id, b.relation.id] }])
  expect(direct.platform.businessRecords).toHaveLength(1)
  expect(direct.platform.businessRecords[0].observationRefs.map((o: any) => o.relationId)).toEqual([a.relation.id, b.relation.id])
  expect(direct.platform.relations[0]).toMatchObject({ queryId: a.query.id, sequenceNo: 1, rawFields: { id: 'SQ246', year: '2025', sblx: '申请' }, year: 2025, declareKind: 'apply' })
  expect(direct.platform.businessRecords[0].observationRefs.map((o: any) => o.existingCorrespondenceIds)).toEqual([[decision.id], []])
  vi.stubEnv('NUXT_DB_PATH', join(f.dir, 'roster.db'))
  for (const [key, value] of Object.entries({ defineEventHandler, getRouterParam, createError, setHeader })) vi.stubGlobal(key, value)
  const handler = (await import('../server/api/roster/enterprises/[id].get')).default
  const server = createServer(toNodeListener(createApp().use(createRouter().get('/api/roster/enterprises/:id', handler))))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/roster/enterprises/${f.enterprise.id}`)
  expect(response.status).toBe(200)
  // The qualification scope carries an execution-time asOf, and the HTTP read
  // runs in its own executor; compare every field except that timing digest.
  const body = await response.json() as any, strip = (detail: any) => { const copy = structuredClone(detail); delete copy.qualificationAssessment?.asOf; delete copy.qualificationAssessment?.snapshotId; return copy }
  expect(strip(body)).toEqual(strip(direct))
})
