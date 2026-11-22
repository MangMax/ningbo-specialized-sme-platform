import { formalValiditySchema } from '../../lib/roster/formal-validity'
import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { importBatch as ImportBatchTable } from '../../../../db/postgresql/import-tables'
import type { recordEvidence as RecordEvidenceTable } from '../../../../db/postgresql/ledger-tables'
import type { recordCorrespondence as RecordCorrespondenceTable } from '../../../../db/postgresql/qualification-tables'
import { computeTitleLifecycle } from '../../lib/roster/lifecycle'
import { CURRENT_TITLES, diagnoseOfficialEventFields } from '../../lib/roster/current-qualification-model'
import type { readPostgresLegacyQualification } from '../../lib/roster/current-qualification-postgres'
import type { OfficialEventRow as StoredEvent, RosterRecordRow as StoredRecord } from './roster-event-version-model'
import type { storedFile } from '../../../../db/postgresql/file-tables'
import type { RosterImportBeforeQualificationReadback, RosterImportAfterQualificationReadback } from '../../lib/roster-import-client'

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1)

const year = z.number().int().min(1900).max(9999).nullable()

export const eventCorrectionOperationSchema = z.strictObject({
  eventId: positive, recordId: positive, enterpriseId: positive, expectedRevision: positive,
  patch: z.strictObject({ formalValidity: formalValiditySchema.nullable().optional(), eventType: z.enum(['award', 'review', 'nurture']).optional(), year: year.optional(), decidedYear: year.optional(), batchSeq: positive.nullable().optional(), reviewOutcome: z.enum(['passed', 'failed']).nullable().optional() }).refine(patch => Object.keys(patch).length > 0, 'Patch must contain an event field'),
})

export const eventCorrectionRequestSchema = z.strictObject({
  idempotencyKey: z.string().trim().min(1).max(200), sourceIdentity: z.string().trim().min(1).max(1000),
  actor: z.strictObject({ type: z.enum(['user', 'agent']), id: z.string().trim().min(1).max(200) }),
  basis: z.string().trim().min(1).max(4000), operations: z.array(eventCorrectionOperationSchema).min(1).max(300),
})

export type EventCorrectionRequest = z.infer<typeof eventCorrectionRequestSchema>

export const eventCorrectionHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function eventCorrectionFailure(statusCode: number, code: string, message: string): never { throw Object.assign(new Error(message), { statusCode, code }) }

type CorrectionSnapshot = {
  event: StoredEvent
  record: StoredRecord
  evidence: Array<typeof RecordEvidenceTable.$inferSelect>
  files: (Pick<typeof storedFile.$inferSelect, 'id' | 'relPath' | 'sha256' | 'removedAt'> & { bytes: number })[]
}

type CorrectionRelation = Pick<typeof RecordCorrespondenceTable.$inferSelect, 'id' | 'revision' | 'status'>

export type EventCorrectionInputs = {
  snapshot(id: number): CorrectionSnapshot
  correspondence(id: number): CorrectionRelation[]
  titleEvents(record: StoredRecord): StoredEvent[]
  siblings(recordId: number): StoredEvent[]
  origin(id: number): StoredEvent | null
}

export function validateEventCorrectionTargets(request: EventCorrectionRequest) {
  const ids = request.operations.map(op => op.eventId)
  if (new Set(ids).size !== ids.length) eventCorrectionFailure(422, 'duplicate_target', 'Each event may be corrected only once per batch')
}

