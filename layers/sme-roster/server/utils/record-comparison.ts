import { validatedComparisonInput, comparisonBefore, type Query, type Relation, type SelectedRecordComparison, compareRecordInputs, type ComparisonRead, type ReadResult, projectLegacyComparisonImpact, type SourceEnterpriseLink, unique, projectSourceEnterpriseLinks, comparisonCatalogWindows, projectCatalogDocument, projectCatalogExport, projectCatalogQuery } from './record-comparison-model'
import { and, eq, getTableColumns, inArray, isNull, or, sql } from 'drizzle-orm'
import type { useApplicationDb } from '../../../../db/client'
import * as schema from '../../../../db/schema'
import { normalizeName } from '../../lib/domain'
import { differenceEvidenceColumns } from '../../lib/platform/difference-reference-target'
import { targetSchema } from '../../lib/platform/target-schema'
import { comparisonSourceCatalogInput, type ComparisonSourceCatalogInput, type RecordComparisonInput } from '../../lib/roster/record-comparison'
import { registeredFileAtLocator } from '../../../core/server/utils/file-read-identity'
import { officialSourceDirectory, readOfficialSourceDocuments } from './official-source-directory'
import { readPlatformBusinessMetadata } from './platform-business-record-read'
import { comparisonFormalCounts, iterateComparisonFormalEvents } from './record-comparison-formal'
import { readComparisonTargetIdentities, readComparisonTargetQueryFacts, readComparisonTargetRelations } from './record-comparison-target-sources'
import { readScopedRecordCorrespondences } from './record-correspondence'
import { correspondenceColumns, correspondenceTable } from './record-correspondence-store'
type Db = ReturnType<typeof useApplicationDb>
export function selected(db: Db, input: RecordComparisonInput) {
  const parsed = validatedComparisonInput(input)
  const targetFacts = readComparisonTargetQueryFacts(db, parsed.queryIds)
  if ((targetFacts.length !== parsed.queryIds.length || targetFacts.some(row => !comparisonBefore(row.collection.queriedAt, parsed.asOf)))) throw new Error('source_set_missing_or_out_of_scope')
  const queries: Query[] = targetFacts.map(facts => ({ ...facts.collection, id: facts.id, collectionEvidence: null, rawResponse: null, comparisonFacts: facts })).filter(row => comparisonBefore(row.queriedAt, parsed.asOf))
  const batches = db.select().from(schema.platformExportBatch).where(inArray(schema.platformExportBatch.id, parsed.exportBatchIds)).orderBy(schema.platformExportBatch.id).all().filter(row => row.importStatus === 'imported' && comparisonBefore(row.collectedOn, parsed.asOf))
  const documents = readOfficialSourceDocuments(db, parsed.officialSourceDocumentIds).filter(row => row.source === 'jxj' && (!parsed.asOf || comparisonBefore(row.issueDate, parsed.asOf)))
  if (queries.length !== parsed.queryIds.length || batches.length !== parsed.exportBatchIds.length || documents.length !== parsed.officialSourceDocumentIds.length) throw new Error('source_set_missing_or_out_of_scope')
  const queryMap = new Map(queries.map(row => [row.id, row]))
  const batchMap = new Map(batches.map(row => [row.id, row]))
  const relations: Array<{ relation: Relation; query: Query }> = readComparisonTargetRelations(db, parsed.queryIds).map(relation => ({ relation, query: queryMap.get(relation.queryId)! }))
  const exports = db.select({ ...getTableColumns(schema.platformExportRow), rawFields: sql<null>`null` }).from(schema.platformExportRow).where(inArray(schema.platformExportRow.batchId, parsed.exportBatchIds)).orderBy(schema.platformExportRow.id).all().map(row => ({ row, batch: batchMap.get(row.batchId)! }))
  const c = correspondenceTable(db)
  const targetObservations = db.select({ id: targetSchema.platformBusinessObservation.id }).from(targetSchema.platformBusinessObservation).innerJoin(targetSchema.platformLegacyQueryAlias, eq(targetSchema.platformLegacyQueryAlias.collectionId, targetSchema.platformBusinessObservation.collectionId)).where(inArray(targetSchema.platformLegacyQueryAlias.oldId, parsed.queryIds))
  const exportIds = db.select({ id: schema.platformExportRow.id }).from(schema.platformExportRow).where(inArray(schema.platformExportRow.batchId, parsed.exportBatchIds))
  const edgeScope = and(or(isNull(c.observationId), inArray(c.observationId, targetObservations)), or(isNull(c.exportRowId), inArray(c.exportRowId, exportIds)))
  const scopedEdgeIds = db.select({ id: c.id }).from(c).where(edgeScope)
  const allEdges = readScopedRecordCorrespondences(db, db.select(correspondenceColumns(db)).from(c).where(edgeScope).orderBy(c.id).all().filter(edge => comparisonBefore(edge.createdAt, parsed.asOf)))
  const revisedAfterCutoff = new Set(parsed.asOf ? db.select({ correspondenceId: schema.recordCorrespondenceAudit.correspondenceId, decidedAt: schema.recordCorrespondenceAudit.decidedAt }).from(schema.recordCorrespondenceAudit).where(inArray(schema.recordCorrespondenceAudit.correspondenceId, scopedEdgeIds)).all().filter(audit => !comparisonBefore(audit.decidedAt, parsed.asOf)).map(audit => audit.correspondenceId) : [])
  const unavailableEdges = allEdges.filter(edge => parsed.asOf && ((!comparisonBefore(edge.decidedAt, parsed.asOf) && edge.decidedAt !== null) || revisedAfterCutoff.has(edge.id)))
  const unavailableIds = new Set(unavailableEdges.map(edge => edge.id))
  const edges = allEdges.filter(edge => !unavailableIds.has(edge.id))
  const businessMetadata = readPlatformBusinessMetadata(db, relations.map(item => item.relation.id))
  return { input: parsed, queries, batches, documents, relations, exports, edges, unavailableEdges, businessMetadata }
}
export function getRecordComparison(db: Db, input: RecordComparisonInput) {
  return consumeComparison(iterateRecordComparison(db, input))
}
/** Same comparison computation, with cooperative boundaries for HTTP/MCP reads. */
export function* iterateRecordComparison(db: Db, input: RecordComparisonInput) {
  return yield* compareRecords(db, selected(db, input))
}
function consumeComparison<T>(steps: Generator<void, T>) {
  while (true) { const step = steps.next(); if (step.done) return step.value }
}
function* compareRecords(db: Db, source: SelectedRecordComparison, paginate = true) {
  const steps = compareRecordInputs(source, paginate)
  let step = steps.next()
  try {
    while (!step.done) {
      const request: ComparisonRead = step.value
      let data: ReadResult = undefined
      if (request === undefined) yield
      else if (request.type === 'count') data = yield* comparisonFormalCounts(db)
      else if (request.type === 'events') data = iterateComparisonFormalEvents(db, request.paths, source.input, request.laterOwners)
      else data = db.select().from(schema.recordEvidence).where(inArray(schema.recordEvidence.recordEventId, request.ids))
        .orderBy(schema.recordEvidence.id).all().map(evidence => ({ evidence, registered: registeredFileAtLocator(db, evidence.sourceFile) }))
      step = steps.next(data)
    }
    return step.value
  } finally { steps.return(undefined as never) }
}
// Keep the legacy JS parser (including ten-character day values) while SQLite
// counts and pages narrow columns. No reason notes or off-page rows are hydrated.
const legacyCutoffClients = new WeakSet<Db['$client']>()
function registerLegacyCutoff(db: Db) {
  if (legacyCutoffClients.has(db.$client)) return
  db.$client.function('record_comparison_before', { deterministic: true }, (time, asOf) =>
    Number(comparisonBefore(time as string | null, asOf as string)))
  legacyCutoffClients.add(db.$client)
}
export function previewRecordCorrespondenceImpact(db: Db, input: RecordComparisonInput) {
  const source = selected(db, input)
  const comparison = consumeComparison(compareRecords(db, source, false))
  const reason = schema.differenceReason
  if (input.asOf) registerLegacyCutoff(db)
  const cutoff = input.asOf ? sql`record_comparison_before(${reason.recordedAt}, ${input.asOf}) = 1` : undefined
  const filtered = and(cutoff, input.enterpriseId == null ? undefined : eq(reason.enterpriseId, input.enterpriseId), input.titleCode ? eq(reason.titleCode, input.titleCode) : undefined)
  const { legacyRows, total, pageReasons } = db.transaction(tx => ({
    legacyRows: tx.select({ count: sql<number>`count(*)` }).from(reason).where(cutoff).get()!.count,
    total: tx.select({ count: sql<number>`count(*)` }).from(reason).where(filtered).get()!.count,
    pageReasons: tx.select({ id: reason.id, enterpriseId: reason.enterpriseId, titleCode: reason.titleCode, direction: reason.direction, status: reason.status, reasonCode: reason.reasonCode, measureCode: reason.measureCode, ...differenceEvidenceColumns(tx), verificationStatus: reason.verificationStatus, recordedAt: reason.recordedAt })
      .from(reason).where(filtered).orderBy(reason.id).limit(input.pageSize).offset((input.page - 1) * input.pageSize).all(),
  }))
  const owners = new Map(db.selectDistinct({ id: schema.enterprise.id, uscc: schema.enterprise.usccNorm }).from(schema.enterprise).innerJoin(schema.record, eq(schema.record.enterpriseId, schema.enterprise.id)).where(and(eq(schema.record.source, 'jxj'), input.enterpriseId == null ? undefined : eq(schema.enterprise.id, input.enterpriseId), input.titleCode ? eq(schema.record.titleCode, input.titleCode) : undefined)).all().map(row => [row.id, row.uscc]))
  return projectLegacyComparisonImpact(source, comparison, owners, { legacyRows, total, pageReasons })
}
function chunked<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size))
  return chunks
}
/**
 * 只给本页 query IDs 补企业对象：
 * - `confirmedEnterprises` 保留 relation 级一对多，同时带 `nameRaw`；
 *   已确认主体与平台原行名并列返回，归并不替换原行名。
 * - `recordNames` 只收未关联/未确认关系的原行名称，UI 标“未确认主体”。
 * 两个查询都以本页查询 ID 为界，不扫描全库。
 */
