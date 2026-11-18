import { fileClassificationJoin } from './roster-file-classification'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { relative, isAbsolute } from 'node:path'
import { and, asc, count, desc, eq, inArray, ne, or } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { z } from 'zod'
import * as schema from '../../db/schema'
import { normalizeAttachment } from '../../lib/attachment'
import { evidencePreviewHref, isPageCapable } from '../../lib/roster/evidence-page'
import { readPdfPageCount, resolveWithinRoot } from '../../layers/core/server/utils/pdf-pages'
import { advanceOfficialEventRevision } from './roster-event-version'
import { refreshDerivedFileParts } from './file-parts'
import { officialPublishedRowSchema, planOfficialEvidenceChanges, writeOfficialPublishedRow, OfficialFactError, type OfficialClaimChange } from './official-evidence-plan'
import { OfficialEvidenceError } from './official-evidence'

type Db = BetterSQLite3Database<typeof schema>
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type Executor = Db | Tx
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const filled = z.string().trim().min(1).max(4000)
export const evidenceCoordinateSchema = z.strictObject({ sourceFile: filled, attachment: filled.nullable(), listNo: positive.nullable(), page: positive.nullable() })
export const evidenceCorrectionOperationSchema = z.strictObject({ evidenceId: positive, eventId: positive, recordId: positive, enterpriseId: positive, expectedVersion: z.string().regex(/^[a-f0-9]{64}$/), coordinate: evidenceCoordinateSchema, publishedRow: officialPublishedRowSchema.optional(), expectedRowRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1).optional() }).refine(op => op.publishedRow ? op.expectedRowRevision !== undefined : op.expectedRowRevision === undefined, 'publishedRow and expectedRowRevision must be supplied together')
export const evidenceCorrectionRequestSchema = z.strictObject({
  idempotencyKey: z.string().trim().min(1).max(200),
  actor: z.strictObject({ type: z.enum(['user', 'agent']), id: filled }),
  basis: filled,
  operations: z.array(evidenceCorrectionOperationSchema).min(1).max(100),
})
export type EvidenceCorrectionRequest = z.infer<typeof evidenceCorrectionRequestSchema>
export type EvidenceCoordinate = z.infer<typeof evidenceCoordinateSchema>
export class EvidenceCorrectionError extends Error {
  constructor(readonly code: string, message: string, readonly status = 422) { super(message) }
}
function fail(code: string, message: string, status = 422): never { throw new EvidenceCorrectionError(code, message, status) }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const coordinateOf = (row: typeof schema.recordEvidence.$inferSelect): EvidenceCoordinate => ({ sourceFile: row.sourceFile, attachment: row.attachment, listNo: row.listNo, page: row.page })
function fileIdentity(db: Executor, sourceFile: string) {
  return db.select({ id: schema.storedFile.id, relPath: schema.storedFile.relPath, sha256: schema.storedFile.sha256, bytes: schema.storedFile.bytes, removedAt: schema.storedFile.removedAt, source: schema.rosterFileClassification.source, kind: schema.rosterFileClassification.kind, titleCode: schema.rosterFileClassification.titleCode }).from(schema.storedFile).innerJoin(schema.rosterFileClassification, fileClassificationJoin).where(eq(schema.storedFile.relPath, sourceFile)).get() ?? null
}
export function readExactEvidence(db: Executor, evidenceId: number) {
  const row = db.select({ evidence: schema.recordEvidence, event: schema.recordEvent, recordId: schema.record.id, enterpriseId: schema.record.enterpriseId, titleCode: schema.record.titleCode, source: schema.record.source })
    .from(schema.recordEvidence).innerJoin(schema.recordEvent, eq(schema.recordEvent.id, schema.recordEvidence.recordEventId)).innerJoin(schema.record, eq(schema.record.id, schema.recordEvent.recordId)).where(eq(schema.recordEvidence.id, evidenceId)).get()
  if (!row) fail('not_found', 'Evidence not found', 404)
  const file = fileIdentity(db, row.evidence.sourceFile)
  const revision = db.select({ id: schema.evidenceCorrectionAudit.id }).from(schema.evidenceCorrectionAudit).where(eq(schema.evidenceCorrectionAudit.evidenceId, evidenceId)).orderBy(desc(schema.evidenceCorrectionAudit.id)).limit(1).get()?.id ?? 0
  const coordinate = coordinateOf(row.evidence)
  return { evidenceId, eventId: row.event.id, recordId: row.recordId, enterpriseId: row.enterpriseId, source: row.source, titleCode: row.titleCode, event: row.event, coordinate, file, revision, version: hash({ row, file, revision }), sourceHref: evidencePreviewHref(coordinate) }
}

