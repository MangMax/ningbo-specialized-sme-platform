import { recordCorrespondence, recordCorrespondenceAudit } from '../../../../db/postgresql/qualification-tables'
import { setImmediate } from 'node:timers/promises'
import { and, count, countDistinct, eq, inArray, lt, isNotNull, isNull, or, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { alias } from 'drizzle-orm/pg-core'
import { enterprise } from '../../../../db/postgresql/enterprise-tables'
import { storedFile } from '../../../../db/postgresql/file-tables'
import { record, recordEvidence, recordEvent } from '../../../../db/postgresql/ledger-tables'
import {
  platformCollection, platformCollectionCondition, platformCollectionPage, platformCollectionUnfinished,
  platformLegacyQueryAlias, platformLegacyRelationAlias,
  platformExportBatch, platformExportRow,
} from '../../../../db/postgresql/platform-tables'
import { platformQueryTitleScope } from '../../../../db/postgresql/platform-archive-tables'
import { differenceReason } from '../../../../db/postgresql/roster-selection-tables'
import { sourceDocument } from '../../../../db/postgresql/official-evidence-tables'
import type * as schema from '../../../../db/schema'
import { fileNameOf } from '../../../core/lib/preview'
import type { StoredFileContentIdentity } from '../../../core/server/utils/file-content-identity'
import type { RecordComparisonInput } from '../../lib/roster/record-comparison'
import { postgresRosterRow } from '../../lib/roster/postgres-rows'
import { postgresOfficialSourceDirectory } from './official-source-directory-postgres'
import { readPostgresComparisonIdentities } from './record-comparison-catalog-postgres'
import { readPostgresObservationComparisonFacts } from './record-correspondence-target-postgres'
import { readPostgresCorrespondenceSelection } from './record-correspondence-postgres'
import { compareRecordInputs, comparisonBefore, projectLegacyComparisonImpact, validatedComparisonInput, type ComparisonRead, type SelectedRecordComparison } from './record-comparison-model'
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
  const q = platformLegacyQueryAlias, c = alias(platformCollection, 'c')
  const rows = await db.select({
    id: q.oldId, collection: sql<QueryFacts['collection']>`${postgresRosterRow(platformCollection,'c')}`,
  }).from(q).innerJoin(c, eq(c.id, q.collectionId)).where(eq(q.oldId, sql`ANY(${numbers(ids)})`)).orderBy(q.oldId)
  const coordinates = numbers(rows.map(row => row.collection.id))
  const page = alias(platformCollectionPage, 'p'), remaining = alias(platformCollectionUnfinished, 'p')
  const pages = Map.groupBy((await db.select({
    row: sql<typeof schema.platformCollectionPage.$inferSelect>`${postgresRosterRow(platformCollectionPage, 'p')}`,
  }).from(page).where(eq(page.collectionId, sql`ANY(${coordinates})`))
    .orderBy(page.collectionId, page.ordinal)).map(({ row }) => row), row => row.collectionId)
  const unfinished = Map.groupBy((await db.select({
    row: sql<typeof schema.platformCollectionUnfinished.$inferSelect>`${postgresRosterRow(platformCollectionUnfinished, 'p')}`,
  }).from(remaining).where(eq(remaining.collectionId, sql`ANY(${coordinates})`))
    .orderBy(remaining.collectionId, remaining.ordinal)).map(({ row }) => row), row => row.collectionId)
  const condition = platformCollectionCondition
  const conditions = await db.select({
    collectionId: condition.collectionId, name: condition.name, valueKind: condition.valueKind,
    textValue: condition.textValue, integerValue: condition.integerValue,
  }).from(condition).where(eq(condition.collectionId, sql`ANY(${coordinates})`))
  const titleScope = platformQueryTitleScope
  const titleScopes = await db.select({ collectionId: titleScope.collectionId, rdjb: titleScope.rdjb })
    .from(titleScope).where(eq(titleScope.collectionId, sql`ANY(${coordinates})`))
  const byCondition = Map.groupBy(conditions, row => row.collectionId)
  const byTitle = Map.groupBy(titleScopes, row => row.collectionId)
  return rows.map(({ id, collection }) => {
    const coordinate = collection.id, evidencePresent = ['captured', 'conflict'].includes(collection.provenanceState)
    const values = byCondition.get(coordinate)
    const scopeOrder = collection.rdjb.split(',')
    return { id, collection, evidencePresent, pages: pages.get(coordinate) ?? [], unfinished: unfinished.get(coordinate) ?? [],
      conditions: evidencePresent && values ? Object.fromEntries(values.filter(r => r.valueKind !== 'absent').map(r => [r.name, r.valueKind === 'text' ? r.textValue : r.valueKind === 'boolean' ? Boolean(r.integerValue) : r.integerValue])) : null,
      scopes: (byTitle.get(coordinate) ?? []).map(row => row.rdjb).sort((a,b) => scopeOrder.indexOf(a) - scopeOrder.indexOf(b)), }
  })
}

