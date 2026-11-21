import { and, eq, exists, gt, notExists, sql } from 'drizzle-orm'
import { enterprise } from '../../../../db/postgresql/enterprise-tables'
import { record, recordEvent, recordEvidence } from '../../../../db/postgresql/ledger-tables'
import { officialEvidenceRowRevision as revisions, sourceDocument } from '../../../../db/postgresql/official-evidence-tables'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { PgColumn } from 'drizzle-orm/pg-core'
import type { OfficialDeclaration, OfficialPublishedRow } from '../../lib/roster-import-client'
import { officialPlanJson, officialFactFailure } from './official-evidence-plan'
import { OfficialEvidenceError, validateOfficialEvidenceRevision, type OfficialEvidenceCapture, type OfficialEvidenceCommand } from './official-evidence'

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]

export async function resolvePostgresOfficialDeclaration(tx: Tx, declaration: OfficialDeclaration, cache: Map<string, number>) {
  if (declaration.kind === 'existing') {
    const reference = await tx.select({ id: sourceDocument.id }).from(sourceDocument)
      .where(and(eq(sourceDocument.id, declaration.sourceDocumentId), eq(sourceDocument.source, 'jxj')))
    if (!reference.length) return officialFactFailure('source_binding_conflict', 'Explicit existing official declaration not found', 409)
    return declaration.sourceDocumentId
  }
  const key = officialPlanJson(declaration)
  const saved = cache.get(key)
  if (saved !== undefined) return saved
  const document = declaration.sourceDocument
  const [created] = await tx.insert(sourceDocument).values(document).returning({ id: sourceDocument.id })
  cache.set(key, created!.id)
  return created!.id
}

async function appendPostgresOfficialEvidence(tx: Tx, capture: OfficialEvidenceCapture, expectedRevision: number) {
  const { revision, createdAt } = validateOfficialEvidenceRevision(capture, expectedRevision)
  const ownerMatch = and(eq(recordEvidence.id, capture.evidenceId), eq(recordEvent.id, capture.eventId),
    eq(record.id, capture.capturedRecordId), eq(record.enterpriseId, capture.capturedEnterpriseId))
  const latestMatches = notExists(tx.select({ revision: revisions.revision }).from(revisions).where(and(
    eq(revisions.evidenceId, capture.evidenceId), gt(revisions.revision, expectedRevision),
  )))
  const expectedExists = expectedRevision === 0 ? undefined : exists(tx.select({ revision: revisions.revision }).from(revisions).where(and(
    eq(revisions.evidenceId, capture.evidenceId), eq(revisions.revision, expectedRevision),
  )))
  // Drizzle has no literal projection helper. Bind values in INSERT SELECT to keep the ownership check and CAS atomic.
  const bound = <T>(column: PgColumn, value: T) => sql<T>`${value}`.as(column.name)
  const insert = tx.select({
    evidenceId: recordEvidence.id, revision: bound(revisions.revision, revision), formatVersion: bound(revisions.formatVersion, 1), eventId: recordEvent.id,
    capturedRecordId: record.id, capturedEnterpriseId: record.enterpriseId, nameRaw: bound(revisions.nameRaw, capture.nameRaw),
    usccRaw: bound(revisions.usccRaw, capture.usccRaw), districtRaw: bound(revisions.districtRaw, capture.districtRaw), sourceDocumentId: bound(revisions.sourceDocumentId, capture.sourceDocumentId),
    storedFileId: bound(revisions.storedFileId, capture.storedFileId), path: bound(revisions.path, capture.path), sha256: bound(revisions.sha256, capture.sha256), bytes: bound(revisions.bytes, capture.bytes),
    attachment: bound(revisions.attachment, capture.attachment), sectionKey: bound(revisions.sectionKey, capture.sectionKey), listNo: bound(revisions.listNo, capture.listNo), page: bound(revisions.page, capture.page),
    sourceBindingKnown: bound(revisions.sourceBindingKnown, Number(capture.sourceBindingKnown)), actor: bound(revisions.actor, JSON.stringify(capture.actor)), basis: bound(revisions.basis, capture.basis),
    commandKind: bound(revisions.commandKind, capture.command.kind), importBatchId: bound(revisions.importBatchId, capture.command.kind === 'import' ? capture.command.batchId : null),
    correctionBatchKey: bound(revisions.correctionBatchKey, capture.command.kind === 'evidence_correction' ? capture.command.batchKey : null), createdAt: bound(revisions.createdAt, createdAt),
  }).from(recordEvidence)
    .innerJoin(recordEvent, eq(recordEvent.id, recordEvidence.recordEventId))
    .innerJoin(record, eq(record.id, recordEvent.recordId))
    .innerJoin(enterprise, eq(enterprise.id, record.enterpriseId))
    .where(and(ownerMatch, latestMatches, expectedExists))
  let written
  try {
    written = await tx.insert(revisions).select(insert).returning({ evidenceId: revisions.evidenceId })
  } catch (error) {
    const cause = error as { code?: string; cause?: { code?: string } }
    const code = cause.code ?? cause.cause?.code
    if (code === '23503') throw new OfficialEvidenceError(409, 'reference_mismatch', 'Referenced source, file or command does not exist', error)
    if (code === '23505') throw new OfficialEvidenceError(409, 'revision_conflict', 'Expected row revision is stale', error)
    throw error
  }
  if (!written.length) {
    const owner = await readPostgresEvidenceOwner(tx, capture.evidenceId)
    const referenceMatches = owner?.eventId === capture.eventId && owner.capturedRecordId === capture.capturedRecordId
      && owner.capturedEnterpriseId === capture.capturedEnterpriseId
    throw new OfficialEvidenceError(409, referenceMatches ? 'revision_conflict' : 'reference_mismatch',
      referenceMatches ? 'Expected row revision is stale' : 'New capture does not match evidence/event/current owner')
  }
  return { formatVersion: 1 as const, evidenceId: capture.evidenceId, eventId: capture.eventId, revision }
}

async function readPostgresEvidenceOwner(tx: Tx, evidenceId: number) {
  const [owner] = await tx.select({
    eventId: recordEvent.id, capturedRecordId: record.id, capturedEnterpriseId: record.enterpriseId,
  }).from(recordEvidence).innerJoin(recordEvent, eq(recordEvent.id, recordEvidence.recordEventId))
    .innerJoin(record, eq(record.id, recordEvent.recordId)).innerJoin(enterprise, eq(enterprise.id, record.enterpriseId))
    .where(eq(recordEvidence.id, evidenceId))
  return owner
}

export async function writePostgresOfficialPublishedRow(tx: Tx, row: OfficialPublishedRow, evidenceId: number, expectedRevision: number,
  command: OfficialEvidenceCommand, declarations: Map<string, number>,
) {
  const owner = await readPostgresEvidenceOwner(tx, evidenceId)
  if (!owner) return officialFactFailure('reference_mismatch', 'Current real evidence owner required', 409)
  const { declaration, ...capture } = row
  const sourceDocumentId = await resolvePostgresOfficialDeclaration(tx, declaration, declarations)
  return appendPostgresOfficialEvidence(tx, { ...capture, ...owner, sourceDocumentId, evidenceId, command }, expectedRevision)
}
