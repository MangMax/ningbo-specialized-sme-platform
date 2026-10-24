import { createHash } from 'node:crypto'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { useDb } from '../../db/client'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as s from '../../db/schema'
import type { PlatformCorrespondenceRef } from '../../lib/platform/business-record'
import { RDJB_TITLE_CODES } from '../../lib/platform/recognized-evidence'
import { ANNUAL_CORRESPONDENCE_RULE, ANNUAL_CORRESPONDENCE_VERSION, type AnnualDecisionRef, type AnnualFinalQualification, type AnnualStepOutcome } from '../../lib/roster/annual-correspondence'
import { correspondenceRefValidity } from './record-correspondence-ref-validity'
import { commitRecordCorrespondences, preflightRecordCorrespondences, type CorrespondenceRequest } from './record-correspondence'

export type AnnualDb = BetterSQLite3Database<typeof s>
/** JobContext deliberately exposes only Drizzle's base type; this adapter uses
 * the native client attached by the repository's actual better-sqlite factory. */
export function annualDbReadonly(db: AnnualDb): boolean {
  return (db as ReturnType<typeof useDb>).$client.readonly
}
/** Private write port, populated only by the complete shared annual reader.
 * currentRelationIds identifies the selected version; protectionRelationIds also
 * covers earlier versions. It does not confer a decision on any of those rows. */
export interface AnnualWriteStep {
  stepId: string
  currentRelationIds: number[]
  protectionRelationIds: number[]
  preferredRelationId: number | null
  eligible: boolean
  reasons: string[]
}
export interface AnnualWriteScope {
  eventId: number
  enterpriseId: number
  titleCode: string
  declareKind: 'apply' | 'review' | null
  generation: string
  sourceRefs: unknown
  steps: AnnualWriteStep[]
  finalCandidateStepId: string | null
  reasons: string[]
}
export type AnnualScopeReader = (db: AnnualDb, eventId: number) => AnnualWriteScope | null
export function annualHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
export function annualFail(code: string, statusCode = 409): never {
  throw Object.assign(new Error(code), { code, statusCode })
}
/** Optional current target keeps unrelated event decisions out of validity work.
 * Unscoped callers retain the complete observation-local read contract. */
