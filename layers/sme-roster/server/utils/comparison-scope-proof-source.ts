import { type OfficialEvidence, validateOfficialProofScope, officialProofReferences, officialProofFingerprint, type CurrentEvidence, currentProofInputs, validateCurrentProofBinding, currentProofFingerprint } from './comparison-scope-proof-source-projection'
import { fileClassificationJoin } from './roster-file-classification'
import { and, between, eq, inArray, or } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../../db/schema'
import { correspondenceQueryRelationIds, readCorrespondenceTargetQueries, readCorrespondenceTargetSources } from './record-correspondence-target-sources'
type Db = BetterSQLite3Database<typeof schema>
export type ProofExecutor = Db | Parameters<Parameters<Db['transaction']>[0]>[0]
export function officialSource(db: ProofExecutor, evidence: OfficialEvidence) {
  validateOfficialProofScope(evidence)
  const documents = db.select().from(schema.sourceDocument).where(inArray(schema.sourceDocument.id, evidence.sourceDocuments.map(ref => ref.id))).all()
  const files = db.select({
    id: schema.storedFile.id, relPath: schema.storedFile.relPath, bytes: schema.storedFile.bytes,
    sha256: schema.storedFile.sha256, removedAt: schema.storedFile.removedAt,
    source: schema.rosterFileClassification.source,
  }).from(schema.storedFile).innerJoin(schema.rosterFileClassification, fileClassificationJoin).where(inArray(schema.storedFile.id, evidence.sourceDocuments.map(ref => ref.fileId))).all()
  const refs = officialProofReferences(evidence, documents, files, ref => {
    const coordinates = db.select({ id: schema.recordEvidence.id }).from(schema.recordEvidence).where(and(eq(schema.recordEvidence.sourceFile, documents.find(document => document.id === ref.id)!.path), ref.reference.page == null ? undefined : eq(schema.recordEvidence.page, ref.reference.page), ref.reference.attachment == null ? undefined : eq(schema.recordEvidence.attachment, ref.reference.attachment), ref.reference.listNo == null ? undefined : eq(schema.recordEvidence.listNo, ref.reference.listNo))).limit(1).get()
    return Boolean(coordinates)
  })
  const recordScope = and(eq(schema.record.source, 'jxj'), eq(schema.record.titleCode, evidence.titleCode), evidence.enterpriseIds === null ? undefined : inArray(schema.record.enterpriseId, evidence.enterpriseIds))
  const recordIds = db.select({ id: schema.record.id }).from(schema.record).where(recordScope)
  const eventScope = and(inArray(schema.recordEvent.recordId, recordIds), or(between(schema.recordEvent.year, evidence.fromYear, evidence.throughYear), between(schema.recordEvent.decidedYear, evidence.fromYear, evidence.throughYear)))
  const eventIds = db.select({ id: schema.recordEvent.id }).from(schema.recordEvent).where(eventScope)
  const records = db.select().from(schema.record).where(recordScope).orderBy(schema.record.id).all()
  const events = db.select().from(schema.recordEvent).where(eventScope).orderBy(schema.recordEvent.id).all()
  const eventEvidence = db.select().from(schema.recordEvidence).where(inArray(schema.recordEvidence.recordEventId, eventIds)).orderBy(schema.recordEvidence.id).all()
  return officialProofFingerprint(evidence, refs, records, events, eventEvidence)
}
export function currentSource(db: ProofExecutor, evidence: CurrentEvidence) {
  const target = readCorrespondenceTargetQueries(db, [evidence.queryId]).get(evidence.queryId)
  const batch = db.select().from(schema.platformExportBatch).where(eq(schema.platformExportBatch.id, evidence.exportBatchId)).get()
  const inputs = currentProofInputs(evidence, target, batch)
  const { scope } = evidence
  const freezeFile = db.select({
    id: schema.storedFile.id, relPath: schema.storedFile.relPath, bytes: schema.storedFile.bytes,
    sha256: schema.storedFile.sha256, removedAt: schema.storedFile.removedAt,
    source: schema.rosterFileClassification.source,
  }).from(schema.storedFile).innerJoin(schema.rosterFileClassification, fileClassificationJoin).where(eq(schema.storedFile.id, scope.freezeFileId)).get()
  const binding = validateCurrentProofBinding(evidence, inputs, freezeFile)
  const { query } = inputs.target
  const queryRows = readCorrespondenceTargetSources(db, correspondenceQueryRelationIds(db, query.id)).map(row => row.relation)
  const exportRows = db.select().from(schema.platformExportRow).where(eq(schema.platformExportRow.batchId, inputs.batch.id)).orderBy(schema.platformExportRow.id).all()
  return currentProofFingerprint(evidence, query, inputs.batch, binding, queryRows, exportRows)
}
export { fingerprint, ProofSourceError } from './comparison-scope-proof-source-model'
export { comparisonQueryFingerprint, type OfficialEvidence, type CurrentEvidence, validateOfficialProofScope, officialProofReferences, officialProofFingerprint, currentProofInputs, validateCurrentProofBinding, currentProofFingerprint } from './comparison-scope-proof-source-projection'
