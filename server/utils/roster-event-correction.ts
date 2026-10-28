import { createHash } from 'node:crypto'
import { and, asc, count, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { computeTitleLifecycle } from '../../lib/roster/lifecycle'
import { advanceOfficialEventRevision } from './roster-event-version'
import { ensureBatchRow } from './roster-batch-ledger'
import { refreshDerivedFileParts } from './file-parts'
import { CURRENT_TITLES, diagnoseOfficialEventFields, readCurrentQualificationAssessment } from '../../lib/roster/current-qualification'
import type { RosterImportBeforeQualificationReadback, RosterImportAfterQualificationReadback } from '../../lib/roster-import-client'

type Db = BetterSQLite3Database<typeof schema>
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type Executor = Db | Tx
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1)
const year = z.number().int().min(1900).max(9999).nullable()
export const eventCorrectionOperationSchema = z.strictObject({
  eventId: positive, recordId: positive, enterpriseId: positive, expectedRevision: positive,
  patch: z.strictObject({ eventType: z.enum(['award', 'review', 'nurture']).optional(), year: year.optional(), decidedYear: year.optional(), batchSeq: positive.nullable().optional(), reviewOutcome: z.enum(['passed', 'failed']).nullable().optional() }).refine(patch => Object.keys(patch).length > 0, 'Patch must contain an event field'),
})
export const eventCorrectionRequestSchema = z.strictObject({
  idempotencyKey: z.string().trim().min(1).max(200), sourceIdentity: z.string().trim().min(1).max(1000),
  actor: z.strictObject({ type: z.enum(['user', 'agent']), id: z.string().trim().min(1).max(200) }),
  basis: z.string().trim().min(1).max(4000), operations: z.array(eventCorrectionOperationSchema).min(1).max(300),
})
export type EventCorrectionRequest = z.infer<typeof eventCorrectionRequestSchema>
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function fail(statusCode: number, code: string, message: string): never { throw Object.assign(new Error(message), { statusCode, code }) }
function snapshot(db: Executor, id: number) {
  const row = db.select({ event: schema.recordEvent, record: schema.record }).from(schema.recordEvent)
    .innerJoin(schema.record, eq(schema.recordEvent.recordId, schema.record.id)).where(eq(schema.recordEvent.id, id)).get()
  if (!row || row.record.source !== 'jxj') fail(404, 'not_found', 'Official jxj event not found')
  const evidence = db.select().from(schema.recordEvidence).where(eq(schema.recordEvidence.recordEventId, id)).orderBy(asc(schema.recordEvidence.id)).limit(301).all()
  if (evidence.length > 300) fail(413, 'source_limit', 'Event has more than 300 evidence references; narrow source maintenance required')
  const paths = [...new Set(evidence.map(row => row.sourceFile))]
  const files = paths.length ? db.select({ id: schema.storedFile.id, relPath: schema.storedFile.relPath, sha256: schema.storedFile.sha256, bytes: schema.storedFile.bytes, removedAt: schema.storedFile.removedAt }).from(schema.storedFile).where(inArray(schema.storedFile.relPath, paths)).orderBy(asc(schema.storedFile.id)).all() : []
  return { ...row, evidence, files }
}
function lifecycleEvents(db: Executor, record: typeof schema.record.$inferSelect) {
  const rows = db.select({ event: schema.recordEvent }).from(schema.recordEvent).innerJoin(schema.record, eq(schema.recordEvent.recordId, schema.record.id))
    .where(and(eq(schema.record.enterpriseId, record.enterpriseId), eq(schema.record.titleCode, record.titleCode), eq(schema.record.source, 'jxj'))).all()
  return rows.map(row => row.event)
}
export function readOfficialEvent(db: Db, id: number) {
  return db.transaction(tx => { const source = snapshot(tx, id); return { ...source, lifecycle: computeTitleLifecycle(lifecycleEvents(tx, source.record)) } })
}
export function readEventCorrectionAudit(db: Db, id: number, page: number, pageSize: number) {
  return db.transaction(tx => {
    const found = tx.select({ id: schema.recordEvent.id }).from(schema.recordEvent).innerJoin(schema.record, eq(schema.recordEvent.recordId, schema.record.id)).where(and(eq(schema.recordEvent.id, id), eq(schema.record.source, 'jxj'))).get()
    if (!found) fail(404, 'not_found', 'Official event not found')
    const t = schema.eventCorrectionAudit, where = eq(t.eventId, id)
    const total = tx.select({ total: count() }).from(t).where(where).get()!.total
    return { total, page, pageSize, rows: tx.select().from(t).where(where).orderBy(asc(t.id)).limit(pageSize).offset((page - 1) * pageSize).all() }
  })
}
function buildPlan(db: Executor, request: EventCorrectionRequest) {
  const ids = request.operations.map(op => op.eventId)
  if (new Set(ids).size !== ids.length) fail(422, 'duplicate_target', 'Each event may be corrected only once per batch')
  const titleEvents = new Map<string, ReturnType<typeof lifecycleEvents>>()
  const siblingsByRecord = new Map<number, Array<typeof schema.recordEvent.$inferSelect>>()
  const targets = request.operations.map(op => {
    const source = snapshot(db, op.eventId), before = source.event
    if (source.record.id !== op.recordId || source.record.enterpriseId !== op.enterpriseId) fail(409, 'target_mismatch', 'Event record/enterprise ownership changed')
    if (before.revision !== op.expectedRevision) fail(409, 'stale_revision', 'Official event revision changed')
    if (!source.evidence.length) fail(422, 'basis_required', 'Official source evidence is required for correction')
    const after = { ...before, ...op.patch, sortKey: op.patch.year === undefined ? before.sortKey : op.patch.year ?? 0, revision: before.revision + 1 }
    if (after.eventType === 'maintain' || after.eventType !== 'review' && after.reviewOutcome != null || after.year != null && after.decidedYear != null && after.decidedYear < after.year) fail(422, 'invalid_event_combination', 'Only official award/review/nurture; reviewOutcome is review-only and decidedYear cannot precede year')
    if (Object.entries(op.patch).every(([key, value]) => before[key as keyof typeof before] === value)) fail(422, 'no_change', 'Correction must change an event field')
    const related = db.select({ id: schema.recordCorrespondence.id, revision: schema.recordCorrespondence.revision, status: schema.recordCorrespondence.status }).from(schema.recordCorrespondence).where(eq(schema.recordCorrespondence.eventId, op.eventId)).orderBy(asc(schema.recordCorrespondence.id)).limit(301).all()
    // Predecessor confirmations are covered by the same event revision fingerprint.
    const predecessors = db.select({ id: schema.recordCorrespondence.id, revision: schema.recordCorrespondence.revision, status: schema.recordCorrespondence.status }).from(schema.recordCorrespondence).where(eq(schema.recordCorrespondence.predecessorEventId, op.eventId)).orderBy(asc(schema.recordCorrespondence.id)).limit(301).all()
    if (related.length + predecessors.length > 300) fail(413, 'source_limit', 'Event correspondence impact exceeds 300 rows')
    const titleKey = `${source.record.enterpriseId}:${source.record.titleCode}`
    if (!titleEvents.has(titleKey)) titleEvents.set(titleKey, lifecycleEvents(db, source.record))
    return { titleCode: source.record.titleCode, eventId: op.eventId, recordId: op.recordId, enterpriseId: op.enterpriseId, before, after, evidence: source.evidence, files: source.files, correspondences: [...related, ...predecessors].sort((a, b) => a.id - b.id), lifecycleBefore: computeTitleLifecycle(titleEvents.get(titleKey)!) }
  })
  for (const target of targets) {
    // Input-key scoped candidates only; no all-events/raw query materialization.
    if (!siblingsByRecord.has(target.recordId)) siblingsByRecord.set(target.recordId, db.select().from(schema.recordEvent).where(eq(schema.recordEvent.recordId, target.recordId)).all())
    const siblings = siblingsByRecord.get(target.recordId)!
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
    if (conflict) fail(409, 'natural_key_conflict', 'Another event occupies the official event scope; distinct review rounds require known origin, batch and decision years; events are never merged by correction')
  }
  const finalEvents = new Map(targets.map(target => [target.eventId, target.after]))
  const projected = targets.map(target => ({ ...target, lifecycleAfter: computeTitleLifecycle(titleEvents.get(`${target.enterpriseId}:${target.titleCode}`)!.map(event => finalEvents.get(event.id) ?? event)) }))
  const requestHash = hash(request)
  return { requestHash, planHash: hash({ requestHash, targets: projected }), targets: projected, impact: { corrected: targets.length, requiresRevalidation: targets.reduce((n, t) => n + t.correspondences.filter(c => c.status === 'confirmed').length, 0) } }
}
function boundBatch(db: Executor, request: EventCorrectionRequest) {
  const batch = db.select().from(schema.importBatch).where(eq(schema.importBatch.idempotencyKey, request.idempotencyKey)).get()
  if (batch && (batch.sourceKind !== 'event_correction' || batch.sourceIdentity !== request.sourceIdentity || (batch.preflightResult as { requestHash?: string } | null)?.requestHash !== hash(request))) fail(409, 'idempotency_conflict', 'Idempotency key belongs to another request')
  return batch
}

