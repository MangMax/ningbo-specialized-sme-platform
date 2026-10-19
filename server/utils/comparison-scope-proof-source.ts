import { and, eq, inArray, or, between } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { versionedOfficialEvent } from './roster-event-version'
import { RDJB_TITLE_CODES } from '../../lib/platform/recognized-evidence'

type Db = BetterSQLite3Database<typeof schema>
export type ProofExecutor = Db | Parameters<Parameters<Db['transaction']>[0]>[0]
export const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Matches the comparison service's query identity without importing that service. */
export function comparisonQueryFingerprint(query: typeof schema.platformQuery.$inferSelect) {
  return fingerprint({ id: query.id, interface: query.interface, queryKey: query.queryKey, rdjb: query.rdjb, titleCode: query.titleCode, queriedAt: query.queriedAt, status: query.status, collectionEvidence: query.collectionEvidence })
}

export type OfficialEvidence = {
  titleCode: string; fromYear: number; throughYear: number; enterpriseIds: number[] | null; fullRange: true
  sourceDocuments: Array<{ id: number; fileId: number; sha256: string; reference: { field: 'source_document.path' | 'record_evidence.source_file'; page?: number; attachment?: string; listNo?: number } }>
}
export type CurrentEvidence = {
  queryId: number; exportBatchId: number; titleCode: string
  queryReference: 'platform_query.collectionEvidence'; exportReference: 'platform_export_batch.sha256'
  scope: {
    queryAccount: string; exportAccount: string; queryRegion: string; exportRegion: string
    queryFilters: Record<string, unknown>; exportFilters: Record<string, unknown>
    windowStart: string; windowEnd: string; platformVersion: string; freezeReference: string; freezeFileId: number; freezeSha256: string
  }
}

export class ProofSourceError extends Error {
  constructor(readonly code: 'source_missing' | 'insufficient_evidence' | 'source_mismatch', message: string) { super(message) }
  get status() { return this.code === 'source_missing' ? 404 : 422 }
}
function fail(code: ProofSourceError['code'], message: string): never { throw new ProofSourceError(code, message) }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export function officialSource(db: ProofExecutor, evidence: OfficialEvidence) {
  if (!evidence.fullRange || evidence.fromYear > evidence.throughYear || !evidence.sourceDocuments.length || evidence.enterpriseIds?.length === 0) fail('insufficient_evidence', 'Full official title/year/enterprise scope and source documents required')
  if (new Set(evidence.sourceDocuments.map(ref => ref.id)).size !== evidence.sourceDocuments.length) fail('insufficient_evidence', 'Duplicate source document')
  const documents = db.select().from(schema.sourceDocument).where(inArray(schema.sourceDocument.id, evidence.sourceDocuments.map(ref => ref.id))).all()
  const files = db.select().from(schema.storedFile).where(inArray(schema.storedFile.id, evidence.sourceDocuments.map(ref => ref.fileId))).all()
  const refs = evidence.sourceDocuments.map(ref => {
    const document = documents.find(row => row.id === ref.id)
    const file = files.find(row => row.id === ref.fileId)
    if (!document || !file) fail('source_missing', 'Archived official document or file missing')
    if (document.source !== 'jxj' || file.source !== 'jxj' || file.removedAt || file.relPath !== document.path || file.sha256 !== ref.sha256 || !ref.sha256) fail('source_mismatch', 'Official document/file/hash does not match')
    if (ref.reference.field === 'record_evidence.source_file') {
      const coordinates = db.select({ id: schema.recordEvidence.id }).from(schema.recordEvidence).where(and(eq(schema.recordEvidence.sourceFile, document.path), ref.reference.page == null ? undefined : eq(schema.recordEvidence.page, ref.reference.page), ref.reference.attachment == null ? undefined : eq(schema.recordEvidence.attachment, ref.reference.attachment), ref.reference.listNo == null ? undefined : eq(schema.recordEvidence.listNo, ref.reference.listNo))).limit(1).get()
      if (!coordinates) fail('source_mismatch', 'Official source coordinates do not exist')
    }
    return { document, file: { id: file.id, relPath: file.relPath, sha256: file.sha256, bytes: file.bytes, removedAt: file.removedAt }, reference: ref.reference }
  })
  const recordScope = and(eq(schema.record.source, 'jxj'), eq(schema.record.titleCode, evidence.titleCode), evidence.enterpriseIds === null ? undefined : inArray(schema.record.enterpriseId, evidence.enterpriseIds))
  const recordIds = db.select({ id: schema.record.id }).from(schema.record).where(recordScope)
  const eventScope = and(inArray(schema.recordEvent.recordId, recordIds), or(between(schema.recordEvent.year, evidence.fromYear, evidence.throughYear), between(schema.recordEvent.decidedYear, evidence.fromYear, evidence.throughYear)))
  const eventIds = db.select({ id: schema.recordEvent.id }).from(schema.recordEvent).where(eventScope)
  const records = db.select().from(schema.record).where(recordScope).orderBy(schema.record.id).all()
  const events = db.select().from(schema.recordEvent).where(eventScope).orderBy(schema.recordEvent.id).all()
  const eventEvidence = db.select().from(schema.recordEvidence).where(inArray(schema.recordEvidence.recordEventId, eventIds)).orderBy(schema.recordEvidence.id).all()
  return { sourceFingerprint: fingerprint({ kind: 'official_coverage', scope: { titleCode: evidence.titleCode, fromYear: evidence.fromYear, throughYear: evidence.throughYear, enterpriseIds: evidence.enterpriseIds, fullRange: evidence.fullRange }, refs, records, events: events.map(versionedOfficialEvent), eventEvidence }), sourceSummary: { documents: refs.map(row => ({ id: row.document.id, path: row.document.path, sha256: row.file.sha256, reference: row.reference })), recordCount: records.length, eventCount: events.length } }
}

