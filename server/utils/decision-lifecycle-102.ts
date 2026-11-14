import { and,desc,eq,sql,type AnyColumn,type SQL } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import * as s from '../../db/schema'
import { normalizeUscc } from '../../lib/domain'
import { differenceEvidenceColumns,differencePublicColumns,targetDifferenceReason } from '../../lib/platform/difference-reference-target'
import { readDifferenceCollection,readDifferenceCollectionScope,readDifferenceObservation } from '../../lib/platform/difference-sources'
import { RDJB_TITLE_CODES } from '../../lib/platform/recognized-evidence'
import { readLatestDecisionHead102 as latestDecisionHead102,whereDecisionScope102 as whereScope } from './decision-lifecycle-102/head'
import { readEvidenceToken113 } from './evidence-impact-113'
export { readLatestDecisionHead102 as latestDecisionHead102 } from './decision-lifecycle-102/head'

export type DecisionDb = BetterSQLite3Database<typeof s>
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
/**
 * Drizzle deliberately passes JS `null` through as SQL NULL instead of json.dumps-ing it,
 * so a typed `null` cannot satisfy the receipt's existing NOT NULL actor column. This
 * expression writes the JSON text `null` (the honest "not recorded" value) without a
 * migration and without inventing a placeholder actor. Reading it back yields JS null.
 */
const jsonNull = sql`'null'`
const note = z.string().trim().min(1).max(4000)
const title = z.enum(['little_giant', 'specialized_sme', 'innovative_sme'])
const direction = z.enum(['missing_in_miit', 'extra_in_miit'])
export const decisionScope102 = z.strictObject({ enterpriseId: positive, titleCode: title, direction })
export const currentQualification102 = z.strictObject({
  titleCode: title,
  validFrom: z.string().datetime({ offset: true }),
  validUntil: z.string().datetime({ offset: true }),
  // Explicit new award, never inferred from an interval/renewal or free text.
  awardYear: z.number().int().min(1900).max(2200).optional(),
  basis: note,
  publicationCheck: z.strictObject({ status: z.enum(['not_found', 'not_checked']), scope: note }),
}).refine(q => Date.parse(q.validFrom) < Date.parse(q.validUntil), 'Qualification interval must be nonempty')
  .refine(q => q.awardYear == null || q.awardYear <= new Date(q.validFrom).getUTCFullYear(), 'Award must precede or start the qualification interval')
const content = z.strictObject({
  factReferences: z.array(z.strictObject({ enterpriseId: positive, factId: positive, revision: positive, kind: z.enum(['moved_in', 'moved_out', 'cancelled', 'registration_status']) })).max(100).optional(),
  currentQualification: currentQualification102.optional(),
  status: z.enum(s.differenceReason.status.enumValues!),
  reasonCode: z.enum(s.differenceReason.reasonCode.enumValues!).nullish(),
  reasonNote: note.nullish(),
  measureCode: z.enum(s.differenceReason.measureCode.enumValues!),
  measureNote: note.nullish(),
  evidenceQueryId: positive.nullish(), evidenceRelationId: positive.nullish(),
  verificationStatus: z.enum(['confirmed', 'pending']),
  movedIn: z.strictObject({ city: note.nullish(), titleCode: title.nullish(), year: z.number().int().min(1900).max(2200).nullish(), batch: positive.nullish() }).optional(),
})
const actor102 = z.strictObject({ type: z.enum(['user', 'agent']), id: z.string().trim().min(1).max(200) })
const ruleVersion102 = z.string().trim().min(1).max(200)
/** Business fields shared by every write transport; identity metadata stays transport-specific. */
function decisionCommandFields() {
  return {
    expectedCurrentId: positive.nullable(),
    idempotencyKey: z.string().trim().min(1).max(200),
    basis: note,
    effectiveAt: z.string().datetime({ offset: true }), decision: content.optional(),
    reviewedEvidence: z.strictObject({ latestRevisionId: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), projectionReady: z.literal(true) }).optional(),
  }
}
type ReviewedEvidence102 = { latestRevisionId: number; projectionReady: true }
function refineDecisionCommand(c: { titleCode: string; action: 'replace' | 'withdraw' | 'maintain'; decision?: z.infer<typeof content>; reviewedEvidence?: ReviewedEvidence102 }, ctx: z.RefinementCtx) {
  const d = c.decision
  const invalid = (message: string) => ctx.addIssue({ code: 'custom', message })
  if ((c.action === 'replace') !== !!d) invalid('Replace requires decision; withdraw/maintain must omit it')
  if (c.action === 'maintain' && !c.reviewedEvidence || c.action === 'withdraw' && c.reviewedEvidence) invalid('Maintain requires reviewed evidence; withdraw must omit it')
  if (!d) return
  if (d.currentQualification && (d.reasonCode !== 'moved_in' || d.status !== 'confirmed_reason' || d.verificationStatus !== 'confirmed' || d.currentQualification.titleCode !== c.titleCode || d.movedIn?.titleCode && d.movedIn.titleCode !== c.titleCode || !d.evidenceRelationId)) invalid('Current qualification requires confirmed same-title moved_in with explicit source evidence')
  if (d.status === 'confirmed_no_diff' && (d.reasonCode != null || d.measureCode !== 'none' || d.verificationStatus !== 'confirmed')) invalid('confirmed_no_diff requires no reason, none measure, confirmed verification')
  if (d.status === 'confirmed_reason' && (!d.reasonCode || d.verificationStatus !== 'confirmed')) invalid('confirmed_reason requires reason and confirmed verification')
  if (d.reasonCode === 'pending_review' && (d.status !== 'confirmed_reason' || d.verificationStatus !== 'confirmed' || d.measureCode !== 'follow_review')) invalid('pending_review requires confirmed_reason, confirmed, follow_review')
}
/**
 * External HTTP/MCP command: actor and ruleVersion remain required.
 * The browser capability has its own schema that rejects those keys outright.
 */
