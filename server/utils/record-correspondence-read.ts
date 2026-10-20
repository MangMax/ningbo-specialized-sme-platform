import { asc, eq, getTableColumns, inArray, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { sourcePositionForSequence } from '../../lib/platform/recognized-evidence'
import { getRecordCorrespondenceAudit, listRecordCorrespondenceRefs, type CorrespondenceRead } from './record-correspondence'

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
function chunks<T>(values: T[]) {
  const unique = [...new Set(values)]
  return Array.from({ length: Math.ceil(unique.length / 400) }, (_, i) => unique.slice(i * 400, (i + 1) * 400))
}
/** Request-local hydration only. Never retained across a write or shared with another request. */
export function sourceReader(db: Db, rows: CorrespondenceRead[], extra?: { kind: SourceKind; id: number }) {
  const eventIds = [...new Set(rows.flatMap(row => [row.eventId, row.predecessorEventId]).filter((id): id is number => id != null).concat(extra?.kind === 'event' ? [extra.id] : []))]
  const relationIds = [...new Set(rows.flatMap(row => row.relationId == null ? [] : [row.relationId]).concat(extra?.kind === 'relation' ? [extra.id] : []))]
  const exportRowIds = [...new Set(rows.flatMap(row => row.exportRowId == null ? [] : [row.exportRowId]).concat(extra?.kind === 'export_row' ? [extra.id] : []))]
  const events = chunks(eventIds).flatMap(ids => db.select({ event: schema.recordEvent, record: schema.record }).from(schema.recordEvent).innerJoin(schema.record, eq(schema.recordEvent.recordId, schema.record.id)).where(inArray(schema.recordEvent.id, ids)).all())
  const evidenceRows = chunks(eventIds).flatMap(ids => db.select().from(schema.recordEvidence).where(inArray(schema.recordEvidence.recordEventId, ids)).orderBy(asc(schema.recordEvidence.id)).all())
  const files = chunks(evidenceRows.map(e => e.sourceFile)).flatMap(paths => db.select({ id: schema.storedFile.id, relPath: schema.storedFile.relPath, bytes: schema.storedFile.bytes, sha256: schema.storedFile.sha256, removedAt: schema.storedFile.removedAt }).from(schema.storedFile).where(inArray(schema.storedFile.relPath, paths)).all())
  const filesByPath = new Map(files.map(f => [f.relPath, f]))
  const evidenceByEvent = Map.groupBy(evidenceRows, e => e.recordEventId)
  const { rawResponse: _rawResponse, collectionEvidence, ...queryColumns } = getTableColumns(schema.platformQuery)
  const relations = chunks(relationIds).flatMap(ids => db.select({ relation: schema.platformRelation, query: { ...queryColumns, collectionEvidence: sql`json_remove(${collectionEvidence}, '$.rows')`.mapWith(collectionEvidence) } }).from(schema.platformRelation).innerJoin(schema.platformQuery, eq(schema.platformRelation.queryId, schema.platformQuery.id)).where(inArray(schema.platformRelation.id, ids)).all())
  const exports = chunks(exportRowIds).flatMap(ids => db.select({ row: schema.platformExportRow, batch: schema.platformExportBatch }).from(schema.platformExportRow).innerJoin(schema.platformExportBatch, eq(schema.platformExportRow.batchId, schema.platformExportBatch.id)).where(inArray(schema.platformExportRow.id, ids)).all())
  // Three source sets together stay below SQLite's parameter budget, including the repeated event predicate.
  const links = new Map<number, ReturnType<typeof listRecordCorrespondenceRefs>[number]>()
  const eventChunks = chunks(eventIds), relationChunks = chunks(relationIds), exportChunks = chunks(exportRowIds)
  for (let i = 0; i < Math.max(eventChunks.length, relationChunks.length, exportChunks.length); i++) {
    for (const link of listRecordCorrespondenceRefs(db, {}, { eventIds: eventChunks[i] ?? [], relationIds: relationChunks[i] ?? [], exportRowIds: exportChunks[i] ?? [] })) links.set(link.id, link)
  }
  const sortedLinks = [...links.values()].sort((a, b) => a.id - b.id)
  const byEvent = Map.groupBy(sortedLinks.filter(r => r.eventId != null), r => r.eventId)
  const byPredecessor = Map.groupBy(sortedLinks.filter(r => r.predecessorEventId != null), r => r.predecessorEventId)
  const byRelation = Map.groupBy(sortedLinks.filter(r => r.relationId != null), r => r.relationId)
  const byExport = Map.groupBy(sortedLinks.filter(r => r.exportRowId != null), r => r.exportRowId)
  const eventSources = new Map(events.map(joined => {
    const id = joined.event.id, evidence = evidenceByEvent.get(id) ?? []
    const officialEvidence = evidence.map(item => ({ evidence: sanitizeEvidence(item), storedFile: filesByPath.get(item.sourceFile) ?? null }))
    const eventLinks = [...new Map([...(byEvent.get(id) ?? []), ...(byPredecessor.get(id) ?? [])].map(r => [r.id, r])).values()].sort((a, b) => a.id - b.id)
    return [id, { ...joined.event, record: { id: joined.record.id, enterpriseId: joined.record.enterpriseId, titleCode: joined.record.titleCode, source: joined.record.source, usccRaw: joined.record.usccRaw }, evidence: sanitizeEvidence(evidence), officialEvidence: sanitizeEvidence(officialEvidence), correspondences: eventLinks }] as const
  }))
  const relationSources = new Map(relations.map(({ relation, query }) => {
    const position = sourcePositionForSequence(query.collectionEvidence, relation.sequenceNo)
    return [relation.id, { ...relation, sourceRdjb: position.sourceRdjb, sourcePage: position.sourcePage, rawFields: sanitizeEvidence(relation.rawFields), query: { ...query, failureReason: sanitizeEvidence(query.failureReason), collectionEvidence: safeCollectionEvidence(query.collectionEvidence) }, correspondences: byRelation.get(relation.id) ?? [] }] as const
  }))
  const exportSources = new Map(exports.map(({ row, batch }) => [row.id, { ...row, rawFields: sanitizeEvidence(row.rawFields), batch: sanitizeEvidence(batch), correspondences: byExport.get(row.id) ?? [] }] as const))
  const read = (kind: SourceKind, id: number) => kind === 'event' ? eventSources.get(id) ?? null : kind === 'relation' ? relationSources.get(id) ?? null : exportSources.get(id) ?? null
  const detailRow = (row: CorrespondenceRead) => {
    const { edgeKey: _edgeKey, targetIdentity: _targetIdentity, provenance: _provenance, sourceFingerprint: _sourceFingerprint, ...publicRow } = row
    return { ...publicRow, event: row.eventId ? read('event', row.eventId) : null, predecessorEvent: row.predecessorEventId ? read('event', row.predecessorEventId) : null, relation: row.relationId ? read('relation', row.relationId) : null, exportRow: row.exportRowId ? read('export_row', row.exportRowId) : null }
  }
  return { read, detail: detailRow }
}
export function readSource(db: Db, kind: SourceKind, id: number) { return sourceReader(db, [], { kind, id }).read(kind, id) }
export function eventSource(db: Db, id: number) { return readSource(db, 'event', id) }
export function relationSource(db: Db, id: number) { return readSource(db, 'relation', id) }
export function exportRowSource(db: Db, id: number) { return readSource(db, 'export_row', id) }
export function details(db: Db, rows: CorrespondenceRead[]) {
  const reader = sourceReader(db, rows)
  return rows.map(reader.detail)
}
/** Opt-in list projection; source IDs resolve through the existing point/source routes. */
export function summaries(rows: CorrespondenceRead[]) {
  return rows.map(({ edgeKey: _edgeKey, targetIdentity: _targetIdentity, provenance: _provenance, sourceFingerprint: _sourceFingerprint, ...publicRow }) => publicRow)
}
export function detail(db: Db, row: CorrespondenceRead) { return details(db, [row])[0]! }
export function audit(db: Db, correspondenceId: number) {
  return getRecordCorrespondenceAudit(db, correspondenceId).map(({ evidence, ...row }) => ({ ...row, evidence: sanitizeEvidence(evidence) }))
}
