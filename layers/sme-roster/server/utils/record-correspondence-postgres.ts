import { and, count, eq, getTableColumns, or, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { enterprise } from '../../../../db/postgresql/enterprise-tables'
import { storedFile } from '../../../../db/postgresql/file-tables'
import { record, recordEvidence, recordEvent } from '../../../../db/postgresql/ledger-tables'
import { platformExportBatch, platformExportRow, platformLegacyRelationAlias } from '../../../../db/postgresql/platform-tables'
import { recordCorrespondence } from '../../../../db/postgresql/qualification-tables'
import { title } from '../../../../db/postgresql/title-table'
import * as schema from '../../../../db/schema'
import { postgresRosterRow } from '../../lib/roster/postgres-rows'
import { readPostgresRelationDisplays } from '../../lib/platform/postgres-query-display'
import { readPostgresPublishedNames } from '../../lib/roster/official-published-presentation-postgres'
import { readPostgresCurrentProofCoverage } from './comparison-scope-proof-postgres'
import { readPostgresCorrespondenceRefs } from './record-correspondence-postgres-refs'
import { sanitizeRelationDisplays } from './platform-relation-evidence-display-target'
import { correspondencePublishedScope, correspondenceSourceSelections, projectCorrespondenceSources, type SourceSelection } from './record-correspondence-read'
import type { ReceiptRedactor } from './import-receipt-redaction'
import { readPostgresCorrespondenceTargetSources } from './record-correspondence-target-postgres'
import { projectObservedCorrespondence, type CorrespondenceFilter, type CorrespondencePaging, type CorrespondenceRead, type ReadSources, type SourceReference, type StoredCorrespondence } from './record-correspondence'

type Db = Pick<NodePgDatabase, 'execute' | 'select'>
type Evidence = ReadSources['evidence'] extends Map<number, (infer T)[]> ? T : never
const ids = (values: readonly number[]) => sql`${sql.param(values)}::bigint[]`
const present = (values: (number | null)[]) => [...new Set(values.flatMap(id => id === null ? [] : [id]))]

async function readEventsAndEvidence(db: Db, eventIds: number[]) {
  const ev = alias(recordEvent, 'ev'), r = alias(record, 'r'), e = alias(enterprise, 'e')
  const v = alias(recordEvidence, 'v'), f = storedFile
  type Event = ReadSources['events'] extends Map<number, infer V> ? V : never
  const events = await db.select({
    event: sql<Event['event']>`${postgresRosterRow(schema.recordEvent, 'ev')}`,
    record: sql<Event['record']>`${postgresRosterRow(schema.record, 'r')}`,
    enterprise: sql<Event['enterprise']>`${postgresRosterRow(schema.enterprise, 'e')}`,
  }).from(ev).innerJoin(r, eq(r.id, ev.recordId)).innerJoin(e, eq(e.id, r.enterpriseId))
    .where(eq(ev.id, sql`ANY(${ids(eventIds)})`))
  const evidence = await db.select({
    evidence: sql<Evidence['evidence']>`${postgresRosterRow(schema.recordEvidence, 'v')}`,
    storedFile: sql<Evidence['storedFile']>`CASE WHEN ${f.id} IS NOT NULL THEN json_build_object(
      'id',${f.id},'relPath',${f.relPath},'bytes',${f.bytes},'sha256',${f.sha256},'removedAt',${f.removedAt}) END`,
  }).from(v).leftJoin(f, eq(f.relPath, v.sourceFile))
    .where(eq(v.recordEventId, sql`ANY(${ids(eventIds)})`)).orderBy(v.id)
  return { events, evidence }
}

async function readExports(db: Db, rowIds: number[]) {
  const r = alias(platformExportRow, 'r'), b = alias(platformExportBatch, 'b')
  type Export = ReadSources['exports'] extends Map<number, infer V> ? V : never
  return db.select({
    exportRow: sql<Export['exportRow']>`${postgresRosterRow(schema.platformExportRow, 'r')}`,
    exportBatch: sql<Export['exportBatch']>`${postgresRosterRow(schema.platformExportBatch, 'b')}`,
  }).from(r).innerJoin(b, eq(b.id, r.batchId)).where(eq(r.id, sql`ANY(${ids(rowIds)})`))

}

type ProofPair = { relationId: number; exportRowId: number; ids: number[] }

export async function observePostgresCorrespondences(db: Db,
  references: (SourceReference & Partial<Pick<StoredCorrespondence, 'type' | 'role' | 'provenance'>>)[], requestedProofs: ProofPair[] = [],
) {
  const scoped = references.filter(row => row.status === 'confirmed' || row.status === 'candidate')
  const { events, evidence } = await readEventsAndEvidence(db, present(scoped.flatMap(row => [row.eventId, row.predecessorEventId])))
  const relations = await readPostgresCorrespondenceTargetSources(db, present(scoped.map(row => row.relationId)))
  const exports = await readExports(db, present(scoped.map(row => row.exportRowId)))
  const owner = alias(enterprise, 'p')
  const ownerIds = present([...scoped.map(row => row.enterpriseId), ...relations.map(row => row.relation.enterpriseId)])
  const enterprises = await db.select({
    row: sql<typeof schema.enterprise.$inferSelect>`${postgresRosterRow(schema.enterprise, 'p')}`,
  }).from(owner).where(eq(owner.id, sql`ANY(${ids(ownerIds)})`))
  const titles = await db.select({ code: title.code }).from(title)
    .where(eq(title.code, sql`ANY(${sql.param([...new Set(scoped.map(row => row.titleCode))])}::text[])`))
  const exportMap = new Map(exports.map(row => [row.exportRow.id, row]))
  const relationMap = new Map(relations.map(row => [row.relation.id, row]))
  const savedProofs = scoped.flatMap(ref => {
    if (ref.type !== 'recognized_export' || ref.role !== 'same_current_row' || ref.status !== 'confirmed') return []
    return [{ relationId: ref.relationId!, exportRowId: ref.exportRowId!, ids: ref.provenance?.comparisonProofIds as number[] ?? [] }]
  })
  const coverage = await readPostgresCurrentProofCoverage(db, [...savedProofs, ...requestedProofs].flatMap(ref => {
    const queryId = relationMap.get(ref.relationId)?.query.id
    const batchId = exportMap.get(ref.exportRowId)?.exportBatch.id
    return queryId === undefined || batchId === undefined ? [] : [{ ids: ref.ids, queryId, batchId }]
  }))
  const observed: ReadSources = {
    coversCurrentProof: (ids, queryId, batchId) => coverage({ ids, queryId, batchId }),
    events: new Map(events.map(row => [row.event.id, row])),
    evidence: Map.groupBy(evidence, row => row.evidence.recordEventId),
    relations: relationMap, exports: exportMap, enterprises: new Map(enterprises.map(({ row }) => [row.id, row])),
    titles: new Set(titles.map(row => row.code)),
  }
  return observed
}

const edge = recordCorrespondence
const relation = platformLegacyRelationAlias
const filters = {
  id: edge.id, eventId: edge.eventId, relationId: relation.oldId, exportRowId: edge.exportRowId,
  enterpriseId: edge.enterpriseId, titleCode: edge.titleCode, status: edge.status,
  type: edge.type, role: edge.role, ruleVersion: edge.ruleVersion,
}

function relationScope(filter: CorrespondenceFilter) {
  const { anyEventId, ...exact } = filter
  return and(
    ...Object.entries(exact).flatMap(([key, value]) => value == null ? [] : [
      eq(filters[key as keyof typeof filters], sql`${value}`),
    ]),
    anyEventId === undefined ? undefined : or(eq(edge.eventId, anyEventId), eq(edge.predecessorEventId, anyEventId)),
  )
}

export async function listPostgresCorrespondences(db: Db, filter: CorrespondenceFilter, paging?: CorrespondencePaging) {
  return readPostgresCorrespondenceSelection(db, relationScope(filter), paging)
}

export async function readPostgresCorrespondenceSelection(db: Db, where: SQL | undefined, paging?: CorrespondencePaging) {
  const { observationId: _observationId, targetIdentity: _targetIdentity, provenance: _provenance, ...columns } = getTableColumns(edge)
  const query = db.select({
    ...columns,
    relationId: relation.oldId,
    targetIdentity: sql<StoredCorrespondence['targetIdentity']>`'{}'::jsonb`,
    provenance: sql<StoredCorrespondence['provenance']>`CASE WHEN ${edge.status}='confirmed'
      THEN jsonb_build_object('comparisonProofIds',${edge.provenance}::json->'comparisonProofIds') ELSE '{}'::jsonb END`,
  }).from(edge).leftJoin(relation, eq(relation.observationId, edge.observationId))
    .where(where).orderBy(edge.id)
  const page = await (paging
    ? query.limit(paging.pageSize).offset(Math.min(Number.MAX_SAFE_INTEGER, (paging.page - 1) * paging.pageSize))
    : query)
  const observed = page.length ? await observePostgresCorrespondences(db, page) : undefined
  return page.map(row => projectObservedCorrespondence(row, observed!))
}

export async function pagePostgresCorrespondences(db: Db, filter: CorrespondenceFilter, paging: CorrespondencePaging) {
  const [countRow] = await db.select({ total: count() }).from(edge)
    .leftJoin(relation, eq(relation.observationId, edge.observationId)).where(relationScope(filter))
  return { rows: await listPostgresCorrespondences(db, filter, paging), total: countRow!.total, ...paging }
}

export async function readPostgresCorrespondenceSources(db: NodePgDatabase, rows: CorrespondenceRead[], redact: ReceiptRedactor, extra?: SourceSelection) {
  const { eventIds, relationIds, exportRowIds, occurrences } = correspondenceSourceSelections(rows, extra)
  const { events, evidence } = await readEventsAndEvidence(db, eventIds)
  const exports = await readExports(db, exportRowIds)
  const reverse = await readPostgresCorrespondenceRefs(db, { eventIds, relationIds, exportRowIds })
  const displays = await readPostgresRelationDisplays(db, relationIds)
  const targetDisplays = sanitizeRelationDisplays(displays, redact)
  const evidenceRows = evidence.map(row => row.evidence)
  const { scope, copies } = correspondencePublishedScope(evidenceRows, occurrences)
  const presentation = await readPostgresPublishedNames(db, scope, redact, copies, occurrences.length)
  return projectCorrespondenceSources({ events, evidenceRows, files: evidence.flatMap(row => row.storedFile ? [row.storedFile] : []),
    sortedLinks: reverse, exports: exports.map(row => ({ row: row.exportRow, batch: row.exportBatch })), targetDisplays, presentation })
}
