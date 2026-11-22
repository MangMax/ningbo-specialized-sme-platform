import { createHash } from 'node:crypto'
import { RDJB_TITLE_CODES } from '../../lib/platform/recognized-evidence'
import { ANNUAL_CORRESPONDENCE_RULE, ANNUAL_CORRESPONDENCE_VERSION, type AnnualDecisionRef, type AnnualFinalQualification, type AnnualStepOutcome } from '../../lib/roster/annual-correspondence'
import type { CorrespondenceRequest } from './record-correspondence-model'
import type { readPostgresAnnualDecisionRefs } from './event-annual-process-postgres'

type AnnualDecisionRows = Awaited<ReturnType<typeof readPostgresAnnualDecisionRefs>>

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

export function annualHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function annualFail(code: string, statusCode = 409): never {
  throw Object.assign(new Error(code), { code, statusCode })
}

export function validAnnualDecisionQuery(titleCode: string, queryTitle: string | null, queryRdjb: string | null, queryInterface: string | null, queryStatus: string | null) {
  const scopes = queryRdjb?.split(',').filter(Boolean) ?? []
  const scopedTitle = scopes.length === 1 ? RDJB_TITLE_CODES[scopes[0]!] : undefined
  // Annual title lineage is not native title evidence for sourceForEdge.
  // Preserve its original process-interface/title guard even for old refs.
  return ['business_list','apply_list'].includes(queryInterface ?? '') && ['success','partial'].includes(queryStatus ?? '') &&
    (queryTitle ?? scopedTitle) === titleCode && !(queryTitle && scopedTitle && queryTitle !== scopedTitle)
}

function assessAnnualStep(scope: AnnualWriteScope, step: AnnualWriteStep, rows: AnnualDecisionRows) {
  const sameTarget = rows.filter(r => r.eventId === scope.eventId && r.enterpriseId === scope.enterpriseId && r.titleCode === scope.titleCode &&
    (r.role === 'context_only' || r.role === (scope.declareKind === 'apply' ? 'supports_award' : 'supports_review')))
  const protectedRows = sameTarget.filter(r => r.status === 'rejected' || r.status === 'unlinked')
  const current = sameTarget.filter(r => step.currentRelationIds.includes(r.relationId))
  const confirmed = current.filter(r => r.status === 'confirmed' && !r.requiresRevalidation)
  return { rows, protectedRows, current, confirmed }
}

function refs(rows: AnnualDecisionRows): AnnualDecisionRef[] {
  return rows.map(({ id, relationId, revision, status, requiresRevalidation }) => ({ id, relationId, revision, status, requiresRevalidation }))
}

export function projectAnnualFinalQualification(scope: AnnualWriteScope, rows: AnnualDecisionRows, expectedGeneration = scope.generation): AnnualFinalQualification {
  if (scope.generation !== expectedGeneration) return { stepId: null, status: 'blocked', decisionRefs: [], reasons: ['source_generation_changed'] }
  const step = scope.steps.find(s => s.stepId === scope.finalCandidateStepId)
  if (!step) return { stepId: null, status: 'none', decisionRefs: [], reasons: scope.reasons }
  const state = assessAnnualStep(scope, step, rows)
  if (state.protectedRows.length) return { stepId: null, status: 'blocked', decisionRefs: refs(state.protectedRows), reasons: ['protected_decision'] }
  if (!step.eligible) return { stepId: null, status: 'blocked', decisionRefs: [], reasons: step.reasons }
  if (state.confirmed.length) return { stepId: step.stepId, status: 'confirmed', decisionRefs: refs(state.confirmed), reasons: [] }
  if (state.current.some(r => r.status === 'confirmed' && r.requiresRevalidation)) return { stepId: null, status: 'blocked', decisionRefs: refs(state.current), reasons: ['source_requires_revalidation'] }
  return { stepId: step.stepId, status: 'eligible', decisionRefs: [], reasons: ['decision_required'] }
}

export function planAnnualStep(scope: AnnualWriteScope, step: AnnualWriteStep, rows: AnnualDecisionRows):
  { outcome: AnnualStepOutcome } | { relationId: number; request: CorrespondenceRequest; created: (rows: AnnualDecisionRows) => AnnualStepOutcome } {
  const state = assessAnnualStep(scope, step, rows)
  const outcome = (status: AnnualStepOutcome['status'], rows: AnnualDecisionRows, reasons: string[], relationId = step.preferredRelationId): AnnualStepOutcome => ({ stepId: step.stepId, status, relationId, decisionRefs: refs(rows), reasons })
  if (state.protectedRows.length) return { outcome: outcome('protected', state.protectedRows, ['protected_decision']) }
  if (!step.eligible) return { outcome: outcome('needs_review', [], step.reasons) }
  if (state.confirmed.length) return { outcome: outcome('existing', state.confirmed, [], state.confirmed[0]!.relationId) }
  if (state.current.some(r => r.status === 'confirmed')) return { outcome: outcome('needs_review', state.current, ['source_requires_revalidation']) }
  const relationId = step.preferredRelationId
  if (!relationId || !step.currentRelationIds.includes(relationId)) return { outcome: outcome('needs_review', [], ['explicit_endpoint_required']) }
  const candidate = state.current.find(r => r.relationId === relationId && r.role === 'context_only' && r.status === 'candidate')
  if (candidate?.requiresRevalidation) return { outcome: outcome('needs_review', [candidate], ['source_requires_revalidation']) }
  const identity = { eventId: scope.eventId, generation: scope.generation, ruleId: ANNUAL_CORRESPONDENCE_RULE, ruleVersion: ANNUAL_CORRESPONDENCE_VERSION, stepId: step.stepId }
  const request: CorrespondenceRequest = {
    idempotencyKey: `annual:${annualHash(identity)}`,
    sourceIdentity: JSON.stringify(identity),
    actor: { type: 'agent', id: 'annual-correspondence-worker' },
    basis: JSON.stringify({ ...identity, sourceRefs: scope.sourceRefs, selectedRelationId: relationId, reason: 'complete_explicit_annual_process' }),
    ruleId: ANNUAL_CORRESPONDENCE_RULE, ruleVersion: ANNUAL_CORRESPONDENCE_VERSION,
    operations: candidate ? [{ action: 'decide', correspondenceId: candidate.id, expectedRevision: candidate.revision, status: 'confirmed' }] : [{ action: 'create', status: 'confirmed', edge: { type: 'event_process', eventId: scope.eventId, relationId, role: 'context_only' } }],
  }
  return { relationId, request, created: refs => outcome('created', refs, []) }
}
