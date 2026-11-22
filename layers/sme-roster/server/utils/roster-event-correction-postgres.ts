import { and, asc, eq, exists, inArray } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { storedFile } from '../../../../db/postgresql/file-tables'
import { importBatch } from '../../../../db/postgresql/import-tables'
import { record, recordEvent, recordEvidence } from '../../../../db/postgresql/ledger-tables'
import { eventCorrectionAudit } from '../../../../db/postgresql/official-evidence-tables'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { readPostgresLegacyQualification, type PostgresQualificationTransaction } from '../../lib/roster/current-qualification-postgres'
import { assertEventCorrectionBatch, eventCorrectionCapture, eventCorrectionCommitBatch, eventCorrectionCommitReplay, eventCorrectionFailure, eventCorrectionPreflightReplay, eventCorrectionPreflightResult, eventCorrectionReadbackScope, eventCorrectionResult, projectEventCorrectionPlan, validateEventCorrectionTargets, type EventCorrectionInputs, type EventCorrectionRequest, type CorrectionQualificationSafety } from './roster-event-correction-model'
import { lockPostgresRosterImportKey } from './roster-export-import-postgres'
import { advancePostgresOfficialEventRevision } from './evidence-revision-postgres'
import { lockPostgresFilePaths, refreshPostgresDerivedFileParts } from './file-parts-postgres'

type Reader = Pick<NodePgDatabase, 'select'>
type Tx = PostgresQualificationTransaction
type EventSnapshot = ReturnType<EventCorrectionInputs['snapshot']>
type Plan = ReturnType<typeof projectEventCorrectionPlan>

export async function loadPostgresEventCorrectionInputs(tx: Reader, eventIds: number[]): Promise<EventCorrectionInputs> {
  const eventFilter = inArray(recordEvent.id, eventIds)
  // The event plan hashes the serialized snapshot. Keep the established key order for stored preflights.
  const parseEvent = ({ revision, formalValidity, ...event }: typeof recordEvent.$inferSelect): EventSnapshot['event'] => ({
    ...event, formalValidity: formalValidity === null ? null : JSON.parse(formalValidity), revision,
  })
  const rows = await tx.select({ event: recordEvent, record }).from(recordEvent)
    .innerJoin(record, eq(record.id, recordEvent.recordId)).where(and(eventFilter, eq(record.source, 'jxj')))
  const targets = rows.map(row => ({
    event: parseEvent(row.event),
    record: { ...row.record, qualityFlags: row.record.qualityFlags === null ? null : JSON.parse(row.record.qualityFlags) },
  }))
  const byId = new Map(targets.map(target => [target.event.id, target]))
  const eventEvidence = tx.select().from(recordEvidence).where(eq(recordEvidence.recordEventId, recordEvent.id))
    .orderBy(asc(recordEvidence.id)).limit(301).as('event_evidence')
  const evidence = await tx.select({
    id: eventEvidence.id, recordEventId: eventEvidence.recordEventId, sourceFile: eventEvidence.sourceFile,
    attachment: eventEvidence.attachment, listNo: eventEvidence.listNo, page: eventEvidence.page,
  }).from(recordEvent).crossJoinLateral(eventEvidence).where(eventFilter).orderBy(asc(eventEvidence.id))
  const files = evidence.length ? await tx.select({
    id: storedFile.id, relPath: storedFile.relPath, sha256: storedFile.sha256, bytes: storedFile.bytes, removedAt: storedFile.removedAt,
  }).from(storedFile).where(inArray(storedFile.relPath, [...new Set(evidence.map(row => row.sourceFile))]))
    .orderBy(asc(storedFile.id)) : []
  const targetEvent = alias(recordEvent, 'target_event')
  const targetRecord = alias(record, 'target_record')
  const targetScope = tx.select({ id: targetEvent.id }).from(targetEvent)
    .innerJoin(targetRecord, eq(targetRecord.id, targetEvent.recordId)).where(and(
      inArray(targetEvent.id, eventIds), eq(targetRecord.enterpriseId, record.enterpriseId), eq(targetRecord.titleCode, record.titleCode),
    ))
  const relatedRows = await tx.select({ event: recordEvent, enterpriseId: record.enterpriseId, titleCode: record.titleCode })
    .from(recordEvent).innerJoin(record, eq(record.id, recordEvent.recordId))
    .where(and(eq(record.source, 'jxj'), exists(targetScope))).orderBy(asc(recordEvent.id))
  const related = relatedRows.map(row => ({ event: parseEvent(row.event), key: row.enterpriseId + ':' + row.titleCode }))
  const evidenceByEvent = Map.groupBy(evidence, row => row.recordEventId)
  const titles = Map.groupBy(related, row => row.key)
  const events = related.map(row => row.event)
  const siblings = Map.groupBy(events, row => row.recordId)
  const origins = new Map(events.map(row => [row.id, row]))
  return {
    snapshot: id => {
      const target = byId.get(id)
      if (!target) return eventCorrectionFailure(404,'not_found','Official jxj event not found')
      const rows = evidenceByEvent.get(id) ?? []
      if (rows.length > 300) return eventCorrectionFailure(413,'source_limit','Event has more than 300 evidence references; narrow source maintenance required')
      const paths = new Set(rows.map(row => row.sourceFile))
      return { ...target, evidence: rows, files: files.flatMap(file => paths.has(file.relPath) ? [{ ...file, bytes: Number(file.bytes) }] : []) }
    },
    titleEvents: record => titles.get(record.enterpriseId + ':' + record.titleCode)?.map(row => row.event) ?? [],
    siblings: id => siblings.get(id) ?? [],
    origin: id => origins.get(id) ?? null,
  }
}