async function selectComparison(db: Reader, input: RecordComparisonInput): Promise<SelectedRecordComparison> {
  const facts = await readQueryFacts(db, input.queryIds)
  const batch = alias(platformExportBatch, 'p')
  const batches = (await db.select({
    row: sql<typeof schema.platformExportBatch.$inferSelect>`${postgresRosterRow(platformExportBatch, 'p')}`,
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
    const projection = normalized.get(row.observationId)
    if (!projection) throw new Error('comparison_observation_fact_missing')
    return { relation: { ...row, ...projection }, query: byQuery.get(row.queryId)! }
  })
  const batchById = new Map(batches.map(row => [row.id, row]))
  const exportRow = alias(platformExportRow, 'p')
  const exports = (await db.select({
    row: sql<typeof schema.platformExportRow.$inferSelect>`${postgresRosterRow(platformExportRow, 'p')}`,
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
type FormalEvent = ReturnType<typeof import('./record-comparison-formal').iterateComparisonFormalEvents> extends Generator<infer T> ? T : never

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

async function runComparison(tx: Reader, source: SelectedRecordComparison, signal?: AbortSignal, paginate = true) {
  const steps = compareRecordInputs(source, paginate)
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
          evidence: sql<typeof schema.recordEvidence.$inferSelect>`${postgresRosterRow(recordEvidence,'p')}`,
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

export function previewPostgresRecordCorrespondenceImpact(db: NodePgDatabase, raw: RecordComparisonInput, signal?: AbortSignal) {
  const input = validatedComparisonInput(raw)
  return db.transaction(async tx => {
    const source = await selectComparison(tx, input)
    const comparison = await runComparison(tx, source, signal, false)
    const d = differenceReason, q = platformLegacyQueryAlias, a = platformLegacyRelationAlias
    const reasonIds = input.asOf ? (await tx.select({ id: d.id, recordedAt: d.recordedAt }).from(d))
      .filter(row => comparisonBefore(row.recordedAt, input.asOf)).map(row => row.id) : null
    const cutoff = reasonIds ? eq(d.id, sql`ANY(${numbers(reasonIds)})`) : sql`true`
    const where = and(cutoff, input.enterpriseId === undefined ? undefined : eq(d.enterpriseId, input.enterpriseId),
      input.titleCode === undefined ? undefined : eq(d.titleCode, input.titleCode))
    const [counts] = await tx.select({
      legacyRows: sql<number>`count(*) FILTER (WHERE ${cutoff})::float8`,
      total: sql<number>`count(*) FILTER (WHERE ${where})::float8`,
    }).from(d)
    const pageReasons = await tx.select({
      id: d.id, enterpriseId: d.enterpriseId, titleCode: d.titleCode, direction: d.direction, status: d.status,
      reasonCode: d.reasonCode, measureCode: d.measureCode, evidenceQueryId: q.oldId, evidenceRelationId: a.oldId,
      verificationStatus: d.verificationStatus, recordedAt: d.recordedAt,
    }).from(d).leftJoin(q, eq(q.collectionId, d.evidenceQueryId))
      .leftJoin(a, eq(a.observationId, d.evidenceRelationId)).where(where).orderBy(d.id)
      .limit(input.pageSize).offset(Math.min(Number.MAX_SAFE_INTEGER, (input.page - 1) * input.pageSize))
    const owners = await tx.selectDistinct({ id: enterprise.id, uscc: enterprise.usccNorm })
      .from(enterprise).innerJoin(record, eq(record.enterpriseId, enterprise.id)).where(and(
        eq(record.source, 'jxj'), input.enterpriseId === undefined ? undefined : eq(enterprise.id, input.enterpriseId),
        input.titleCode === undefined ? undefined : eq(record.titleCode, input.titleCode),
      ))
    return projectLegacyComparisonImpact(source, comparison, new Map(owners.map(row => [row.id, row.uscc])), { ...counts!, pageReasons })
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}