/** Read only the requested file bytes, streaming the digest; never change source content. */
async function inspectSource(filesDir: string | undefined, coordinate: EvidenceCoordinate) {
  if (!filesDir) fail('file_unavailable', 'File root unavailable')
  try {
    const root = await realpath(filesDir!)
    const path = await realpath(resolveWithinRoot(root, coordinate.sourceFile))
    const within = relative(root, path)
    if (isAbsolute(within) || within === '..' || within.startsWith('../')) fail('file_unavailable', 'File path escapes file root')
    const before = await stat(path)
    if (!before.isFile()) fail('file_unavailable', 'Source is not a file')
    const digest = createHash('sha256')
    for await (const chunk of createReadStream(path)) digest.update(chunk)
    const after = await stat(path)
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) fail('file_changed', 'File changed during validation', 409)
    const pageCount = isPageCapable(coordinate.sourceFile) ? await readPdfPageCount(root, relative(root, path)) : null
    const counted = await stat(path)
    if (before.size !== counted.size || before.mtimeMs !== counted.mtimeMs || before.ino !== counted.ino) fail('file_changed', 'File changed during page validation', 409)
    if (coordinate.page !== null) {
      if (!isPageCapable(coordinate.sourceFile)) fail('not_page_capable', 'Source has no stable PDF pages')
      if (pageCount === null) fail('page_count_unknown', 'Cannot read original PDF page count')
      if (coordinate.page > pageCount!) fail('page_invalid', 'Page exceeds original PDF page count')
    }
    return { sha256: digest.digest('hex'), bytes: before.size, pageCount }
  } catch (error) {
    if (error instanceof EvidenceCorrectionError) throw error
    return fail('file_unavailable', 'Original source file unavailable or unsafe')
  }
}
type Inspection = Awaited<ReturnType<typeof inspectSource>>
function validateDestination(db: Executor, row: ReturnType<typeof readExactEvidence>, coordinate: EvidenceCoordinate, inspection: Inspection, strictFile: boolean) {
  const file = fileIdentity(db, coordinate.sourceFile)
  if (strictFile && (!file || file.removedAt || file.source !== 'jxj' || file.kind !== 'announcement' || file.titleCode && file.titleCode !== row.titleCode)) fail('file_identity_conflict', 'An active official announcement file of the same title is required')
  if (file && (file.removedAt || file.sha256 !== inspection.sha256 || file.bytes !== inspection.bytes)) fail('file_changed', 'Original file differs from registered identity', 409)
  // A supplied attachment must belong to the explicitly declared segment, when present.
  const parts = strictFile && file ? db.select({ titleCode: schema.storedFilePart.titleCode, eventKind: schema.storedFilePart.eventKind, year: schema.storedFilePart.year, batch: schema.storedFilePart.batch, attachment: schema.storedFilePart.attachment, hasConflict: schema.storedFilePart.hasConflict }).from(schema.storedFilePart).where(and(eq(schema.storedFilePart.fileId, file.id), inArray(schema.storedFilePart.origin, ['agent', 'legacy']))).limit(1001).all() : []
  if (parts.length > 1000) fail('ambiguous_attachment', 'Too many declared segments; narrow source before correction')
  if (strictFile && parts.length) {
    const matches = parts.filter(p => p.titleCode === row.titleCode && p.eventKind === row.event.eventType && p.year === row.event.year && p.batch === row.event.batchSeq && normalizeAttachment(p.attachment) === normalizeAttachment(coordinate.attachment))
    if (matches.length !== 1 || matches[0]!.hasConflict) fail('attachment_conflict', 'Attachment must match one conflict-free declared event segment')
  }
  return { ...file, ...inspection }
}
export function planEvidenceCorrectionTargets(db: Executor, request: EvidenceCorrectionRequest, inspected: Map<string, Inspection>, typed = request.operations.some(op => op.publishedRow !== undefined)) {
  const seen = new Set<number>()
  const targets = request.operations.map(op => {
    if (seen.has(op.evidenceId)) fail('ambiguous_target', 'Duplicate evidence ID in batch')
    seen.add(op.evidenceId)
    const row = readExactEvidence(db, op.evidenceId)
    if (row.source !== 'jxj' || row.eventId !== op.eventId || row.recordId !== op.recordId || row.enterpriseId !== op.enterpriseId) fail('target_mismatch', 'Evidence, event and ownership IDs must match')
    if (typed && !db.select({ id: schema.enterprise.id }).from(schema.enterprise).where(eq(schema.enterprise.id, row.enterpriseId)).get()) fail('target_mismatch', 'Current real enterprise is required', 409)
    if (row.version !== op.expectedVersion) fail('stale_version', 'Evidence or source version changed', 409)
    const after = { ...op.coordinate, attachment: normalizeAttachment(op.coordinate.attachment) }
    const file = validateDestination(db, row, after, inspected.get(after.sourceFile)!, true)
    // List numbers restart per event segment. Do not use them as a target locator.
    if (!typed && after.listNo !== null) {
      const collisions = db.select({ id: schema.recordEvidence.id, attachment: schema.recordEvidence.attachment, event: schema.recordEvent }).from(schema.recordEvidence).innerJoin(schema.recordEvent, eq(schema.recordEvent.id, schema.recordEvidence.recordEventId))
        .where(and(eq(schema.recordEvidence.sourceFile, after.sourceFile), eq(schema.recordEvidence.listNo, after.listNo), ne(schema.recordEvidence.id, row.evidenceId))).limit(101).all()
      if (collisions.length > 100) fail('ambiguous_target', 'Too many existing coordinate claims; resolve source ambiguity first')
      for (const collision of collisions) {
        const moving = request.operations.find(item => item.evidenceId === collision.id)
        if (moving && hash({ ...moving.coordinate, attachment: normalizeAttachment(moving.coordinate.attachment) }) !== hash(after)) continue
        if (normalizeAttachment(collision.attachment) === after.attachment && collision.event.eventType === row.event.eventType && collision.event.year === row.event.year && collision.event.batchSeq === row.event.batchSeq) fail('coordinate_conflict', 'Destination conflicts with another evidence in the same event segment')
      }
    }
    const correspondenceCount = db.select({ n: count() }).from(schema.recordCorrespondence).where(or(eq(schema.recordCorrespondence.eventId, row.eventId), eq(schema.recordCorrespondence.predecessorEventId, row.eventId))).get()!.n
    const rowChange: OfficialClaimChange | undefined = op.publishedRow ? { ref: `correction:${op.evidenceId}`, evidenceId: op.evidenceId, eventId: op.eventId, owner: `enterprise:${op.enterpriseId}`, titleCode: row.titleCode, coordinate: after, publishedRow: op.publishedRow, expectedRowRevision: op.expectedRowRevision! } : undefined
    if (typed && !rowChange) fail('ambiguity', 'A mixed typed correction batch requires explicit publishedRow for every target')
    return { evidenceId: row.evidenceId, eventId: row.eventId, recordId: row.recordId, enterpriseId: row.enterpriseId, expectedVersion: row.version, before: row.coordinate, beforeFile: row.file, event: row.event, after, file, relatedCorrespondences: correspondenceCount, rowChange }
  })
  for (let i = 0; i < targets.length; i++) for (let j = i + 1; j < targets.length; j++) {
    const a = targets[i]!, b = targets[j]!
    const ae = a.event, be = b.event
    if (!typed && a.after.listNo !== null && a.after.sourceFile === b.after.sourceFile && a.after.attachment === b.after.attachment && a.after.listNo === b.after.listNo && ae.eventType === be.eventType && ae.year === be.year && ae.batchSeq === be.batchSeq) fail('coordinate_conflict', 'Two batch operations claim the same coordinate')
  }
  return targets
}
function buildPlan(db: Executor, request: EvidenceCorrectionRequest, inspected: Map<string, Inspection>, filesDir?: string) {
  const targets = planEvidenceCorrectionTargets(db, request, inspected)
  const changes = targets.flatMap(target => target.rowChange ? [target.rowChange] : [])
  const facts = changes.length ? planOfficialEvidenceChanges(db, changes, filesDir) : null
  const impact = { updated: targets.filter(t => hash(t.before) !== hash(t.after) || t.rowChange?.changed).length, audit: targets.filter(t => hash(t.before) !== hash(t.after) || t.rowChange?.changed).length, correspondencePolicy: 'dynamic_source_fingerprint_revalidation' }
  return { status: 'preflight', targets, impact, planHash: hash({ request, targets, impact, facts: facts?.planHash }) }
}
async function inspectRequest(request: EvidenceCorrectionRequest, filesDir?: string) {
  const inspections = new Map<string, Inspection>()
  // Sequential to bound PDF engines/stream buffers; validate each page even for reused files.
  for (const op of request.operations) {
    const inspection = inspections.get(op.coordinate.sourceFile) ?? await inspectSource(filesDir, op.coordinate)
    if (op.coordinate.page !== null) {
      if (!isPageCapable(op.coordinate.sourceFile)) fail('not_page_capable', 'Source has no stable PDF pages')
      if (inspection.pageCount === null) fail('page_count_unknown', 'Cannot read original PDF page count')
      if (op.coordinate.page > inspection.pageCount!) fail('page_invalid', 'Page exceeds original PDF page count')
    }
    inspections.set(op.coordinate.sourceFile, inspection)
  }
  return inspections
}
export async function preflightEvidenceCorrection(db: Db, request: EvidenceCorrectionRequest, filesDir?: string) {
  const inspected = await inspectRequest(request, filesDir)
  const plan = translateOfficialErrors(() => db.transaction(tx => buildPlan(tx, request, inspected, filesDir), { behavior: 'immediate' }))
  return { ...plan, targets: plan.targets.map(({ rowChange, ...target }) => ({ ...target, ...(rowChange ? { beforeRowRevision: rowChange.before?.revision ?? 0, afterRowRevision: rowChange.expectedRowRevision + Number(rowChange.changed) } : {}) })) }
}
function translateOfficialErrors<T>(run: () => T): T {
  try { return run() } catch (error) {
    if (error instanceof OfficialFactError) throw new EvidenceCorrectionError(error.code, error.message, error.statusCode)
    if (error instanceof OfficialEvidenceError) throw new EvidenceCorrectionError(error.code, error.message, error.statusCode)
    throw error
  }
}