function completeTitle(query: typeof schema.platformQuery.$inferSelect, titleCode: string) {
  const collection = query.collectionEvidence
  if (!collection || query.interface !== 'recognized_list' || !['success', 'no_record'].includes(query.status) || collection.completeness !== 'complete' || collection.fullRange !== true || collection.unfinished.length || collection.effectiveConditions.combination !== 'and') return false
  const selected = collection.titleScope.rdjb.filter(rdjb => RDJB_TITLE_CODES[rdjb] === titleCode)
  if (selected.length !== 1) return false
  const pages = collection.pages.filter(page => page.rdjb === selected[0]).sort((a, b) => a.page - b.page)
  if (!pages.length || pages[0]?.page !== 1 || pages.some((page, index) => page.status !== 'success' || page.page !== index + 1)) return false
  const last = pages.at(-1)!
  return last.maxPage != null ? last.page === last.maxPage : last.declaredTotal != null ? pages.reduce((sum, page) => sum + page.fetchedCount, 0) === last.declaredTotal : last.fetchedCount === 0
}

export function currentSource(db: ProofExecutor, evidence: CurrentEvidence) {
  const query = db.select().from(schema.platformQuery).where(eq(schema.platformQuery.id, evidence.queryId)).get()
  const batch = db.select().from(schema.platformExportBatch).where(eq(schema.platformExportBatch.id, evidence.exportBatchId)).get()
  if (!query || !batch) fail('source_missing', 'Archived query or export batch missing')
  if (batch.importStatus !== 'imported' || batch.titleCode !== evidence.titleCode || !/^[0-9a-f]{64}$/.test(batch.sha256) || !completeTitle(query, evidence.titleCode)) fail('insufficient_evidence', 'Complete recognized query and imported hashed same-title export required')
  const actual = query.collectionEvidence!
  const conditions = actual.effectiveConditions as unknown as Record<string, unknown>
  const narrowed = ['name', 'uscc', 'sqsj', 'rddqrq', 'whpcyear', 'whpc', 'szq'].some(key => Boolean(conditions[key]))
  if (narrowed) fail('insufficient_evidence', 'Current equivalence requires full title scope without narrowing conditions')
  const scope = evidence.scope
  const freezeFile = db.select().from(schema.storedFile).where(eq(schema.storedFile.id, scope.freezeFileId)).get()
  if (!freezeFile || freezeFile.source !== 'miit' || freezeFile.removedAt || freezeFile.sha256 !== scope.freezeSha256 || freezeFile.relPath !== scope.freezeReference || !scope.freezeSha256) fail('source_mismatch', 'Archived platform freeze file reference/hash required')
  const start = Date.parse(scope.windowStart); const end = Date.parse(scope.windowEnd)
  const queried = Date.parse(actual.queriedAt); const completed = Date.parse(actual.completedAt)
  if (!scope.queryAccount || !scope.exportAccount || scope.queryAccount !== scope.exportAccount || !scope.queryRegion || scope.queryRegion !== scope.exportRegion || !scope.platformVersion || !scope.freezeReference || !Number.isFinite(start) || !Number.isFinite(end) || start > end || !same(scope.queryFilters, conditions) || !same(scope.exportFilters, conditions)) fail('insufficient_evidence', 'Explicit equal account, region, filters, window, version and freeze evidence required')
  if (!Number.isFinite(queried) || !Number.isFinite(completed) || queried < start || completed > end || completed < queried || batch.collectedOn < scope.windowStart.slice(0, 10) || batch.collectedOn > scope.windowEnd.slice(0, 10)) fail('source_mismatch', 'Attested window excludes archived collection evidence')
  if (evidence.queryReference !== 'platform_query.collectionEvidence' || evidence.exportReference !== 'platform_export_batch.sha256' || !batch.sha256) fail('insufficient_evidence', 'Traceable original query and export field references required')
  const queryRows = db.select().from(schema.platformRelation).where(eq(schema.platformRelation.queryId, query.id)).orderBy(schema.platformRelation.id).all()
  const exportRows = db.select().from(schema.platformExportRow).where(eq(schema.platformExportRow.batchId, batch.id)).orderBy(schema.platformExportRow.id).all()
  return { sourceFingerprint: fingerprint({ kind: 'current_source_equivalence', query, queryRows, batch, exportRows, scope, freezeFile: { id: freezeFile.id, relPath: freezeFile.relPath, sha256: freezeFile.sha256, bytes: freezeFile.bytes } }), querySourceFingerprint: comparisonQueryFingerprint(query), exportSha256: batch.sha256, sourceSummary: { queryId: query.id, queryRowCount: queryRows.length, exportBatchId: batch.id, exportRowCount: exportRows.length, queryReference: evidence.queryReference, exportReference: evidence.exportReference, freezeFileId: freezeFile.id, freezeSha256: freezeFile.sha256 } }
}
