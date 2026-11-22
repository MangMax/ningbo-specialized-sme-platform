import { projectOfficialDeclaration, checkOfficialOuterDocument, type OfficialClaimChange, type OfficialCoordinate, type OfficialEvidenceLocatorMove, projectOfficialEvidenceChanges, type PlanInput, officialPlanJson, officialFactFailure } from './official-evidence-claim-model'
import { fileClassificationJoin } from './roster-file-classification'
import { and, eq, isNull } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../../db/schema'
import type { OfficialDeclaration, OfficialPublishedRow } from '../../lib/roster-import-client'
import { appendOfficialEvidenceRevision, readLatestOfficialEvidence, readOfficialEvidenceCandidates, type OfficialEvidenceCommand } from './official-evidence'
type Db = BetterSQLite3Database<typeof schema>
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type Executor = Db | Tx
function declarationIdentity(db: Executor, declaration: OfficialDeclaration) {
  return projectOfficialDeclaration(declaration, declaration.kind === 'existing'
    ? db.select().from(schema.sourceDocument).where(eq(schema.sourceDocument.id, declaration.sourceDocumentId)).get() : undefined)
}
export function verifyOfficialDeclaration(db: Executor, row: OfficialPublishedRow, outer?: { source: string; title: string; docNumber?: string | null; issueDate?: string | null }) {
  const identity = declarationIdentity(db, row.declaration)
  return checkOfficialOuterDocument(identity, outer)
}
/** One narrowly scoped final-set check shared by import and exact corrections. No SQL for A's table lives here. */
export function planOfficialEvidenceChanges(db: Executor, changes: OfficialClaimChange[], filesDir: string | undefined, finalOwner: (owner: string | null) => string | null = value => value, newUnknownClaims: readonly { ref: string; coordinate: OfficialCoordinate }[] = [], locatorMoves: readonly OfficialEvidenceLocatorMove[] = []) {
  const query = projectOfficialEvidenceChanges(changes, filesDir, finalOwner, newUnknownClaims, locatorMoves)
  let next = query.next()
  while (!next.done) next = query.next(readOfficialPlanInput(db, next.value))
  return next.value
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
export { officialDeclarationSchema, officialPublishedRowSchema, officialAppendSchema, OfficialFactError, officialFactFailure, officialPlanJson, officialPlanDigest, type OfficialCoordinate, type OfficialEvidenceLocatorMove, type OfficialClaimChange, readOfficialFile, projectOfficialDeclaration, checkOfficialOuterDocument, sameOfficialRow, projectOfficialEvidenceChanges } from './official-evidence-claim-model'
