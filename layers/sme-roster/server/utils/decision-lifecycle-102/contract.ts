import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { platformCollection as PlatformCollectionTable } from '../../../../../db/postgresql/platform-tables'
import type { EnterpriseFactRevision } from '../enterprise-fact-model'
import type { differenceReason as DifferenceReasonTable } from '../../../../../db/postgresql/roster-selection-tables'
import { differenceStatuses, differenceReasons, differenceMeasures } from '../../../../../db/difference-codes'
import { normalizeUscc } from '../../../lib/domain'
import { RDJB_TITLE_CODES } from '../../../lib/platform/recognized-evidence'
import type { DifferenceObservation } from '../../../lib/platform/difference-sources'
import type { DifferenceCollectionScopeRows } from '../../../lib/platform/difference-collection-scope'
import type { readPostgresDecisionHead102 } from './postgres-reads'

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)

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
  status: z.enum(differenceStatuses),
  reasonCode: z.enum(differenceReasons).nullish(),
  reasonNote: note.nullish(),
  measureCode: z.enum(differenceMeasures),
  measureNote: note.nullish(),
  evidenceQueryId: positive.nullish(), evidenceRelationId: positive.nullish(),
  verificationStatus: z.enum(['confirmed', 'pending']),
  movedIn: z.strictObject({ city: note.nullish(), titleCode: title.nullish(), year: z.number().int().min(1900).max(2200).nullish(), batch: positive.nullish() }).optional(),
})

const actor102 = z.strictObject({ type: z.enum(['user', 'agent']), id: z.string().trim().min(1).max(200) })

const ruleVersion102 = z.string().trim().min(1).max(200)

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

export const decisionCommand102 = decisionScope102.extend({
  action: z.enum(['replace', 'withdraw', 'maintain']),
  actor: actor102, ruleVersion: ruleVersion102,
  ...decisionCommandFields(),
}).superRefine(refineDecisionCommand)

export const browserDecisionCommand102 = decisionScope102.extend({
  action: z.literal('replace'),
  ...decisionCommandFields(),
}).omit({ reviewedEvidence: true }).superRefine(refineDecisionCommand)

export const internalDecisionCommand102 = decisionScope102.extend({
  action: z.enum(['replace', 'withdraw', 'maintain']),
  actor: actor102.nullable(), ruleVersion: ruleVersion102.nullable(),
  ...decisionCommandFields(),
}).superRefine(refineDecisionCommand)

export type Scope = Omit<z.infer<typeof decisionScope102>, 'titleCode'> & { titleCode: string }

export type DecisionCommand102 = z.infer<typeof internalDecisionCommand102>

export class DecisionError102 extends Error {
  constructor(public statusCode: number, public code: string, message: string) { super(message) }
}

export function parse102<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new DecisionError102(400, 'invalid_request', 'Invalid decision request; see decision-lifecycle contract')
  return result.data
}

export function publicVersion102(row: Omit<typeof DifferenceReasonTable.$inferSelect, 'actor' | 'currentQualification' | 'factReferences' | 'retiredEvidenceValidity' | 'retiredEvidenceReviewed'> & {
  evidenceQueryId: number | null
  evidenceRelationId: number | null
  actor: DecisionCommand102['actor']
  currentQualification: z.infer<typeof currentQualification102> | null
  factReferences: NonNullable<DecisionCommand102['decision']>['factReferences'] | null
}, currentId: number | null) {
  const { requestHash, idempotencyKey, ...version } = row
  return { ...version, origin: row.lifecycleAction ? 'lifecycle' : 'legacy_import', isCurrent: row.id === currentId }
}

export function decisionReceipt102(row: Pick<typeof DifferenceReasonTable.$inferSelect, 'id' | 'lifecycleAction' | 'previousId' | 'recordedAt'>) {
  return { versionId: row.id, currentId: row.lifecycleAction === 'withdraw' ? null : row.id, previousId: row.previousId, action: row.lifecycleAction as string | null, recordedAt: row.recordedAt }
}

