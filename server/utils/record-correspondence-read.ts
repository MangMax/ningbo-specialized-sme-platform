import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { getRecordCorrespondenceAudit, listRecordCorrespondences, type CorrespondenceRead } from './record-correspondence'

type Db = BetterSQLite3Database<typeof schema>
export type SourceKind = 'event' | 'relation' | 'export_row'
const secretKey = /cookie|password|passwd|token|secret|credential|authorization|api.?key|session|set-cookie|rawresponse|raw_response/i
export function sanitizeEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeEvidence)
  if (typeof value === 'string') return value.replace(/\b(cookie|token|password|secret|authorization|api[_-]?key)\s*[:=]\s*[^\s;,]+/gi, '$1=[REDACTED]')
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !secretKey.test(key)).map(([key, item]) => [key, sanitizeEvidence(item)]))
  return value
}
function refs(db: Db, filter: Parameters<typeof listRecordCorrespondences>[1]) {
  return listRecordCorrespondences(db, filter).map(({ id, type, role, status, eventId, predecessorEventId, relationId, exportRowId, enterpriseId, titleCode, revision, requiresRevalidation }) => ({ id, type, role, status, eventId, predecessorEventId, relationId, exportRowId, enterpriseId, titleCode, revision, requiresRevalidation }))
}
export function eventSource(db: Db, id: number) {
  const joined = db.select({ event: schema.recordEvent, record: schema.record }).from(schema.recordEvent).innerJoin(schema.record, eq(schema.recordEvent.recordId, schema.record.id)).where(eq(schema.recordEvent.id, id)).get()
  if (!joined) return null
  const evidence = db.select().from(schema.recordEvidence).where(eq(schema.recordEvidence.recordEventId, id)).all().sort((a, b) => a.id - b.id)
  const officialEvidence = evidence.map(item => ({ evidence: sanitizeEvidence(item), storedFile: db.select({ id: schema.storedFile.id, relPath: schema.storedFile.relPath, bytes: schema.storedFile.bytes, sha256: schema.storedFile.sha256, removedAt: schema.storedFile.removedAt }).from(schema.storedFile).where(eq(schema.storedFile.relPath, item.sourceFile)).get() ?? null }))
  const eventLinks = listRecordCorrespondences(db).filter(row => row.eventId === id || row.predecessorEventId === id)
  return { ...joined.event, record: { id: joined.record.id, enterpriseId: joined.record.enterpriseId, titleCode: joined.record.titleCode, source: joined.record.source, usccRaw: joined.record.usccRaw }, evidence: sanitizeEvidence(evidence), officialEvidence: sanitizeEvidence(officialEvidence), correspondences: eventLinks.map(({ id, type, role, status, eventId, predecessorEventId, relationId, exportRowId, enterpriseId, titleCode, revision, requiresRevalidation }) => ({ id, type, role, status, eventId, predecessorEventId, relationId, exportRowId, enterpriseId, titleCode, revision, requiresRevalidation })) }
}
export function relationSource(db: Db, id: number) {
  const joined = db.select({ relation: schema.platformRelation, query: schema.platformQuery }).from(schema.platformRelation).innerJoin(schema.platformQuery, eq(schema.platformRelation.queryId, schema.platformQuery.id)).where(eq(schema.platformRelation.id, id)).get()
  if (!joined) return null
  const { rawResponse: _rawResponse, ...query } = joined.query
  return { ...joined.relation, rawFields: sanitizeEvidence(joined.relation.rawFields), query: { ...query, failureReason: sanitizeEvidence(query.failureReason), collectionEvidence: sanitizeEvidence(query.collectionEvidence) }, correspondences: refs(db, { relationId: id }) }
}
export function exportRowSource(db: Db, id: number) {
  const joined = db.select({ row: schema.platformExportRow, batch: schema.platformExportBatch }).from(schema.platformExportRow).innerJoin(schema.platformExportBatch, eq(schema.platformExportRow.batchId, schema.platformExportBatch.id)).where(eq(schema.platformExportRow.id, id)).get()
  if (!joined) return null
  return { ...joined.row, rawFields: sanitizeEvidence(joined.row.rawFields), batch: sanitizeEvidence(joined.batch), correspondences: refs(db, { exportRowId: id }) }
}
export function readSource(db: Db, kind: SourceKind, id: number) {
  if (kind === 'event') return eventSource(db, id)
  if (kind === 'relation') return relationSource(db, id)
  return exportRowSource(db, id)
}
export function detail(db: Db, row: CorrespondenceRead) {
  const { edgeKey: _edgeKey, targetIdentity: _targetIdentity, provenance: _provenance, sourceFingerprint: _sourceFingerprint, ...publicRow } = row
  return { ...publicRow, event: row.eventId ? eventSource(db, row.eventId) : null, predecessorEvent: row.predecessorEventId ? eventSource(db, row.predecessorEventId) : null, relation: row.relationId ? relationSource(db, row.relationId) : null, exportRow: row.exportRowId ? exportRowSource(db, row.exportRowId) : null }
}
export function audit(db: Db, correspondenceId: number) {
  return getRecordCorrespondenceAudit(db, correspondenceId).map(({ evidence, ...row }) => ({ ...row, evidence: sanitizeEvidence(evidence) }))
}