function sourceEnterpriseLinks(db: Db, queryPageIds: number[]) {
  if (!queryPageIds.length) return new Map<number, { confirmedEnterprises: SourceEnterpriseLink[]; recordNames: string[] }>()
  const targetRows = readComparisonTargetIdentities(db, queryPageIds)
  const names = new Map(targetRows?.length ? db.select({ id: schema.enterprise.id, name: schema.enterprise.name }).from(schema.enterprise).where(inArray(schema.enterprise.id, unique(targetRows.flatMap(r => r.enterpriseId === null ? [] : [r.enterpriseId])))).all().map(r => [r.id, r.name]) : [])
  const relationRows = targetRows.map(r => ({ ...r, relationId: r.id, enterpriseName: r.enterpriseId === null ? null : names.get(r.enterpriseId) ?? null }))
  const confirmed = relationRows.filter(row => row.verificationStatus === 'confirmed' && row.enterpriseId != null && row.enterpriseName != null)
  const enterpriseIds = [...new Set(confirmed.map(row => row.enterpriseId!))]
  const nameNorms = new Set(confirmed.flatMap(row => row.nameRaw ? [normalizeName(row.nameRaw)] : []))
  const aliases = new Map<string, { note: string | null }>()
  for (const ids of chunked(enterpriseIds, 400)) {
    if (!nameNorms.size) break
    const rows = db.select({
      enterpriseId: schema.enterpriseAlias.enterpriseId,
      nameNorm: schema.enterpriseAlias.nameNorm,
      note: schema.enterpriseAlias.note,
    }).from(schema.enterpriseAlias)
      .where(and(inArray(schema.enterpriseAlias.enterpriseId, ids), eq(schema.enterpriseAlias.verificationStatus, 'confirmed'), sql`${schema.enterpriseAlias.nameNorm} in (select value from json_each(${JSON.stringify([...nameNorms])}))`)).all()
    for (const alias of rows) aliases.set(`${alias.enterpriseId}\u0000${alias.nameNorm}`, alias)
  }
  return projectSourceEnterpriseLinks(relationRows, aliases)
}
/** Picker data only. Stable ID order; selecting a source always requires an explicit UI action. */
export function listRecordComparisonSources(db: Db, input: ComparisonSourceCatalogInput) {
  return consumeComparison(iterateRecordComparisonSources(db, input))
}
export function* iterateRecordComparisonSources(db: Db, input: ComparisonSourceCatalogInput) {
  const filter = comparisonSourceCatalogInput.parse(input)
  const qa = targetSchema.platformLegacyQueryAlias
  const qids = filter.ids === undefined ? undefined : inArray(qa.oldId, filter.ids)
  const dids = filter.ids === undefined ? sql`1` : inArray(sql`id`, filter.ids)
  const bids = filter.ids === undefined ? undefined : inArray(schema.platformExportBatch.id, filter.ids)
  // SQLite's native whole-index Count can block the first request while leaf
  // pages enter its pager. Stream scalar IDs from the existing covering index
  // so a cold count also cooperates, without decoding query/archive objects.
  let queryCount = 0
  if (filter.ids === undefined) {
    const ids = db.$client.prepare('select old_id from platform_legacy_query_alias').pluck().iterate()
    for (const _id of ids) { if (++queryCount % 256 === 0) yield }
  } else queryCount = db.select({ n: sql<number>`count(*)` }).from(qa).where(qids).get()!.n
  const counts = {
    official_document: db.get<{ n: number }>(sql`select count(*) as n from ${officialSourceDirectory} where ${dids}`)!.n,
    query: queryCount,
    export_batch: db.select({ n: sql<number>`count(*)` }).from(schema.platformExportBatch).where(bids).get()!.n,
  }
  const { dw, qw, bw } = comparisonCatalogWindows(filter, counts)
  const documents = dw.limit ? db.all<import('./official-source-directory').OfficialSourceDocument>(sql`select * from ${officialSourceDirectory} where ${dids} order by id limit ${dw.limit} offset ${dw.offset}`).map(row => projectCatalogDocument(row, registeredFileAtLocator(db, row.path))) : []
  const pageQueryIds = (qw.limit ? db.select({ id: qa.oldId }).from(qa).where(qids).orderBy(qa.oldId).limit(qw.limit).offset(qw.offset).all().map(r => r.id) : [])
  const enterpriseLinks = sourceEnterpriseLinks(db, pageQueryIds)
  const targetPage = readComparisonTargetQueryFacts(db, pageQueryIds).map(({ id, collection: c, conditions, evidencePresent }) => ({ ...c, id, completeness: evidencePresent ? c.completeness : 'unknown', fullRange: evidencePresent ? c.fullRange : null, conditions }))
  const batches = bw.limit ? db.select().from(schema.platformExportBatch).where(bids).orderBy(schema.platformExportBatch.id).limit(bw.limit).offset(bw.offset).all().map(projectCatalogExport) : []
  const queries = targetPage.map(row => projectCatalogQuery(row, enterpriseLinks))
  return { rows: [...documents, ...queries, ...batches], total: filter.kind ? counts[filter.kind] : counts.official_document + counts.query + counts.export_batch, page: filter.page, pageSize: filter.pageSize, counts, selection: 'explicit', completeness: 'not_implied_by_catalog' }
}
export { comparisonBefore, validatedComparisonInput, type SelectedRecordComparison, type ComparisonRead, compareRecordInputs, projectLegacyComparisonImpact, projectSourceEnterpriseLinks, comparisonCatalogWindows, projectCatalogDocument, projectCatalogQuery, projectCatalogExport } from './record-comparison-model'