export function checkDecisionHead102(command: DecisionCommand102, previous: Awaited<ReturnType<typeof readPostgresDecisionHead102>>, token?: { latestRevisionId: number; projectionReady: boolean }) {
  if ((previous?.id ?? null) !== command.expectedCurrentId) throw new DecisionError102(409, 'stale_version', 'Expected current version no longer matches')
  if (command.reviewedEvidence) {
    if (!token?.projectionReady || token.latestRevisionId !== command.reviewedEvidence.latestRevisionId) throw new DecisionError102(409, 'stale_evidence', 'Relevant committed evidence changed or its projection is unfinished')
    if (!previous || previous.lifecycleAction === 'withdraw') throw new DecisionError102(409, 'no_current_decision', 'Review requires an active current decision')
  }
}

export const decisionContent102 = (command: DecisionCommand102) => command.decision ??
  { status: 'not_queried' as const, measureCode: 'none' as const, verificationStatus: 'pending' as const }

export function checkDecisionFact102(enterpriseId: number, ref: NonNullable<NonNullable<DecisionCommand102['decision']>['factReferences']>[number],
  fact: EnterpriseFactRevision | undefined) {
  if (ref.enterpriseId !== enterpriseId || !fact || fact.revision !== ref.revision || fact.status !== 'confirmed' || fact.fact.kind !== ref.kind) {
    throw new DecisionError102(422, 'fact_reference_mismatch', 'Fact reference must pin a current confirmed fact owned by this enterprise')
  }
}

export function checkDecisionRelation102(enterprise: { id: number; usccNorm: string | null; nameNorm: string }, d: ReturnType<typeof decisionContent102>, relation: DifferenceObservation | null | undefined) {
  if (d.currentQualification && (!relation || relation.verificationStatus !== 'confirmed')) throw new DecisionError102(422, 'qualification_evidence_unconfirmed', 'Current qualification requires an explicitly confirmed source row')
  if (d.evidenceRelationId && !relation) throw new DecisionError102(422, 'evidence_not_found', 'Relation evidence not found')
  const enterpriseUscc=normalizeUscc(enterprise.usccNorm), relationUscc=normalizeUscc(relation?.uscc)
  const ownerMismatch=relation && (relation.enterpriseId != null ? relation.enterpriseId !== enterprise.id : !enterpriseUscc || relationUscc !== enterpriseUscc)
  const explicitConflict=relationUscc && enterpriseUscc && relationUscc !== enterpriseUscc
  if (ownerMismatch || explicitConflict) throw new DecisionError102(422, 'evidence_mismatch', 'Relation evidence belongs to another or conflicting enterprise')
  if (relation && d.evidenceQueryId && relation.queryId !== d.evidenceQueryId) throw new DecisionError102(422, 'evidence_mismatch', 'Query and relation evidence must identify the same query')
}

export function checkDecisionQuery102(command: DecisionCommand102, enterprise: { id: number; usccNorm: string | null; nameNorm: string }, queryId: number | null | undefined,
  targetQuery: { collection: Pick<typeof PlatformCollectionTable.$inferSelect, 'rdjb' | 'queryKey'> } | null | undefined, relation: DifferenceObservation | null | undefined,
  collectionPages: () => DifferenceCollectionScopeRows['pages']) {
  if (queryId) {
    const query = targetQuery?.collection
    if (!query) throw new DecisionError102(422, 'evidence_not_found', 'Query evidence not found')
    const titles = query.rdjb.split(',')
    if (!titles.some(rdjb => RDJB_TITLE_CODES[rdjb] === command.titleCode)) throw new DecisionError102(422, 'evidence_mismatch', 'Evidence title scope does not include decision title')
    if (!relation && query.queryKey !== enterprise.usccNorm && query.queryKey !== `name:${enterprise.nameNorm}`) throw new DecisionError102(422, 'evidence_mismatch', 'Query-only evidence must identify the exact enterprise')
    if (relation && titles.length > 1) {
      const pages = collectionPages()
      let offset = 0; let rowTitle: string | undefined
      for (const page of pages) { if (page.status !== 'success') continue; offset += page.fetchedCount ?? 0; if (relation.sequenceNo <= offset) { rowTitle = page.rdjb ? RDJB_TITLE_CODES[page.rdjb] : undefined; break } }
      if (rowTitle !== command.titleCode) throw new DecisionError102(422, 'evidence_mismatch', 'Original row title is unknown or different')
    }
  }
}

