import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from '../../../../db/schema'
import { postgresRosterRow, readPostgresRosterRowsById } from '../../lib/roster/postgres-rows'
import {
  evidenceCorrectionAuditValues, evidenceCorrectionDigest, evidenceCorrectionError, EvidenceCorrectionError,
  inspectEvidenceCorrectionRequest, projectEvidenceCorrectionPlan, projectEvidenceCorrectionPreview,
  projectEvidenceCorrectionTargets, type EvidenceCorrectionRequest,
} from './roster-evidence-correction'
import type { OfficialEvidenceCommand } from './official-evidence'
import { readPostgresExactEvidence } from './official-evidence-postgres'
import { planPostgresOfficialEvidenceChanges } from './official-evidence-plan-postgres'
import { writePostgresOfficialPublishedRow } from './official-evidence-write-postgres'
import { advancePostgresOfficialEventRevision } from './evidence-revision-postgres'
import { lockPostgresFilePaths, refreshPostgresDerivedFileParts } from './file-parts-postgres'
import { runPostgresCorrespondenceTransaction } from './record-correspondence-write-postgres'

type Reader = Pick<NodePgDatabase,'execute'>
type Query = Exclude<ReturnType<ReturnType<typeof projectEvidenceCorrectionTargets>['next']>, {done: true}>['value']
const ids = (values: readonly number[]) => sql`${sql.param(values)}::bigint[]`
const snapshot = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const
const fail = (code: string, message: string, status = 422): never => { throw new EvidenceCorrectionError(code, message, status) }

async function readTargetInput(tx: Reader, input: Query) {
  if (input.type === 'evidence') return readPostgresExactEvidence(tx, input.id)
  if (input.type === 'enterprise') return Boolean((await tx.execute(sql`SELECT 1 FROM enterprise WHERE id=${input.id}`)).rows.length)
  if (input.type === 'file') {
    const { rows: [file] } = await tx.execute(sql`
      SELECT f.id::float8 AS id,f.rel_path AS "relPath",f.sha256,f.bytes::float8 AS bytes,f.removed_at AS "removedAt",
        c.source,c.kind,c.title_code AS "titleCode"
      FROM stored_file f JOIN roster_file_classification c ON c.file_id=f.id WHERE f.rel_path=${input.sourceFile}`)
    return file ?? null
  }
  if (input.type === 'parts') return readPostgresRosterRowsById(tx, schema.storedFilePart, sql`
    FROM (SELECT * FROM stored_file_part WHERE file_id=${input.fileId} AND origin IN('agent','legacy') LIMIT 1001) p`)
  if (input.type === 'collisions') {
    const { rows } = await tx.execute(sql`SELECT v.id::float8 AS id,v.attachment,${postgresRosterRow(schema.recordEvent,'e')} AS event
      FROM record_evidence v JOIN record_event e ON e.id=v.record_event_id
      WHERE v.source_file=${input.coordinate.sourceFile} AND v.list_no=${input.coordinate.listNo} AND v.id<>${input.id} LIMIT 101`)
    return rows
  }
  const { rows: [count] } = await tx.execute<{ n: number }>(sql`SELECT count(*)::float8 AS n FROM record_correspondence
    WHERE event_id=${input.eventId} OR predecessor_event_id=${input.eventId}`)
  return count!.n
}

export async function planPostgresEvidenceCorrectionTargets(tx: Reader, request: EvidenceCorrectionRequest,
  inspected: Awaited<ReturnType<typeof inspectEvidenceCorrectionRequest>>, typed?: boolean,
) {
  const queries = projectEvidenceCorrectionTargets(request, inspected, typed)
  let step = queries.next()
  while (!step.done) step = queries.next(await readTargetInput(tx, step.value))
  return step.value
}

async function buildPostgresEvidencePlan(tx: Reader, request: EvidenceCorrectionRequest, inspected: Awaited<ReturnType<typeof inspectEvidenceCorrectionRequest>>, filesDir?: string) {
  const targets = await planPostgresEvidenceCorrectionTargets(tx, request, inspected)
  const changes = targets.flatMap(target => target.rowChange ? [target.rowChange] : [])
  const facts = changes.length ? await planPostgresOfficialEvidenceChanges(tx, changes, filesDir) : null
  return projectEvidenceCorrectionPlan(request, targets, facts?.planHash)
}

export async function preflightPostgresEvidenceCorrection(db: NodePgDatabase, request: EvidenceCorrectionRequest, filesDir?: string) {
  const inspected = await inspectEvidenceCorrectionRequest(request, filesDir)
  try {
    const plan = await db.transaction(tx => buildPostgresEvidencePlan(tx, request, inspected, filesDir), snapshot)
    return projectEvidenceCorrectionPreview(plan)
  } catch (error) { throw evidenceCorrectionError(error) }
}

type CorrectionReceipt = { status: string; idempotencyKey: string; planHash: string;
  impact: ReturnType<typeof projectEvidenceCorrectionPlan>['impact']; evidenceIds: number[]; committedAt: string }
