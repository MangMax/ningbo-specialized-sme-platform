import { alias } from 'drizzle-orm/sqlite-core'
import { and,desc,eq,gt,inArray,notExists,or,sql,type AnyColumn,type SQL } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { z } from 'zod'
import * as s from '../../../../db/schema'
import { differenceEvidenceColumns,differencePublicColumns,targetDifferenceReason } from '../../lib/platform/difference-reference-target'
import { readDifferenceCollection,readDifferenceCollectionScope,readDifferenceObservation } from '../../lib/platform/difference-sources'
import { readLatestDecisionHead102 as latestDecisionHead102,whereDecisionScope102 as whereScope } from './decision-lifecycle-102/head'
import { readEvidenceToken113 } from './evidence-impact-113'
import { decisionScope102, currentQualification102, decisionCommand102, browserDecisionCommand102, internalDecisionCommand102, type Scope, type DecisionCommand102, DecisionError102, parse102, publicVersion102, decisionReceipt102, checkDecisionHead102, decisionContent102, checkDecisionFact102, checkDecisionRelation102, checkDecisionQuery102, checkDecisionPriorTime102, qualificationPlanRule, qualificationPreflight102, qualificationCommit102, qualificationPlanHash, decisionRequestHash102, decisionValues102, decisionHistory102 } from './decision-lifecycle-102/contract'
export { readLatestDecisionHead102 as latestDecisionHead102 } from './decision-lifecycle-102/head'

export { decisionScope102, currentQualification102, decisionCommand102, browserDecisionCommand102, internalDecisionCommand102, type Scope, type DecisionCommand102, DecisionError102, parse102, publicVersion102, decisionReceipt102, checkDecisionHead102, decisionContent102, checkDecisionFact102, checkDecisionRelation102, checkDecisionQuery102, checkDecisionPriorTime102, qualificationPlanRule, qualificationPreflight102, qualificationCommit102, qualificationPlanHash, decisionRequestHash102, decisionValues102, decisionHistory102 } from './decision-lifecycle-102/contract'

export type DecisionDb = BetterSQLite3Database<typeof s>
/**
 * Drizzle deliberately passes JS `null` through as SQL NULL instead of json.dumps-ing it,
 * so a typed `null` cannot satisfy the receipt's existing NOT NULL actor column. This
 * expression writes the JSON text `null` (the honest "not recorded" value) without a
 * migration and without inventing a placeholder actor. Reading it back yields JS null.
 */
