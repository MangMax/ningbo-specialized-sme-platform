import { and, asc, eq, inArray, ne } from 'drizzle-orm'
import { enterprise } from '../../../../db/postgresql/enterprise-tables'
import { storedFile } from '../../../../db/postgresql/file-tables'
import { recordEvent, recordEvidence } from '../../../../db/postgresql/ledger-tables'
import { evidenceCorrectionAudit, evidenceCorrectionBatch } from '../../../../db/postgresql/official-evidence-tables'
import { rosterFileClassification, storedFilePart } from '../../../../db/postgresql/roster-file-tables'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { EvidencePageCandidate } from '../../lib/roster/evidence-page'
import { createLegacyEvidencePageInspection, legacyEvidencePageAudit, legacyEvidencePageFile, type LegacyEvidencePageInput, evidenceCorrectionAuditValues, evidenceCorrectionDigest, evidenceCorrectionError, EvidenceCorrectionError, inspectEvidenceCorrectionRequest, projectEvidenceCorrectionPlan, projectEvidenceCorrectionPreview, projectEvidenceCorrectionTargets, type EvidenceCorrectionRequest } from './roster-evidence-correction-model'
import type { OfficialEvidenceCommand } from './official-evidence'
import { readPostgresExactEvidence } from './official-evidence-postgres'
import { planPostgresOfficialEvidenceChanges } from './official-evidence-plan-postgres'
import { writePostgresOfficialPublishedRow } from './official-evidence-write-postgres'
import { advancePostgresOfficialEventRevision } from './evidence-revision-postgres'
import { lockPostgresFilePaths, refreshPostgresDerivedFileParts } from './file-parts-postgres'
import { runPostgresSerializableTransaction } from './postgres-serializable-transaction'

type Reader = Pick<NodePgDatabase, 'execute' | 'select'>
type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
type Query = Exclude<ReturnType<ReturnType<typeof projectEvidenceCorrectionTargets>['next']>, {done: true}>['value']
const snapshot = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const
const fail = (code: string, message: string, status = 422): never => { throw new EvidenceCorrectionError(code, message, status) }

async function appendCorrectionAudit(tx: Tx, audit: ReturnType<typeof evidenceCorrectionAuditValues>) {
  await tx.insert(evidenceCorrectionAudit).values({
    ...audit, actor: JSON.stringify(audit.actor), before: JSON.stringify(audit.before), after: JSON.stringify(audit.after),
  })
}

export function createPostgresLegacyEvidencePageAdapter(db: NodePgDatabase, filesDir?: string) {
  const inspect = createLegacyEvidencePageInspection(filesDir)
  return async (input: LegacyEvidencePageInput & { candidate: EvidencePageCandidate }) => {
    const row = await readPostgresExactEvidence(db, input.evidenceId)
    const { candidate } = input
    if (row.enterpriseId !== candidate.enterpriseId || row.coordinate.sourceFile !== candidate.sourceFile ||
      row.coordinate.listNo !== candidate.listNo) {
      return fail('stale_version', 'Legacy candidate identity changed', 409)
    }
    const { coordinate, inspection } = await inspect(row, input)
    const verify = async (tx: Tx) => {
      const current = await readPostgresExactEvidence(tx, row.evidenceId)
      if (current.version !== row.version) return fail('stale_version', 'Evidence changed before write', 409)
      return legacyEvidencePageFile(current, current.file, inspection)
    }
    if (input.dryRun) {
      await db.transaction(verify, snapshot)
      return false
    }
    return runPostgresSerializableTransaction(db, async tx => {
      await lockPostgresFilePaths(tx, [coordinate.sourceFile])
      await tx.select({ id: recordEvent.id }).from(recordEvent).where(eq(recordEvent.id, row.eventId)).for('update')
      const file = await verify(tx)
      await tx.update(recordEvidence).set({ page: coordinate.page }).where(eq(recordEvidence.id, row.evidenceId))
      await advancePostgresOfficialEventRevision(tx, row.eventId, row.event.revision)
      await appendCorrectionAudit(tx, evidenceCorrectionAuditValues(row, coordinate, legacyEvidencePageAudit(input.basis), file))
      await refreshPostgresDerivedFileParts(tx, [coordinate.sourceFile])
      return true
    })
  }
}