export function checkDecisionPriorTime102(command: DecisionCommand102, previous: Awaited<ReturnType<typeof readPostgresDecisionHead102>>) {
  if (command.action !== 'maintain' && previous && !Number.isFinite(Date.parse(previous.recordedAt.slice(0, 19) + 'Z'))) throw new DecisionError102(422, 'invalid_prior_time', 'Historical registration time must be reviewed before replacement')
}

export const qualificationPlanRule = 'qualification-preflight-1'

export const qualificationPreflight102 = decisionCommand102.refine(c => c.action === 'replace' && !!c.decision?.currentQualification, 'Requires qualification replacement')

export const qualificationCommit102 = z.strictObject({ command: qualificationPreflight102, planHash: z.string().regex(/^[a-f0-9]{64}$/) })

export function qualificationPlanHash(command: DecisionCommand102, pins: unknown) {
  return createHash('sha256').update(JSON.stringify({ rule: qualificationPlanRule, command, pins })).digest('hex')
}

export function decisionRequestHash102(command: DecisionCommand102, planHash?: string) {
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
  return createHash('sha256').update(JSON.stringify(planHash ? { command: normalized, planHash } : normalized)).digest('hex')
}

export function decisionValues102(command: DecisionCommand102, previous: Awaited<ReturnType<typeof readPostgresDecisionHead102>>,
  d: ReturnType<typeof decisionContent102>, hash: string) {
  if (command.action === 'maintain' || (command.action === 'replace') !== !!command.decision) throw new DecisionError102(400, 'invalid_request', 'Replacement requires decision; withdrawal must omit decision')
  if (command.action === 'withdraw' && (!previous || previous.lifecycleAction === 'withdraw')) throw new DecisionError102(409, 'no_current_decision', 'No active decision to withdraw')
  const previousWall = previous ? Date.parse(previous.recordedAt.slice(0, 19) + 'Z') : 0
  // Older imports may omit milliseconds or carry offsets. Move beyond their
  // wall-clock second as well as actual instant so all existing lexical readers agree.
  const recordedAt = new Date(Math.max(Date.now(), previousWall + 1000, previous ? Date.parse(previous.recordedAt) + 1000 : 0)).toISOString()
  return {
    enterpriseId: command.enterpriseId, titleCode: command.titleCode, direction: command.direction,
    status: d.status, reasonCode: d.reasonCode ?? null, reasonNote: d.reasonNote ?? null,
    measureCode: d.measureCode, measureNote: d.measureNote ?? null,
    verificationStatus: d.verificationStatus, movedInCity: d.movedIn?.city ?? null, movedInTitleCode: d.movedIn?.titleCode ?? null,
    movedInYear: d.movedIn?.year ?? null, movedInBatch: d.movedIn?.batch ?? null, factReferences: d.factReferences ?? [], currentQualification: d.currentQualification ?? null,
    lifecycleAction: command.action, previousId: previous?.id ?? null, actor: command.actor, basis: command.basis,
    ruleVersion: command.ruleVersion, effectiveAt: command.effectiveAt, idempotencyKey: command.idempotencyKey, requestHash: hash, recordedAt,
  }
}

export const decisionHistory102 = z.union([
  decisionScope102.extend({ page: positive.max(1000000).default(1), pageSize: positive.max(50).default(50) }),
  z.strictObject({ id: positive, page: positive.max(1000000).default(1), pageSize: positive.max(50).default(50) }),
])