const jsonNull = sql`'null'`
/** Explicit review of a legacy version adopts its existing scope without rewriting that version. */
export function managedDecision102(id: AnyColumn | SQL = s.differenceReason.id, action: AnyColumn | SQL = s.differenceReason.lifecycleAction) {
  return sql`(${action} is not null or exists(select 1 from evidence_review_receipt_114 r where (r.decision_id=${id} or r.source_decision_id=${id}) and r.reviewed_revision_id is not null))`
}
export function latestDecision102(db: DecisionDb, scope: Scope) {
  return db.select().from(s.differenceReason).where(whereScope(scope)).orderBy(desc(s.differenceReason.recordedAt), desc(s.differenceReason.id)).limit(1).get()
}
function requireEnterprise(db: DecisionDb, enterpriseId: number) {
  const enterprise = db.select({ id: s.enterprise.id, usccNorm: s.enterprise.usccNorm, nameNorm: s.enterprise.nameNorm }).from(s.enterprise).where(eq(s.enterprise.id, enterpriseId)).get()
  if (!enterprise) throw new DecisionError102(404, 'not_found', 'Enterprise not found')
  return enterprise
}
export function readDecision102(db: DecisionDb, id: number) {
  const row = db.select(differencePublicColumns(db)).from(s.differenceReason).where(eq(s.differenceReason.id, id)).get()
  if (!row) throw new DecisionError102(404, 'not_found', 'Decision version not found')
  return publicVersion102(row, latestDecisionHead102(db, row)?.id ?? null)
}
export function currentDecision102(db: DecisionDb, scope: Scope) {
  requireEnterprise(db, scope.enterpriseId)
  const state = decisionState102(db.select(differencePublicColumns(db)).from(s.differenceReason).where(whereScope(scope)).orderBy(desc(s.differenceReason.recordedAt), desc(s.differenceReason.id)).limit(1).get())
  return { ...scope, versionId: state.versionId, current: state.current ? publicVersion102(state.current, state.current.id) : null }
}
function decisionState102<T extends { id: number; lifecycleAction: string | null }>(row: T | undefined) {
  return { versionId: row?.id ?? null, current: row && row.lifecycleAction !== 'withdraw' ? row : null }
}
/** State-only owner projection: never fetch notes, qualification JSON or audit bodies. */
export function currentDecisionState102(db: DecisionDb, scope: Scope) {
  requireEnterprise(db, scope.enterpriseId)
  const t = s.differenceReason
  const row = db.select({ id: t.id, status: t.status, lifecycleAction: t.lifecycleAction }).from(t)
    .where(whereScope(scope)).orderBy(desc(t.recordedAt), desc(t.id)).limit(1).get()
  return decisionState102(row)
}
/** Internal page read on the caller's transaction. Return positions, including duplicates. */
export function currentDecisionStates102(db: DecisionDb, scopes: readonly Scope[]) {
  if (!scopes.length) return []
  const ids = [...new Set(scopes.map(scope => scope.enterpriseId))]
  const existing = new Set(db.select({ id: s.enterprise.id }).from(s.enterprise).where(inArray(s.enterprise.id, ids)).all().map(row => row.id))
  if (ids.some(id => !existing.has(id))) throw new DecisionError102(404, 'not_found', 'Enterprise not found')
  const unique = [...new Map(scopes.map(scope => [JSON.stringify([scope.enterpriseId, scope.titleCode, scope.direction]), scope])).values()]
  const t = s.differenceReason, newer = alias(t, 'decision_page_newer')
  // Filter heads in SQLite BEFORE any public body hydration. ID alone is not time.
  const rows = db.select({ id: t.id, enterpriseId: t.enterpriseId, titleCode: t.titleCode, direction: t.direction, status: t.status, lifecycleAction: t.lifecycleAction }).from(t)
    .where(and(or(...unique.map(whereScope)), notExists(db.select({ id: newer.id }).from(newer).where(and(
      eq(newer.enterpriseId, t.enterpriseId), eq(newer.titleCode, t.titleCode), eq(newer.direction, t.direction),
      or(gt(newer.recordedAt, t.recordedAt), and(eq(newer.recordedAt, t.recordedAt), gt(newer.id, t.id))),
    ))))).all()
  const heads = new Map(rows.map(row => [JSON.stringify([row.enterpriseId, row.titleCode, row.direction]), row]))
  return scopes.map(scope => {
    const row = heads.get(JSON.stringify([scope.enterpriseId, scope.titleCode, scope.direction]))
    return decisionState102(row ? { id: row.id, status: row.status, lifecycleAction: row.lifecycleAction } : undefined)
  })
}
/** Full public bodies only for active heads; withdrawal version IDs remain visible. */
export function currentDecisions102(db: DecisionDb, scopes: readonly Scope[]) {
  const states = currentDecisionStates102(db, scopes)
  const ids = [...new Set(states.flatMap(state => state.current ? [state.current.id] : []))]
  const rows = ids.length ? db.select(differencePublicColumns(db)).from(s.differenceReason).where(inArray(s.differenceReason.id, ids)).all() : []
  const bodies = new Map(rows.map(row => [row.id, row]))
  return states.map((state, index) => ({ ...scopes[index]!, versionId: state.versionId,
    current: state.current ? publicVersion102(bodies.get(state.current.id)!, state.current.id) : null }))
}