export function projectEventCorrectionPlan(request: EventCorrectionRequest, inputs: EventCorrectionInputs) {
  validateEventCorrectionTargets(request)
  const titleEvents = new Map<string, StoredEvent[]>()
  const siblingsByRecord = new Map<number, StoredEvent[]>()
  const targets = request.operations.map(op => {
    const source = inputs.snapshot(op.eventId), before = source.event
    if (source.record.id !== op.recordId || source.record.enterpriseId !== op.enterpriseId) eventCorrectionFailure(409, 'target_mismatch', 'Event record/enterprise ownership changed')
    if (before.revision !== op.expectedRevision) eventCorrectionFailure(409, 'stale_revision', 'Official event revision changed')
    if (!source.evidence.length) eventCorrectionFailure(422, 'basis_required', 'Official source evidence is required for correction')
    const after = { ...before, ...op.patch, sortKey: op.patch.year === undefined ? before.sortKey : op.patch.year ?? 0, revision: before.revision + 1 }
    if (after.eventType === 'maintain' || after.eventType !== 'review' && after.reviewOutcome != null || after.year != null && after.decidedYear != null && after.decidedYear < after.year) eventCorrectionFailure(422, 'invalid_event_combination', 'Only official award/review/nurture; reviewOutcome is review-only and decidedYear cannot precede year')
    if (after.formalValidity) {
      const fact = after.formalValidity
      const evidence = source.evidence.find(row => row.id === fact.evidenceId)
      const file = source.files.find(row => row.relPath === evidence?.sourceFile && row.sha256 === fact.sourceSha256 && row.removedAt == null)
      if (!evidence || !file) eventCorrectionFailure(422, 'invalid_validity_source', 'Formal validity must reference current event evidence and stored file SHA256')
      if (after.eventType !== 'award' && after.eventType !== 'review') eventCorrectionFailure(422, 'invalid_event_combination', 'Formal validity requires award or review')
    }
    if (Object.entries(op.patch).every(([key, value]) => isDeepStrictEqual(before[key as keyof typeof before], value))) eventCorrectionFailure(422, 'no_change', 'Correction must change an event field')
    const correspondences = inputs.correspondence(op.eventId)
    if (correspondences.length > 300) eventCorrectionFailure(413, 'source_limit', 'Event correspondence impact exceeds 300 rows')
    const titleKey = `${source.record.enterpriseId}:${source.record.titleCode}`
    if (!titleEvents.has(titleKey)) titleEvents.set(titleKey, inputs.titleEvents(source.record))
    return { titleCode: source.record.titleCode, eventId: op.eventId, recordId: op.recordId, enterpriseId: op.enterpriseId, before, after, evidence: source.evidence, files: source.files, correspondences: correspondences.sort((a, b) => a.id - b.id), lifecycleBefore: computeTitleLifecycle(titleEvents.get(titleKey)!) }
  })
  const finalEvents = new Map(targets.map(target => [target.eventId, target.after]))
  const validityOrigins: Array<{ eventId: number; origin: StoredEvent | null }> = []
  for (const target of targets) {
    // Input-key scoped candidates only; no all-events/raw query materialization.
    if (!siblingsByRecord.has(target.recordId)) siblingsByRecord.set(target.recordId, inputs.siblings(target.recordId))
    const siblings = siblingsByRecord.get(target.recordId)!
    for (const stored of siblings) {
      const event = finalEvents.get(stored.id) ?? stored
      const originId = event.formalValidity?.originAwardEventId
      if (originId === undefined || !finalEvents.has(event.id) && !finalEvents.has(originId)) continue
      const originBefore = inputs.origin(originId)
      const origin = finalEvents.get(originId) ?? originBefore
      if (!origin || origin.recordId !== event.recordId || origin.eventType !== 'award' || origin.year == null || origin.year !== event.year || event.batchSeq != null && origin.batchSeq != null && origin.batchSeq !== event.batchSeq) eventCorrectionFailure(422, 'invalid_validity_origin', 'Origin must be the same record award and original year with no known batch conflict')
      if (!validityOrigins.some(link => link.eventId === event.id)) validityOrigins.push({ eventId: event.id, origin: originBefore })
    }
    const desired = target.after
    const conflict = siblings.some(stored => {
      if (stored.id === desired.id) return false
      const other = targets.find(t => t.eventId === stored.id)?.after ?? stored
      if (other.eventType !== desired.eventType || other.year !== desired.year || other.batchSeq !== desired.batchSeq) return false
      // Only fully identified review rounds may share the original award batch.
      // Outcome never distinguishes a matter; unknown coordinates retain the conflict guard.
      return desired.eventType !== 'review' || desired.year == null || desired.batchSeq == null
        || desired.decidedYear == null || other.decidedYear == null || other.decidedYear === desired.decidedYear
    })
    if (conflict) eventCorrectionFailure(409, 'natural_key_conflict', 'Another event occupies the official event scope; distinct review rounds require known origin, batch and decision years; events are never merged by correction')
  }
  const projected = targets.map(target => ({ ...target, lifecycleAfter: computeTitleLifecycle(titleEvents.get(`${target.enterpriseId}:${target.titleCode}`)!.map(event => finalEvents.get(event.id) ?? event)) }))
  const requestHash = eventCorrectionHash(request)
  return { requestHash, planHash: eventCorrectionHash({ requestHash, targets: projected, ...(validityOrigins.length ? { validityOrigins } : {}) }), targets: projected, impact: { corrected: targets.length, requiresRevalidation: targets.reduce((n, t) => n + t.correspondences.filter(c => c.status === 'confirmed').length, 0) } }
}