/** The only coordinate writer for exact corrections and the compatibility adapter. */
function writeEvidenceCoordinate(db: Executor, row: ReturnType<typeof readExactEvidence>, coordinate: EvidenceCoordinate, audit: { actor: { type: 'user' | 'agent' | 'legacy'; id: string }; basis: string; entryPoint: 'correction' | 'legacy_pages'; batchKey: string | null }, file: unknown, advanceRevision = true, facts?: { change: OfficialClaimChange; command: import('./official-evidence').OfficialEvidenceCommand; declarations: Map<string, number> }) {
  if (hash(row.coordinate) === hash(coordinate) && !facts?.change.changed) return false
  const current = readExactEvidence(db, row.evidenceId)
  if (current.version !== row.version) fail('stale_version', 'Evidence changed before write', 409)
  db.update(schema.recordEvidence).set(coordinate).where(eq(schema.recordEvidence.id, row.evidenceId)).run()
  const rowRevision = facts?.change.changed ? writeOfficialPublishedRow(db, facts.change.publishedRow, row.evidenceId, facts.change.expectedRowRevision, facts.command, facts.declarations).revision : undefined
  if (advanceRevision) advanceOfficialEventRevision(db, row.eventId, row.event.revision)
  const importRef = facts?.command.kind === 'import' ? { importBatchId: facts.command.batchId } : {}
  db.insert(schema.evidenceCorrectionAudit).values({ evidenceId: row.evidenceId, eventId: row.eventId, ...audit, before: { coordinate: row.coordinate, file: row.file, version: row.version, eventRevision: row.event.revision, ...(facts ? { row: facts.change.before ?? null } : {}), ...importRef }, after: { coordinate, file, eventRevision: row.event.revision + 1, ...(rowRevision !== undefined ? { rowRevision, publishedRow: facts!.change.publishedRow } : {}), ...importRef }, createdAt: new Date().toISOString() }).run()
  return true
}
function replay(db: Executor, request: EvidenceCorrectionRequest, planHash: string) {
  const batch = db.select().from(schema.evidenceCorrectionBatch).where(eq(schema.evidenceCorrectionBatch.idempotencyKey, request.idempotencyKey)).get()
  if (!batch) return null
  if (batch.requestHash !== hash(request) || batch.planHash !== planHash) fail('idempotency_conflict', 'Key already committed with another request or plan', 409)
  return batch.receipt
}
export async function commitEvidenceCorrection(db: Db, request: EvidenceCorrectionRequest, planHash: string, filesDir?: string) {
  const previous = replay(db, request, planHash)
  if (previous) return previous
  const inspected = await inspectRequest(request, filesDir)
  return translateOfficialErrors(() => db.transaction(tx => {
    const raced = replay(tx, request, planHash)
    if (raced) return raced
    const plan = buildPlan(tx, request, inspected, filesDir)
    if (plan.planHash !== planHash) fail('plan_mismatch', 'Preflight impact or source changed; preflight again', 409)
    const receipt = { status: 'committed', idempotencyKey: request.idempotencyKey, planHash, impact: plan.impact, evidenceIds: plan.targets.map(t => t.evidenceId), committedAt: new Date().toISOString() }
    tx.insert(schema.evidenceCorrectionBatch).values({ idempotencyKey: request.idempotencyKey, requestHash: hash(request), planHash, receipt, createdAt: receipt.committedAt }).run()
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
  const inspections = new Map<string, Inspection>()
  return async (input: { evidenceId: number; previous: number | null; page: number; basis?: string; dryRun?: boolean }) => {
    const row = readExactEvidence(db, input.evidenceId)
    if (row.coordinate.page !== input.previous) fail('stale_version', 'Legacy candidate page changed', 409)
    const coordinate = { ...row.coordinate, page: input.page }
    const inspection = inspections.get(coordinate.sourceFile) ?? await inspectSource(filesDir, coordinate)
    inspections.set(coordinate.sourceFile, inspection)
    if (!isPageCapable(coordinate.sourceFile)) fail('not_page_capable', 'Source has no stable PDF pages')
    if (inspection.pageCount === null) fail('page_count_unknown', 'Cannot read original PDF page count')
    if (coordinate.page > inspection.pageCount!) fail('page_invalid', 'Page exceeds original PDF page count')
    return db.transaction(tx => {
      const file = validateDestination(tx, row, coordinate, inspection, false)
      if (input.dryRun) return false
      const changed = writeEvidenceCoordinate(tx, row, coordinate, { actor: { type: 'legacy', id: 'evidence-pages-adapter' }, basis: input.basis ?? 'Legacy page entry; basis not supplied', entryPoint: 'legacy_pages', batchKey: null }, file)
      if (changed) refreshDerivedFileParts(tx, [row.coordinate.sourceFile, coordinate.sourceFile])
      return changed
    }, { behavior: 'immediate' })
  }
}
