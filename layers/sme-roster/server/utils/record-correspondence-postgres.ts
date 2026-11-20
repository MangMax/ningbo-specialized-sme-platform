import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from '../../../../db/schema'
import { postgresRosterRow, readPostgresRosterRowsById } from '../../lib/roster/postgres-rows'
import { readPostgresRelationDisplays } from '../../lib/platform/postgres-query-display'
import { readPostgresPublishedNames } from '../../lib/roster/official-published-presentation-postgres'
import { readPostgresCurrentProofCoverage } from './comparison-scope-proof-postgres'
import { readPostgresCorrespondenceRefs } from './record-correspondence-postgres-refs'
import { sanitizeRelationDisplays } from './platform-relation-evidence-display-target'
import { correspondencePublishedScope, correspondenceSourceSelections, projectCorrespondenceSources, type SourceSelection } from './record-correspondence-read'
import type { ReceiptRedactor } from './import-receipt-redaction'
import { readPostgresCorrespondenceTargetSources } from './record-correspondence-target-postgres'
import { projectObservedCorrespondence, type CorrespondenceFilter, type CorrespondencePaging, type CorrespondenceRead, type ReadSources, type SourceReference, type StoredCorrespondence } from './record-correspondence'

type Db = Pick<NodePgDatabase, 'execute'>
type Evidence = ReadSources['evidence'] extends Map<number, (infer T)[]> ? T : never
const ids = (values: readonly number[]) => sql`${sql.param(values)}::bigint[]`
const present = (values: (number | null)[]) => [...new Set(values.flatMap(id => id === null ? [] : [id]))]

async function readEventsAndEvidence(db: Db, eventIds: number[]) {
  const { rows: events } = await db.execute<ReadSources['events'] extends Map<number,infer V> ? V : never>(sql`
    SELECT ${postgresRosterRow(schema.recordEvent,'ev')} AS event,
      ${postgresRosterRow(schema.record,'r')} AS record, ${postgresRosterRow(schema.enterprise,'e')} AS enterprise
    FROM record_event ev JOIN record r ON r.id=ev.record_id JOIN enterprise e ON e.id=r.enterprise_id
    WHERE ev.id=ANY(${ids(eventIds)})`)
  const { rows: evidence } = await db.execute<Evidence>(sql`
    SELECT ${postgresRosterRow(schema.recordEvidence,'v')} AS evidence,
      CASE WHEN f.id IS NOT NULL THEN json_build_object('id',f.id,'relPath',f.rel_path,
        'bytes',f.bytes,'sha256',f.sha256,'removedAt',f.removed_at) END AS "storedFile"
    FROM record_evidence v LEFT JOIN stored_file f ON f.rel_path=v.source_file
    WHERE v.record_event_id=ANY(${ids(eventIds)}) ORDER BY v.id`)
  return { events, evidence }
}

async function readExports(db: Db, rowIds: number[]) {
  const { rows: exports } = await db.execute<ReadSources['exports'] extends Map<number,infer V> ? V : never>(sql`
    SELECT ${postgresRosterRow(schema.platformExportRow,'r')} AS "exportRow", ${postgresRosterRow(schema.platformExportBatch,'b')} AS "exportBatch"
    FROM platform_export_row r JOIN platform_export_batch b ON b.id=r.batch_id
    WHERE r.id=ANY(${ids(rowIds)})`)
  return exports
}

type ProofPair = { relationId: number; exportRowId: number; ids: number[] }

