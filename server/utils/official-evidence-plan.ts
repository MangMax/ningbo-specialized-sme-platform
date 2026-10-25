import { createHash } from 'node:crypto'
import { openSync, closeSync, readSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { and, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { isPageCapable } from '../../lib/roster/evidence-page'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import type { OfficialDeclaration, OfficialPublishedRow } from '../../lib/roster-import-client'
import { appendOfficialEvidenceRevision, readLatestOfficialEvidence, readOfficialEvidenceCandidates, type OfficialEvidenceCommand, type OfficialEvidenceRow, type OfficialEvidenceSourceKey } from './official-evidence'

type Db = BetterSQLite3Database<typeof schema>
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type Executor = Db | Tx
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const raw = z.string().max(4000).refine(value => value.isWellFormed(), 'Well-formed Unicode required')
const filled = raw.refine(value => value.trim().length > 0, 'Explicit nonblank value required')
const nullableRaw = raw.nullable()
export const officialDeclarationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('existing'), sourceDocumentId: positive, basis: filled }),
  z.strictObject({ kind: z.literal('independent'), sourceDocument: z.strictObject({ source: z.literal('jxj'), title: filled, docNumber: nullableRaw, issueDate: nullableRaw, path: filled }), basis: filled }),
])
export const officialPublishedRowSchema = z.strictObject({
  nameRaw: nullableRaw, usccRaw: nullableRaw, districtRaw: nullableRaw, declaration: officialDeclarationSchema,
  storedFileId: positive.nullable(), path: nullableRaw, sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(), bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  attachment: nullableRaw, sectionKey: nullableRaw, listNo: positive.nullable(), page: positive.nullable(), sourceBindingKnown: z.boolean(),
  actor: z.strictObject({ type: z.enum(['user', 'agent']), id: filled }), basis: filled,
})
export const officialAppendSchema = z.strictObject({
  eventId: positive, recordId: positive, enterpriseId: positive, expectedVersion: positive,
  evidence: z.strictObject({ sourceFile: filled, attachment: nullableRaw, listNo: positive.nullable(), page: positive.nullable(), publishedRow: officialPublishedRowSchema }),
})
export class OfficialFactError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 422) { super(message) }
}
export function officialFactFailure(code: string, message: string, status = 422): never { throw new OfficialFactError(code, message, status) }
export function officialPlanJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(officialPlanJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${officialPlanJson(v)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
export const officialPlanDigest = (value: unknown) => createHash('sha256').update(officialPlanJson(value)).digest('hex')
export type OfficialCoordinate = { sourceFile: string; attachment: string | null; listNo: number | null; page: number | null }
export interface OfficialClaimChange {
  ref: string
  evidenceId: number | string
  eventId: number | string
  /** Real current owner or an importer-owned batch identity, never a captured historical ID. */
  owner: string | null
  titleCode: string
  coordinate: OfficialCoordinate
  publishedRow: OfficialPublishedRow
  expectedRowRevision: number
  before?: OfficialEvidenceRow | null
  noOpEvidenceId?: number
  changed?: boolean
}
function failBinding(message: string): never { return officialFactFailure('source_binding_conflict', message, 409) }
export function readOfficialFile(filesDir: string | undefined, path: string) {
  if (!filesDir) return officialFactFailure('file_unavailable', 'Configured file root is required')
  try {
    const root = realpathSync(filesDir), file = realpathSync(resolve(root, path)), rel = relative(root, file)
    if (isAbsolute(path) || isAbsolute(rel) || rel === '..' || rel.startsWith('../')) return officialFactFailure('file_unavailable', 'Source escapes configured root')
    const before = statSync(file)
    if (!before.isFile()) return officialFactFailure('file_unavailable', 'Source is not a regular file')
    const fd = openSync(file, 'r'), buffer = Buffer.allocUnsafe(65536), digest = createHash('sha256')
    try { let n: number; while ((n = readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, n)) } finally { closeSync(fd) }
    const after = statSync(file)
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || realpathSync(resolve(root, path)) !== file) return officialFactFailure('file_changed', 'Source changed while reading', 409)
    return { sha256: digest.digest('hex'), bytes: after.size }
  } catch (error) {
    if (error instanceof OfficialFactError) throw error
    return officialFactFailure('file_unavailable', 'Original file unavailable or unsafe')
  }
}
function declarationIdentity(db: Executor, declaration: OfficialDeclaration) {
  if (declaration.kind === 'independent') return { id: `independent:${officialPlanJson(declaration)}`, document: declaration.sourceDocument }
  const document = db.select().from(schema.sourceDocument).where(eq(schema.sourceDocument.id, declaration.sourceDocumentId)).get()
  if (!document || document.source !== 'jxj') return officialFactFailure('source_binding_conflict', 'Explicit existing official declaration not found', 409)
  return { id: document.id, document }
}
export function verifyOfficialDeclaration(db: Executor, row: OfficialPublishedRow, outer?: { source: string; title: string; docNumber?: string | null; issueDate?: string | null }) {
  const identity = declarationIdentity(db, row.declaration)
  if (outer) for (const key of ['source', 'title', 'docNumber', 'issueDate'] as const) {
    if (outer[key] !== undefined && (outer[key] ?? null) !== (identity.document[key] ?? null)) failBinding(`Outer sourceDocument.${key} disagrees with explicit declaration`)
  }
  return identity
}
function keyOf(row: Pick<OfficialEvidenceRow, 'sourceBindingKnown' | 'sourceDocumentId' | 'sha256' | 'bytes' | 'attachment' | 'sectionKey' | 'listNo'>): OfficialEvidenceSourceKey | null {
  return row.sourceBindingKnown ? { sourceDocumentId: row.sourceDocumentId!, sha256: row.sha256!, bytes: row.bytes!, attachment: row.attachment, sectionKey: row.sectionKey!, listNo: row.listNo! } : null
}
const factFields = ['nameRaw', 'usccRaw', 'districtRaw', 'storedFileId', 'path', 'sha256', 'bytes', 'attachment', 'sectionKey', 'listNo', 'page', 'sourceBindingKnown'] as const
export function sameOfficialRow(before: OfficialEvidenceRow | null, row: OfficialPublishedRow, sourceId: number | string) {
  return !!before && before.sourceDocumentId === sourceId && factFields.every(field => before[field] === row[field])
}

/** One narrowly scoped final-set check shared by import and exact corrections. No SQL for A's table lives here. */
export function planOfficialEvidenceChanges(db: Executor, changes: OfficialClaimChange[], filesDir: string | undefined, finalOwner: (owner: string | null) => string | null = value => value, newUnknownClaims: readonly { ref: string; coordinate: OfficialCoordinate }[] = []) {
  if (changes.length > 100) officialFactFailure('input_limit', 'At most 100 new official fact operations', 400)
  for (const eventId of new Set(changes.map(change => change.eventId).filter((id): id is number => typeof id === 'number'))) {
    if (db.select({ id: schema.recordEvidence.id }).from(schema.recordEvidence).where(eq(schema.recordEvidence.recordEventId, eventId)).limit(301).all().length > 300) officialFactFailure('source_limit', 'Event evidence exceeds 300', 413)
  }
  const seen = new Set<number | string>(), keys = new Map<string, { key: OfficialEvidenceSourceKey; sourceId: number | string }>()
  const sourceStates: unknown[] = []
  const sourceFor = new Map<OfficialClaimChange, number | string>()
  for (const change of changes) {
    if (seen.has(change.evidenceId)) officialFactFailure('ambiguous_target', 'Each evidence may be changed only once per batch')
    seen.add(change.evidenceId)
    const parsed = officialPublishedRowSchema.safeParse(change.publishedRow)
    if (!parsed.success) officialFactFailure('invalid_input', 'Full explicit publishedRow with bounded nullable raw fields required', 400)
    const row = parsed.data, coordinate = change.coordinate
    if (coordinate.page !== null && !isPageCapable(coordinate.sourceFile)) officialFactFailure('not_page_capable', 'Source has no stable PDF pages')
    for (const [field, value] of Object.entries({ path: coordinate.sourceFile, attachment: coordinate.attachment, listNo: coordinate.listNo, page: coordinate.page })) {
      if (row[field as 'path' | 'attachment' | 'listNo' | 'page'] !== value) failBinding(`publishedRow.${field} disagrees with outer coordinate`)
    }
    const source = declarationIdentity(db, row.declaration); sourceFor.set(change, source.id)
    const file = row.storedFileId === null ? null : db.select().from(schema.storedFile).where(eq(schema.storedFile.id, row.storedFileId)).get()
    if (row.storedFileId !== null && (!file || file.removedAt || file.source !== 'jxj' || file.kind !== 'announcement' || file.titleCode && file.titleCode !== change.titleCode || file.relPath !== row.path)) failBinding('Selected storedFile must be the active official source of this title and path')
    const actual = readOfficialFile(filesDir, coordinate.sourceFile)
    if (file && (file.sha256 !== actual.sha256 || file.bytes !== actual.bytes) || row.sha256 !== null && row.sha256 !== actual.sha256 || row.bytes !== null && row.bytes !== actual.bytes) officialFactFailure('file_changed', 'Explicit and registered file identities must match actual bytes', 409)
    if (row.sourceBindingKnown && (row.sha256 === null || row.bytes === null || !row.sectionKey?.length || row.listNo === null)) officialFactFailure('ambiguity', 'Confirmed source binding requires verified content and section/row')
    if (typeof change.evidenceId === 'number') {
      change.before = readLatestOfficialEvidence(db, change.evidenceId, { maxBytes: 65536 }).row
      if ((change.before?.revision ?? 0) !== change.expectedRowRevision) officialFactFailure('revision_conflict', 'Published row revision changed', 409)
    }
    change.changed = !sameOfficialRow(change.before ?? null, row, source.id)
    sourceStates.push({ ref: change.ref, declaration: source, file: file ? { id: file.id, relPath: file.relPath, sha256: file.sha256, bytes: file.bytes, removedAt: file.removedAt, source: file.source, kind: file.kind, titleCode: file.titleCode } : null, actual, before: change.before ?? null })
    const oldKey = change.before ? keyOf(change.before) : null
    if (oldKey) keys.set(officialPlanJson(oldKey), { key: oldKey, sourceId: oldKey.sourceDocumentId })
    if (row.sourceBindingKnown) {
      const key = { sourceDocumentId: source.id as number, sha256: row.sha256!, bytes: row.bytes!, attachment: row.attachment, sectionKey: row.sectionKey!, listNo: row.listNo! }
      keys.set(officialPlanJson(key), { key, sourceId: source.id })
    }
  }
  const overlapsCoordinate = (a: OfficialCoordinate, b: OfficialCoordinate) => a.listNo !== null && a.sourceFile === b.sourceFile && a.attachment === b.attachment && a.listNo === b.listNo
  for (let i = 0; i < changes.length; i++) for (let j = i + 1; j < changes.length; j++) {
    const a = changes[i]!, b = changes[j]!, ac = a.coordinate, bc = b.coordinate
    if (overlapsCoordinate(ac, bc) && (!a.publishedRow.sourceBindingKnown || !b.publishedRow.sourceBindingKnown)) officialFactFailure('ambiguity', 'Overlapping final coordinates have unknown source-row binding', 409)
  }
  if (keys.size > 200) officialFactFailure('input_limit', 'At most 200 affected source keys', 400)
  const receipts: unknown[] = []
  // Only one K's original candidates are retained at a time; the plan retains digests, not all raw scopes.
  for (const [token, { key, sourceId }] of [...keys].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const original = typeof sourceId === 'number' ? readOfficialEvidenceCandidates(db, key, { maxBytes: 65536 }).candidates : []
    type Claim = { evidenceId: number | string; eventId: number | string; owner: string | null; nameRaw: string | null; usccRaw: string | null; districtRaw: string | null }
    const final: Claim[] = original.filter(row => !seen.has(row.evidenceId)).map(row => ({ ...row, owner: finalOwner(row.currentOwner ? `enterprise:${row.currentOwner.enterpriseId}` : null) }))
    const proposals = changes.filter(change => {
      const row = change.publishedRow
      return row.sourceBindingKnown && officialPlanJson({ sourceDocumentId: sourceFor.get(change), sha256: row.sha256, bytes: row.bytes, attachment: row.attachment, sectionKey: row.sectionKey, listNo: row.listNo }) === token
    })
    for (const change of proposals) {
      const row = change.publishedRow
      const existing = final.find(claim => claim.eventId === change.eventId && typeof claim.evidenceId === 'number')
      if (typeof change.evidenceId === 'string' && existing && existing.owner !== null && existing.owner === finalOwner(change.owner) && ['nameRaw', 'usccRaw', 'districtRaw'].every(field => row[field as 'nameRaw'] !== null && row[field as 'nameRaw'] === existing[field as 'nameRaw'])) {
        const stored = readLatestOfficialEvidence(db, existing.evidenceId as number, { maxBytes: 65536 }).row
        if (sameOfficialRow(stored, row, sourceFor.get(change)!)) { change.noOpEvidenceId = existing.evidenceId as number; continue }
      }
      final.push({ evidenceId: change.evidenceId, eventId: change.eventId, owner: finalOwner(change.owner), nameRaw: row.nameRaw, usccRaw: row.usccRaw, districtRaw: row.districtRaw })
    }
    if (final.length > 100) officialFactFailure('source_limit', 'Final source row scope exceeds 100 claims', 413)
    for (let i = 0; i < final.length; i++) for (let j = i + 1; j < final.length; j++) {
      const a = final[i]!, b = final[j]!
      if (a.owner !== null && b.owner !== null && a.owner !== b.owner || ['nameRaw', 'usccRaw', 'districtRaw'].some(field => {
        const k = field as 'nameRaw' | 'usccRaw' | 'districtRaw'; return a[k] !== null && b[k] !== null && a[k] !== b[k]
      })) officialFactFailure('source_row_conflict', 'Confirmed source row has incompatible owners or verbatim raw values', 409)
      if (a.owner === null || b.owner === null) officialFactFailure('ambiguity', 'Current source-row ownership cannot be proven compatible', 409)
      if (a.eventId === b.eventId) {
        const proposed = proposals.find(change => change.evidenceId === b.evidenceId) ?? proposals.find(change => change.evidenceId === a.evidenceId)
        const stored = typeof a.evidenceId === 'number' ? a : typeof b.evidenceId === 'number' ? b : null
        if (!proposed || !stored || ['nameRaw', 'usccRaw', 'districtRaw'].some(field => a[field as 'nameRaw'] === null || b[field as 'nameRaw'] === null)) officialFactFailure('ambiguity', 'Duplicate event association requires exact known equivalence or explicit correction', 409)
        const existing = readLatestOfficialEvidence(db, stored.evidenceId as number, { maxBytes: 65536 }).row
        if (!sameOfficialRow(existing, proposed.publishedRow, sourceFor.get(proposed)!)) officialFactFailure('ambiguity', 'Existing event association differs; use exact correction', 409)
        proposed.noOpEvidenceId = stored.evidenceId as number
      }
    }
    receipts.push({ key: token, candidates: officialPlanDigest(original), final: officialPlanDigest(final) })
  }
  // The final view also contains newly planned legacy rows, although they have
  // no A sidecar. Treat them exactly like persisted unknown claims, across all
  // events/owners, after removing every replaced claim from the old scope.
  const affectedCoordinates = new Map<string, OfficialCoordinate>()
  for (const change of changes) {
    affectedCoordinates.set(officialPlanJson(change.coordinate), change.coordinate)
    const before = change.before
    if (before?.path !== null && before?.path !== undefined) {
      const old = { sourceFile: before.path, attachment: before.attachment, listNo: before.listNo, page: before.page }
      affectedCoordinates.set(officialPlanJson(old), old)
    }
  }
  for (const c of affectedCoordinates.values()) {
    if (c.listNo === null) continue
    const overlaps = db.select({ evidence: schema.recordEvidence }).from(schema.recordEvidence).where(and(eq(schema.recordEvidence.sourceFile, c.sourceFile), eq(schema.recordEvidence.listNo, c.listNo), c.attachment === null ? isNull(schema.recordEvidence.attachment) : eq(schema.recordEvidence.attachment, c.attachment))).limit(101).all()
    if (overlaps.length > 100) officialFactFailure('source_limit', 'Coordinate source scope exceeds 100 claims', 413)
    const remaining = overlaps.filter(overlap => !seen.has(overlap.evidence.id))
    const incoming = newUnknownClaims.filter(claim => overlapsCoordinate(c, claim.coordinate))
    const proposed = changes.filter(claim => overlapsCoordinate(c, claim.coordinate))
    if (incoming.length && remaining.length + incoming.length + proposed.length > 100) officialFactFailure('source_limit', 'Final coordinate source scope exceeds 100 claims', 413)
    if (incoming.length && remaining.length + proposed.length > 0) officialFactFailure('ambiguity', 'Overlapping legacy source claim has unknown declaration or binding', 409)
    if (!proposed.length) continue
    for (const overlap of remaining) {
      const latest = readLatestOfficialEvidence(db, overlap.evidence.id, { maxBytes: 65536 }).row
      if (!latest?.sourceBindingKnown || proposed.some(change => !change.publishedRow.sourceBindingKnown)) officialFactFailure('ambiguity', 'Overlapping legacy source claim has unknown declaration or binding', 409)
    }
  }
  return { changes, planHash: officialPlanDigest({ changes: changes.map(({ before, ...change }) => change), newUnknownClaims, sourceStates, receipts }) }
}

/** Caller owns the transaction and one per-batch declaration cache; never a global registry. */
export function resolveOfficialDeclaration(db: Executor, declaration: OfficialDeclaration, cache: Map<string, number>): number {
  const identity = declarationIdentity(db, declaration), key = officialPlanJson(declaration)
  if (typeof identity.id === 'number') return identity.id
  const known = cache.get(key)
  if (known !== undefined) return known
  const id = db.insert(schema.sourceDocument).values(identity.document).returning({ id: schema.sourceDocument.id }).get().id
  cache.set(key, id); return id
}
export function writeOfficialPublishedRow(db: Executor, row: OfficialPublishedRow, evidenceId: number, expectedRevision: number, command: OfficialEvidenceCommand, cache: Map<string, number>) {
  const reference = db.select({ eventId: schema.recordEvent.id, recordId: schema.record.id, enterpriseId: schema.enterprise.id }).from(schema.recordEvidence).innerJoin(schema.recordEvent, eq(schema.recordEvent.id, schema.recordEvidence.recordEventId)).innerJoin(schema.record, eq(schema.record.id, schema.recordEvent.recordId)).innerJoin(schema.enterprise, eq(schema.enterprise.id, schema.record.enterpriseId)).where(eq(schema.recordEvidence.id, evidenceId)).get()
  if (!reference) officialFactFailure('reference_mismatch', 'Current real evidence owner required', 409)
  const { declaration, ...capture } = row
  return appendOfficialEvidenceRevision(db, { ...capture, sourceDocumentId: resolveOfficialDeclaration(db, declaration, cache), evidenceId, eventId: reference.eventId, capturedRecordId: reference.recordId, capturedEnterpriseId: reference.enterpriseId, command }, expectedRevision)
}
