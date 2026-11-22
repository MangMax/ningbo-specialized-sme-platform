import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { and, eq } from 'drizzle-orm'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import * as schema from '../../../db/schema'
import { targetSchema } from '../../../layers/sme-roster/lib/platform/target-schema'
import { initializeDb } from '../../../db/client'
import { commitRosterImport, findEnterpriseById, preflightRosterImport } from '../../../layers/sme-roster/server/utils/roster-import'
import { buildPlatformEvidenceIndex, findUsccKeyedRelationEvidence } from '../../../layers/sme-roster/server/utils/roster-duplicate-merge'
import { listRosterEnterprises } from '../../../layers/sme-roster/lib/roster/enterprise-roster'
import { getRosterEnterpriseDetail } from '../../../layers/sme-roster/lib/roster/enterprise-roster-sqlite'
import { readDifferenceObservation } from '../../../layers/sme-roster/lib/platform/difference-sources'
import { readEnterpriseFactEffects } from '../../../layers/sme-roster/lib/roster/enterprise-fact-effects'
import { getEnterpriseProfile, patchEnterpriseProfile } from '../../../layers/sme-roster/server/utils/enterprise-profile'
import { readUsccTargets } from '../../../layers/sme-roster/server/utils/uscc-research-read'
import type { RosterImportRequest } from '../../../layers/sme-roster/lib/roster-import-client'