type QualificationReadback = RosterImportBeforeQualificationReadback | RosterImportAfterQualificationReadback
type QualificationUnavailable = Extract<QualificationReadback, { status: 'unavailable' }>
type QualificationPhase = QualificationReadback['stage']
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
  return value.snapshotId === hash([scope, value.titles])
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
function readQualification(db: Db, targets: readonly { enterpriseId: number }[], stage: QualificationPhase, safety?: CorrectionQualificationSafety): QualificationReadback {
  const enterpriseIds = [...new Set(targets.map(target => target.enterpriseId))].sort((a, b) => a - b)
  if (!enterpriseIds.length) return stage === 'before' ? legacyReadback(stage) : { stage, status: 'not_retained', reason: 'no_targets', target: null }
  if (enterpriseIds.length !== 1) return stage === 'before'
    ? { stage, status: 'not_retained', reason: 'multiple_targets', target: null, enterpriseIds }
    : { stage, status: 'not_retained', reason: 'multiple_targets', target: null, enterpriseIds }
  const target = { enterpriseId: enterpriseIds[0]! }
  try {
    const asOf = Date.now()
    const assessment = readCurrentQualificationAssessment((db as Db & { $client: import('better-sqlite3').Database }).$client, target.enterpriseId, asOf)
    const capture: Extract<QualificationReadback, { status: 'captured' }> = stage === 'before'
      ? { stage, status: 'captured', target, assessment }
      : { stage, status: 'captured', target, assessment }
    return protectCapture(capture, stage, target, safety)
  } catch { return unavailable(stage, target) }
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

export function preflightEventCorrections(db: Db, request: EventCorrectionRequest, safety?: CorrectionQualificationSafety) {
  return db.transaction(tx => {
    const old = boundBatch(tx, request)
    if (old && isObject(old.preflightResult) && old.preflightResult.qualificationReadbackProtocol === readbackProtocol) {
      const result = replayReadback(old.preflightResult, 'before', safety)
      return responseWithReadback({ ...result, batchStatus: old.status }, result.qualificationReadback, safety)
    }
    if (old && isObject(old.preflightResult) && !Object.hasOwn(old.preflightResult, 'qualificationReadback')) {
      return responseWithReadback({ ...old.preflightResult, batchStatus: old.status }, legacyReadback('before'), safety)
    }
    if (old?.preflightResult) return { ...(old.preflightResult as object), batchStatus: old.status }
    const plan = buildPlan(tx, request)
    const batch = ensureBatchRow(db, { idempotencyKey: request.idempotencyKey, sourceIdentity: request.sourceIdentity, sourceKind: 'event_correction' })
    const qualificationDiagnostics = plan.targets.map(target => ({ ref: `event:${target.eventId}`, eventType: target.after.eventType, ...diagnoseOfficialEventFields(target.after) }))
    const result = { batchId: batch.id, batchStatus: 'preflight', ...plan, qualificationDiagnostics }
    const qualificationReadback = readQualification(db, plan.targets, 'before', safety)
    tx.update(schema.importBatch).set({ preflightResult: { ...result, qualificationReadback, qualificationReadbackProtocol: readbackProtocol } }).where(eq(schema.importBatch.id, batch.id)).run()
    return responseWithReadback(result, qualificationReadback, safety)
  }, { behavior: 'immediate' })
}
export function commitEventCorrections(db: Db, request: EventCorrectionRequest, planHash: string, safety?: CorrectionQualificationSafety) {
  return db.transaction(tx => {
    const batch = boundBatch(tx, request)
    const stored = batch?.preflightResult as ReturnType<typeof buildPlan> | null
    if (!batch || !stored || stored.planHash !== planHash) fail(409, 'plan_mismatch', 'Matching bound preflight required')
    if (batch.status === 'committed') {
      if (isObject(batch.summary) && batch.summary.qualificationReadbackProtocol === readbackProtocol) return replayReadback(batch.summary, 'after', safety)
      if (isObject(batch.summary) && !Object.hasOwn(batch.summary, 'qualificationReadback')) return responseWithReadback(batch.summary, legacyReadback('after'), safety)
      return batch.summary
    }
    const plan = buildPlan(tx, request)
    if (plan.planHash !== planHash) fail(409, 'plan_mismatch', 'Event/source/impact changed after preflight')
    const correctedAt = new Date().toISOString()
    for (const target of plan.targets) {
      advanceOfficialEventRevision(tx, target.eventId, target.before.revision)
      const { id, recordId, revision, ...fields } = target.after
      tx.update(schema.recordEvent).set(fields).where(eq(schema.recordEvent.id, id)).run()
      tx.insert(schema.eventCorrectionAudit).values({ eventId: id, recordId, enterpriseId: target.enterpriseId, batchId: batch.id, before: target.before, after: target.after, evidence: target.evidence, sourceIdentity: request.sourceIdentity, actorType: request.actor.type, actorId: request.actor.id, basis: request.basis, correctedAt }).run()
    }
    refreshDerivedFileParts(tx, plan.targets.flatMap(target => target.evidence.map(row => row.sourceFile)))
    const receipt = { batchId: batch.id, planHash, eventIds: plan.targets.map(t => t.eventId), impact: plan.impact, committedAt: correctedAt }
    const qualificationReadback = readQualification(db, plan.targets, 'after', safety)
    tx.update(schema.importBatch).set({ status: 'committed', summary: { ...receipt, qualificationReadback, qualificationReadbackProtocol: readbackProtocol }, itemResults: plan.targets.map(t => ({ eventId: t.eventId, revision: t.after.revision })), committedAt: correctedAt, error: null }).where(eq(schema.importBatch.id, batch.id)).run()
    return responseWithReadback(receipt, qualificationReadback, safety)
  }, { behavior: 'immediate' })
}
