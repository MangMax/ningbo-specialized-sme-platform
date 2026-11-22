import type { OfficialEventRow } from './roster-event-version-model'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { relative, isAbsolute } from 'node:path'
import { z } from 'zod'
import type { recordEvidence as RecordEvidenceTable } from '../../../../db/postgresql/ledger-tables'
import type { storedFilePart as StoredFilePartTable } from '../../../../db/postgresql/roster-file-tables'
import { normalizeAttachment } from '../../lib/attachment'
import { evidencePreviewHref, isPageCapable } from '../../lib/roster/evidence-page'
import { readPdfPageCount, resolveWithinRoot } from '../../../core/server/utils/pdf-pages'
import { officialPublishedRowSchema, OfficialFactError, type OfficialClaimChange } from './official-evidence-claim-model'
import { OfficialEvidenceError } from './official-evidence'
import type { storedFile } from '../../../../db/postgresql/file-tables'
import type { rosterFileClassification } from '../../../../db/postgresql/roster-file-tables'

type EvidenceFile = Pick<typeof storedFile.$inferSelect, 'id' | 'relPath' | 'sha256' | 'removedAt'>
  & { bytes: number } & Pick<typeof rosterFileClassification.$inferSelect, 'source' | 'kind' | 'titleCode'>

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

export const evidenceCorrectionDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

const coordinateOf = (row: typeof RecordEvidenceTable.$inferSelect): EvidenceCoordinate => ({ sourceFile: row.sourceFile, attachment: row.attachment, listNo: row.listNo, page: row.page })