export type QualificationReadback = RosterImportBeforeQualificationReadback | RosterImportAfterQualificationReadback

type QualificationUnavailable = Extract<QualificationReadback, { status: 'unavailable' }>

export type QualificationPhase = QualificationReadback['stage']

/** Internal transport predicate, never a JSON request field or part of a plan hash. */
export type CorrectionQualificationSafety = (value: unknown) => boolean

const readbackProtocol = 'event-correction-407-v1'

const trustedReadbacks = new WeakMap<object, { safety: CorrectionQualificationSafety; value: unknown }>()

function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }

function positiveId(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value < Number.MAX_SAFE_INTEGER }

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)) }

/** Protocol integrity only; no eligibility or missing-field rule is reproduced here. */
function completeSnapshot(value: unknown, enterpriseId: number): boolean {
  if (!isObject(value) || !exactKeys(value, ['enterpriseId', 'asOf', 'ruleVersion', 'assessmentVersion', 'snapshotId', 'titles'])
    || value.enterpriseId !== enterpriseId || typeof value.asOf !== 'string' || !Number.isFinite(Date.parse(value.asOf))
    || typeof value.ruleVersion !== 'string' || !value.ruleVersion || typeof value.assessmentVersion !== 'string' || !value.assessmentVersion
    || typeof value.snapshotId !== 'string' || !/^[a-f0-9]{64}$/.test(value.snapshotId) || !Array.isArray(value.titles) || value.titles.length !== CURRENT_TITLES.length) return false
  const codes = new Set<unknown>()
  for (const title of value.titles) {
    if (!isObject(title) || !CURRENT_TITLES.some(code => code === title.titleCode) || codes.has(title.titleCode) || !isObject(title.versions)) return false
    codes.add(title.titleCode)
    for (const key of ['facts', 'sources', 'decisions', 'observations']) {
      const digest = title.versions[key]
      if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) return false
    }
    if (typeof title.group !== 'string' || !['eligible', 'pending', 'excluded'].includes(title.group)
      || !['officialQualification', 'subject', 'region', 'platform', 'correspondence', 'completeness', 'shadow'].every(key => isObject(title[key]))
      || !['cycles', 'evidence', 'sourceVersions', 'references', 'notes'].every(key => Array.isArray(title[key]))) return false
  }
  const scope = { enterpriseId: value.enterpriseId, asOf: value.asOf, ruleVersion: value.ruleVersion, assessmentVersion: value.assessmentVersion }
  return value.snapshotId === eventCorrectionHash([scope, value.titles])
}

function unavailable(stage: QualificationPhase, target: { enterpriseId: number }): QualificationUnavailable {
  return stage === 'before' ? { stage, status: 'unavailable', reason: 'read_unavailable', target } : { stage, status: 'unavailable', reason: 'read_unavailable', target }
}