const root = mkdtempSync(join(tmpdir(), 'enterprise-merge-target-'))
const from = 91001, into = 91002, third = 91003
const uscc = '91330200712345678C', thirdUscc = '91330200712345678D'
const oldName = '归并原名', currentName = '归并现名'
let sqlite: Database.Database, db: ReturnType<typeof drizzle<typeof schema>>, serial = 0
let sourceSerial = 0
const trace: string[] = []
beforeEach(() => {
  const path = join(root, `case-${++serial}.sqlite`)
  const native=initializeDb({dbPath:path,create:true})
  native.$client.close()
  sqlite = new Database(path, { verbose: text => trace.push(String(text)) }); sqlite.pragma('foreign_keys=ON')
  expect(sqlite.prepare("select name from sqlite_schema where type='table' and name in ('platform_query','platform_relation')").all()).toEqual([])
  db = drizzle(sqlite, { schema })
  db.insert(schema.enterprise).values([
    { id: from, name: oldName, nameNorm: oldName },
    { id: into, name: currentName, nameNorm: currentName, usccNorm: uscc },
    { id: third, name: '第三现名', nameNorm: '第三现名', usccNorm: thirdUscc },
  ]).run()
  db.insert(schema.rosterLegacyMember).values({ enterpriseId: from }).run()
  trace.length = 0
})
afterEach(() => sqlite?.close())
function commit(request: RosterImportRequest) {
  return commitRosterImport(db, request, [], { deferCandidateTasks: true })
}
function source(key = 'source', owner = from) {
  const result = commit({ idempotencyKey: key, sourceKind: 'platform_archive', sourceIdentity: 'merge-target',
    payload: { platformQueries: [{ interface: 'business_list', queryKey: uscc, rdjb: '3',
      queriedAt: `2026-11-13T${String(serial).padStart(2, '0')}:00:${String(++sourceSerial).padStart(2, '0')}Z`, status: 'success', rawResponse: ' original response ',
      relations: [{ sequenceNo: 1, relationKey: key, enterpriseId: owner, nameRaw: oldName, usccRaw: uscc,
        rawFields: { id: key, qymc: oldName, tyshxydm: uscc, rdjb: '3', cszt: '终审通过' } }] }] } })
  expect(result.status, JSON.stringify(result)).toBe('committed')
  const evidence = findUsccKeyedRelationEvidence(db, { uscc, name: oldName })
  if (!evidence.ok) throw new Error(evidence.message)
  return evidence.evidence
}
function merge(key = 'merge', fromEnterpriseId = from, intoUscc = uscc): RosterImportRequest {
  return { idempotencyKey: key, sourceKind: 'alias_evidence', sourceIdentity: 'merge-target',
    payload: { merges: [{ fromEnterpriseId, intoUscc, sourceKind: 'manual', note: '同一法人身份已核实' }] } }
}
function noLegacyRead() {
  expect(trace.filter(text => /\b(?:from|join|insert into|update|delete from)\s+["`]?platform_(?:query|relation)["`]?(?=\s|$|\()/i.test(text))).toEqual([])
}
it('merges the normal target path while retaining original identity assignment source bytes and one current enterprise', () => {
  const evidence = source()
  const a = targetSchema.platformObservationAssignment
  const original = db.select().from(a).all()
  const archive = sqlite.prepare('select * from platform_archive_value order by id').all()
  const recordId = db.insert(schema.record).values({ enterpriseId: from, titleCode: 'little_giant', source: 'jxj', nameRaw: oldName })
    .returning({ id: schema.record.id }).get().id
  const eventId = db.insert(schema.recordEvent).values({ recordId, eventType: 'award', year: 2024, batchSeq: 1 })
    .returning({ id: schema.recordEvent.id }).get().id
  const request = merge()
  expect(preflightRosterImport(db, request).preflight.conflicts).toEqual([])
  const result = commit(request)
  expect(result.status, JSON.stringify(result)).toBe('committed')
  expect(sqlite.prepare('select id,name,uscc_norm from enterprise where id=?').get(from)).toEqual({ id: from, name: oldName, uscc_norm: null })
  expect(findEnterpriseById(db, from)).toMatchObject({ id: into, name: currentName, usccNorm: uscc })
  expect(db.select().from(a).where(eq(a.revision, 1)).all()).toEqual(original)
  const current = readDifferenceObservation(db, evidence.relationId)
  expect(current).toMatchObject({ enterpriseId: into, nameRaw: oldName, uscc, id: evidence.relationId, queryId: evidence.queryId })
  expect(db.select().from(a).where(and(eq(a.observationId, current!.observationId), eq(a.revision, 2))).get())
    .toMatchObject({ enterpriseId: into, origin: 'command', actor: null, basis: '同一法人身份已核实', nameRaw: oldName, usccRaw: uscc })
  expect(sqlite.prepare('select * from platform_archive_value order by id').all()).toEqual(archive)
  expect(db.select().from(schema.record).where(eq(schema.record.id, recordId)).get()).toMatchObject({ enterpriseId: into })
  expect(db.select().from(schema.recordEvent).where(eq(schema.recordEvent.id, eventId)).get()).toMatchObject({ recordId })
  expect(listRosterEnterprises(db, { q: '归并' }).rows.map(row => row.enterpriseId)).toEqual([into])
  expect(getRosterEnterpriseDetail(db, from)?.enterprise.enterpriseId).toBe(into)
  expect(readUsccTargets(db, {}).rows.some(row => row.enterpriseId === from)).toBe(false)
  const beforeReplay = db.select().from(a).all()
  expect(commit(request).status).toBe('committed')
  expect(db.select().from(a).all()).toEqual(beforeReplay)
  expect(findUsccKeyedRelationEvidence(db, { uscc, name: oldName }, buildPlatformEvidenceIndex(db))).toEqual({ ok: true, evidence })
  noLegacyRead()
  expect(sqlite.pragma('foreign_key_check')).toEqual([])
})
it('resolves later old-ID writes and chained merges without rewriting original fact namespaces', () => {
  const evidence = source()
  const fact = { kind: 'cancelled', source: { reference: 'official-source', statement: '注销事实' },
    effective: { precision: 'day', value: '2026-01-01' } }
  for (const id of [from, into]) db.insert(schema.enterpriseFactRevision).values({
    enterpriseId: id, factId: 1, revision: 1, status: 'confirmed', fact, action: 'assert',
    actor: { type: 'agent', id: 'merge-test' }, basis: '核实', createdAt: '2026-01-02',
  }).run()
  expect(commit(merge()).status).toBe('committed')
  const profile = getEnterpriseProfile(db, from)
  expect(profile.profile.enterpriseId).toBe(into)
  expect(patchEnterpriseProfile(db, from, { idempotencyKey: 'old-id-profile', expectedVersion: profile.version,
    changes: { district: '鄞州区' }, actor: { type: 'agent', id: 'merge-test' }, basis: '核实属地' }).profile)
    .toMatchObject({ enterpriseId: into, district: '鄞州区' })
  expect(source('after-merge', from).relationId).not.toBe(evidence.relationId)
  expect(db.select().from(targetSchema.platformObservationAssignment).where(eq(targetSchema.platformObservationAssignment.enterpriseId, from)).all())
    .toHaveLength(1)
  expect(commit(merge('chain', into, thirdUscc)).status).toBe('committed')
  expect(findEnterpriseById(db, from)).toMatchObject({ id: third })
  expect(readDifferenceObservation(db, evidence.relationId)?.enterpriseId).toBe(third)
  const effects = readEnterpriseFactEffects(sqlite, third, Date.parse('2026-11-13'))
  expect(effects).toMatchObject({ terminated: true })
  expect(effects?.refs).toEqual([`enterprise:${from}/fact:1/revision:1`, `enterprise:${into}/fact:1/revision:1`])
  expect(() => sqlite.prepare('insert or replace into enterprise_merge values(?,?,?,?)').run(from, third, 'overwrite', 'now'))
    .toThrow('enterprise_merge_current_identity_required')
  noLegacyRead()
  expect(sqlite.pragma('foreign_key_check')).toEqual([])
})
it('rolls attribution revisions and redirect back when a later child migration fails', () => {
  source()
  db.insert(schema.record).values({ enterpriseId: from, titleCode: 'little_giant', source: 'jxj', nameRaw: oldName }).run()
  const before = db.select().from(targetSchema.platformObservationAssignment).all()
  sqlite.exec(`CREATE TRIGGER reject_merge_record BEFORE UPDATE ON record WHEN OLD.enterprise_id=${from}
    BEGIN SELECT RAISE(ABORT,'injected child failure'); END`)
  expect(commit(merge('fails')).status).toBe('failed')
  expect(db.select().from(targetSchema.platformObservationAssignment).all()).toEqual(before)
  expect(db.select().from(schema.enterpriseMerge).all()).toEqual([])
  expect(findEnterpriseById(db, from)?.id).toBe(from)
  noLegacyRead()
  expect(sqlite.pragma('foreign_key_check')).toEqual([])
})
