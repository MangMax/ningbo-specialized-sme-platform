import { and, count, eq, getTableColumns, or, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { enterprise } from '../../../../db/postgresql/enterprise-tables'
import { storedFile } from '../../../../db/postgresql/file-tables'
import { record, recordEvidence, recordEvent } from '../../../../db/postgresql/ledger-tables'
import { platformExportBatch, platformExportRow, platformBusinessObservation } from '../../../../db/postgresql/platform-tables'
import { recordCorrespondence } from '../../../../db/postgresql/qualification-tables'
import { title } from '../../../../db/postgresql/title-table'
import type { enterprise as EnterpriseTable } from '../../../../db/postgresql/enterprise-tables'
import { postgresRosterRow } from '../../lib/roster/postgres-rows'
import { readPostgresRelationDisplays } from '../../lib/platform/postgres-query-display'
import { readPostgresPublishedNames } from '../../lib/roster/official-published-presentation-postgres'
import { readPostgresCorrespondenceRefs } from './record-correspondence-postgres-refs'
import { sanitizeRelationDisplays } from './relation-evidence-projection'
import { correspondencePublishedScope, correspondenceSourceSelections, projectCorrespondenceSources, type SourceSelection } from './record-correspondence-projection'
import type { ReceiptRedactor } from './import-receipt-redaction'
import { readPostgresCorrespondenceTargetSources } from './record-correspondence-target-postgres'
import { type CorrespondenceFilter, type CorrespondencePaging, type CorrespondenceRead, type ReadSources, type SourceReference } from './record-correspondence'
import { projectObservedCorrespondence } from './record-correspondence-model'

type Db = Pick<NodePgDatabase, 'execute' | 'select'>
type Evidence = ReadSources['evidence'] extends Map<number, (infer T)[]> ? T : never
const ids = (values: readonly number[]) => sql`${sql.param(values)}::bigint[]`
const present = (values: (number | null)[]) => [...new Set(values.flatMap(id => id === null ? [] : [id]))]

async function readEventsAndEvidence(db: Db, eventIds: number[]) {
  const ev = alias(recordEvent, 'ev'), r = alias(record, 'r'), e = alias(enterprise, 'e')
  const v = alias(recordEvidence, 'v'), f = storedFile
  type Event = ReadSources['events'] extends Map<number, infer V> ? V : never
  const events = await db.select({
    event: sql<Event['event']>`${postgresRosterRow(recordEvent, 'ev')}`,
    record: sql<Event['record']>`${postgresRosterRow(record, 'r')}`,
    enterprise: sql<Event['enterprise']>`${postgresRosterRow(enterprise, 'e')}`,
  }).from(ev).innerJoin(r, eq(r.id, ev.recordId)).innerJoin(e, eq(e.id, r.enterpriseId))
    .where(eq(ev.id, sql`ANY(${ids(eventIds)})`))
  const evidence = await db.select({
    evidence: sql<Evidence['evidence']>`${postgresRosterRow(recordEvidence, 'v')}`,
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
    exportRow: sql<Export['exportRow']>`${postgresRosterRow(platformExportRow, 'r')}`,
    exportBatch: sql<Export['exportBatch']>`${postgresRosterRow(platformExportBatch, 'b')}`,
  }).from(r).innerJoin(b, eq(b.id, r.batchId)).where(eq(r.id, sql`ANY(${ids(rowIds)})`))

}

export async function observePostgresCorrespondences(db: Db, references: SourceReference[], validityIds: number[]) {
  const scoped = references.filter(row => row.status === 'confirmed' || row.status === 'candidate')
  const { events, evidence } = await readEventsAndEvidence(db, present(scoped.flatMap(row => [row.eventId, row.predecessorEventId])))
  const relations = await readPostgresCorrespondenceTargetSources(db, present(scoped.map(row => row.relationId)))
  const exports = await readExports(db, present(scoped.map(row => row.exportRowId)))
  const owner = alias(enterprise, 'p')
  const ownerIds = present([...scoped.map(row => row.enterpriseId), ...relations.map(row => row.relation.enterpriseId)])
  const enterprises = await db.select({
    row: sql<typeof EnterpriseTable.$inferSelect>`${postgresRosterRow(enterprise, 'p')}`,
  }).from(owner).where(eq(owner.id, sql`ANY(${ids(ownerIds)})`))
  const titles = await db.select({ code: title.code }).from(title)
    .where(eq(title.code, sql`ANY(${sql.param([...new Set(scoped.map(row => row.titleCode))])}::text[])`))
  const exportMap = new Map(exports.map(row => [row.exportRow.id, row]))
  const relationMap = new Map(relations.map(row => [row.relation.id, row]))
  const validity = await readPostgresCorrespondenceRefs(db, { validityIds })
  const observed: ReadSources = {
    sourceValidity: new Map(validity.map(ref => [ref.id, !ref.requiresRevalidation])),
    events: new Map(events.map(row => [row.event.id, row])),
    evidence: Map.groupBy(evidence, row => row.evidence.recordEventId),
    relations: relationMap, exports: exportMap, enterprises: new Map(enterprises.map(({ row }) => [row.id, row])),
    titles: new Set(titles.map(row => row.code)),
  }
  return observed
}

const edge = recordCorrespondence
const relation = platformBusinessObservation
const filters = {
  id: edge.id, eventId: edge.eventId, relationId: relation.publicId, exportRowId: edge.exportRowId,
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
  const { observationId: _observationId, targetIdentity: _targetIdentity, provenance: _provenance, platformEvidenceReboundRevision: _rebound, ...columns } = getTableColumns(edge)
  const query = db.select({
    ...columns,
    relationId: relation.publicId,
  }).from(edge).leftJoin(relation, eq(relation.id, edge.observationId))
    .where(where).orderBy(edge.id)
  const page = await (paging
    ? query.limit(paging.pageSize).offset(Math.min(Number.MAX_SAFE_INTEGER, (paging.page - 1) * paging.pageSize))
    : query)
  const observed = page.length ? await observePostgresCorrespondences(db, page, page.filter(row => row.status === 'confirmed' || row.status === 'candidate').map(row => row.id)) : undefined
  return page.map(row => projectObservedCorrespondence({ ...row, targetIdentity: {}, provenance: {} }, observed!))
}

export async function pagePostgresCorrespondences(db: Db, filter: CorrespondenceFilter, paging: CorrespondencePaging) {
  const [countRow] = await db.select({ total: count() }).from(edge)
    .leftJoin(relation, eq(relation.id, edge.observationId)).where(relationScope(filter))
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
