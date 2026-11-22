import { type SourceSelection, correspondenceSourceSelections, correspondencePublishedScope, projectCorrespondenceSources, type SourceKind } from './record-correspondence-projection'
import { asc, eq, inArray } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../../db/schema'
import { readPublicPublishedNames } from '../../lib/roster/official-published-presentation-sqlite'
import type { ReceiptRedactor } from './import-receipt-redaction'
import { readTargetRelationEvidenceDisplay } from './platform-relation-evidence-display-target'
import { sanitizeEvidence } from './evidence-redaction'
export { safeCollectionEvidence, sanitizeEvidence } from './evidence-redaction'
import { getRecordCorrespondenceAudit, listRecordCorrespondenceRefs, type CorrespondenceRead } from './record-correspondence'
type Db = BetterSQLite3Database<typeof schema>
function chunks<T>(values: T[]) {
  const unique = [...new Set(values)]
  return Array.from({ length: Math.ceil(unique.length / 400) }, (_, i) => unique.slice(i * 400, (i + 1) * 400))
}
/** Request-local hydration only. Never retained across a write or shared with another request. */
export function sourceReader(db: Db, rows: CorrespondenceRead[], extra?: SourceSelection, redactor?: ReceiptRedactor) {
  const { eventIds, relationIds, exportRowIds, occurrences } = correspondenceSourceSelections(rows, extra)
  const events = chunks(eventIds).flatMap(ids => db.select({ event: schema.recordEvent, record: schema.record }).from(schema.recordEvent).innerJoin(schema.record, eq(schema.recordEvent.recordId, schema.record.id)).where(inArray(schema.recordEvent.id, ids)).all())
  const evidenceRows = chunks(eventIds).flatMap(ids => db.select().from(schema.recordEvidence).where(inArray(schema.recordEvidence.recordEventId, ids)).orderBy(asc(schema.recordEvidence.id)).all())
  const files = chunks(evidenceRows.map(e => e.sourceFile)).flatMap(paths => db.select({ id: schema.storedFile.id, relPath: schema.storedFile.relPath, bytes: schema.storedFile.bytes, sha256: schema.storedFile.sha256, removedAt: schema.storedFile.removedAt }).from(schema.storedFile).where(inArray(schema.storedFile.relPath, paths)).all())
  const targetDisplays = readTargetRelationEvidenceDisplay(db, relationIds.map(relationId => ({ relationId })), redactor).sources
  const exports = chunks(exportRowIds).flatMap(ids => db.select({ row: schema.platformExportRow, batch: schema.platformExportBatch }).from(schema.platformExportRow).innerJoin(schema.platformExportBatch, eq(schema.platformExportRow.batchId, schema.platformExportBatch.id)).where(inArray(schema.platformExportRow.id, ids)).all())
  // Three source sets together stay below SQLite's parameter budget, including the repeated event predicate.
  const links = new Map<number, ReturnType<typeof listRecordCorrespondenceRefs>[number]>()
  const eventChunks = chunks(eventIds), relationChunks = chunks(relationIds), exportChunks = chunks(exportRowIds)
  for (let i = 0; i < Math.max(eventChunks.length, relationChunks.length, exportChunks.length); i++) {
    for (const link of listRecordCorrespondenceRefs(db, {}, { eventIds: eventChunks[i] ?? [], relationIds: relationChunks[i] ?? [], exportRowIds: exportChunks[i] ?? [] })) links.set(link.id, link)
  }
  const sortedLinks = [...links.values()].sort((a, b) => a.id - b.id)
  const { scope, copies } = correspondencePublishedScope(evidenceRows, occurrences)
  const presentation = readPublicPublishedNames(db, scope, copies, occurrences.length, 1, redactor)
  return projectCorrespondenceSources({ events, evidenceRows, files, sortedLinks, exports, targetDisplays, presentation })
}
export function readSource(db: Db, kind: SourceKind, id: number, redactor?: ReceiptRedactor) { return sourceReader(db, [], { kind, id }, redactor).read(kind, id) }
export function eventSource(db: Db, id: number, redactor?: ReceiptRedactor) { return readSource(db, 'event', id, redactor) as ReturnType<typeof detail>['event'] }
export function relationSource(db: Db, id: number, redactor?: ReceiptRedactor) { return readSource(db, 'relation', id, redactor) }
export function exportRowSource(db: Db, id: number, redactor?: ReceiptRedactor) { return readSource(db, 'export_row', id, redactor) }
export function details(db: Db, rows: CorrespondenceRead[], redactor?: ReceiptRedactor) {
  const reader = sourceReader(db, rows, undefined, redactor)
  return rows.map(reader.detail)
}
export function detail(db: Db, row: CorrespondenceRead, redactor?: ReceiptRedactor) { return details(db, [row], redactor)[0]! }
export function audit(db: Db, correspondenceId: number) {
  return getRecordCorrespondenceAudit(db, correspondenceId).map(({ evidence, ...row }) => ({ ...row, evidence: sanitizeEvidence(evidence) }))
}
export { type SourceKind, type SourceSelection, correspondenceSourceSelections, type SourceEvidence, correspondencePublishedScope, projectCorrespondenceSources } from './record-correspondence-projection'
export { summaries } from './record-correspondence-summary-projection'