export const decisionCommand102 = decisionScope102.extend({
  action: z.enum(['replace', 'withdraw', 'maintain']),
  actor: actor102, ruleVersion: ruleVersion102,
  ...decisionCommandFields(),
}).superRefine(refineDecisionCommand)
/** Browser reviews carry business facts only; a supplied actor/ruleVersion is a strict-schema 400. */
export const browserDecisionCommand102 = decisionScope102.extend({
  action: z.enum(['replace', 'maintain']),
  ...decisionCommandFields(),
}).superRefine(refineDecisionCommand)
/**
 * Trusted internal envelope: the browser route fills actor/ruleVersion with real null.
 * Keeping it separate from the public schemas is what stops a client from omitting metadata
 * to bypass the identity requirement on HTTP/MCP.
 */
const internalDecisionCommand102 = decisionScope102.extend({
  action: z.enum(['replace', 'withdraw', 'maintain']),
  actor: actor102.nullable(), ruleVersion: ruleVersion102.nullable(),
  ...decisionCommandFields(),
}).superRefine(refineDecisionCommand)
type Scope = Omit<z.infer<typeof decisionScope102>, 'titleCode'> & { titleCode: string }
export type DecisionCommand102 = z.infer<typeof internalDecisionCommand102>
export class DecisionError102 extends Error {
  constructor(public statusCode: number, public code: string, message: string) { super(message) }
}
export function parse102<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new DecisionError102(400, 'invalid_request', 'Invalid decision request; see decision-lifecycle contract')
  return result.data
}
/** Explicit review of a legacy version adopts its existing scope without rewriting that version. */
export function managedDecision102(id: AnyColumn | SQL = s.differenceReason.id, action: AnyColumn | SQL = s.differenceReason.lifecycleAction) {
  return sql`(${action} is not null or exists(select 1 from evidence_review_receipt_114 r where (r.decision_id=${id} or r.source_decision_id=${id}) and r.reviewed_revision_id is not null))`
}
export function latestDecision102(db: DecisionDb, scope: Scope) {
  return db.select().from(s.differenceReason).where(whereScope(scope)).orderBy(desc(s.differenceReason.recordedAt), desc(s.differenceReason.id)).limit(1).get()
}
function publicVersion(row: Omit<typeof s.differenceReason.$inferSelect, 'evidenceCollectionId' | 'evidenceObservationId'> & { evidenceQueryId: number | null; evidenceRelationId: number | null }, currentId: number | null) {
  const { requestHash, idempotencyKey, ...version } = row
  return { ...version, origin: row.lifecycleAction ? 'lifecycle' : 'legacy_import', isCurrent: row.id === currentId }
}
function receipt(row: Pick<typeof s.differenceReason.$inferSelect, 'id' | 'lifecycleAction' | 'previousId' | 'recordedAt'>) {
  return { versionId: row.id, currentId: row.lifecycleAction === 'withdraw' ? null : row.id, previousId: row.previousId, action: row.lifecycleAction as string | null, recordedAt: row.recordedAt }
}
function requireEnterprise(db: DecisionDb, enterpriseId: number) {
  const enterprise = db.select({ id: s.enterprise.id, usccNorm: s.enterprise.usccNorm, nameNorm: s.enterprise.nameNorm }).from(s.enterprise).where(eq(s.enterprise.id, enterpriseId)).get()
  if (!enterprise) throw new DecisionError102(404, 'not_found', 'Enterprise not found')
  return enterprise
}
export function readDecision102(db: DecisionDb, id: number) {
  const row = db.select(differencePublicColumns(db)).from(s.differenceReason).where(eq(s.differenceReason.id, id)).get()
  if (!row) throw new DecisionError102(404, 'not_found', 'Decision version not found')
  return publicVersion(row, latestDecisionHead102(db, row)?.id ?? null)
}
export function currentDecision102(db: DecisionDb, scope: Scope) {
  requireEnterprise(db, scope.enterpriseId)
  const state = decisionState102(db.select(differencePublicColumns(db)).from(s.differenceReason).where(whereScope(scope)).orderBy(desc(s.differenceReason.recordedAt), desc(s.differenceReason.id)).limit(1).get())
  return { ...scope, versionId: state.versionId, current: state.current ? publicVersion(state.current, state.current.id) : null }
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
export function saveDecision102(db: DecisionDb, command: DecisionCommand102) {
  command = parse102(internalDecisionCommand102, command)
  // External receipts predate the browser envelope. Preserve their normalized key
  // order even when shared schema fields move; nested fields are ordered by content.
  // Nullable internal metadata keeps its existing envelope and stored hashes;
  // public HTTP/MCP schemas require both metadata fields to be non-null.
  const normalized = command.actor !== null && command.ruleVersion !== null ? {
    enterpriseId: command.enterpriseId, titleCode: command.titleCode, direction: command.direction,
    action: command.action, expectedCurrentId: command.expectedCurrentId,
    idempotencyKey: command.idempotencyKey, actor: command.actor,
    basis: command.basis, ruleVersion: command.ruleVersion, effectiveAt: command.effectiveAt,
    decision: command.decision, reviewedEvidence: command.reviewedEvidence,
  } : command
  const hash = createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
  return db.transaction(tx => {
    const review = tx.select().from(s.evidenceReviewReceipt114).where(eq(s.evidenceReviewReceipt114.idempotencyKey, command.idempotencyKey)).get()
    if (review) {
      if (review.requestHash !== hash) throw new DecisionError102(409, 'idempotency_conflict', 'Idempotency key already has a different request')
      return review.response
    }
    const prior = tx.select().from(s.differenceReason).where(eq(s.differenceReason.idempotencyKey, command.idempotencyKey)).get()
    if (prior) {
      if (prior.requestHash !== hash) throw new DecisionError102(409, 'idempotency_conflict', 'Idempotency key already has a different request')
      return receipt(prior)
    }
    const enterprise = requireEnterprise(tx, command.enterpriseId)
    const previous = latestDecisionHead102(tx, command)
    if ((previous?.id ?? null) !== command.expectedCurrentId) throw new DecisionError102(409, 'stale_version', 'Expected current version no longer matches')
    if (command.reviewedEvidence) {
      const token = readEvidenceToken113(tx, command)
      if (!token.projectionReady || token.latestRevisionId !== command.reviewedEvidence.latestRevisionId) throw new DecisionError102(409, 'stale_evidence', 'Relevant committed evidence changed or its projection is unfinished')
      if (!previous || previous.lifecycleAction === 'withdraw') throw new DecisionError102(409, 'no_current_decision', 'Review requires an active current decision')
    }
    const finishReview = (result: ReturnType<typeof receipt>, decisionId: number) => {
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
      return finishReview({ ...receipt(row), action: 'maintain', recordedAt: new Date().toISOString() }, row.id)
    }
    if ((command.action === 'replace') !== !!command.decision) throw new DecisionError102(400, 'invalid_request', 'Replacement requires decision; withdrawal must omit decision')
    if (command.action === 'withdraw' && (!previous || previous.lifecycleAction === 'withdraw')) throw new DecisionError102(409, 'no_current_decision', 'No active decision to withdraw')
    const d = command.decision ?? { status: 'not_queried' as const, measureCode: 'none' as const, verificationStatus: 'pending' as const }
    for (const ref of d.factReferences ?? []) {
      const fact = tx.select().from(s.enterpriseFactRevision).where(and(eq(s.enterpriseFactRevision.enterpriseId, command.enterpriseId), eq(s.enterpriseFactRevision.factId, ref.factId))).orderBy(desc(s.enterpriseFactRevision.revision)).get()
      if (ref.enterpriseId !== command.enterpriseId || !fact || fact.revision !== ref.revision || fact.status !== 'confirmed' || fact.fact.kind !== ref.kind) throw new DecisionError102(422, 'fact_reference_mismatch', 'Fact reference must pin a current confirmed fact owned by this enterprise')
    }
    // Validate source identity/title with narrow projections; original bodies remain untouched.
    const targetRelation = d.evidenceRelationId ? readDifferenceObservation(tx, d.evidenceRelationId) : null
    const relation = targetRelation
    if (d.currentQualification && (!relation || relation.verificationStatus !== 'confirmed')) throw new DecisionError102(422, 'qualification_evidence_unconfirmed', 'Current qualification requires an explicitly confirmed source row')
    if (d.evidenceRelationId && !relation) throw new DecisionError102(422, 'evidence_not_found', 'Relation evidence not found')
    const enterpriseUscc=normalizeUscc(enterprise.usccNorm), relationUscc=normalizeUscc(relation?.uscc)
    const ownerMismatch=relation && (relation.enterpriseId != null ? relation.enterpriseId !== enterprise.id : !enterpriseUscc || relationUscc !== enterpriseUscc)
    const explicitConflict=relationUscc && enterpriseUscc && relationUscc !== enterpriseUscc
    if (ownerMismatch || explicitConflict) throw new DecisionError102(422, 'evidence_mismatch', 'Relation evidence belongs to another or conflicting enterprise')
    if (relation && d.evidenceQueryId && relation.queryId !== d.evidenceQueryId) throw new DecisionError102(422, 'evidence_mismatch', 'Query and relation evidence must identify the same query')
    const queryId = d.evidenceQueryId ?? relation?.queryId
    const targetQuery = queryId ? readDifferenceCollection(tx, queryId) : null
    if (queryId) {
      const query = targetQuery?.collection
      if (!query) throw new DecisionError102(422, 'evidence_not_found', 'Query evidence not found')
      const titles = query.rdjb.split(',')
      if (!titles.some(rdjb => RDJB_TITLE_CODES[rdjb] === command.titleCode)) throw new DecisionError102(422, 'evidence_mismatch', 'Evidence title scope does not include decision title')
      if (!relation && query.queryKey !== enterprise.usccNorm && query.queryKey !== `name:${enterprise.nameNorm}`) throw new DecisionError102(422, 'evidence_mismatch', 'Query-only evidence must identify the exact enterprise')
      if (relation && titles.length > 1) {
        // Only page metadata is needed to locate a multi-title original row.

        const pages = readDifferenceCollectionScope(tx, targetQuery!.collection.id).pages
        let offset = 0; let rowTitle: string | undefined
        for (const page of pages) { if (page.status !== 'success') continue; offset += page.fetchedCount ?? 0; if (relation.sequenceNo <= offset) { rowTitle = page.rdjb ? RDJB_TITLE_CODES[page.rdjb] : undefined; break } }
        if (rowTitle !== command.titleCode) throw new DecisionError102(422, 'evidence_mismatch', 'Original row title is unknown or different')
      }
    }
    const previousWall = previous ? Date.parse(previous.recordedAt.slice(0, 19) + 'Z') : 0
    if (previous && !Number.isFinite(previousWall)) throw new DecisionError102(422, 'invalid_prior_time', 'Historical registration time must be reviewed before replacement')
    // Older imports may omit milliseconds or carry offsets. Move beyond their
    // wall-clock second as well as actual instant so all existing lexical readers agree.
    const recordedAt = new Date(Math.max(Date.now(), previousWall + 1000, previous ? Date.parse(previous.recordedAt) + 1000 : 0)).toISOString()
    const values = {
      enterpriseId: command.enterpriseId, titleCode: command.titleCode, direction: command.direction,
      status: d.status, reasonCode: d.reasonCode ?? null, reasonNote: d.reasonNote ?? null,
      measureCode: d.measureCode, measureNote: d.measureNote ?? null,
      verificationStatus: d.verificationStatus, movedInCity: d.movedIn?.city ?? null, movedInTitleCode: d.movedIn?.titleCode ?? null,
      movedInYear: d.movedIn?.year ?? null, movedInBatch: d.movedIn?.batch ?? null, factReferences: d.factReferences ?? [], currentQualification: d.currentQualification ?? null,
      lifecycleAction: command.action, previousId: previous?.id ?? null, actor: command.actor === null ? jsonNull : command.actor, basis: command.basis,
      ruleVersion: command.ruleVersion, effectiveAt: command.effectiveAt, idempotencyKey: command.idempotencyKey, requestHash: hash, recordedAt,
    }
    // External IDs have already been resolved and validated. Bind them exactly once
    // to the target slots; hashes and serialized receipts retain the original request.
    const row = tx.insert(targetDifferenceReason).values({ ...values, evidenceCollectionId: d.evidenceQueryId ? targetQuery!.collection.id : null, evidenceObservationId: targetRelation?.observationId ?? null }).returning({ id: targetDifferenceReason.id, lifecycleAction: targetDifferenceReason.lifecycleAction, previousId: targetDifferenceReason.previousId, recordedAt: targetDifferenceReason.recordedAt }).get()
    return finishReview(receipt(row), row.id)
  }, { behavior: 'immediate' })
}

export const decisionHistory102 = z.union([
  decisionScope102.extend({ page: positive.max(1000000).default(1), pageSize: positive.max(50).default(50) }),
  z.strictObject({ id: positive, page: positive.max(1000000).default(1), pageSize: positive.max(50).default(50) }),
])
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