function prepareDecision102(db: DecisionDb, command: DecisionCommand102, capturePins = false) {
  const enterprise = requireEnterprise(db, command.enterpriseId)
  const previous = latestDecisionHead102(db, command)
  checkDecisionHead102(command, previous, command.reviewedEvidence && readEvidenceToken113(db, command))
  const d = decisionContent102(command)
  const facts = (d.factReferences ?? []).map(ref => {
    const fact = db.select().from(s.enterpriseFactRevision).where(and(eq(s.enterpriseFactRevision.enterpriseId, command.enterpriseId), eq(s.enterpriseFactRevision.factId, ref.factId))).orderBy(desc(s.enterpriseFactRevision.revision)).get()
    checkDecisionFact102(command.enterpriseId, ref, fact)
    return fact
  })
  const relation = d.evidenceRelationId ? readDifferenceObservation(db, d.evidenceRelationId) : null
  checkDecisionRelation102(enterprise, d, relation)
  const queryId = d.evidenceQueryId ?? relation?.queryId
  const targetQuery = queryId ? readDifferenceCollection(db, queryId) : null
  checkDecisionQuery102(command, enterprise, queryId, targetQuery, relation, () => readDifferenceCollectionScope(db, targetQuery!.collection.id).pages)
  checkDecisionPriorTime102(command, previous)
  const targetRelation = relation
  if (!capturePins) return { previous, d, targetQuery, targetRelation, pins: null }
  const observation = relation ? db.select().from(s.platformBusinessObservation).where(eq(s.platformBusinessObservation.id, relation.observationId)).get() : null
  const version = observation?.versionId ? db.select().from(s.platformBusinessRecordVersion).where(eq(s.platformBusinessRecordVersion.id, observation.versionId)).get() : null
  const assignment = observation ? db.select().from(s.platformObservationAssignment).where(eq(s.platformObservationAssignment.observationId, observation.id)).orderBy(desc(s.platformObservationAssignment.revision)).get() : null
  const sourceScope = targetQuery ? readDifferenceCollectionScope(db, targetQuery.collection.id) : null
  const sourceVersions = observation?.recordId ? db.select({ id: s.platformBusinessRecordVersion.id, contentHash: s.platformBusinessRecordVersion.contentHash }).from(s.platformBusinessRecordVersion).where(eq(s.platformBusinessRecordVersion.recordId, observation.recordId)).orderBy(desc(s.platformBusinessRecordVersion.id)).limit(1).all() : []
  const pins = { sourceVersions, enterprise, previous: previous ?? null, relation, observation, version, assignment, sourceScope, facts }
  return { previous, d, targetQuery, targetRelation, pins }
}
export function preflightQualification102(db: DecisionDb, input: unknown) {
  const command = parse102(qualificationPreflight102, input)
  return db.transaction(tx => {
    const prepared = prepareDecision102(tx, command, true)
    return { command, planHash: qualificationPlanHash(command, prepared.pins), planRuleVersion: qualificationPlanRule,
      qualification: command.decision!.currentQualification!, movedIn: command.decision!.movedIn ?? null,
      facts: prepared.pins!.facts, source: prepared.pins!.relation, latestKnownSourceVersion: prepared.pins!.sourceVersions[0] ?? null }
  })
}
export function commitQualification102(db: DecisionDb, input: unknown) {
  const envelope = parse102(qualificationCommit102, input)
  return saveDecision102(db, envelope.command, envelope.planHash)
}

