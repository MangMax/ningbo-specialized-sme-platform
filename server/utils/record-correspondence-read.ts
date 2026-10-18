import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { sourcePositionForSequence } from '../../lib/platform/recognized-evidence'
import { getRecordCorrespondenceAudit, listRecordCorrespondences, type CorrespondenceRead } from './record-correspondence'

type Db = BetterSQLite3Database<typeof schema>
export type SourceKind = 'event' | 'relation' | 'export_row'
const secretKey = /cookie|password|passwd|token|secret|credential|authorization|api.?key|session|set-cookie|rawresponse|raw_response/i
const credentialName = String.raw`(?:set[-_]?cookie|cookie|password|passwd|(?:access|refresh|id)[-_]?token|token|secret|credential|authorization|authentication|auth|api[-_]?key|session(?:id)?|raw[-_]?response)`
const escapedJsonCredential = new RegExp(String.raw`(\\"${credentialName}\\"\s*:\s*\\")((?:(?!\\").)*)(\\")`, 'gi')
const jsonCredential = new RegExp(String.raw`("${credentialName}"\s*:\s*")((?:\\.|[^"\\])*)(")`, 'gi')
const assignmentCredential = new RegExp(String.raw`(\b${credentialName}\b\s*(?:[:=]|%3A|%3D)\s*(?:\\?"|%22)?)([^\s;,&}\]"']+)`, 'gi')
function redactAssignments(value: string): string {
  return value
    .replace(escapedJsonCredential, '$1[REDACTED]$3')
    .replace(jsonCredential, '$1[REDACTED]$3')
    .replace(assignmentCredential, (match, prefix: string, existing: string) => existing === '[REDACTED' ? match : `${prefix}[REDACTED]`)
}
function redactCredentialEchoes(value: string): string {
  const direct = redactAssignments(value)
  // Archived evidence can contain URI-encoded JSON, or JSON quoted inside
  // another string. Unwrap a bounded number of reversible layers and apply
  // the same structural assignment checks, including ordinary JSON spacing.
  let normalized = direct
  let foundEncodedCredential = false
  for (let depth = 0; depth < 4; depth++) {
    let next = normalized
    next = next.replace(/(?:%[0-9a-f]{2})+/gi, encoded => {
      try { return decodeURIComponent(encoded) } catch { return encoded }
    })
    next = next.replace(/\\(["\\])/g, '$1')
    if (next === normalized) break
    const sanitized = redactAssignments(next)
    if (sanitized !== next) foundEncodedCredential = true
    normalized = sanitized
  }
  return foundEncodedCredential ? normalized : direct
}
export function sanitizeEvidence(value: unknown, knownRedactors: ReadonlyArray<(text: string) => string> = []): unknown {
  if (Array.isArray(value)) return value.map(item => sanitizeEvidence(item, knownRedactors))
  const redact = (text: string) => knownRedactors.reduce((result, known) => known(result), redactCredentialEchoes(text))
  if (typeof value === 'string') return redact(value)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !secretKey.test(key)).map(([key, item]) => [redact(key), sanitizeEvidence(item, knownRedactors)]))
  return value
}
export function safeCollectionEvidence(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { rows: _rows, ...metadata } = value as Record<string, unknown>
  return sanitizeEvidence(metadata)
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
  const position = sourcePositionForSequence(query.collectionEvidence, joined.relation.sequenceNo)
  return { ...joined.relation, sourceRdjb: position.sourceRdjb, sourcePage: position.sourcePage, rawFields: sanitizeEvidence(joined.relation.rawFields), query: { ...query, failureReason: sanitizeEvidence(query.failureReason), collectionEvidence: safeCollectionEvidence(query.collectionEvidence) }, correspondences: refs(db, { relationId: id }) }
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