export function projectExactEvidence(row: {
  evidence: typeof RecordEvidenceTable.$inferSelect; event: OfficialEventRow
  recordId: number; enterpriseId: number; titleCode: string; source: 'jxj' | 'miit'
}, file: EvidenceFile | null, revision: number) {
  const evidenceId = row.evidence.id
  const coordinate = coordinateOf(row.evidence)
  return { evidenceId, eventId: row.event.id, recordId: row.recordId, enterpriseId: row.enterpriseId, source: row.source, titleCode: row.titleCode, event: row.event, coordinate, file, revision, version: evidenceCorrectionDigest({ row, file, revision }), sourceHref: evidencePreviewHref(coordinate) }
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

export type Inspection = Awaited<ReturnType<typeof inspectSource>>

type ExactEvidence = ReturnType<typeof projectExactEvidence>

type DestinationPart = Pick<typeof StoredFilePartTable.$inferSelect, 'titleCode' | 'eventKind' | 'year' | 'batch' | 'attachment' | 'hasConflict'>

export type EvidencePlanInput = { type: 'evidence'; id: number } | { type: 'enterprise'; id: number } | { type: 'file'; sourceFile: string }
  | { type: 'parts'; fileId: number } | { type: 'collisions'; coordinate: EvidenceCoordinate; id: number } | { type: 'correspondences'; eventId: number }

type EvidencePlanValues = {
  evidence: ExactEvidence
  enterprise: boolean
  file: EvidenceFile | null
  parts: DestinationPart[]
  collisions: { id: number; attachment: string | null; event: OfficialEventRow }[]
  correspondences: number
}

function* evidenceInput<T extends EvidencePlanInput['type']>(input: Extract<EvidencePlanInput, { type: T }>): Generator<EvidencePlanInput, EvidencePlanValues[T], unknown> {
  return (yield input) as EvidencePlanValues[T]
}

function validateFile(row: ExactEvidence, file: EvidenceFile | null, inspection: Inspection, strictFile: boolean) {
  if (strictFile && (!file || file.removedAt || file.source !== 'jxj' || file.kind !== 'announcement' || file.titleCode && file.titleCode !== row.titleCode)) fail('file_identity_conflict', 'An active official announcement file of the same title is required')
  if (file && (file.removedAt || file.sha256 !== inspection.sha256 || file.bytes !== inspection.bytes)) fail('file_changed', 'Original file differs from registered identity', 409)
}

function validateParts(row: ExactEvidence, coordinate: EvidenceCoordinate, parts: DestinationPart[]) {
  if (parts.length > 1000) fail('ambiguous_attachment', 'Too many declared segments; narrow source before correction')
  if (parts.length) {
    const matches = parts.filter(p => p.titleCode === row.titleCode && p.eventKind === row.event.eventType && p.year === row.event.year && p.batch === row.event.batchSeq && normalizeAttachment(p.attachment) === normalizeAttachment(coordinate.attachment))
    if (matches.length !== 1 || matches[0]!.hasConflict) fail('attachment_conflict', 'Attachment must match one conflict-free declared event segment')
  }
}

export function* projectEvidenceCorrectionTargets(request: EvidenceCorrectionRequest, inspected: Map<string, Inspection>, typed = request.operations.some(op => op.publishedRow !== undefined)) {
  const seen = new Set<number>()
  const targets = []
  for (const op of request.operations) {
    if (seen.has(op.evidenceId)) fail('ambiguous_target', 'Duplicate evidence ID in batch')
    seen.add(op.evidenceId)
    const row = yield* evidenceInput<'evidence'>({ type: 'evidence', id: op.evidenceId })
    if (row.source !== 'jxj' || row.eventId !== op.eventId || row.recordId !== op.recordId || row.enterpriseId !== op.enterpriseId) fail('target_mismatch', 'Evidence, event and ownership IDs must match')
    if (typed && !(yield* evidenceInput<'enterprise'>({ type: 'enterprise', id: row.enterpriseId }))) fail('target_mismatch', 'Current real enterprise is required', 409)
    if (row.version !== op.expectedVersion) fail('stale_version', 'Evidence or source version changed', 409)
    const after = { ...op.coordinate, attachment: normalizeAttachment(op.coordinate.attachment) }
    const registered = yield* evidenceInput<'file'>({ type: 'file', sourceFile: after.sourceFile })
    const inspection = inspected.get(after.sourceFile)!
    validateFile(row, registered, inspection, true)
    validateParts(row, after, yield* evidenceInput<'parts'>({ type: 'parts', fileId: registered!.id }))
    const file = { ...registered, ...inspection }
    // List numbers restart per event segment. Do not use them as a target locator.
    if (!typed && after.listNo !== null) {
      const collisions = yield* evidenceInput<'collisions'>({ type: 'collisions', coordinate: after, id: row.evidenceId })
      if (collisions.length > 100) fail('ambiguous_target', 'Too many existing coordinate claims; resolve source ambiguity first')
      for (const collision of collisions) {
        const moving = request.operations.find(item => item.evidenceId === collision.id)
        if (moving && evidenceCorrectionDigest({ ...moving.coordinate, attachment: normalizeAttachment(moving.coordinate.attachment) }) !== evidenceCorrectionDigest(after)) continue
        if (normalizeAttachment(collision.attachment) === after.attachment && collision.event.eventType === row.event.eventType && collision.event.year === row.event.year && collision.event.batchSeq === row.event.batchSeq) fail('coordinate_conflict', 'Destination conflicts with another evidence in the same event segment')
      }
    }
    const correspondenceCount = yield* evidenceInput<'correspondences'>({ type: 'correspondences', eventId: row.eventId })
    const rowChange: OfficialClaimChange | undefined = op.publishedRow ? { ref: `correction:${op.evidenceId}`, evidenceId: op.evidenceId, eventId: op.eventId, owner: `enterprise:${op.enterpriseId}`, titleCode: row.titleCode, coordinate: after, publishedRow: op.publishedRow, expectedRowRevision: op.expectedRowRevision! } : undefined
    if (typed && !rowChange) fail('ambiguity', 'A mixed typed correction batch requires explicit publishedRow for every target')
    targets.push({ evidenceId: row.evidenceId, eventId: row.eventId, recordId: row.recordId, enterpriseId: row.enterpriseId, expectedVersion: row.version, before: row.coordinate, beforeFile: row.file, event: row.event, after, file, relatedCorrespondences: correspondenceCount, rowChange })
  }
  for (let i = 0; i < targets.length; i++) for (let j = i + 1; j < targets.length; j++) {
    const a = targets[i]!, b = targets[j]!
    const ae = a.event, be = b.event
    if (!typed && a.after.listNo !== null && a.after.sourceFile === b.after.sourceFile && a.after.attachment === b.after.attachment && a.after.listNo === b.after.listNo && ae.eventType === be.eventType && ae.year === be.year && ae.batchSeq === be.batchSeq) fail('coordinate_conflict', 'Two batch operations claim the same coordinate')
  }
  return targets
}

export function projectEvidenceCorrectionPlan(request: EvidenceCorrectionRequest, targets: ReturnType<typeof projectEvidenceCorrectionTargets> extends Generator<unknown, infer Result> ? Result : never, factsHash?: string) {
  const impact = { updated: targets.filter(t => evidenceCorrectionDigest(t.before) !== evidenceCorrectionDigest(t.after) || t.rowChange?.changed).length, audit: targets.filter(t => evidenceCorrectionDigest(t.before) !== evidenceCorrectionDigest(t.after) || t.rowChange?.changed).length, correspondencePolicy: 'dynamic_source_fingerprint_revalidation' }
  return { status: 'preflight', targets, impact, planHash: evidenceCorrectionDigest({ request, targets, impact, facts: factsHash }) }
}

export async function inspectEvidenceCorrectionRequest(request: EvidenceCorrectionRequest, filesDir?: string) {
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

export function projectEvidenceCorrectionPreview(plan: ReturnType<typeof projectEvidenceCorrectionPlan>) {
  return { ...plan, targets: plan.targets.map(({ rowChange, ...target }) => ({ ...target, ...(rowChange ? { beforeRowRevision: rowChange.before?.revision ?? 0, afterRowRevision: rowChange.expectedRowRevision + Number(rowChange.changed) } : {}) })) }
}

export function evidenceCorrectionError(error: unknown) {
  if (error instanceof OfficialFactError || error instanceof OfficialEvidenceError) return new EvidenceCorrectionError(error.code, error.message, error.statusCode)
  return error
}

export function evidenceCorrectionAuditValues(row: ExactEvidence, coordinate: EvidenceCoordinate,
  audit: { actor: { type: 'user' | 'agent' | 'legacy'; id: string }; basis: string; entryPoint: 'correction' | 'legacy_pages'; batchKey: string | null },
  file: unknown, change?: OfficialClaimChange, rowRevision?: number, importBatchId?: number,
) {
  const importRef = importBatchId === undefined ? {} : { importBatchId }
  return { evidenceId: row.evidenceId, eventId: row.eventId, ...audit,
    before: { coordinate: row.coordinate, file: row.file, version: row.version, eventRevision: row.event.revision, ...(change ? { row: change.before ?? null } : {}), ...importRef },
    after: { coordinate, file, eventRevision: row.event.revision + 1,
      ...(rowRevision !== undefined ? { rowRevision, publishedRow: change!.publishedRow } : {}), ...importRef },
    createdAt: new Date().toISOString(),
  }
}

export type LegacyEvidencePageInput = { evidenceId: number; previous: number | null; page: number; basis?: string; dryRun?: boolean }

export function createLegacyEvidencePageInspection(filesDir?: string) {
  const inspections = new Map<string, Inspection>()
  return async (row: ExactEvidence, input: LegacyEvidencePageInput) => {
    if (row.coordinate.page !== input.previous) fail('stale_version', 'Legacy candidate page changed', 409)
    const coordinate = { ...row.coordinate, page: input.page }
    const inspection = inspections.get(coordinate.sourceFile) ?? await inspectSource(filesDir, coordinate)
    inspections.set(coordinate.sourceFile, inspection)
    if (!isPageCapable(coordinate.sourceFile)) fail('not_page_capable', 'Source has no stable PDF pages')
    if (inspection.pageCount === null) fail('page_count_unknown', 'Cannot read original PDF page count')
    if (coordinate.page > inspection.pageCount!) fail('page_invalid', 'Page exceeds original PDF page count')
    return { coordinate, inspection }
  }
}

export function legacyEvidencePageFile(row: ExactEvidence, file: ExactEvidence['file'], inspection: Inspection) {
  validateFile(row, file, inspection, false)
  return { ...file, ...inspection }
}

export function legacyEvidencePageAudit(basis?: string) {
  return {
    actor: { type: 'legacy', id: 'evidence-pages-adapter' },
    basis: basis ?? 'Legacy page entry; basis not supplied', entryPoint: 'legacy_pages', batchKey: null,
  } as const
}