/** No predicate means an internal, unredacted core result, not permission to bypass transport. */
function protectCapture<T extends object>(capture: T, stage: QualificationPhase, target: { enterpriseId: number }, safety?: CorrectionQualificationSafety): T | QualificationUnavailable {
  try {
    if (!isObject(capture) || !completeSnapshot(capture.assessment, target.enterpriseId) || safety && !safety(capture)) return unavailable(stage, target)
    const requiredBytes = Buffer.byteLength(JSON.stringify(capture), 'utf8')
    if (requiredBytes > 65536) return stage === 'before'
      ? { stage, status: 'unavailable', reason: 'response_limit', target, requiredBytes }
      : { stage, status: 'unavailable', reason: 'response_limit', target, requiredBytes }
    return capture
  } catch { return unavailable(stage, target) }
}

export function eventCorrectionReadbackScope(targets: readonly { enterpriseId: number }[], stage: QualificationPhase) {
  const enterpriseIds = [...new Set(targets.map(target => target.enterpriseId))].sort((a, b) => a - b)
  if (enterpriseIds.length === 1) return { target: { enterpriseId: enterpriseIds[0]! } } as const
  const readback: QualificationReadback = enterpriseIds.length
    ? { stage, status: 'not_retained', reason: 'multiple_targets', target: null, enterpriseIds }
    : stage === 'before' ? legacyReadback(stage) : { stage, status: 'not_retained', reason: 'no_targets', target: null }
  return { readback } as const
}

export function eventCorrectionCapture(assessment: Awaited<ReturnType<typeof readPostgresLegacyQualification>> | null, stage: QualificationPhase, target: { enterpriseId: number }, safety?: CorrectionQualificationSafety): QualificationReadback {
  if (!assessment) return unavailable(stage, target)
  return protectCapture({ stage, status: 'captured' as const, target, assessment }, stage, target, safety)
}

function legacyReadback(stage: QualificationPhase): QualificationReadback {
  return stage === 'before' ? { stage, status: 'not_retained', reason: 'scope_not_established', target: null }
    : { stage, status: 'not_retained', reason: 'legacy_receipt', target: null }
}

function storedReadback(value: unknown, stage: QualificationPhase, safety?: CorrectionQualificationSafety): unknown {
  if (!isObject(value) || value.stage !== stage) return legacyReadback(stage)
  if (value.status === 'captured' && exactKeys(value, ['stage', 'status', 'target', 'assessment']) && isObject(value.target)
    && exactKeys(value.target, ['enterpriseId']) && positiveId(value.target.enterpriseId)) {
    return protectCapture(value, stage, { enterpriseId: value.target.enterpriseId }, safety)
  }
  if (value.status === 'not_retained' && value.target === null) {
    if ((value.reason === 'scope_not_established' && stage === 'before' || (value.reason === 'legacy_receipt' || value.reason === 'no_targets') && stage === 'after')
      && exactKeys(value, ['stage', 'status', 'target', 'reason'])) return value
    if (value.reason === 'multiple_targets' && exactKeys(value, ['stage', 'status', 'target', 'reason', 'enterpriseIds'])
      && Array.isArray(value.enterpriseIds) && value.enterpriseIds.length > 1 && value.enterpriseIds.every(positiveId)) return value
  }
  if (value.status === 'unavailable' && isObject(value.target) && exactKeys(value.target, ['enterpriseId']) && positiveId(value.target.enterpriseId)) {
    if (value.reason === 'read_unavailable' && exactKeys(value, ['stage', 'status', 'target', 'reason'])) return value
    if (value.reason === 'response_limit' && exactKeys(value, ['stage', 'status', 'target', 'reason', 'requiredBytes']) && positiveId(value.requiredBytes)) return value
  }
  return legacyReadback(stage)
}

function responseWithReadback<T extends object>(legacy: T, value: unknown, safety?: CorrectionQualificationSafety) {
  const result = { ...legacy, qualificationReadback: value }
  if (safety) trustedReadbacks.set(result, { safety, value })
  return result
}