export async function observePostgresCorrespondences(db: Db,
  references: (SourceReference & Partial<Pick<StoredCorrespondence, 'type' | 'role' | 'provenance'>>)[], requestedProofs: ProofPair[] = [],
) {
  const scoped = references.filter(row => row.status === 'confirmed' || row.status === 'candidate')
  const { events, evidence } = await readEventsAndEvidence(db, present(scoped.flatMap(row => [row.eventId, row.predecessorEventId])))
  const relations = await readPostgresCorrespondenceTargetSources(db, present(scoped.map(row => row.relationId)))
  const exports = await readExports(db, present(scoped.map(row => row.exportRowId)))
  const enterprises = await readPostgresRosterRowsById(db, schema.enterprise, sql`
    FROM enterprise p WHERE p.id=ANY(${ids(present([...scoped.map(row => row.enterpriseId), ...relations.map(row => row.relation.enterpriseId)]))})`)
  const { rows: titles } = await db.execute<{ code: string }>(sql`
    SELECT code FROM title WHERE code=ANY(${sql.param([...new Set(scoped.map(row => row.titleCode))])}::text[])`)
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
    relations: relationMap, exports: exportMap, enterprises: new Map(enterprises.map(row => [row.id, row])),
    titles: new Set(titles.map(row => row.code)),
  }
  return observed
}

const filters = {
  id: sql`p.id`, eventId: sql`p.event_id`, relationId: sql`a.old_id`, exportRowId: sql`p.export_row_id`,
  enterpriseId: sql`p.enterprise_id`, titleCode: sql`p.title_code`, status: sql`p.status`,
  type: sql`p.type`, role: sql`p.role`, ruleVersion: sql`p.rule_version`,
}

function relationScope(filter: CorrespondenceFilter) {
  const { anyEventId, ...exact } = filter
  const fields = Object.entries(exact).filter(([, value]) => value != null)
    .map(([key, value]) => sql`${filters[key as keyof typeof filters]}=${value}`)
  if (anyEventId !== undefined) fields.push(sql`(p.event_id=${anyEventId} OR p.predecessor_event_id=${anyEventId})`)
  const where = fields.length ? sql`WHERE ${sql.join(fields, sql` AND `)}` : sql.empty()
  return sql`FROM record_correspondence p LEFT JOIN platform_legacy_relation_alias a ON a.observation_id=p.observation_id ${where}`
}

export async function listPostgresCorrespondences(db: Db, filter: CorrespondenceFilter, paging?: CorrespondencePaging) {
  const from = relationScope(filter)
  const { rows } = await db.execute<{ row: StoredCorrespondence }>(sql`
    SELECT (jsonb_build_object('id',p.id,'edgeKey',p.edge_key,'type',p.type,'role',p.role,
      'eventId',p.event_id,'predecessorEventId',p.predecessor_event_id,'relationId',a.old_id,
      'exportRowId',p.export_row_id,'enterpriseId',p.enterprise_id,'titleCode',p.title_code,
      'status',p.status,'revision',p.revision,'targetIdentity','{}'::jsonb,
      'provenance',CASE WHEN p.status='confirmed' THEN jsonb_build_object('comparisonProofIds',p.provenance::json->'comparisonProofIds') ELSE '{}'::jsonb END,
      'sourceFingerprint',p.source_fingerprint,'ruleId',p.rule_id,'ruleVersion',p.rule_version,
      'createdAt',p.created_at,'decidedAt',p.decided_at,'endedAt',p.ended_at)) AS row
    ${from} ORDER BY p.id ${paging ? sql`LIMIT ${paging.pageSize} OFFSET ${Math.min(Number.MAX_SAFE_INTEGER, (paging.page - 1) * paging.pageSize)}` : sql.empty()}`)
  const page = rows.map(row => row.row)
  const observed = page.length ? await observePostgresCorrespondences(db, page) : undefined
  return page.map(row => projectObservedCorrespondence(row, observed!))
}

export async function pagePostgresCorrespondences(db: Db, filter: CorrespondenceFilter, paging: CorrespondencePaging) {
  const { rows: [total] } = await db.execute<{ n: string }>(sql`SELECT count(*) AS n ${relationScope(filter)}`)
  return { rows: await listPostgresCorrespondences(db, filter, paging), total: Number(total!.n), ...paging }
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
