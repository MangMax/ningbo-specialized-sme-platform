import { eventCorrectionFailure, type EventCorrectionRequest, projectEventCorrectionPlan, assertEventCorrectionBatch, type QualificationPhase, type CorrectionQualificationSafety, type QualificationReadback, eventCorrectionReadbackScope, eventCorrectionCapture, eventCorrectionPreflightReplay, eventCorrectionResult, eventCorrectionPreflightResult, eventCorrectionCommitBatch, eventCorrectionCommitReplay } from './roster-event-correction-model'
import { and, asc, count, eq, inArray } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../../db/schema'
import { computeTitleLifecycle } from '../../lib/roster/lifecycle'
import { advanceOfficialEventRevision } from './roster-event-version'
import { ensureBatchRow } from './roster-batch-ledger'
import { refreshDerivedFileParts } from './file-parts'
import { readCurrentQualificationAssessment } from '../../lib/roster/current-qualification'
type Db = BetterSQLite3Database<typeof schema>
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type Executor = Db | Tx
export function snapshot(db: Executor, id: number) {
  const row = db.select({ event: schema.recordEvent, record: schema.record }).from(schema.recordEvent)
    .innerJoin(schema.record, eq(schema.recordEvent.recordId, schema.record.id)).where(eq(schema.recordEvent.id, id)).get()
  if (!row || row.record.source !== 'jxj') eventCorrectionFailure(404, 'not_found', 'Official jxj event not found')
  const evidence = db.select().from(schema.recordEvidence).where(eq(schema.recordEvidence.recordEventId, id)).orderBy(asc(schema.recordEvidence.id)).limit(301).all()
  if (evidence.length > 300) eventCorrectionFailure(413, 'source_limit', 'Event has more than 300 evidence references; narrow source maintenance required')
  const paths = [...new Set(evidence.map(row => row.sourceFile))]
  const files = paths.length ? db.select({ id: schema.storedFile.id, relPath: schema.storedFile.relPath, sha256: schema.storedFile.sha256, bytes: schema.storedFile.bytes, removedAt: schema.storedFile.removedAt }).from(schema.storedFile).where(inArray(schema.storedFile.relPath, paths)).orderBy(asc(schema.storedFile.id)).all() : []
  return { ...row, evidence, files }
}
export function lifecycleEvents(db: Executor, record: typeof schema.record.$inferSelect) {
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
    if (!found) eventCorrectionFailure(404, 'not_found', 'Official event not found')
    const t = schema.eventCorrectionAudit, where = eq(t.eventId, id)
    const total = tx.select({ total: count() }).from(t).where(where).get()!.total
    return { total, page, pageSize, rows: tx.select().from(t).where(where).orderBy(asc(t.id)).limit(pageSize).offset((page - 1) * pageSize).all() }
  })
}
export function buildPlan(db: Executor, request: EventCorrectionRequest) {
  const correspondence = (column: typeof schema.recordCorrespondence.eventId | typeof schema.recordCorrespondence.predecessorEventId, id: number) =>
    db.select({ id: schema.recordCorrespondence.id, revision: schema.recordCorrespondence.revision, status: schema.recordCorrespondence.status })
      .from(schema.recordCorrespondence).where(eq(column, id)).orderBy(asc(schema.recordCorrespondence.id)).limit(301).all()
  return projectEventCorrectionPlan(request, {
    snapshot: id => snapshot(db, id),
    correspondence: id => [...correspondence(schema.recordCorrespondence.eventId, id), ...correspondence(schema.recordCorrespondence.predecessorEventId, id)],
    titleEvents: record => lifecycleEvents(db, record),
    siblings: recordId => db.select().from(schema.recordEvent).where(eq(schema.recordEvent.recordId, recordId)).all(),
    origin: id => db.select().from(schema.recordEvent).where(eq(schema.recordEvent.id, id)).get() ?? null,
  })
}
function boundBatch(db: Executor, request: EventCorrectionRequest) {
  const batch = db.select().from(schema.importBatch).where(eq(schema.importBatch.idempotencyKey, request.idempotencyKey)).get()
  return assertEventCorrectionBatch(batch, request)
}
function readQualification(db: Db, targets: readonly { enterpriseId: number }[], stage: QualificationPhase, safety?: CorrectionQualificationSafety): QualificationReadback {
  const scope = eventCorrectionReadbackScope(targets, stage)
  if (scope.readback) return scope.readback
  try {
    const assessment = readCurrentQualificationAssessment((db as Db & { $client: import('better-sqlite3').Database }).$client, scope.target.enterpriseId, Date.now(), { assessmentVersion: 'enterprise-qualification-407-v1' })
    return eventCorrectionCapture(assessment, stage, scope.target, safety)
  } catch { return eventCorrectionCapture(null, stage, scope.target, safety) }
}
export function preflightEventCorrections(db: Db, request: EventCorrectionRequest, safety?: CorrectionQualificationSafety) {
  return db.transaction(tx => {
    const replay = eventCorrectionPreflightReplay(boundBatch(tx, request), safety)
    if (replay) return replay
    const plan = buildPlan(tx, request)
    const batch = ensureBatchRow(db, { idempotencyKey: request.idempotencyKey, sourceIdentity: request.sourceIdentity, sourceKind: 'event_correction' })
    const result = eventCorrectionResult(eventCorrectionPreflightResult(batch.id, plan), readQualification(db, plan.targets, 'before', safety), safety)
    tx.update(schema.importBatch).set({ preflightResult: result.stored }).where(eq(schema.importBatch.id, batch.id)).run()
    return result.response
  }, { behavior: 'immediate' })
}
export function commitEventCorrections(db: Db, request: EventCorrectionRequest, planHash: string, safety?: CorrectionQualificationSafety) {
  return db.transaction(tx => {
    const batch = eventCorrectionCommitBatch(boundBatch(tx, request), planHash)
    if (batch.status === 'committed') return eventCorrectionCommitReplay(batch, safety)
    const plan = buildPlan(tx, request)
    if (plan.planHash !== planHash) eventCorrectionFailure(409, 'plan_mismatch', 'Event/source/impact changed after preflight')
    const correctedAt = new Date().toISOString()
    for (const target of plan.targets) {
      advanceOfficialEventRevision(tx, target.eventId, target.before.revision)
      const { id, recordId, revision, ...fields } = target.after
      tx.update(schema.recordEvent).set(fields).where(eq(schema.recordEvent.id, id)).run()
      tx.insert(schema.eventCorrectionAudit).values({ eventId: id, recordId, enterpriseId: target.enterpriseId, batchId: batch.id, before: target.before, after: target.after, evidence: target.evidence, sourceIdentity: request.sourceIdentity, actorType: request.actor.type, actorId: request.actor.id, basis: request.basis, correctedAt }).run()
    }
    refreshDerivedFileParts(tx, plan.targets.flatMap(target => target.evidence.map(row => row.sourceFile)))
    const receipt = { batchId: batch.id, planHash, eventIds: plan.targets.map(t => t.eventId), impact: plan.impact, committedAt: correctedAt }
    const result = eventCorrectionResult(receipt, readQualification(db, plan.targets, 'after', safety), safety)
    tx.update(schema.importBatch).set({ status: 'committed', summary: result.stored, itemResults: plan.targets.map(t => ({ eventId: t.eventId, revision: t.after.revision })), committedAt: correctedAt, error: null }).where(eq(schema.importBatch.id, batch.id)).run()
    return result.response
  }, { behavior: 'immediate' })
}
export { eventCorrectionOperationSchema, eventCorrectionRequestSchema, type EventCorrectionRequest, eventCorrectionHash, eventCorrectionFailure, type EventCorrectionInputs, validateEventCorrectionTargets, projectEventCorrectionPlan, type CorrectionQualificationSafety, eventCorrectionReadbackScope, eventCorrectionCapture, finalizedCorrectionReadback, assertEventCorrectionBatch, eventCorrectionPreflightReplay, eventCorrectionCommitBatch, eventCorrectionCommitReplay, eventCorrectionPreflightResult, eventCorrectionResult } from './roster-event-correction-model'
