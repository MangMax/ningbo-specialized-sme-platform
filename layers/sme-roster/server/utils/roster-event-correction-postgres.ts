import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from '../../../../db/schema'
import { readPostgresLegacyQualification, type PostgresQualificationTransaction } from '../../lib/roster/current-qualification-postgres'
import { postgresRosterRow, readPostgresRosterRowsById } from '../../lib/roster/postgres-rows'
import {
  assertEventCorrectionBatch, eventCorrectionCapture, eventCorrectionCommitBatch, eventCorrectionCommitReplay,
  eventCorrectionFailure, eventCorrectionPreflightReplay, eventCorrectionPreflightResult, eventCorrectionReadbackScope,
  eventCorrectionResult, projectEventCorrectionPlan, validateEventCorrectionTargets, type EventCorrectionInputs,
  type EventCorrectionRequest, type CorrectionQualificationSafety,
} from './roster-event-correction'
import { lockPostgresRosterImportKey } from './roster-export-import-postgres'
import { advancePostgresOfficialEventRevision } from './evidence-revision-postgres'
import { lockPostgresFilePaths, refreshPostgresDerivedFileParts } from './file-parts-postgres'

type Reader = Pick<NodePgDatabase, 'execute'>
type Tx = PostgresQualificationTransaction
type EventSnapshot = ReturnType<EventCorrectionInputs['snapshot']>
type Plan = ReturnType<typeof projectEventCorrectionPlan>
const ids = (values: readonly number[]) => sql`${sql.param(values)}::bigint[]`

export async function loadPostgresEventCorrectionInputs(tx: Reader, eventIds: number[]): Promise<EventCorrectionInputs> {
  const { rows: targets } = await tx.execute<Pick<EventSnapshot, 'event' | 'record'>>(sql`
    SELECT ${postgresRosterRow(schema.recordEvent,'e')} AS event,${postgresRosterRow(schema.record,'r')} AS record
    FROM record_event e JOIN record r ON r.id=e.record_id WHERE e.id=ANY(${ids(eventIds)}) AND r.source='jxj'`)
  const byId = new Map(targets.map(target => [target.event.id, target]))
  const evidence = await readPostgresRosterRowsById(tx, schema.recordEvidence, sql`FROM unnest(${ids(eventIds)}) AS t(event_id)
    CROSS JOIN LATERAL (SELECT * FROM record_evidence WHERE record_event_id=t.event_id ORDER BY id LIMIT 301) p`)
  const files = evidence.length ? (await tx.execute<{ file: EventSnapshot['files'][number] }>(sql`
    SELECT json_build_object('id',id,'relPath',rel_path,'sha256',sha256,'bytes',bytes,'removedAt',removed_at) AS file
    FROM stored_file WHERE rel_path=ANY(${sql.param([...new Set(evidence.map(row => row.sourceFile))])}::text[]) ORDER BY id`)).rows : []
  const correspondence = await tx.execute<{ eventId: number; relation: ReturnType<EventCorrectionInputs['correspondence']>[number] }>(sql`
    SELECT t.event_id::float8 AS "eventId", json_build_object('id',c.id,'revision',c.revision,'status',c.status) AS relation
    FROM unnest(${ids(eventIds)}) AS t(event_id)
    CROSS JOIN LATERAL (
      (SELECT id,revision,status FROM record_correspondence WHERE event_id=t.event_id ORDER BY id LIMIT 301)
      UNION ALL
      (SELECT id,revision,status FROM record_correspondence WHERE predecessor_event_id=t.event_id ORDER BY id LIMIT 301)
    ) c ORDER BY c.id`)
  const { rows: related } = await tx.execute<{ event: EventSnapshot['event']; key: string }>(sql`
    SELECT ${postgresRosterRow(schema.recordEvent,'p')} AS event, r.enterprise_id::text || ':' || r.title_code AS key
    FROM record_event p JOIN record r ON r.id=p.record_id WHERE r.source='jxj' AND EXISTS (
      SELECT 1 FROM record_event e JOIN record source ON source.id=e.record_id
      WHERE e.id=ANY(${ids(eventIds)}) AND source.enterprise_id=r.enterprise_id AND source.title_code=r.title_code) ORDER BY p.id`)
  const evidenceByEvent = Map.groupBy(evidence, row => row.recordEventId)
  const correspondenceByEvent = Map.groupBy(correspondence.rows, row => row.eventId)
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
      return { ...target, evidence: rows, files: files.flatMap(({ file }) => paths.has(file.relPath) ? [file] : []) }
    },
    correspondence: id => correspondenceByEvent.get(id)?.map(row => row.relation) ?? [],
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
  const { rows: [row] } = await tx.execute<NonNullable<Parameters<typeof assertEventCorrectionBatch>[0]>>(sql`
    SELECT id::float8 AS id,status,source_kind AS "sourceKind",source_identity AS "sourceIdentity",
      preflight_result::json AS "preflightResult",summary::json AS summary
    FROM import_batch WHERE idempotency_key=${request.idempotencyKey} FOR UPDATE`)
  return assertEventCorrectionBatch(row, request)
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
  const { rows: [batch] } = await tx.execute<{ id: number }>(sql`
    INSERT INTO import_batch(idempotency_key,source_kind,source_identity,status,created_at)
    VALUES(${request.idempotencyKey},'event_correction',${request.sourceIdentity},'preflight',${new Date().toISOString()})
    ON CONFLICT(idempotency_key) DO NOTHING RETURNING id::float8 AS id`)
  if (!batch) return eventCorrectionFailure(409, 'idempotency_conflict', 'Idempotency key belongs to another request')
  const result = eventCorrectionResult(eventCorrectionPreflightResult(batch.id, plan), await readQualification(tx, plan, 'before', safety), safety)
  await tx.execute(sql`UPDATE import_batch SET preflight_result=${JSON.stringify(result.stored)} WHERE id=${batch.id}`)
  return result.response
}

