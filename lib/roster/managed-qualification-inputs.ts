import { and, eq, inArray, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as s from '../../db/schema'
import { normalizeUscc } from '../domain'

/** Bounded current lifecycle qualification inputs, separate from legacy diagnostics.
 * Never hydrate raw source bodies or make a platform validity flag authoritative. */
export function readManagedQualificationInputs(db: Pick<BetterSQLite3Database<typeof s>, 'select'>, ids: readonly number[]) {
  const d = s.differenceReason, o = s.platformBusinessObservation, a = s.platformObservationAssignment
  const rows = db.select({ decision: d, source: {
    observationId: o.id, collectionId: o.collectionId, versionId: o.versionId, recordId: o.recordId,
    scopeMask: o.candidateScopeMask, scopeState: o.candidateScopeState,
    latestVersionId: sql<number | null>`(select max(id) from platform_business_record_version where record_id=${o.recordId})`,
    enterpriseId: a.enterpriseId, uscc: a.usccRaw, verificationStatus: a.verificationStatus, revision: a.revision,
    pendingImpact: sql<number>`exists(select 1 from explanation_impact_113 i where i.decision_id=${d.id} and i.latest_revision_id>coalesce(i.reviewed_revision_id,-1))`,
    pendingProjection: sql<number>`exists(select 1 from evidence_scope_version_113 v where v.pending_count>0 and v.scope_key in (json_array(${d.enterpriseId},${d.titleCode},${d.direction}),json_array(${d.enterpriseId},${d.titleCode},null),json_array(${d.enterpriseId},null,${d.direction}),json_array(${d.enterpriseId},null,null),json_array(null,${d.titleCode},${d.direction}),json_array(null,${d.titleCode},null),json_array(null,null,${d.direction}),json_array(null,null,null)))`,
  } }).from(d).leftJoin(o, eq(o.id, d.evidenceObservationId)).leftJoin(a, and(eq(a.observationId, o.id),
    sql`${a.revision}=(select max(revision) from platform_observation_assignment where observation_id=${o.id})`))
    .where(and(inArray(d.enterpriseId, [...ids]), sql`${d.id}=(select id from difference_reason h where h.enterprise_id=${d.enterpriseId} and h.title_code=${d.titleCode} and h.direction=${d.direction} order by h.recorded_at desc,h.id desc limit 1)`,
      sql`${d.lifecycleAction} is not null`)).orderBy(d.id).all()
  return Map.groupBy(rows, row => row.decision.enterpriseId)
}
export function managedQualificationSourceValid(input: ReturnType<typeof readManagedQualificationInputs> extends Map<number, (infer T)[]> ? T : never, uscc: string | null) {
  const { decision: d, source } = input
  const own = normalizeUscc(uscc), observed = normalizeUscc(source?.uscc)
  const mask = { innovative_sme: 1, specialized_sme: 2, little_giant: 4 }[d.titleCode as 'innovative_sme' | 'specialized_sme' | 'little_giant']
  return !!source && source.verificationStatus === 'confirmed' &&
    (source.enterpriseId === d.enterpriseId || source.enterpriseId == null && !!own && observed === own) &&
    !(own && observed && own !== observed) && source.scopeState === 'captured' && !!(source.scopeMask! & mask) &&
    (source.recordId == null || source.versionId != null && source.versionId === source.latestVersionId) &&
    !source.pendingImpact && !source.pendingProjection
}