export function saveDecision102(db: DecisionDb, command: DecisionCommand102, planHash?: string) {
  command = parse102(internalDecisionCommand102, command)
  const hash = decisionRequestHash102(command, planHash)
  return db.transaction(tx => {
    const review = tx.select().from(s.evidenceReviewReceipt114).where(eq(s.evidenceReviewReceipt114.idempotencyKey, command.idempotencyKey)).get()
    if (review) {
      if (review.requestHash !== hash) throw new DecisionError102(409, 'idempotency_conflict', 'Idempotency key already has a different request')
      return review.response
    }
    const prior = tx.select().from(s.differenceReason).where(eq(s.differenceReason.idempotencyKey, command.idempotencyKey)).get()
    if (prior) {
      if (prior.requestHash !== hash) throw new DecisionError102(409, 'idempotency_conflict', 'Idempotency key already has a different request')
      return decisionReceipt102(prior)
    }
    const prepared = prepareDecision102(tx, command, !!planHash)
    const { previous } = prepared
    if (planHash && qualificationPlanHash(command, prepared.pins) !== planHash) throw new DecisionError102(409, 'stale_plan', 'Qualification plan changed; preflight again')
    const finishReview = (result: ReturnType<typeof decisionReceipt102>, decisionId: number) => {
      if (!command.reviewedEvidence) return result
      const revisionId = command.reviewedEvidence.latestRevisionId
      // Establish the baseline for the resulting version; replacement never invents content.
      const impact = s.explanationImpact113
      tx.insert(impact).values({ enterpriseId: command.enterpriseId, titleCode: command.titleCode, direction: command.direction, decisionId, latestRevisionId: revisionId, pendingSinceRevisionId: revisionId, reviewedRevisionId: revisionId, classification: 'evidence_changed' })
        .onConflictDoUpdate({ target: [impact.enterpriseId, impact.titleCode, impact.direction, impact.decisionId], set: { reviewedRevisionId: revisionId } }).run()
      if (previous && previous.id !== decisionId) tx.update(impact).set({ reviewedRevisionId: revisionId }).where(and(eq(impact.decisionId, previous.id), eq(impact.enterpriseId, command.enterpriseId), eq(impact.titleCode, command.titleCode), eq(impact.direction, command.direction))).run()
      const response = { ...result, reviewedRevisionId: revisionId }
      tx.insert(s.evidenceReviewReceipt114).values({ idempotencyKey: command.idempotencyKey, requestHash: hash, kind: command.action, enterpriseId: command.enterpriseId, titleCode: command.titleCode, direction: command.direction, decisionId, sourceDecisionId: previous?.id ?? null, reviewedRevisionId: revisionId, actor: command.actor === null ? jsonNull : command.actor, basis: command.basis, ruleVersion: command.ruleVersion, effectiveAt: command.effectiveAt, response, recordedAt: new Date().toISOString() }).run()
      return response
    }
    if (command.action === 'maintain') {
      const row = latestDecision102(tx, command)!
      return finishReview({ ...decisionReceipt102(row), action: 'maintain', recordedAt: new Date().toISOString() }, row.id)
    }
    const { d, targetQuery, targetRelation } = prepared
    const values = decisionValues102(command, previous, d, hash)
    // External IDs have already been resolved and validated. Bind them exactly once
    // to the target slots; hashes and serialized receipts retain the original request.
    const row = tx.insert(targetDifferenceReason).values({ ...values, actor: values.actor ?? jsonNull, evidenceCollectionId: d.evidenceQueryId ? targetQuery!.collection.id : null, evidenceObservationId: targetRelation?.observationId ?? null }).returning({ id: targetDifferenceReason.id, lifecycleAction: targetDifferenceReason.lifecycleAction, previousId: targetDifferenceReason.previousId, recordedAt: targetDifferenceReason.recordedAt }).get()
    return finishReview(decisionReceipt102(row), row.id)
  }, { behavior: 'immediate' })
}
export function historyDecision102(db: DecisionDb, input: z.infer<typeof decisionHistory102>) {
  const scope = 'id' in input ? db.select({ enterpriseId: s.differenceReason.enterpriseId, titleCode: s.differenceReason.titleCode, direction: s.differenceReason.direction }).from(s.differenceReason).where(eq(s.differenceReason.id, input.id)).get() : input
  if (!scope) throw new DecisionError102(404, 'not_found', 'Decision version not found')
  requireEnterprise(db, scope.enterpriseId)
  const current = latestDecisionHead102(db, scope)
  const total = db.select({ n: sql<number>`count(*)` }).from(s.differenceReason).where(whereScope(scope)).get()!.n
  const rows = db.select({ id: s.differenceReason.id, enterpriseId: s.differenceReason.enterpriseId, titleCode: s.differenceReason.titleCode, direction: s.differenceReason.direction,
    status: s.differenceReason.status, reasonCode: s.differenceReason.reasonCode, measureCode: s.differenceReason.measureCode,
    verificationStatus: s.differenceReason.verificationStatus, recordedAt: s.differenceReason.recordedAt, lifecycleAction: s.differenceReason.lifecycleAction,
    previousId: s.differenceReason.previousId, actor: s.differenceReason.actor, ruleVersion: s.differenceReason.ruleVersion, effectiveAt: s.differenceReason.effectiveAt,
    ...differenceEvidenceColumns(db),
  }).from(s.differenceReason).where(whereScope(scope)).orderBy(desc(s.differenceReason.recordedAt), desc(s.differenceReason.id)).limit(input.pageSize).offset((input.page - 1) * input.pageSize).all()
  return { rows: rows.map(row => ({ ...row, origin: row.lifecycleAction ? 'lifecycle' : 'legacy_import', isCurrent: row.id === current?.id, detailsAvailable: true })), total, page: input.page, pageSize: input.pageSize }
}
