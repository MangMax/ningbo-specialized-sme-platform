import { type AnnualWriteScope, validAnnualDecisionQuery, projectAnnualFinalQualification, annualFail, planAnnualStep } from './annual-correspondence-contract'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { useApplicationDb } from '../../../../db/client'
import * as s from '../../../../db/schema'
import type { PlatformCorrespondenceRef } from '../../lib/platform/business-record'
import { targetSchema } from '../../lib/platform/target-schema'
import type { AnnualFinalQualification, AnnualStepOutcome } from '../../lib/roster/annual-correspondence'
import { commitRecordCorrespondences, preflightRecordCorrespondences } from './record-correspondence'
import { correspondenceRefValidity } from './record-correspondence-ref-validity'
import { correspondenceColumns, correspondenceTable, externalRelationColumn } from './record-correspondence-store'
export type AnnualDb = BetterSQLite3Database<typeof s>
/** JobContext deliberately exposes only Drizzle's base type; this adapter uses
 * the native client attached by the repository's actual better-sqlite factory. */
export function annualDbReadonly(db: AnnualDb): boolean {
  return (db as ReturnType<typeof useApplicationDb>).$client.readonly
}
export type AnnualScopeReader = {
  (db: AnnualDb, eventId: number): AnnualWriteScope | null
  batch?: (db: AnnualDb, eventIds: readonly number[]) => Map<number, AnnualWriteScope>
}
export function readAnnualScopes(db: AnnualDb, read: AnnualScopeReader, ids: readonly number[]) {
  return read.batch ? read.batch(db, ids) : new Map(ids.flatMap(id => {
    const scope = read(db, id)
    return scope ? [[id, scope] as const] : []
  }))
}
/** Optional current target keeps unrelated event decisions out of validity work.
 * Unscoped callers retain the complete observation-local read contract. */
export function readAnnualDecisionRefs(db: AnnualDb, ids: number[], target?: Pick<AnnualWriteScope, 'eventId' | 'enterpriseId' | 'titleCode' | 'declareKind'>) {
  const rows: (PlatformCorrespondenceRef & { queryTitle: string | null; queryRdjb: string | null; queryInterface: string | null; queryStatus: string | null })[] = []
  const unique = [...new Set(ids)].sort((a,b) => a-b)
  const c = correspondenceTable(db), columns = correspondenceColumns(db)

    const ra = targetSchema.platformLegacyRelationAlias, o = targetSchema.platformBusinessObservation, q = s.platformCollection
    for (let i = 0; i < unique.length; i += 400) rows.push(...db.select({
      id: c.id, relationId: columns.relationId, eventId: c.eventId, revision: c.revision, status: c.status, role: c.role, exportRowId: c.exportRowId,
      predecessorEventId: c.predecessorEventId, enterpriseId: c.enterpriseId, titleCode: c.titleCode, type: c.type, ruleId: c.ruleId, ruleVersion: c.ruleVersion,
      createdAt: c.createdAt, decidedAt: c.decidedAt, endedAt: c.endedAt,
      queryTitle: q.titleCode, queryRdjb: q.rdjb, queryInterface: q.interface, queryStatus: q.status,
    }).from(c).innerJoin(ra, eq(ra.observationId, c.observationId)).innerJoin(o, eq(o.id, ra.observationId)).innerJoin(q, eq(q.id, o.collectionId))
      .where(and(eq(c.type, 'event_process'), inArray(externalRelationColumn(db), unique.slice(i, i + 400)),
        target ? and(eq(c.eventId, target.eventId), eq(c.enterpriseId, target.enterpriseId), eq(c.titleCode, target.titleCode),
          inArray(c.role, ['context_only', target.declareKind === 'apply' ? 'supports_award' : 'supports_review'])) : undefined)).all())

  rows.sort((a, b) => a.id - b.id)
  const validity = new Map<number, boolean>()
  for (let i = 0; i < rows.length; i += 400) for (const pair of correspondenceRefValidity(db, rows.slice(i,i+400).map(r => r.id))) validity.set(...pair)
  return rows.map(({queryTitle,queryRdjb,queryInterface,queryStatus,...row}) => {
    return {...row,relationId:row.relationId!,requiresRevalidation:validity.get(row.id) !== false || !validAnnualDecisionQuery(row.titleCode, queryTitle, queryRdjb, queryInterface, queryStatus)}
  })
}
export const decisions = readAnnualDecisionRefs
/** Read-only. Caller keeps one snapshot for scope and decision reads. */
export function qualifyAnnualFinal(db: AnnualDb, scope: AnnualWriteScope, expectedGeneration = scope.generation): AnnualFinalQualification {
  const step = scope.steps.find(s => s.stepId === scope.finalCandidateStepId)
  const rows = step && scope.generation === expectedGeneration ? decisions(db, [...step.protectionRelationIds, ...step.currentRelationIds], scope) : []
  return projectAnnualFinalQualification(scope, rows, expectedGeneration)
}
/** Current scope and actual decisions are checked under an immediate write lock.
 * Never accepts a client-provided plan, scope, proof, endpoint or final flag. */
export function reconcileAnnualStep(db: AnnualDb, readScope: AnnualScopeReader, input: { eventId: number; generation: string; stepId: string }): AnnualStepOutcome {
  return db.transaction(() => {
    const scope = readScope(db, input.eventId)
    if (!scope) annualFail('event_unavailable', 422)
    if (scope.generation !== input.generation) annualFail('source_generation_changed')
    const step = scope.steps.find(s => s.stepId === input.stepId)
    if (!step) annualFail('source_generation_changed')
    const refs = decisions(db, [...step.protectionRelationIds, ...step.currentRelationIds], scope)
    const plan = planAnnualStep(scope, step, refs)
    if ('outcome' in plan) return plan.outcome
    const bytes = targetSourceBytes(db, plan.relationId)
    if (bytes == null || bytes > 4 * 1024 * 1024) annualFail('source_materialization_limit', 422)
    const preflight = preflightRecordCorrespondences(db, plan.request)
    const receipt = commitRecordCorrespondences(db, plan.request, preflight.planHash)
    return plan.created(decisions(db, [plan.relationId], scope).filter(r => receipt.correspondenceIds.includes(r.id)))
  }, { behavior: 'immediate' })
}
function targetSourceBytes(db: AnnualDb, relationId: number) {
  const a = targetSchema.platformLegacyRelationAlias, o = targetSchema.platformBusinessObservation
  const r = targetSchema.platformObservationArchiveRef, q = s.platformCollectionArchiveRef, v = s.platformArchiveValue
  return db.select({ n: sql<number>`coalesce((select sum(${v.byteLength}) from ${q} join ${v} on ${v.id}=${q.archiveId}
    where ${q.ownerId}=${o.collectionId} and ${q.field} in ('rawResponse','collectionEvidence')),0) +
    coalesce((select sum(${v.byteLength}) from ${r} join ${v} on ${v.id}=${r.archiveId}
    where ${r.ownerId}=${o.id} and ${r.field}='rawFields'),0)` }).from(a).innerJoin(o, eq(o.id, a.observationId)).where(eq(a.oldId, relationId)).get()?.n
}
export { type AnnualWriteStep, type AnnualWriteScope, annualHash, annualFail, validAnnualDecisionQuery, projectAnnualFinalQualification, planAnnualStep } from './annual-correspondence-contract'
