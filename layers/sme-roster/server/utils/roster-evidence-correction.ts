import { fail, projectExactEvidence, type EvidencePlanInput, type EvidenceCorrectionRequest, type Inspection, projectEvidenceCorrectionTargets, projectEvidenceCorrectionPlan, inspectEvidenceCorrectionRequest, projectEvidenceCorrectionPreview, evidenceCorrectionError, type EvidenceCoordinate, evidenceCorrectionDigest, evidenceCorrectionAuditValues, createLegacyEvidencePageInspection, type LegacyEvidencePageInput, legacyEvidencePageFile, legacyEvidencePageAudit } from './roster-evidence-correction-model'
import { fileClassificationJoin } from './roster-file-classification'
import { and, asc, count, desc, eq, inArray, ne, or } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../../db/schema'
import { advanceOfficialEventRevision } from './roster-event-version'
import { refreshDerivedFileParts } from './file-parts'
import { planOfficialEvidenceChanges, writeOfficialPublishedRow } from './official-evidence-plan'
import { type OfficialClaimChange } from './official-evidence-claim-model'
type Db = BetterSQLite3Database<typeof schema>
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type Executor = Db | Tx
export function fileIdentity(db: Executor, sourceFile: string) {
  return db.select({ id: schema.storedFile.id, relPath: schema.storedFile.relPath, sha256: schema.storedFile.sha256, bytes: schema.storedFile.bytes, removedAt: schema.storedFile.removedAt, source: schema.rosterFileClassification.source, kind: schema.rosterFileClassification.kind, titleCode: schema.rosterFileClassification.titleCode }).from(schema.storedFile).innerJoin(schema.rosterFileClassification, fileClassificationJoin).where(eq(schema.storedFile.relPath, sourceFile)).get() ?? null
}
export function readExactEvidence(db: Executor, evidenceId: number) {
  const row = db.select({ evidence: schema.recordEvidence, event: schema.recordEvent, recordId: schema.record.id, enterpriseId: schema.record.enterpriseId, titleCode: schema.record.titleCode, source: schema.record.source })
    .from(schema.recordEvidence).innerJoin(schema.recordEvent, eq(schema.recordEvent.id, schema.recordEvidence.recordEventId)).innerJoin(schema.record, eq(schema.record.id, schema.recordEvent.recordId)).where(eq(schema.recordEvidence.id, evidenceId)).get()
  if (!row) fail('not_found', 'Evidence not found', 404)
  const file = fileIdentity(db, row.evidence.sourceFile)
  const revision = db.select({ id: schema.evidenceCorrectionAudit.id }).from(schema.evidenceCorrectionAudit).where(eq(schema.evidenceCorrectionAudit.evidenceId, evidenceId)).orderBy(desc(schema.evidenceCorrectionAudit.id)).limit(1).get()?.id ?? 0
  return projectExactEvidence(row, file, revision)
}
function readEvidencePlanInput(db: Executor, input: EvidencePlanInput) {
  if (input.type === 'evidence') return readExactEvidence(db, input.id)
  if (input.type === 'enterprise') return !!db.select({ id: schema.enterprise.id }).from(schema.enterprise).where(eq(schema.enterprise.id, input.id)).get()
  if (input.type === 'file') return fileIdentity(db, input.sourceFile)
  if (input.type === 'parts') return db.select({ titleCode: schema.storedFilePart.titleCode, eventKind: schema.storedFilePart.eventKind, year: schema.storedFilePart.year, batch: schema.storedFilePart.batch, attachment: schema.storedFilePart.attachment, hasConflict: schema.storedFilePart.hasConflict }).from(schema.storedFilePart).where(and(eq(schema.storedFilePart.fileId, input.fileId), inArray(schema.storedFilePart.origin, ['agent', 'legacy']))).limit(1001).all()
  if (input.type === 'collisions') return db.select({ id: schema.recordEvidence.id, attachment: schema.recordEvidence.attachment, event: schema.recordEvent }).from(schema.recordEvidence).innerJoin(schema.recordEvent, eq(schema.recordEvent.id, schema.recordEvidence.recordEventId))
        .where(and(eq(schema.recordEvidence.sourceFile, input.coordinate.sourceFile), eq(schema.recordEvidence.listNo, input.coordinate.listNo!), ne(schema.recordEvidence.id, input.id))).limit(101).all()
  return db.select({ n: count() }).from(schema.recordCorrespondence)
    .where(or(eq(schema.recordCorrespondence.eventId, input.eventId), eq(schema.recordCorrespondence.predecessorEventId, input.eventId))).get()!.n
}
export function planEvidenceCorrectionTargets(db: Executor, request: EvidenceCorrectionRequest, inspected: Map<string, Inspection>, typed = request.operations.some(op => op.publishedRow !== undefined)) {
  const query = projectEvidenceCorrectionTargets(request, inspected, typed)
  let next = query.next()
  while (!next.done) next = query.next(readEvidencePlanInput(db, next.value))
  return next.value
}
function buildPlan(db: Executor, request: EvidenceCorrectionRequest, inspected: Map<string, Inspection>, filesDir?: string) {
  const targets = planEvidenceCorrectionTargets(db, request, inspected)
  const changes = targets.flatMap(target => target.rowChange ? [target.rowChange] : [])
  const facts = changes.length ? planOfficialEvidenceChanges(db, changes, filesDir) : null
  return projectEvidenceCorrectionPlan(request, targets, facts?.planHash)
}
export async function preflightEvidenceCorrection(db: Db, request: EvidenceCorrectionRequest, filesDir?: string) {
  const inspected = await inspectEvidenceCorrectionRequest(request, filesDir)
  const plan = translateOfficialErrors(() => db.transaction(tx => buildPlan(tx, request, inspected, filesDir), { behavior: 'immediate' }))
  return projectEvidenceCorrectionPreview(plan)
}
function translateOfficialErrors<T>(run: () => T): T {
  try { return run() } catch (error) { throw evidenceCorrectionError(error) }
}
/** The only coordinate writer for exact corrections and the compatibility adapter. */
function writeEvidenceCoordinate(db: Executor, row: ReturnType<typeof readExactEvidence>, coordinate: EvidenceCoordinate, audit: { actor: { type: 'user' | 'agent' | 'legacy'; id: string }; basis: string; entryPoint: 'correction' | 'legacy_pages'; batchKey: string | null }, file: unknown, advanceRevision = true, facts?: { change: OfficialClaimChange; command: import('./official-evidence').OfficialEvidenceCommand; declarations: Map<string, number> }) {
  if (evidenceCorrectionDigest(row.coordinate) === evidenceCorrectionDigest(coordinate) && !facts?.change.changed) return false
  const current = readExactEvidence(db, row.evidenceId)
  if (current.version !== row.version) fail('stale_version', 'Evidence changed before write', 409)
  db.update(schema.recordEvidence).set(coordinate).where(eq(schema.recordEvidence.id, row.evidenceId)).run()
  const rowRevision = facts?.change.changed ? writeOfficialPublishedRow(db, facts.change.publishedRow, row.evidenceId, facts.change.expectedRowRevision, facts.command, facts.declarations).revision : undefined
  if (advanceRevision) advanceOfficialEventRevision(db, row.eventId, row.event.revision)
  db.insert(schema.evidenceCorrectionAudit).values(evidenceCorrectionAuditValues(row, coordinate, audit, file, facts?.change, rowRevision,
    facts?.command.kind === 'import' ? facts.command.batchId : undefined)).run()
  return true
}
function replay(db: Executor, request: EvidenceCorrectionRequest, planHash: string) {
  const batch = db.select().from(schema.evidenceCorrectionBatch).where(eq(schema.evidenceCorrectionBatch.idempotencyKey, request.idempotencyKey)).get()
  if (!batch) return null
  if (batch.requestHash !== evidenceCorrectionDigest(request) || batch.planHash !== planHash) fail('idempotency_conflict', 'Key already committed with another request or plan', 409)
  return batch.receipt
}
export async function commitEvidenceCorrection(db: Db, request: EvidenceCorrectionRequest, planHash: string, filesDir?: string) {
  const previous = replay(db, request, planHash)
  if (previous) return previous
  const inspected = await inspectEvidenceCorrectionRequest(request, filesDir)
  return translateOfficialErrors(() => db.transaction(tx => {
    const raced = replay(tx, request, planHash)
    if (raced) return raced
    const plan = buildPlan(tx, request, inspected, filesDir)
    if (plan.planHash !== planHash) fail('plan_mismatch', 'Preflight impact or source changed; preflight again', 409)
    const receipt = { status: 'committed', idempotencyKey: request.idempotencyKey, planHash, impact: plan.impact, evidenceIds: plan.targets.map(t => t.evidenceId), committedAt: new Date().toISOString() }
    tx.insert(schema.evidenceCorrectionBatch).values({ idempotencyKey: request.idempotencyKey, requestHash: evidenceCorrectionDigest(request), planHash, receipt, createdAt: receipt.committedAt }).run()
    const changedEvents = new Map<number, number>()
    const changedFiles = new Set<string>()
    const declarations = new Map<string, number>()
    for (const target of plan.targets) {
      const changed = writeEvidenceCoordinate(tx, readExactEvidence(tx, target.evidenceId), target.after, { actor: request.actor, basis: request.basis, entryPoint: 'correction', batchKey: request.idempotencyKey }, target.file, false, target.rowChange ? { change: target.rowChange, command: { kind: 'evidence_correction', batchKey: request.idempotencyKey }, declarations } : undefined)
      if (changed) {
        changedEvents.set(target.eventId, target.event.revision)
        changedFiles.add(target.before.sourceFile)
        changedFiles.add(target.after.sourceFile)
      }
    }
    for (const [eventId, revision] of changedEvents) advanceOfficialEventRevision(tx, eventId, revision)
    refreshDerivedFileParts(tx, changedFiles)
    return receipt
  }, { behavior: 'immediate' }))
}
/** Import has already validated all original versions and the common final set under IMMEDIATE. */
export function writeImportedEvidenceCorrection(db: Executor, target: ReturnType<typeof planEvidenceCorrectionTargets>[number], request: Pick<EvidenceCorrectionRequest, 'actor' | 'basis'>, batchId: number, declarations: Map<string, number>) {
  return writeEvidenceCoordinate(db, readExactEvidence(db, target.evidenceId), target.after, { actor: request.actor, basis: request.basis, entryPoint: 'correction', batchKey: null }, target.file, false, target.rowChange ? { change: target.rowChange, command: { kind: 'import', batchId }, declarations } : undefined)
}
export function readEvidenceCorrectionBatch(db: Executor, key: string) {
  return db.select({ receipt: schema.evidenceCorrectionBatch.receipt }).from(schema.evidenceCorrectionBatch).where(eq(schema.evidenceCorrectionBatch.idempotencyKey, key)).get()?.receipt ?? null
}
export function readEvidenceCorrectionAudit(db: Executor, evidenceId: number, page: number, pageSize: number) {
  readExactEvidence(db, evidenceId)
  const where = eq(schema.evidenceCorrectionAudit.evidenceId, evidenceId)
  return { rows: db.select().from(schema.evidenceCorrectionAudit).where(where).orderBy(asc(schema.evidenceCorrectionAudit.id)).limit(pageSize).offset((page - 1) * pageSize).all(), total: db.select({ n: count() }).from(schema.evidenceCorrectionAudit).where(where).get()!.n, page, pageSize }
}
/** Preserve the legacy per-row protocol and reuse file inspection within one request. */
export function createLegacyEvidencePageAdapter(db: Db, filesDir?: string) {
  const inspect = createLegacyEvidencePageInspection(filesDir)
  return async (input: LegacyEvidencePageInput) => {
    const row = readExactEvidence(db, input.evidenceId)
    const { coordinate, inspection } = await inspect(row, input)
    return db.transaction(tx => {
      const file = legacyEvidencePageFile(row, fileIdentity(tx, coordinate.sourceFile), inspection)
      if (input.dryRun) return false
      const changed = writeEvidenceCoordinate(tx, row, coordinate, legacyEvidencePageAudit(input.basis), file)
      if (changed) refreshDerivedFileParts(tx, [row.coordinate.sourceFile, coordinate.sourceFile])
      return changed
    }, { behavior: 'immediate' })
  }
}
export { evidenceCoordinateSchema, evidenceCorrectionOperationSchema, evidenceCorrectionRequestSchema, type EvidenceCorrectionRequest, type EvidenceCoordinate, EvidenceCorrectionError, evidenceCorrectionDigest, projectExactEvidence, projectEvidenceCorrectionTargets, projectEvidenceCorrectionPlan, inspectEvidenceCorrectionRequest, projectEvidenceCorrectionPreview, evidenceCorrectionError, evidenceCorrectionAuditValues, type LegacyEvidencePageInput, createLegacyEvidencePageInspection, legacyEvidencePageFile, legacyEvidencePageAudit } from './roster-evidence-correction-model'