async function buildPostgresEventPlan(tx: Reader, request: EventCorrectionRequest) {
  validateEventCorrectionTargets(request)
  const inputs = await loadPostgresEventCorrectionInputs(tx,request.operations.map(op=>op.eventId))
  return projectEventCorrectionPlan(request,inputs)
}

async function readBatch(tx: Tx, request: EventCorrectionRequest) {
  const [row] = await tx.select({
    id: importBatch.id, status: importBatch.status, sourceKind: importBatch.sourceKind, sourceIdentity: importBatch.sourceIdentity,
    preflightResult: importBatch.preflightResult, summary: importBatch.summary,
  }).from(importBatch).where(eq(importBatch.idempotencyKey, request.idempotencyKey)).for('update')
  type Batch = NonNullable<Parameters<typeof assertEventCorrectionBatch>[0]>
  return assertEventCorrectionBatch(row && {
    ...row, sourceKind: row.sourceKind as Batch['sourceKind'], status: row.status as Batch['status'],
    preflightResult: row.preflightResult === null ? null : JSON.parse(row.preflightResult),
    summary: row.summary === null ? null : JSON.parse(row.summary),
  }, request)
}

async function readQualification(tx: Tx, plan: Plan, stage: 'before' | 'after', safety?: CorrectionQualificationSafety) {
  const scope = eventCorrectionReadbackScope(plan.targets, stage)
  if (scope.readback) return scope.readback
  try {
    const assessment = await tx.transaction(nested => readPostgresLegacyQualification(nested, scope.target.enterpriseId, Date.now()))
    return eventCorrectionCapture(assessment, stage, scope.target, safety)
  } catch { return eventCorrectionCapture(null, stage, scope.target, safety) }
}

export async function preflightPostgresEventCorrections(tx: Tx, request: EventCorrectionRequest, safety?: CorrectionQualificationSafety) {
  await lockPostgresRosterImportKey(tx, request.idempotencyKey)
  const old = await readBatch(tx, request)
  const replay = eventCorrectionPreflightReplay(old, safety)
  if (replay) return replay
  const plan = await buildPostgresEventPlan(tx, request)
  const [batch] = await tx.insert(importBatch).values({
    idempotencyKey: request.idempotencyKey, sourceKind: 'event_correction', sourceIdentity: request.sourceIdentity,
    status: 'preflight', createdAt: new Date().toISOString(),
  }).onConflictDoNothing({ target: importBatch.idempotencyKey }).returning({ id: importBatch.id })
  if (!batch) return eventCorrectionFailure(409, 'idempotency_conflict', 'Idempotency key belongs to another request')
  const result = eventCorrectionResult(eventCorrectionPreflightResult(batch.id, plan), await readQualification(tx, plan, 'before', safety), safety)
  await tx.update(importBatch).set({ preflightResult: JSON.stringify(result.stored) }).where(eq(importBatch.id, batch.id))
  return result.response
}

export async function commitPostgresEventCorrections(tx: Tx, request: EventCorrectionRequest, planHash: string, safety?: CorrectionQualificationSafety) {
  await lockPostgresRosterImportKey(tx, request.idempotencyKey)
  const batch = eventCorrectionCommitBatch(await readBatch(tx, request), planHash)
  if (batch.status === 'committed') return eventCorrectionCommitReplay(batch, safety)
  const eventIds = request.operations.map(op => op.eventId)
  const rows = await tx.select({ path: recordEvidence.sourceFile }).from(recordEvidence)
    .where(inArray(recordEvidence.recordEventId, eventIds))
  const paths = new Set(rows.map(row => row.path))
  await lockPostgresFilePaths(tx, paths)
  await tx.select({ id: recordEvent.id }).from(recordEvent).where(inArray(recordEvent.id, eventIds))
    .orderBy(asc(recordEvent.id)).for('update')
  const plan = await buildPostgresEventPlan(tx, request)
  if (plan.planHash !== planHash) return eventCorrectionFailure(409, 'plan_mismatch', 'Event or source changed after preflight; preflight again with a new idempotency key')
  const correctedAt = new Date().toISOString()
  for (const target of plan.targets) {
    const { after, before, evidence, enterpriseId } = target
    await advancePostgresOfficialEventRevision(tx, after.id, before.revision)
    const { eventType, year, batchSeq, sortKey, reviewOutcome, decidedYear, formalValidity } = after
    await tx.update(recordEvent).set({
      eventType, year, batchSeq, sortKey, reviewOutcome, decidedYear,
      formalValidity: formalValidity === null ? null : JSON.stringify(formalValidity),
    }).where(eq(recordEvent.id, after.id))
    await tx.insert(eventCorrectionAudit).values({
      eventId: after.id, batchId: batch.id, recordId: after.recordId, enterpriseId, before: JSON.stringify(before),
      after: JSON.stringify(after), evidence: JSON.stringify(evidence), sourceIdentity: request.sourceIdentity,
      actorType: request.actor.type, actorId: request.actor.id, basis: request.basis, correctedAt,
    })
  }
  await refreshPostgresDerivedFileParts(tx, paths)
  const receipt = { batchId: batch.id, planHash, eventIds, impact: plan.impact, committedAt: correctedAt }
  const result = eventCorrectionResult(receipt, await readQualification(tx, plan, 'after', safety), safety)
  const itemResults = plan.targets.map(target => ({ eventId: target.eventId, revision: target.after.revision }))
  await tx.update(importBatch).set({
    status: 'committed', summary: JSON.stringify(result.stored), itemResults: JSON.stringify(itemResults),
    committedAt: correctedAt, error: null,
  }).where(eq(importBatch.id, batch.id))
  return result.response
}