async function savedReceipt(tx: Reader, request: EvidenceCorrectionRequest, planHash: string) {
  const { rows: [batch] } = await tx.execute<{ requestHash: string; planHash: string; receipt: CorrectionReceipt }>(sql`
    SELECT request_hash AS "requestHash",plan_hash AS "planHash",receipt::json AS receipt
    FROM evidence_correction_batch WHERE idempotency_key=${request.idempotencyKey}`)
  if (!batch) return null
  if (batch.requestHash !== evidenceCorrectionDigest(request) || batch.planHash !== planHash) {
    return fail('idempotency_conflict', 'Key already committed with another request or plan', 409)
  }
  return batch.receipt
}

export async function commitPostgresEvidenceCorrection(db: NodePgDatabase, request: EvidenceCorrectionRequest, planHash: string, filesDir?: string) {
  const previous = await savedReceipt(db, request, planHash)
  if (previous) return previous
  const inspected = await inspectEvidenceCorrectionRequest(request, filesDir)
  try {
    return await runPostgresCorrespondenceTransaction(db, async tx => {
      const replay = await savedReceipt(tx, request, planHash)
      if (replay) return replay
      const { rows: priorFiles } = await tx.execute<{ path: string }>(sql`
        SELECT source_file AS path FROM record_evidence WHERE id=ANY(${ids(request.operations.map(op => op.evidenceId))})`)
      await lockPostgresFilePaths(tx, [...priorFiles.map(row => row.path), ...inspected.keys()])
      await tx.execute(sql`SELECT id FROM record_event WHERE id=ANY(${ids(request.operations.map(op => op.eventId))}) ORDER BY id FOR UPDATE`)
      const plan = await buildPostgresEvidencePlan(tx, request, inspected, filesDir)
      if (plan.planHash !== planHash) return fail('plan_mismatch', 'Preflight impact or source changed; preflight again', 409)
      const receipt: CorrectionReceipt = { status: 'committed', idempotencyKey: request.idempotencyKey, planHash, impact: plan.impact,
        evidenceIds: plan.targets.map(t => t.evidenceId), committedAt: new Date().toISOString() }
      const created = await tx.execute(sql`INSERT INTO evidence_correction_batch(idempotency_key,request_hash,plan_hash,receipt,created_at)
        VALUES(${request.idempotencyKey},${evidenceCorrectionDigest(request)},${planHash},${JSON.stringify(receipt)},${receipt.committedAt})
        ON CONFLICT(idempotency_key) DO NOTHING`)
      if (created.rowCount !== 1) return fail('idempotency_conflict', 'Key already committed with another request or plan', 409)
      const changedEvents = new Map<number, number>(), files = new Set<string>(), declarations = new Map<string, number>()
      for (const target of plan.targets) {
        if (!await writePostgresEvidenceCorrection(tx, target, request,
          { kind: 'evidence_correction', batchKey: request.idempotencyKey }, declarations)) continue
        changedEvents.set(target.eventId, target.event.revision)
        files.add(target.before.sourceFile)
        files.add(target.after.sourceFile)
      }
      for (const [id, revision] of changedEvents) await advancePostgresOfficialEventRevision(tx, id, revision)
      await refreshPostgresDerivedFileParts(tx, files)
      return receipt
    })
  } catch (error) { throw evidenceCorrectionError(error) }
}

export async function writePostgresEvidenceCorrection(tx: Tx,
  target: Awaited<ReturnType<typeof planPostgresEvidenceCorrectionTargets>>[number],
  request: Pick<EvidenceCorrectionRequest, 'actor' | 'basis'>,
  command: OfficialEvidenceCommand, declarations: Map<string, number>,
) {
  const { after, rowChange } = target
  if (evidenceCorrectionDigest(target.before) === evidenceCorrectionDigest(after) && !rowChange?.changed) return false
  const row = await readPostgresExactEvidence(tx, target.evidenceId)
  if (row.version !== target.expectedVersion) return fail('stale_version', 'Evidence changed before write', 409)
  await tx.execute(sql`UPDATE record_evidence SET source_file=${after.sourceFile},attachment=${after.attachment},
    list_no=${after.listNo},page=${after.page} WHERE id=${target.evidenceId}`)
  const revision = rowChange?.changed ? (await writePostgresOfficialPublishedRow(tx, rowChange.publishedRow, target.evidenceId,
    rowChange.expectedRowRevision, command, declarations)).revision : undefined
  const audit = evidenceCorrectionAuditValues(row, after, {
    actor: request.actor, basis: request.basis, entryPoint: 'correction',
    batchKey: command.kind === 'evidence_correction' ? command.batchKey : null,
  }, target.file, rowChange, revision, command.kind === 'import' ? command.batchId : undefined)
  await tx.execute(sql`INSERT INTO evidence_correction_audit(evidence_id,event_id,actor,entry_point,batch_key,basis,before,after,created_at)
    VALUES(${audit.evidenceId},${audit.eventId},${JSON.stringify(audit.actor)},${audit.entryPoint},${audit.batchKey},${audit.basis},
      ${JSON.stringify(audit.before)},${JSON.stringify(audit.after)},${audit.createdAt})`)
  return true
}
