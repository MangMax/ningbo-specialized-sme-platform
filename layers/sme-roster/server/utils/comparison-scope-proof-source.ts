import { fileClassificationJoin } from './roster-file-classification'
import { and,between,eq,inArray,or } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { createHash } from 'node:crypto'
import * as schema from '../../../../db/schema'
import type { PlatformStoredQuery } from '../../lib/platform/read'
import { RDJB_TITLE_CODES } from '../../lib/platform/recognized-evidence'
import { correspondenceQueryRelationIds,readCorrespondenceTargetQueries,readCorrespondenceTargetSources } from './record-correspondence-target-sources'
import { versionedOfficialEvent } from './roster-event-version'

type Db = BetterSQLite3Database<typeof schema>
export type ProofExecutor = Db | Parameters<Parameters<Db['transaction']>[0]>[0]
export const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Matches the comparison service's query identity without importing that service. */
export function comparisonQueryFingerprint(query: PlatformStoredQuery) {
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

export function validateOfficialProofScope(evidence: OfficialEvidence) {
  if (!evidence.fullRange || evidence.fromYear > evidence.throughYear || !evidence.sourceDocuments.length || evidence.enterpriseIds?.length === 0) fail('insufficient_evidence', 'Full official title/year/enterprise scope and source documents required')
  if (new Set(evidence.sourceDocuments.map(ref => ref.id)).size !== evidence.sourceDocuments.length) fail('insufficient_evidence', 'Duplicate source document')
}

type ProofDocument = typeof schema.sourceDocument.$inferSelect
type ProofFile = Pick<typeof schema.storedFile.$inferSelect, 'id' | 'relPath' | 'bytes' | 'sha256' | 'removedAt'> & {
  source: typeof schema.rosterFileClassification.$inferSelect.source
}

export function officialProofReferences(
  evidence: OfficialEvidence, documents: ProofDocument[], files: ProofFile[],
  hasCoordinates: (reference: OfficialEvidence['sourceDocuments'][number]) => boolean,
) {
  return evidence.sourceDocuments.map(ref => {
    const document = documents.find(row => row.id === ref.id)
    const file = files.find(row => row.id === ref.fileId)
    if (!document || !file) fail('source_missing', 'Archived official document or file missing')
    if (document.source !== 'jxj' || file.source !== 'jxj' || file.removedAt || file.relPath !== document.path || file.sha256 !== ref.sha256 || !ref.sha256) fail('source_mismatch', 'Official document/file/hash does not match')
    if (ref.reference.field === 'record_evidence.source_file') {
      if (!hasCoordinates(ref)) fail('source_mismatch', 'Official source coordinates do not exist')
    }
    return { document, file: { id: file.id, relPath: file.relPath, sha256: file.sha256, bytes: file.bytes, removedAt: file.removedAt }, reference: ref.reference }
  })
}

export function officialProofFingerprint(
  evidence: OfficialEvidence, refs: ReturnType<typeof officialProofReferences>,
  records: Array<typeof schema.record.$inferSelect>, events: Array<typeof schema.recordEvent.$inferSelect>,
  eventEvidence: Array<typeof schema.recordEvidence.$inferSelect>,
) {
  return { sourceFingerprint: fingerprint({ kind: 'official_coverage', scope: { titleCode: evidence.titleCode, fromYear: evidence.fromYear, throughYear: evidence.throughYear, enterpriseIds: evidence.enterpriseIds, fullRange: evidence.fullRange }, refs, records, events: events.map(versionedOfficialEvent), eventEvidence }), sourceSummary: { documents: refs.map(row => ({ id: row.document.id, path: row.document.path, sha256: row.file.sha256, reference: row.reference })), recordCount: records.length, eventCount: events.length } }
}

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

function sameStructuredFilters(filters: Record<string, unknown>, conditions: Record<string, unknown>) {
  return Object.keys(filters).length === Object.keys(conditions).length && Object.entries(filters).every(([key, value]) => same(value, conditions[key]))
}
type CurrentProofTarget = {
  query: PlatformStoredQuery
  collection: Pick<typeof schema.platformCollection.$inferSelect, 'interface' | 'status' | 'completeness' | 'fullRange' | 'queriedAt' | 'completedAt'>
  conditions: Pick<typeof schema.platformCollectionCondition.$inferSelect, 'name' | 'valueKind' | 'textValue' | 'integerValue'>[]
  scopes: Pick<typeof schema.platformQueryTitleScope.$inferSelect, 'rdjb'>[]
  pages: Pick<typeof schema.platformCollectionPage.$inferSelect, 'rdjb' | 'pageNo' | 'status' | 'maxPage' | 'declaredTotal' | 'fetchedCount'>[]
  unfinished: Pick<typeof schema.platformCollectionUnfinished.$inferSelect, 'ordinal'>[]
}
type ProofExportBatch = typeof schema.platformExportBatch.$inferSelect
type ProofExportRow = typeof schema.platformExportRow.$inferSelect

function completeTargetTitle(source: CurrentProofTarget, titleCode: string) {
  const c = source.collection
  if (c.interface !== 'recognized_list' || !['success', 'no_record'].includes(c.status) || c.completeness !== 'complete' || c.fullRange !== 1 || source.unfinished.length || !source.conditions.some(row => row.name === 'combination' && row.valueKind === 'text' && row.textValue === 'and')) return false
  const selected = source.scopes.filter(row => RDJB_TITLE_CODES[row.rdjb] === titleCode)
  if (selected.length !== 1) return false
  const pages = source.pages.filter(page => page.rdjb === selected[0]!.rdjb).sort((a, b) => a.pageNo! - b.pageNo!)
  if (!pages.length || pages[0]?.pageNo !== 1 || pages.some((page, index) => page.status !== 'success' || page.pageNo !== index + 1)) return false
  const last = pages.at(-1)!
  return last.maxPage !== null ? last.pageNo === last.maxPage : last.declaredTotal !== null ? pages.reduce((sum, page) => sum + (page.fetchedCount ?? 0), 0) === last.declaredTotal : last.fetchedCount === 0
}
export function currentProofInputs(evidence: CurrentEvidence, target?: CurrentProofTarget, batch?: ProofExportBatch) {
  if (!target || !batch) fail('source_missing', 'Archived query or export batch missing')
  if (batch.importStatus !== 'imported' || batch.titleCode !== evidence.titleCode || !/^[0-9a-f]{64}$/.test(batch.sha256) || !(completeTargetTitle(target, evidence.titleCode))) fail('insufficient_evidence', 'Complete recognized query and imported hashed same-title export required')

  const conditions: Record<string, unknown> = Object.fromEntries(target.conditions.filter(row => row.valueKind !== 'absent').map(row => [row.name, row.valueKind === 'text' ? row.textValue : row.valueKind === 'boolean' ? Boolean(row.integerValue) : row.integerValue]))
  const narrowed = ['name', 'uscc', 'sqsj', 'rddqrq', 'whpcyear', 'whpc', 'szq'].some(key => Boolean(conditions[key]))
  if (narrowed) fail('insufficient_evidence', 'Current equivalence requires full title scope without narrowing conditions')
  return { target, batch, conditions }
}

export function validateCurrentProofBinding(evidence: CurrentEvidence, inputs: ReturnType<typeof currentProofInputs>, freezeFile?: ProofFile) {
  const { target, batch, conditions } = inputs
  const { scope } = evidence
  if (!freezeFile || freezeFile.source !== 'miit' || freezeFile.removedAt || freezeFile.sha256 !== scope.freezeSha256 || freezeFile.relPath !== scope.freezeReference || !scope.freezeSha256) fail('source_mismatch', 'Archived platform freeze file reference/hash required')
  const start = Date.parse(scope.windowStart); const end = Date.parse(scope.windowEnd)
  const queried = Date.parse(target.collection.queriedAt); const completed = Date.parse(target.collection.completedAt ?? '')
  if (!scope.queryAccount || !scope.exportAccount || scope.queryAccount !== scope.exportAccount || !scope.queryRegion || scope.queryRegion !== scope.exportRegion || !scope.platformVersion || !scope.freezeReference || !Number.isFinite(start) || !Number.isFinite(end) || start > end || !(sameStructuredFilters(scope.queryFilters, conditions)) || !(sameStructuredFilters(scope.exportFilters, conditions))) fail('insufficient_evidence', 'Explicit equal account, region, filters, window, version and freeze evidence required')
  if (!Number.isFinite(queried) || !Number.isFinite(completed) || queried < start || completed > end || completed < queried || batch.collectedOn < scope.windowStart.slice(0, 10) || batch.collectedOn > scope.windowEnd.slice(0, 10)) fail('source_mismatch', 'Attested window excludes archived collection evidence')
  if (evidence.queryReference !== 'platform_query.collectionEvidence' || evidence.exportReference !== 'platform_export_batch.sha256' || !batch.sha256) fail('insufficient_evidence', 'Traceable original query and export field references required')
  return freezeFile
}

export function currentProofFingerprint(evidence: CurrentEvidence, query: PlatformStoredQuery, batch: ProofExportBatch, freezeFile: ProofFile, queryRows: import('../../lib/platform/read').PlatformStoredRelation[], exportRows: ProofExportRow[]) {
  const { scope } = evidence
  return { sourceFingerprint: fingerprint({ kind: 'current_source_equivalence', query, queryRows, batch, exportRows, scope, freezeFile: { id: freezeFile.id, relPath: freezeFile.relPath, sha256: freezeFile.sha256, bytes: freezeFile.bytes } }), querySourceFingerprint: comparisonQueryFingerprint(query), exportSha256: batch.sha256, sourceSummary: { queryId: query.id, queryRowCount: queryRows.length, exportBatchId: batch.id, exportRowCount: exportRows.length, queryReference: evidence.queryReference, exportReference: evidence.exportReference, freezeFileId: freezeFile.id, freezeSha256: freezeFile.sha256 } }
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