async function readTargetInput(tx: Reader, input: Query) {
  if (input.type === 'evidence') return readPostgresExactEvidence(tx, input.id)
  if (input.type === 'enterprise') return Boolean((await tx.select({ id: enterprise.id }).from(enterprise)
    .where(eq(enterprise.id, input.id))).length)
  if (input.type === 'file') {
    const [file] = await tx.select({
      id: storedFile.id, relPath: storedFile.relPath, sha256: storedFile.sha256, bytes: storedFile.bytes, removedAt: storedFile.removedAt,
      source: rosterFileClassification.source, kind: rosterFileClassification.kind, titleCode: rosterFileClassification.titleCode,
    }).from(storedFile).innerJoin(rosterFileClassification, eq(rosterFileClassification.fileId, storedFile.id))
      .where(eq(storedFile.relPath, input.sourceFile))
    return file ? { ...file, bytes: Number(file.bytes) } : null
  }
  if (input.type === 'parts') {
    return tx.select().from(storedFilePart).where(and(
      eq(storedFilePart.fileId, input.fileId), inArray(storedFilePart.origin, ['agent', 'legacy']),
    )).orderBy(asc(storedFilePart.id)).limit(1001)
  }
  const listNo = input.coordinate.listNo
  if (listNo === null) return []
  const rows = await tx.select({ id: recordEvidence.id, attachment: recordEvidence.attachment, event: recordEvent })
    .from(recordEvidence).innerJoin(recordEvent, eq(recordEvent.id, recordEvidence.recordEventId)).where(and(
      eq(recordEvidence.sourceFile, input.coordinate.sourceFile), eq(recordEvidence.listNo, listNo), ne(recordEvidence.id, input.id),
    )).limit(101)
  return rows.map(row => ({ ...row,
    event: { ...row.event, formalValidity: row.event.formalValidity === null ? null : JSON.parse(row.event.formalValidity) },
  }))
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
  const [batch] = await tx.select().from(evidenceCorrectionBatch)
    .where(eq(evidenceCorrectionBatch.idempotencyKey, request.idempotencyKey))
  if (!batch) return null
  if (batch.requestHash !== evidenceCorrectionDigest(request) || batch.planHash !== planHash) {
    return fail('idempotency_conflict', 'Key already committed with another request or plan', 409)
  }
  return JSON.parse(batch.receipt) as CorrectionReceipt
}

export async function commitPostgresEvidenceCorrection(db: NodePgDatabase, request: EvidenceCorrectionRequest, planHash: string, filesDir?: string) {
  const previous = await savedReceipt(db, request, planHash)
  if (previous) return previous
  const inspected = await inspectEvidenceCorrectionRequest(request, filesDir)
  try {
    return await runPostgresSerializableTransaction(db, async tx => {
      const replay = await savedReceipt(tx, request, planHash)
      if (replay) return replay
      const priorFiles = await tx.select({ path: recordEvidence.sourceFile }).from(recordEvidence)
        .where(inArray(recordEvidence.id, request.operations.map(op => op.evidenceId)))
      await lockPostgresFilePaths(tx, [...priorFiles.map(row => row.path), ...inspected.keys()])
      await tx.select({ id: recordEvent.id }).from(recordEvent)
        .where(inArray(recordEvent.id, request.operations.map(op => op.eventId))).orderBy(asc(recordEvent.id)).for('update')
      const plan = await buildPostgresEvidencePlan(tx, request, inspected, filesDir)
      if (plan.planHash !== planHash) return fail('plan_mismatch', 'Preflight plan or source changed; preflight again', 409)
      const receipt: CorrectionReceipt = { status: 'committed', idempotencyKey: request.idempotencyKey, planHash, impact: plan.impact,
        evidenceIds: plan.targets.map(t => t.evidenceId), committedAt: new Date().toISOString() }
      const created = await tx.insert(evidenceCorrectionBatch).values({
        idempotencyKey: request.idempotencyKey, requestHash: evidenceCorrectionDigest(request), planHash,
        receipt: JSON.stringify(receipt), createdAt: receipt.committedAt,
      }).onConflictDoNothing({ target: evidenceCorrectionBatch.idempotencyKey }).returning({ key: evidenceCorrectionBatch.idempotencyKey })
      if (created.length !== 1) return fail('idempotency_conflict', 'Key already committed with another request or plan', 409)
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
  await tx.update(recordEvidence).set(after).where(eq(recordEvidence.id, target.evidenceId))
  const revision = rowChange?.changed ? (await writePostgresOfficialPublishedRow(tx, rowChange.publishedRow, target.evidenceId,
    rowChange.expectedRowRevision, command, declarations)).revision : undefined
  const audit = evidenceCorrectionAuditValues(row, after, {
    actor: request.actor, basis: request.basis, entryPoint: 'correction',
    batchKey: command.kind === 'evidence_correction' ? command.batchKey : null,
  }, target.file, rowChange, revision, command.kind === 'import' ? command.batchId : undefined)
  await appendCorrectionAudit(tx, audit)
  return true
}