export function readAnnualDecisionRefs(db: AnnualDb, ids: number[], target?: Pick<AnnualWriteScope, 'eventId' | 'enterpriseId' | 'titleCode' | 'declareKind'>) {
  const rows: (PlatformCorrespondenceRef & { queryTitle: string | null; queryRdjb: string | null; queryInterface: string | null; queryStatus: string | null })[] = []
  const unique = [...new Set(ids)].sort((a,b) => a-b)
  for (let i = 0; i < unique.length; i += 400) rows.push(...db.select({
    id: s.recordCorrespondence.id, relationId: s.recordCorrespondence.relationId,
    eventId: s.recordCorrespondence.eventId, revision: s.recordCorrespondence.revision,
    status: s.recordCorrespondence.status, role: s.recordCorrespondence.role,
    exportRowId: s.recordCorrespondence.exportRowId, predecessorEventId: s.recordCorrespondence.predecessorEventId,
    enterpriseId: s.recordCorrespondence.enterpriseId, titleCode: s.recordCorrespondence.titleCode,
    type: s.recordCorrespondence.type, ruleId: s.recordCorrespondence.ruleId, ruleVersion: s.recordCorrespondence.ruleVersion,
    createdAt: s.recordCorrespondence.createdAt, decidedAt: s.recordCorrespondence.decidedAt, endedAt: s.recordCorrespondence.endedAt,
    queryTitle: s.platformQuery.titleCode, queryRdjb: s.platformQuery.rdjb, queryInterface: s.platformQuery.interface, queryStatus: s.platformQuery.status,
  }).from(s.recordCorrespondence).leftJoin(s.platformRelation,eq(s.platformRelation.id,s.recordCorrespondence.relationId)).leftJoin(s.platformQuery,eq(s.platformQuery.id,s.platformRelation.queryId))
    .where(and(eq(s.recordCorrespondence.type, 'event_process'), inArray(s.recordCorrespondence.relationId, unique.slice(i,i+400)),
      target ? and(eq(s.recordCorrespondence.eventId,target.eventId), eq(s.recordCorrespondence.enterpriseId,target.enterpriseId), eq(s.recordCorrespondence.titleCode,target.titleCode),
        inArray(s.recordCorrespondence.role,['context_only',target.declareKind === 'apply' ? 'supports_award' : 'supports_review'])) : undefined)).all())
  rows.sort((a, b) => a.id - b.id)
  const validity = new Map<number, boolean>()
  for (let i = 0; i < rows.length; i += 400) for (const pair of correspondenceRefValidity(db, rows.slice(i,i+400).map(r => r.id))) validity.set(...pair)
  return rows.map(({queryTitle,queryRdjb,queryInterface,queryStatus,...row}) => {
    const scopes = queryRdjb?.split(',').filter(Boolean) ?? []
    const scopedTitle = scopes.length === 1 ? RDJB_TITLE_CODES[scopes[0]!] : undefined
    // Annual title lineage is not native title evidence for sourceForEdge.
    // Preserve its original process-interface/title guard even for old refs.
    const nativeValid = ['business_list','apply_list'].includes(queryInterface ?? '') && ['success','partial'].includes(queryStatus ?? '') &&
      (queryTitle ?? scopedTitle) === row.titleCode && !(queryTitle && scopedTitle && queryTitle !== scopedTitle)
    return {...row,relationId:row.relationId!,requiresRevalidation:validity.get(row.id) !== false || !nativeValid}
  })
}
const decisions = readAnnualDecisionRefs
function assessStep(db: AnnualDb, scope: AnnualWriteScope, step: AnnualWriteStep) {
  const rows = decisions(db, [...step.protectionRelationIds, ...step.currentRelationIds], scope)
  const sameTarget = rows.filter(r => r.eventId === scope.eventId && r.enterpriseId === scope.enterpriseId && r.titleCode === scope.titleCode &&
    (r.role === 'context_only' || r.role === (scope.declareKind === 'apply' ? 'supports_award' : 'supports_review')))
  const protectedRows = sameTarget.filter(r => r.status === 'rejected' || r.status === 'unlinked')
  const current = sameTarget.filter(r => step.currentRelationIds.includes(r.relationId))
  const confirmed = current.filter(r => r.status === 'confirmed' && !r.requiresRevalidation)
  return { rows, protectedRows, current, confirmed }
}
function refs(rows: ReturnType<typeof decisions>): AnnualDecisionRef[] {
  return rows.map(({ id, relationId, revision, status, requiresRevalidation }) => ({ id, relationId, revision, status, requiresRevalidation }))
}
/** Read-only. Caller keeps one snapshot for scope and decision reads. */
export function qualifyAnnualFinal(db: AnnualDb, scope: AnnualWriteScope, expectedGeneration = scope.generation): AnnualFinalQualification {
  if (scope.generation !== expectedGeneration) return { stepId: null, status: 'blocked', decisionRefs: [], reasons: ['source_generation_changed'] }
  const step = scope.steps.find(s => s.stepId === scope.finalCandidateStepId)
  if (!step) return { stepId: null, status: 'none', decisionRefs: [], reasons: scope.reasons }
  const state = assessStep(db, scope, step)
  if (state.protectedRows.length) return { stepId: null, status: 'blocked', decisionRefs: refs(state.protectedRows), reasons: ['protected_decision'] }
  if (!step.eligible) return { stepId: null, status: 'blocked', decisionRefs: [], reasons: step.reasons }
  if (state.confirmed.length) return { stepId: step.stepId, status: 'confirmed', decisionRefs: refs(state.confirmed), reasons: [] }
  if (state.current.some(r => r.status === 'confirmed' && r.requiresRevalidation)) return { stepId: null, status: 'blocked', decisionRefs: refs(state.current), reasons: ['source_requires_revalidation'] }
  return { stepId: step.stepId, status: 'eligible', decisionRefs: [], reasons: ['decision_required'] }
}
/** Full scope and actual decisions are recomputed under an immediate write lock.
 * Never accepts a client-provided plan, scope, proof, endpoint or final flag. */
