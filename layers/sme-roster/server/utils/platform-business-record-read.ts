import { asc, eq, inArray } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '../../../../db/schema'
import type { PlatformBusinessGroup, ScopedPlatformObservation } from '../../lib/platform/business-record'
import { targetSchema } from '../../lib/platform/target-schema'
import { correspondenceColumns, correspondenceTable, externalRelationColumn } from './record-correspondence-store'
import { projectPlatformBusinessGroups } from './platform-business-record-postgres'

type Db = BetterSQLite3Database<typeof schema>

/** No query discovery here: callers must select observations before this read. */
function chunks(ids: number[]) {
  const unique = [...new Set(ids)].sort((a, b) => a - b)
  return Array.from({ length: Math.ceil(unique.length / 400) }, (_, i) => unique.slice(i * 400, (i + 1) * 400))
}

/** Only lightweight canonical columns; neither raw_fields nor canonical_raw_json is read. */
export function readPlatformBusinessMetadata(db: Db, relationIds: number[]) {

    const { platformLegacyRelationAlias: r, platformBusinessObservation: o, platformBusinessRecord: b, platformBusinessRecordVersion: v } = targetSchema
    return new Map(chunks(relationIds).flatMap(ids => db.select({ relationId: r.oldId, recordId: o.recordId, versionId: o.versionId, interface: b.interface, platformKey: b.platformKey, identityState: o.identityState, contentState: o.contentState, keySource: o.keySource, projectionRuleVersion: o.projectionRuleVersion, hashAlgorithm: v.hashAlgorithm, contentHash: v.contentHash })
      .from(r).innerJoin(o, eq(o.id, r.observationId)).leftJoin(b, eq(b.id, o.recordId)).leftJoin(v, eq(v.id, o.versionId)).where(inArray(r.oldId, ids)).orderBy(r.oldId).all()).map(row => [row.relationId, row]))

}

/** Enrich and group only supplied observations. The caller owns the read snapshot.
 * No outside-scope observations/decisions, source substitution or confirmation propagation.
 */
export function readPlatformBusinessGroups(db: Db, observations: ScopedPlatformObservation[], metadata = readPlatformBusinessMetadata(db, observations.map(o => o.relationId))): PlatformBusinessGroup[] {
  const c = correspondenceTable(db), columns = correspondenceColumns(db)
  const priors = chunks(observations.map(o => o.relationId)).flatMap(ids => db.select({ id: c.id, relationId: columns.relationId, exportRowId: c.exportRowId, eventId: c.eventId, predecessorEventId: c.predecessorEventId, enterpriseId: c.enterpriseId, titleCode: c.titleCode, type: c.type, role: c.role, status: c.status, revision: c.revision, ruleId: c.ruleId, ruleVersion: c.ruleVersion, createdAt: c.createdAt, decidedAt: c.decidedAt, endedAt: c.endedAt }).from(c).where(inArray(externalRelationColumn(db), ids)).orderBy(asc(c.id)).all())
  return projectPlatformBusinessGroups(observations, metadata, priors)
}
