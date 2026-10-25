import { createHash } from 'node:crypto'
import { and, asc, count, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { computeTitleLifecycle } from '../../lib/roster/lifecycle'
import { advanceOfficialEventRevision } from './roster-event-version'
import { ensureBatchRow } from './roster-batch-ledger'
import { refreshDerivedFileParts } from './file-parts'

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
export function preflightEventCorrections(db: Db, request: EventCorrectionRequest) {
  return db.transaction(tx => {
    const old = boundBatch(tx, request)
    if (old?.preflightResult) return { ...(old.preflightResult as object), batchStatus: old.status }
    const plan = buildPlan(tx, request)
    const batch = ensureBatchRow(db, { idempotencyKey: request.idempotencyKey, sourceIdentity: request.sourceIdentity, sourceKind: 'event_correction' })
    const result = { batchId: batch.id, batchStatus: 'preflight', ...plan }
    tx.update(schema.importBatch).set({ preflightResult: result }).where(eq(schema.importBatch.id, batch.id)).run()
    return result
  }, { behavior: 'immediate' })
}
export function commitEventCorrections(db: Db, request: EventCorrectionRequest, planHash: string) {
  return db.transaction(tx => {
    const batch = boundBatch(tx, request)
    const stored = batch?.preflightResult as ReturnType<typeof buildPlan> | null
    if (!batch || !stored || stored.planHash !== planHash) fail(409, 'plan_mismatch', 'Matching bound preflight required')
    if (batch.status === 'committed') return batch.summary
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
    tx.update(schema.importBatch).set({ status: 'committed', summary: receipt, itemResults: plan.targets.map(t => ({ eventId: t.eventId, revision: t.after.revision })), committedAt: correctedAt, error: null }).where(eq(schema.importBatch.id, batch.id)).run()
    return receipt
  }, { behavior: 'immediate' })
}