export function reconcileAnnualStep(db: AnnualDb, readScope: AnnualScopeReader, input: { eventId: number; generation: string; stepId: string }): AnnualStepOutcome {
  return db.transaction(() => {
    const scope = readScope(db, input.eventId)
    if (!scope) annualFail('event_unavailable', 422)
    if (scope.generation !== input.generation) annualFail('source_generation_changed')
    const step = scope.steps.find(s => s.stepId === input.stepId)
    if (!step) annualFail('source_generation_changed')
    const state = assessStep(db, scope, step)
    const outcome = (status: AnnualStepOutcome['status'], rows: ReturnType<typeof decisions>, reasons: string[], relationId = step.preferredRelationId): AnnualStepOutcome => ({ stepId: step.stepId, status, relationId, decisionRefs: refs(rows), reasons })
    if (state.protectedRows.length) return outcome('protected', state.protectedRows, ['protected_decision'])
    if (!step.eligible) return outcome('needs_review', [], step.reasons)
    if (state.confirmed.length) return outcome('existing', state.confirmed, [], state.confirmed[0]!.relationId)
    if (state.current.some(r => r.status === 'confirmed')) return outcome('needs_review', state.current, ['source_requires_revalidation'])
    const relationId = step.preferredRelationId
    if (!relationId || !step.currentRelationIds.includes(relationId)) return outcome('needs_review', [], ['explicit_endpoint_required'])
    const p = s.platformRelation, q = s.platformQuery
    const bytes = db.select({ n: sbytes() }).from(p).innerJoin(q, eq(q.id,p.queryId)).where(eq(p.id,relationId)).get()?.n
    if (bytes == null || bytes > 4 * 1024 * 1024) annualFail('source_materialization_limit', 422)
    const candidate = state.current.find(r => r.relationId === relationId && r.role === 'context_only' && r.status === 'candidate')
    if (candidate?.requiresRevalidation) return outcome('needs_review', [candidate], ['source_requires_revalidation'])
    const identity = { eventId: scope.eventId, generation: scope.generation, ruleId: ANNUAL_CORRESPONDENCE_RULE, ruleVersion: ANNUAL_CORRESPONDENCE_VERSION, stepId: step.stepId }
    const request: CorrespondenceRequest = {
      idempotencyKey: `annual:${annualHash(identity)}`,
      sourceIdentity: JSON.stringify(identity),
      actor: { type: 'agent', id: 'annual-correspondence-worker' },
      basis: JSON.stringify({ ...identity, sourceRefs: scope.sourceRefs, selectedRelationId: relationId, reason: 'complete_explicit_annual_process' }),
      ruleId: ANNUAL_CORRESPONDENCE_RULE, ruleVersion: ANNUAL_CORRESPONDENCE_VERSION,
      // No comparison proof is borrowed from a different observation/version.
      proofIds: [],
      operations: candidate ? [{ action: 'decide', correspondenceId: candidate.id, expectedRevision: candidate.revision, status: 'confirmed' }] : [{ action: 'create', status: 'confirmed', edge: { type: 'event_process', eventId: scope.eventId, relationId, role: 'context_only' } }],
    }
    const plan = preflightRecordCorrespondences(db, request)
    const receipt = commitRecordCorrespondences(db, request, plan.planHash)
    return outcome('created', decisions(db, [relationId], scope).filter(r => receipt.correspondenceIds.includes(r.id)), [])
  }, { behavior: 'immediate' })
}
function sbytes() {
  return sql<number>`length(cast(coalesce(${s.platformQuery.rawResponse},'') as blob)) + length(cast(coalesce(${s.platformQuery.collectionEvidence},'') as blob)) + length(cast(coalesce(${s.platformRelation.rawFields},'') as blob))`
}
