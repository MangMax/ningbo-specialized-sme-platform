/** Offline historical oracle from ab503081dae3e24680afc9b07395a7e3ff21fc9f. */
import { asc, eq, inArray } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../legacy-schema'
import { normalizeUscc } from '../../../layers/sme-roster/lib/domain'
import type { PlatformBusinessGroup, PlatformBusinessMetadata, PlatformBusinessObservationRef, PlatformCorrespondenceRef, ScopedPlatformObservation } from '../../../lib/platform/business-record'
import { targetSchema } from '../../target-schema'
import { correspondenceColumns, correspondenceTable, correspondenceTarget, externalRelationColumn } from './record-correspondence-store'

type Db = BetterSQLite3Database<typeof schema>

/** No query discovery here: callers must select observations before this read. */
function chunks(ids: number[]) {
  const unique = [...new Set(ids)].sort((a, b) => a - b)
  return Array.from({ length: Math.ceil(unique.length / 400) }, (_, i) => unique.slice(i * 400, (i + 1) * 400))
}

/** Only lightweight canonical columns; neither raw_fields nor canonical_raw_json is read. */
export function readPlatformBusinessMetadata(db: Db, relationIds: number[]) {
  if (correspondenceTarget(db)) {
    const { platformLegacyRelationAlias: r, platformBusinessObservation: o, platformBusinessRecord: b, platformBusinessRecordVersion: v } = targetSchema
    return new Map(chunks(relationIds).flatMap(ids => db.select({ relationId: r.oldId, recordId: o.recordId, versionId: o.versionId, interface: b.interface, platformKey: b.platformKey, identityState: o.identityState, contentState: o.contentState, keySource: o.keySource, projectionRuleVersion: o.projectionRuleVersion, hashAlgorithm: v.hashAlgorithm, contentHash: v.contentHash })
      .from(r).innerJoin(o, eq(o.id, r.observationId)).leftJoin(b, eq(b.id, o.recordId)).leftJoin(v, eq(v.id, o.versionId)).where(inArray(r.oldId, ids)).orderBy(r.oldId).all()).map(row => [row.relationId, row]))
  }
  const r = schema.platformRelation, o = schema.platformBusinessObservation, b = schema.platformBusinessRecord, v = schema.platformBusinessRecordVersion
  const rows = chunks(relationIds).flatMap(ids => db.select({ relationId: r.id, recordId: o.recordId, versionId: o.versionId, interface: b.interface, platformKey: b.platformKey, identityState: o.identityState, contentState: o.contentState, keySource: o.keySource, projectionRuleVersion: o.projectionRuleVersion, hashAlgorithm: v.hashAlgorithm, contentHash: v.contentHash })
    .from(r).leftJoin(o, eq(o.relationId, r.id)).leftJoin(b, eq(b.id, o.recordId)).leftJoin(v, eq(v.id, o.versionId))
    .where(inArray(r.id, ids)).orderBy(asc(r.id)).all())
  return new Map(rows.map(row => [row.relationId, row]))
}

function decisionConflicts(priors: PlatformCorrespondenceRef[]) {
  // Different endpoint types/roles may legitimately coexist. Compare decisions
  // within a type/role, retaining all other references without rewriting them.
  for (const sameRole of Map.groupBy(priors, p => JSON.stringify([p.type, p.role])).values()) {
    const decisions = sameRole.filter(p => p.status !== 'candidate')
    if (new Set(decisions.map(p => p.status)).size > 1) return true
    if (new Set(decisions.map(p => JSON.stringify([p.eventId, p.predecessorEventId, p.exportRowId, p.enterpriseId, p.titleCode]))).size > 1) return true
  }
  return false
}

/** Enrich and group only supplied observations. The caller owns the read snapshot.
 * No outside-scope observations/decisions, source substitution or confirmation propagation.
 */