export async function commitPostgresEventCorrections(tx: Tx, request: EventCorrectionRequest, planHash: string, safety?: CorrectionQualificationSafety) {
  await lockPostgresRosterImportKey(tx, request.idempotencyKey)
  const batch = eventCorrectionCommitBatch(await readBatch(tx, request), planHash)
  if (batch.status === 'committed') return eventCorrectionCommitReplay(batch, safety)
  const eventIds = request.operations.map(op => op.eventId)
  const { rows } = await tx.execute<{ path: string }>(sql`SELECT source_file AS path FROM record_evidence WHERE record_event_id=ANY(${ids(eventIds)})`)
  const paths = new Set(rows.map(row => row.path))
  await lockPostgresFilePaths(tx, paths)
  await tx.execute(sql`SELECT id FROM record_event WHERE id=ANY(${ids(eventIds)}) ORDER BY id FOR UPDATE`)
  const plan = await buildPostgresEventPlan(tx, request)
  if (plan.planHash !== planHash) return eventCorrectionFailure(409, 'plan_mismatch', 'Event/source/impact changed after preflight')
  const correctedAt = new Date().toISOString()
  for (const target of plan.targets) {
    const { after, before, evidence, enterpriseId } = target
    await advancePostgresOfficialEventRevision(tx, after.id, before.revision)
    await tx.execute(sql`UPDATE record_event SET event_type=${after.eventType},year=${after.year},batch_seq=${after.batchSeq},
      sort_key=${after.sortKey},review_outcome=${after.reviewOutcome},decided_year=${after.decidedYear},
      formal_validity=${after.formalValidity === null ? null : JSON.stringify(after.formalValidity)} WHERE id=${after.id}`)
    await tx.execute(sql`INSERT INTO event_correction_audit(event_id,batch_id,record_id,enterprise_id,before,after,evidence,
      source_identity,actor_type,actor_id,basis,corrected_at)
      VALUES(${after.id},${batch.id},${after.recordId},${enterpriseId},${JSON.stringify(before)},${JSON.stringify(after)},${JSON.stringify(evidence)},
        ${request.sourceIdentity},${request.actor.type},${request.actor.id},${request.basis},${correctedAt})`)
  }
  await refreshPostgresDerivedFileParts(tx, paths)
  const receipt = { batchId: batch.id, planHash, eventIds, impact: plan.impact, committedAt: correctedAt }
  const result = eventCorrectionResult(receipt, await readQualification(tx, plan, 'after', safety), safety)
  const itemResults = plan.targets.map(target => ({ eventId: target.eventId, revision: target.after.revision }))
  await tx.execute(sql`UPDATE import_batch SET status='committed',summary=${JSON.stringify(result.stored)},item_results=${JSON.stringify(itemResults)},
    committed_at=${correctedAt},error=NULL WHERE id=${batch.id}`)
  return result.response
}
