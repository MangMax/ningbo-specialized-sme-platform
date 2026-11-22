import { recordCorrespondence, recordCorrespondenceAudit } from '../../../../db/postgresql/qualification-tables'
import { setImmediate } from 'node:timers/promises'
import { and, count, countDistinct, eq, inArray, lt, isNotNull, isNull, or, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { alias } from 'drizzle-orm/pg-core'
import { enterprise } from '../../../../db/postgresql/enterprise-tables'
import { storedFile } from '../../../../db/postgresql/file-tables'
import { record, recordEvidence, recordEvent } from '../../../../db/postgresql/ledger-tables'
import {
  platformBusinessObservation, platformCollection, platformCollectionPage,
  platformExportBatch, platformExportRow,
} from '../../../../db/postgresql/platform-tables'
import { platformQueryTitleScope } from '../../../../db/postgresql/platform-query-scope-tables'
import { sourceDocument } from '../../../../db/postgresql/official-evidence-tables'
import type { recordEvidence as RecordEvidenceTable } from '../../../../db/postgresql/ledger-tables'
import type { platformCollectionPage as PlatformCollectionPageTable, platformExportBatch as PlatformExportBatchTable, platformExportRow as PlatformExportRowTable } from '../../../../db/postgresql/platform-tables'
import { fileNameOf } from '../../../core/lib/preview'
import type { StoredFileContentIdentity } from '../../../core/server/utils/file-identity'
import type { RecordComparisonInput } from '../../lib/roster/record-comparison'
import { postgresRosterRow } from '../../lib/roster/postgres-rows'
import { postgresOfficialSourceDirectory } from './official-source-directory-postgres'
import { readPostgresComparisonIdentities } from './record-comparison-catalog-postgres'
import { readPostgresObservationComparisonFacts } from './record-correspondence-target-postgres'
import { readPostgresCorrespondenceSelection } from './record-correspondence-postgres'
import { compareRecordInputs, comparisonBefore, validatedComparisonInput, type ComparisonRead, type FormalEvent, type SelectedRecordComparison } from './record-comparison-model'
import { postgresCollectionConditionValues, projectPostgresComparisonConditions, projectPostgresUnfinishedPositions } from '../../lib/platform/postgres-collection-scope'
import { readPostgresPlatformBusinessMetadata } from './platform-business-record-postgres'

type Reader = Pick<NodePgDatabase, 'execute' | 'select' | 'selectDistinct' | '$with' | 'with'>
type QueryFacts = SelectedRecordComparison['queries'][number]['comparisonFacts']
const numbers = (values: readonly number[]) => sql`${sql.param(values)}::bigint[]`

async function readDocuments(db: Reader, ids: number[]): Promise<SelectedRecordComparison['documents']> {
  const source = sourceDocument, f = storedFile
  const selectedIds = sql`ANY(${numbers(ids)})`
  const d = postgresOfficialSourceDirectory(db)
  const index = db.select({
    id: d.id, source: d.source, title: d.title, docNumber: d.docNumber, issueDate: d.issueDate, path: d.path,
  }).from(d).where(and(lt(d.id, 0), eq(d.id, selectedIds)))
  const selected = db.$with('selected').as(db.select({
    id: source.id, source: sql<'jxj'>`${source.source}`.as('source'), title: sql<string | null>`${source.title}`.as('title'),
    docNumber: source.docNumber, issueDate: source.issueDate, path: source.path,
  }).from(source).where(and(eq(source.source, 'jxj'), eq(source.id, selectedIds))).unionAll(index))
  const rows = await db.with(selected).select({
    row: { id: selected.id, source: selected.source, title: selected.title, docNumber: selected.docNumber,
      issueDate: selected.issueDate, path: selected.path },
    registered: sql<StoredFileContentIdentity | null>`CASE WHEN ${f.id} IS NOT NULL THEN json_build_object(
      'fileId',${f.id},'relPath',${f.relPath},'sha256',${f.sha256},'bytes',${f.bytes}) END`,
  }).from(selected).leftJoin(f, eq(f.relPath, selected.path)).orderBy(selected.id)
  return rows.map(({ row, registered }) => ({ ...row, title: row.title ?? fileNameOf(row.path),
    contentIdentity: { registered, status: 'unknown', historical: 'unknown' } }))
}

async function readQueryFacts(db: Reader, ids: number[]): Promise<QueryFacts[]> {
  const c = alias(platformCollection, 'c')
  const rows = await db.select({
    id: c.publicId, collection: sql<QueryFacts['collection']>`${postgresRosterRow(platformCollection,'c')}`,
    conditions: postgresCollectionConditionValues(c.conditionFacts), unfinished: c.unfinishedPositions,
  }).from(c).where(eq(c.publicId, sql`ANY(${numbers(ids)})`)).orderBy(c.publicId)
  const coordinates = numbers(rows.map(row => row.collection.id))
  const page = alias(platformCollectionPage, 'p')
  const pages = Map.groupBy((await db.select({
    row: sql<typeof PlatformCollectionPageTable.$inferSelect>`${postgresRosterRow(platformCollectionPage, 'p')}`,
  }).from(page).where(eq(page.collectionId, sql`ANY(${coordinates})`))
    .orderBy(page.collectionId, page.ordinal)).map(({ row }) => row), row => row.collectionId)
  const titleScope = platformQueryTitleScope
  const titleScopes = await db.select({ collectionId: titleScope.collectionId, rdjb: titleScope.rdjb })
    .from(titleScope).where(eq(titleScope.collectionId, sql`ANY(${coordinates})`))
  const byTitle = Map.groupBy(titleScopes, row => row.collectionId)
  return rows.map(({ id, collection, conditions, unfinished }) => {
    const coordinate = collection.id, evidencePresent = ['captured', 'conflict'].includes(collection.provenanceState)
    const scopeOrder = collection.rdjb.split(',')
    return { id, collection, evidencePresent, pages: pages.get(coordinate) ?? [],
      unfinished: projectPostgresUnfinishedPositions(coordinate, unfinished),
      conditions: evidencePresent ? projectPostgresComparisonConditions(conditions) : null,
      scopes: (byTitle.get(coordinate) ?? []).map(row => row.rdjb).sort((a,b) => scopeOrder.indexOf(a) - scopeOrder.indexOf(b)), }
  })
}

async function selectComparison(db: Reader, input: RecordComparisonInput): Promise<SelectedRecordComparison> {
  const facts = await readQueryFacts(db, input.queryIds)
  const batch = alias(platformExportBatch, 'p')
  const batches = (await db.select({
    row: sql<typeof PlatformExportBatchTable.$inferSelect>`${postgresRosterRow(platformExportBatch, 'p')}`,
  }).from(batch).where(eq(batch.id, sql`ANY(${numbers(input.exportBatchIds)})`)).orderBy(batch.id))
    .map(({ row }) => row).filter(row => row.importStatus === 'imported' && comparisonBefore(row.collectedOn, input.asOf))
  const documents = (await readDocuments(db, input.officialSourceDocumentIds)).filter(row => comparisonBefore(row.issueDate, input.asOf))
  if (facts.length !== input.queryIds.length || facts.some(row => !comparisonBefore(row.collection.queriedAt, input.asOf)) ||
      batches.length !== input.exportBatchIds.length || documents.length !== input.officialSourceDocumentIds.length) throw new Error('source_set_missing_or_out_of_scope')
  const queries = facts.map(item => ({ ...item.collection, id: item.id, comparisonFacts: item, collectionEvidence: null, rawResponse: null }))
  const byQuery = new Map(queries.map(query => [query.id, query]))
  const observationIds = await readPostgresComparisonIdentities(db, input.queryIds)
  const normalized = await readPostgresObservationComparisonFacts(db, observationIds.map(row => ({ observationId: row.observationId,
    interface: byQuery.get(row.queryId)!.interface })), 'archive')
  const relations = observationIds.map(({ enterpriseName: _name, relationId: _id, ...row }) => {
    const facts = normalized.get(row.observationId)
    if (!facts) throw new Error('comparison_observation_fact_missing')
    const { sqlFactTitle: _title, ...projection } = facts
    return { relation: { ...row, ...projection }, query: byQuery.get(row.queryId)! }
  })
  const batchById = new Map(batches.map(row => [row.id, row]))
  const exportRow = alias(platformExportRow, 'p')
  const exports = (await db.select({
    row: sql<typeof PlatformExportRowTable.$inferSelect>`${postgresRosterRow(platformExportRow, 'p')}`,
  }).from(exportRow).where(eq(exportRow.batchId, sql`ANY(${numbers(input.exportBatchIds)})`)).orderBy(exportRow.id))
    .map(({ row }) => ({ row: { ...row, rawFields: null }, batch: batchById.get(row.batchId)! }))
  const edge = recordCorrespondence
  const edgeScope = and(
    or(isNull(edge.observationId), eq(edge.observationId, sql`ANY(${numbers(observationIds.map(row => row.observationId))})`)),
    or(isNull(edge.exportRowId), eq(edge.exportRowId, sql`ANY(${numbers(exports.map(row => row.row.id))})`)),
  )
  const allEdges = (await readPostgresCorrespondenceSelection(db, edgeScope)).filter(edge => comparisonBefore(edge.createdAt, input.asOf))
  const auditTable = recordCorrespondenceAudit
  const audit = input.asOf ? await db.select({ id: auditTable.correspondenceId, decidedAt: auditTable.decidedAt })
    .from(auditTable).where(eq(auditTable.correspondenceId, sql`ANY(${numbers(allEdges.map(edge => edge.id))})`)) : []
  const revised = new Set(audit.filter(row => !comparisonBefore(row.decidedAt, input.asOf)).map(row => row.id))
  const unavailableEdges = allEdges.filter(edge => input.asOf && (revised.has(edge.id) || edge.decidedAt !== null && !comparisonBefore(edge.decidedAt, input.asOf)))
  const unavailable = new Set(unavailableEdges.map(edge => edge.id))
  const edges = allEdges.filter(edge => !unavailable.has(edge.id))
  const metadata = await readPostgresPlatformBusinessMetadata(db, relations.map(row => row.relation.id))
  return { input, queries, batches, documents, relations, exports, edges, unavailableEdges, businessMetadata: metadata }
}

type FormalStep = Extract<ComparisonRead, { type: 'events' }>

async function readFormalEvents(db: Reader, input: RecordComparisonInput, request: FormalStep) {
  const e = recordEvent, r = record, v = recordEvidence
  const chosen = db.$with('selected_events').as(db.selectDistinct({ id: sql<number>`${v.recordEventId}`.as('event_id') })
    .from(v).where(eq(v.sourceFile, sql`ANY(${sql.param(request.paths)}::text[])`)))
  const chosenId = sql<number>`${sql.identifier('selected_events')}.${sql.identifier('event_id')}`
  const later = db.select({ id: r.id }).from(sql`json_array_elements(${JSON.stringify(request.laterOwners)}::json) AS l(target)`)
    .innerJoin(r, and(eq(r.enterpriseId, sql`(target->>'enterpriseId')::bigint`), eq(r.titleCode, sql`target->>'titleCode'`)))
  const relevant = db.$with('relevant_records').as(db.select({ id: r.id }).from(r)
    .where(and(input.enterpriseId === undefined ? undefined : eq(r.enterpriseId, input.enterpriseId),
      input.titleCode === undefined ? undefined : eq(r.titleCode, input.titleCode))).union(later))
  return db.with(chosen, relevant).select({
    event: {
      id: e.id, recordId: e.recordId, eventType: e.eventType, year: e.year, batchSeq: e.batchSeq,
      sortKey: e.sortKey, reviewOutcome: e.reviewOutcome, decidedYear: e.decidedYear, revision: e.revision,
    },
    record: { id: r.id, enterpriseId: r.enterpriseId, titleCode: r.titleCode, source: r.source, usccRaw: r.usccRaw, nameRaw: r.nameRaw },
    uscc: enterprise.usccNorm, inSelectedSource: isNotNull(chosenId).mapWith(Boolean),
  }).from(e).innerJoin(r, eq(r.id, e.recordId)).leftJoin(enterprise, eq(enterprise.id, r.enterpriseId))
    .leftJoin(chosen, eq(e.id, chosenId))
    .where(and(or(isNotNull(chosenId), inArray(r.id, db.select({ id: relevant.id }).from(relevant))),
      eq(r.source, 'jxj'), inArray(e.eventType, ['award', 'review']))).orderBy(e.id) satisfies PromiseLike<FormalEvent[]>
}

async function runComparison(tx: Reader, source: SelectedRecordComparison, signal?: AbortSignal) {
  const steps = compareRecordInputs(source)
  let step = steps.next()
  try {
    while (!step.done) {
      signal?.throwIfAborted()
      const request = step.value
      if (request === undefined) { await setImmediate(); step = steps.next(); continue }
      if (request.type === 'count') {
        const [counts] = await tx.select({ events: count(), enterpriseTitles: countDistinct(record.id) })
          .from(record).innerJoin(recordEvent, eq(recordEvent.recordId, record.id))
          .where(and(eq(record.source, 'jxj'), inArray(recordEvent.eventType, ['award', 'review'])))
        step = steps.next(counts)
      } else if (request.type === 'events') step = steps.next(await readFormalEvents(tx, source.input, request))
      else {
        const evidence = alias(recordEvidence, 'p'), f = storedFile
        const rows = await tx.select({
          evidence: sql<typeof RecordEvidenceTable.$inferSelect>`${postgresRosterRow(recordEvidence,'p')}`,
          registered: sql<StoredFileContentIdentity | null>`CASE WHEN ${f.id} IS NOT NULL THEN json_build_object(
            'fileId',${f.id},'relPath',${f.relPath},'bytes',${f.bytes},'sha256',${f.sha256}) END`,
        }).from(evidence).leftJoin(f, eq(f.relPath, evidence.sourceFile))
          .where(eq(evidence.recordEventId, sql`ANY(${numbers(request.ids)})`)).orderBy(evidence.id)
        step = steps.next(rows)
      }
    }
    signal?.throwIfAborted()
    return step.value
  } finally { steps.return(undefined as never) }
}

export function readPostgresRecordComparison(db: NodePgDatabase, raw: RecordComparisonInput, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const input = validatedComparisonInput(raw)
  return db.transaction(async tx => {
    const source = await selectComparison(tx, input)
    return runComparison(tx, source, signal)
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}
