import { fileClassificationJoin } from './roster-file-classification'
import { createHash } from 'node:crypto'
import { openSync, closeSync, readSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { and, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { isPageCapable } from '../../lib/roster/evidence-page'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../../db/schema'
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
/** Importer's already frozen equal-content pointer move, never re-guessed here. */
export interface OfficialEvidenceLocatorMove {
  id: number
  recordId: number
  recordEventId: number
  fromSourceFile: string
  sourceFile: string
}
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
  /** Only an append that reuses an association and performs no evidence write. */
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
export function projectOfficialDeclaration(declaration: OfficialDeclaration, document?: typeof schema.sourceDocument.$inferSelect) {
  if (declaration.kind === 'independent') return { id: `independent:${officialPlanJson(declaration)}`, document: declaration.sourceDocument }
  if (!document || document.source !== 'jxj') return officialFactFailure('source_binding_conflict', 'Explicit existing official declaration not found', 409)
  return { id: document.id, document }
}
function declarationIdentity(db: Executor, declaration: OfficialDeclaration) {
  return projectOfficialDeclaration(declaration, declaration.kind === 'existing'
    ? db.select().from(schema.sourceDocument).where(eq(schema.sourceDocument.id, declaration.sourceDocumentId)).get() : undefined)
}
export function verifyOfficialDeclaration(db: Executor, row: OfficialPublishedRow, outer?: { source: string; title: string; docNumber?: string | null; issueDate?: string | null }) {
  const identity = declarationIdentity(db, row.declaration)
  return checkOfficialOuterDocument(identity, outer)
}
export function checkOfficialOuterDocument(identity: ReturnType<typeof projectOfficialDeclaration>,
  outer?: { source: string; title: string; docNumber?: string | null; issueDate?: string | null }) {
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
export function planOfficialEvidenceChanges(db: Executor, changes: OfficialClaimChange[], filesDir: string | undefined, finalOwner: (owner: string | null) => string | null = value => value, newUnknownClaims: readonly { ref: string; coordinate: OfficialCoordinate }[] = [], locatorMoves: readonly OfficialEvidenceLocatorMove[] = []) {
  const query = projectOfficialEvidenceChanges(changes, filesDir, finalOwner, newUnknownClaims, locatorMoves)
  let next = query.next()
  while (!next.done) next = query.next(readOfficialPlanInput(db, next.value))
  return next.value
}

type SourceFile = Pick<typeof schema.storedFile.$inferSelect, 'id' | 'relPath' | 'bytes' | 'sha256' | 'removedAt'>
  & Pick<typeof schema.rosterFileClassification.$inferSelect, 'source' | 'kind' | 'titleCode'>
type RepointReference = {
  evidence: typeof schema.recordEvidence.$inferSelect; event: typeof schema.recordEvent.$inferSelect
  recordId: number; enterpriseId: number | null
}
type PlanInput = { type: 'count'; eventId: number } | { type: 'declaration'; declaration: OfficialDeclaration }
  | { type: 'file'; id: number } | { type: 'latest'; id: number }
  | { type: 'repoint'; id: number } | { type: 'candidates'; key: OfficialEvidenceSourceKey }
  | { type: 'overlaps'; coordinate: OfficialCoordinate }
type PlanResponses = {
  count: number
  declaration: ReturnType<typeof projectOfficialDeclaration>
  file: SourceFile | undefined
  latest: OfficialEvidenceRow | null
  repoint: RepointReference | undefined
  candidates: ReturnType<typeof readOfficialEvidenceCandidates>['candidates']
  overlaps: (typeof schema.recordEvidence.$inferSelect)[]
}
function* planInput<T extends PlanInput['type']>(input: Extract<PlanInput, { type: T }>): Generator<PlanInput, PlanResponses[T], unknown> {
  return (yield input) as PlanResponses[T]
}

function readOfficialPlanInput(db: Executor, input: PlanInput) {
  if (input.type === 'count') return db.select({ id: schema.recordEvidence.id }).from(schema.recordEvidence)
    .where(eq(schema.recordEvidence.recordEventId, input.eventId)).limit(301).all().length
  if (input.type === 'declaration') return declarationIdentity(db, input.declaration)
  if (input.type === 'latest') return readLatestOfficialEvidence(db, input.id, { maxBytes: 65536 }).row
  if (input.type === 'candidates') return readOfficialEvidenceCandidates(db, input.key, { maxBytes: 65536 }).candidates
  if (input.type === 'file') return db.select({
    id: schema.storedFile.id, relPath: schema.storedFile.relPath, bytes: schema.storedFile.bytes,
    sha256: schema.storedFile.sha256, removedAt: schema.storedFile.removedAt,
    source: schema.rosterFileClassification.source, kind: schema.rosterFileClassification.kind, titleCode: schema.rosterFileClassification.titleCode,
  }).from(schema.storedFile).innerJoin(schema.rosterFileClassification, fileClassificationJoin)
    .where(eq(schema.storedFile.id, input.id)).get()
  if (input.type === 'repoint') return db.select({
    evidence: schema.recordEvidence, event: schema.recordEvent, recordId: schema.record.id, enterpriseId: schema.enterprise.id,
  }).from(schema.recordEvidence).innerJoin(schema.recordEvent, eq(schema.recordEvent.id, schema.recordEvidence.recordEventId))
    .innerJoin(schema.record, eq(schema.record.id, schema.recordEvent.recordId)).leftJoin(schema.enterprise, eq(schema.enterprise.id, schema.record.enterpriseId))
    .where(eq(schema.recordEvidence.id, input.id)).get()
  const c = input.coordinate
  return db.select().from(schema.recordEvidence).where(and(eq(schema.recordEvidence.sourceFile, c.sourceFile),
    eq(schema.recordEvidence.listNo, c.listNo!), c.attachment === null ? isNull(schema.recordEvidence.attachment) : eq(schema.recordEvidence.attachment, c.attachment))).limit(101).all()
}

export function* projectOfficialEvidenceChanges(changes: OfficialClaimChange[], filesDir: string | undefined,
  finalOwner: (owner: string | null) => string | null = value => value,
  newUnknownClaims: readonly { ref: string; coordinate: OfficialCoordinate }[] = [],
  locatorMoves: readonly OfficialEvidenceLocatorMove[] = [],
) {
  if (changes.length > 100) officialFactFailure('input_limit', 'At most 100 new official fact operations', 400)
  for (const eventId of new Set([...changes.map(change => change.eventId).filter((id): id is number => typeof id === 'number'), ...locatorMoves.map(move => move.recordEventId)])) {
    if ((yield* planInput<'count'>({ type: 'count', eventId })) > 300) officialFactFailure('source_limit', 'Event evidence exceeds 300', 413)
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
    const source = (yield* planInput<'declaration'>({ type: 'declaration', declaration: row.declaration })); sourceFor.set(change, source.id)
    const file = row.storedFileId === null ? null : (yield* planInput<'file'>({ type: 'file', id: row.storedFileId }))
    if (row.storedFileId !== null && (!file || file.removedAt || file.source !== 'jxj' || file.kind !== 'announcement' || file.titleCode && file.titleCode !== change.titleCode || file.relPath !== row.path)) failBinding('Selected storedFile must be the active official source of this title and path')
    const actual = readOfficialFile(filesDir, coordinate.sourceFile)
    if (file && (file.sha256 !== actual.sha256 || file.bytes !== actual.bytes) || row.sha256 !== null && row.sha256 !== actual.sha256 || row.bytes !== null && row.bytes !== actual.bytes) officialFactFailure('file_changed', 'Explicit and registered file identities must match actual bytes', 409)
    if (row.sourceBindingKnown && (row.sha256 === null || row.bytes === null || !row.sectionKey?.length || row.listNo === null)) officialFactFailure('ambiguity', 'Confirmed source binding requires verified content and section/row')
    if (typeof change.evidenceId === 'number') {
      change.before = (yield* planInput<'latest'>({ type: 'latest', id: change.evidenceId }))
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
  const movedIds = new Set<number>()
  const moves: { target: OfficialEvidenceLocatorMove; before: OfficialCoordinate; coordinate: OfficialCoordinate; latest: OfficialEvidenceRow | null }[] = []
  for (const target of locatorMoves) {
    if (seen.has(target.id) || movedIds.has(target.id)) officialFactFailure('ambiguous_target', 'Each evidence may be changed only once per batch')
    movedIds.add(target.id)
    const reference = yield* planInput<'repoint'>({ type: 'repoint', id: target.id })
    if (!reference || reference.event.id !== target.recordEventId || reference.recordId !== target.recordId || reference.evidence.sourceFile !== target.fromSourceFile) officialFactFailure('stale_version', 'Frozen evidence repoint target changed', 409)
    const latest = (yield* planInput<'latest'>({ type: 'latest', id: target.id }))
    const fromFile = readOfficialFile(filesDir, target.fromSourceFile), toFile = readOfficialFile(filesDir, target.sourceFile)
    if (fromFile.sha256 !== toFile.sha256 || fromFile.bytes !== toFile.bytes) officialFactFailure('file_changed', 'Frozen equal-content repoint differs from actual source bytes', 409)
    const before: OfficialCoordinate = { sourceFile: reference.evidence.sourceFile, attachment: reference.evidence.attachment, listNo: reference.evidence.listNo, page: reference.evidence.page }
    const coordinate: OfficialCoordinate = { ...before, sourceFile: target.sourceFile, page: isPageCapable(target.sourceFile) ? before.page : null }
    const sourceKey = latest ? keyOf(latest) : null
    if (sourceKey) keys.set(officialPlanJson(sourceKey), { key: sourceKey, sourceId: sourceKey.sourceDocumentId })
    sourceStates.push({ target, before, event: reference.event, owner: finalOwner(reference.enterpriseId === null ? null : `enterprise:${reference.enterpriseId}`), latest: officialPlanDigest(latest), fromFile, toFile })
    moves.push({ target, before, coordinate, latest })
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
    const original = typeof sourceId === 'number' ? (yield* planInput<'candidates'>({ type: 'candidates', key })) : []
    const storedRows = new Map<number, OfficialEvidenceRow | null>()
    function* storedRow(id: number) {
      if (!storedRows.has(id)) storedRows.set(id, yield* planInput<'latest'>({ type: 'latest', id }))
      return storedRows.get(id) ?? null
    }
    type Claim = { eventId: number | string; owner: string | null; nameRaw: string | null; usccRaw: string | null; districtRaw: string | null } & (
      { origin: 'stored'; evidenceId: number } | { origin: 'proposal'; evidenceId: number | string; change: OfficialClaimChange }
    )
    const final: Claim[] = original.filter(row => !seen.has(row.evidenceId)).map((row): Claim => ({ ...row, origin: 'stored', owner: finalOwner(row.currentOwner ? `enterprise:${row.currentOwner.enterpriseId}` : null) }))
    const proposals = changes.filter(change => {
      const row = change.publishedRow
      return row.sourceBindingKnown && officialPlanJson({ sourceDocumentId: sourceFor.get(change), sha256: row.sha256, bytes: row.bytes, attachment: row.attachment, sectionKey: row.sectionKey, listNo: row.listNo }) === token
    })
    for (const change of proposals) {
      const row = change.publishedRow
      const existing = final.find((claim): claim is Extract<Claim, { origin: 'stored' }> => claim.origin === 'stored' && claim.eventId === change.eventId)
      if (typeof change.evidenceId === 'string' && existing && existing.owner !== null && existing.owner === finalOwner(change.owner) && ['nameRaw', 'usccRaw', 'districtRaw'].every(field => row[field as 'nameRaw'] !== null && row[field as 'nameRaw'] === existing[field as 'nameRaw'])) {
        const stored = yield* storedRow(existing.evidenceId)
        if (sameOfficialRow(stored, row, sourceId)) { change.noOpEvidenceId = existing.evidenceId; continue }
      }
      if (typeof change.evidenceId === 'string') {
        // A named correction can supply the association's final facts too. It
        // still executes; only this redundant append skips its own insertion.
        const planned = proposals.find((other): other is OfficialClaimChange & { evidenceId: number } => typeof other.evidenceId === 'number' && other.eventId === change.eventId && finalOwner(other.owner) !== null && finalOwner(other.owner) === finalOwner(change.owner) && ['nameRaw', 'usccRaw', 'districtRaw'].every(field => row[field as 'nameRaw'] !== null) && factFields.every(field => other.publishedRow[field] === row[field]))
        if (planned) { change.noOpEvidenceId = planned.evidenceId; continue }
      }
      final.push({ origin: 'proposal', change, evidenceId: change.evidenceId, eventId: change.eventId, owner: finalOwner(change.owner), nameRaw: row.nameRaw, usccRaw: row.usccRaw, districtRaw: row.districtRaw })
    }
    if (final.length > 100) officialFactFailure('source_limit', 'Final source row scope exceeds 100 claims', 413)
    // Finish known source-fact conflicts for the whole K before any pair can
    // return an ownership or event-association ambiguity.
    for (let i = 0; i < final.length; i++) for (let j = i + 1; j < final.length; j++) {
      const a = final[i]!, b = final[j]!
      if (a.owner !== null && b.owner !== null && a.owner !== b.owner || ['nameRaw', 'usccRaw', 'districtRaw'].some(field => {
        const k = field as 'nameRaw' | 'usccRaw' | 'districtRaw'; return a[k] !== null && b[k] !== null && a[k] !== b[k]
      })) officialFactFailure('source_row_conflict', 'Confirmed source row has incompatible owners or verbatim raw values', 409)
    }
    for (let i = 0; i < final.length; i++) for (let j = i + 1; j < final.length; j++) {
      const a = final[i]!, b = final[j]!
      if (a.owner === null || b.owner === null) officialFactFailure('ambiguity', 'Current source-row ownership cannot be proven compatible', 409)
      if (a.eventId === b.eventId) {
        if (['nameRaw', 'usccRaw', 'districtRaw'].some(field => a[field as 'nameRaw'] === null || b[field as 'nameRaw'] === null)) officialFactFailure('ambiguity', 'Duplicate event association requires exact known equivalence or explicit correction', 409)
        if (a.origin === 'stored' && b.origin === 'stored') {
          // These retained IDs were already accepted. Preserve them only after
          // verifying their complete latest facts, not merely the shared K/raw.
          const left = yield* storedRow(a.evidenceId), right = yield* storedRow(b.evidenceId)
          if (!left || !right || left.sourceDocumentId !== sourceId || right.sourceDocumentId !== sourceId || !factFields.every(field => left[field] === right[field])) officialFactFailure('ambiguity', 'Existing event association differs; use exact correction', 409)
          continue
        }
        const proposed = b.origin === 'proposal' ? b : a.origin === 'proposal' ? a : null
        if (!proposed) officialFactFailure('ambiguity', 'Duplicate event association requires exact known equivalence or explicit correction', 409)
        const other = proposed === b ? a : b
        if (other.origin === 'proposal' && typeof other.evidenceId === 'string' && typeof proposed.evidenceId === 'string') officialFactFailure('ambiguity', 'New append proposals require a stable existing association', 409)
        // Replaced numeric IDs are proposals too: compare their complete final
        // facts, never the old latest that this batch has already removed.
        const equivalent = other.origin === 'stored'
          ? sameOfficialRow(yield* storedRow(other.evidenceId), proposed.change.publishedRow, sourceId)
          : sourceFor.get(other.change) === sourceFor.get(proposed.change) && factFields.every(field => other.change.publishedRow[field] === proposed.change.publishedRow[field])
        if (!equivalent) officialFactFailure('ambiguity', 'Existing event association differs; use exact correction', 409)
        // Numeric corrections still write their named evidence, even when another
        // association has equivalent facts. Keep their final locator in the plan.
        if (other.origin === 'stored' && typeof proposed.evidenceId === 'string') proposed.change.noOpEvidenceId = other.evidenceId
      }
    }
    receipts.push({ key: token, candidates: officialPlanDigest(original), final: officialPlanDigest(final) })
  }
  // Live locators and captured facts are distinct: an equal-content repoint
  // leaves the real latest K/raw intact, but replaces its old physical locator.
  // Every coordinate writer contributes to this one remove-all/add-all view.
  const affectedCoordinates = new Map<string, OfficialCoordinate>()
  for (const change of changes) {
    affectedCoordinates.set(officialPlanJson(change.coordinate), change.coordinate)
    const before = change.before
    if (before?.path !== null && before?.path !== undefined) {
      const old = { sourceFile: before.path, attachment: before.attachment, listNo: before.listNo, page: before.page }
      affectedCoordinates.set(officialPlanJson(old), old)
    }
  }
  for (const claim of newUnknownClaims) affectedCoordinates.set(officialPlanJson(claim.coordinate), claim.coordinate)
  for (const move of moves) for (const c of [move.before, move.coordinate]) affectedCoordinates.set(officialPlanJson(c), c)
  for (const c of affectedCoordinates.values()) {
    if (c.listNo === null) continue
    const overlaps = yield* planInput<'overlaps'>({ type: 'overlaps', coordinate: c })
    if (overlaps.length > 100) officialFactFailure('source_limit', 'Coordinate source scope exceeds 100 claims', 413)
    const remaining = overlaps.filter(overlap => !seen.has(overlap.id) && !movedIds.has(overlap.id))
    const incoming = newUnknownClaims.filter(claim => overlapsCoordinate(c, claim.coordinate))
    const proposed = changes.filter(claim => claim.noOpEvidenceId === undefined && overlapsCoordinate(c, claim.coordinate))
    const relocated = moves.filter(move => overlapsCoordinate(c, move.coordinate))
    if (remaining.length + incoming.length + proposed.length + relocated.length > 100) officialFactFailure('source_limit', 'Final coordinate source scope exceeds 100 claims', 413)
    const bindings: boolean[] = []
    for (const overlap of remaining) {
      const latest = yield* planInput<'latest'>({ type: 'latest', id: overlap.id })
      bindings.push(latest?.sourceBindingKnown === true)
    }
    bindings.push(...incoming.map(() => false), ...proposed.map(claim => claim.publishedRow.sourceBindingKnown), ...relocated.map(move => move.latest?.sourceBindingKnown === true))
    if (bindings.length > 1 && bindings.some(known => !known)) officialFactFailure('ambiguity', 'Overlapping legacy source claim has unknown declaration or binding', 409)
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