export function readPlatformBusinessGroups(db: Db, observations: ScopedPlatformObservation[], metadata = readPlatformBusinessMetadata(db, observations.map(o => o.relationId))): PlatformBusinessGroup[] {
  const c = correspondenceTable(db), columns = correspondenceColumns(db)
  const priors = chunks(observations.map(o => o.relationId)).flatMap(ids => db.select({ id: c.id, relationId: columns.relationId, exportRowId: c.exportRowId, eventId: c.eventId, predecessorEventId: c.predecessorEventId, enterpriseId: c.enterpriseId, titleCode: c.titleCode, type: c.type, role: c.role, status: c.status, revision: c.revision, ruleId: c.ruleId, ruleVersion: c.ruleVersion, createdAt: c.createdAt, decidedAt: c.decidedAt, endedAt: c.endedAt }).from(c).where(inArray(externalRelationColumn(db), ids)).orderBy(asc(c.id)).all())
  const byRelation = Map.groupBy(priors, p => p.relationId)
  const groups = new Map<string, PlatformBusinessObservationRef[]>()
  for (const observation of observations) {
    const row = metadata.get(observation.relationId)
    const groupState = !row?.identityState ? 'not_indexed' : row.identityState !== 'resolved' ? row.identityState : row.contentState !== 'verified' ? 'unverifiable' : 'verified'
    const businessRecord: PlatformBusinessMetadata = {
      recordId: row?.recordId ?? null, versionId: row?.versionId ?? null, interface: observation.interface,
      platformKey: row?.platformKey ?? null, groupState, identityState: row?.identityState ?? 'not_indexed', contentState: row?.contentState ?? 'not_indexed',
      keySource: row?.keySource ?? null, projectionRuleVersion: row?.projectionRuleVersion ?? null, hashAlgorithm: row?.hashAlgorithm ?? null, contentHash: row?.contentHash ?? null,
    }
    const existingCorrespondences = byRelation.get(observation.relationId) ?? []
    const ref: PlatformBusinessObservationRef = { ...observation, businessRecord, existingCorrespondences, existingCorrespondenceIds: existingCorrespondences.map(p => p.id) }
    // Never group null/missing/unverified identities, nor distinct target roles.
    const key = JSON.stringify([observation.target.eventId, observation.target.enterpriseId, observation.target.titleCode, observation.target.type, observation.target.role, observation.interface,
      groupState === 'verified' ? [businessRecord.recordId, businessRecord.versionId] : ['relation', observation.relationId]])
    const group = groups.get(key)
    if (group) group.push(ref)
    else groups.set(key, [ref])
  }
  return [...groups.values()].map(observationRefs => {
    const sorted = [...observationRefs].sort((a, b) => a.relationId - b.relationId)
    const representative = sorted.find(o => o.existingCorrespondenceIds.length) ?? sorted[0]!
    const existingCorrespondences = [...new Map(observationRefs.flatMap(o => o.existingCorrespondences).map(p => [p.id, p])).values()].sort((a, b) => a.id - b.id)
    const conflicts = new Set(observationRefs.flatMap(o => o.conflicts))
    if (observationRefs.some(o => o.businessRecord.identityState === 'conflict')) conflicts.add('platform_key_conflict')
    if (new Set(observationRefs.map(o => normalizeUscc(o.usccRaw)).filter(Boolean)).size > 1 || new Set(observationRefs.map(o => o.enterpriseId).filter(id => id != null)).size > 1) conflicts.add('identity_conflict')
    if (new Set(observationRefs.map(o => o.titleCode).filter(Boolean)).size > 1) conflicts.add('title_conflict')
    if (decisionConflicts(existingCorrespondences)) conflicts.add('correspondence_decision_conflict')
    return { businessRecord: representative.businessRecord, representativeRelationId: representative.relationId, observationRefs, existingCorrespondences, existingCorrespondenceIds: existingCorrespondences.map(p => p.id), conflicts: [...conflicts] }
  })
}