/** Only this core's exact response slot sealed for this request's finalizer may bypass a second pass. */
export function finalizedCorrectionReadback(result: unknown, safety: CorrectionQualificationSafety) {
  if (!isObject(result)) return undefined
  const entry = trustedReadbacks.get(result)
  if (!entry || entry.safety !== safety || result.qualificationReadback !== entry.value) return undefined
  return { legacy: Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'qualificationReadback')), value: entry.value }
}

function replayReadback(result: Record<string, unknown>, stage: QualificationPhase, safety?: CorrectionQualificationSafety) {
  const legacy = Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'qualificationReadbackProtocol' && key !== 'qualificationReadback'))
  return responseWithReadback(legacy, storedReadback(result.qualificationReadback, stage, safety), safety)
}

type EventCorrectionBatch = Pick<typeof ImportBatchTable.$inferSelect, 'id' | 'sourceKind' | 'sourceIdentity' | 'status'> & { preflightResult: unknown; summary: unknown }

export function assertEventCorrectionBatch(batch: EventCorrectionBatch | undefined, request: EventCorrectionRequest) {
  if (batch && (batch.sourceKind !== 'event_correction' || batch.sourceIdentity !== request.sourceIdentity || (batch.preflightResult as { requestHash?: string } | null)?.requestHash !== eventCorrectionHash(request))) {
    eventCorrectionFailure(409, 'idempotency_conflict', 'Idempotency key belongs to another request')
  }
  return batch
}

export function eventCorrectionPreflightReplay(old: EventCorrectionBatch | undefined, safety?: CorrectionQualificationSafety) {
  if (old && isObject(old.preflightResult) && old.preflightResult.qualificationReadbackProtocol === readbackProtocol) {
    const result = replayReadback(old.preflightResult, 'before', safety)
    return responseWithReadback({ ...result, batchStatus: old.status }, result.qualificationReadback, safety)
  }
  if (old && isObject(old.preflightResult) && !Object.hasOwn(old.preflightResult, 'qualificationReadback')) {
    return responseWithReadback({ ...old.preflightResult, batchStatus: old.status }, legacyReadback('before'), safety)
  }
  if (old?.preflightResult) return { ...(old.preflightResult as object), batchStatus: old.status }
}

export function eventCorrectionCommitBatch(batch: EventCorrectionBatch | undefined, planHash: string) {
  const stored = batch?.preflightResult as ReturnType<typeof projectEventCorrectionPlan> | null
  if (!batch || !stored || stored.planHash !== planHash) eventCorrectionFailure(409, 'plan_mismatch', 'Matching bound preflight required')
  return batch
}

export function eventCorrectionCommitReplay(batch: EventCorrectionBatch, safety?: CorrectionQualificationSafety) {
  if (isObject(batch.summary) && batch.summary.qualificationReadbackProtocol === readbackProtocol) return replayReadback(batch.summary, 'after', safety)
  if (isObject(batch.summary) && !Object.hasOwn(batch.summary, 'qualificationReadback')) return responseWithReadback(batch.summary, legacyReadback('after'), safety)
  return batch.summary
}

export function eventCorrectionPreflightResult(batchId: number, plan: ReturnType<typeof projectEventCorrectionPlan>) {
  const qualificationDiagnostics = plan.targets.map(target => ({ ref: 'event:' + target.eventId, eventType: target.after.eventType, ...diagnoseOfficialEventFields(target.after) }))
  return { batchId, batchStatus: 'preflight', ...plan, qualificationDiagnostics }
}

export function eventCorrectionResult<T extends object>(body: T, qualificationReadback: QualificationReadback, safety?: CorrectionQualificationSafety) {
  return {
    stored: { ...body, qualificationReadback, qualificationReadbackProtocol: readbackProtocol },
    response: responseWithReadback(body, qualificationReadback, safety),
  }
}
