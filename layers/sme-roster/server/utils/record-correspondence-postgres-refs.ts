import { and, desc, eq, getTableColumns, isNotNull, notExists, or, sql, type SQL, type Table } from 'drizzle-orm'
import { alias, QueryBuilder } from 'drizzle-orm/pg-core'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { enterprise } from '../../../../db/postgresql/enterprise-tables'
import { title } from '../../../../db/postgresql/title-table'
import {
  platformBusinessObservation, platformBusinessProjection, platformExportBatch, platformExportRow,
  platformLegacyQueryAlias, platformLegacyRelationAlias, platformObservationAssignment,
} from '../../../../db/postgresql/platform-tables'
import { recordCorrespondence } from '../../../../db/postgresql/qualification-tables'
import { record, recordEvent, recordEvidence } from '../../../../db/postgresql/ledger-tables'
import { sourceQueryFields, sourceRelationFields } from '../../lib/platform/source-snapshot-fields'
import { readPostgresCurrentProofCoverage } from './comparison-scope-proof-postgres'
import { correspondenceAttributionChanged, type CorrespondenceAttribution } from './record-correspondence-attribution'
import type { CorrespondenceRefRow } from './record-correspondence'

type Db = Pick<NodePgDatabase, 'execute' | 'select'>
type ProofReference = Parameters<typeof readPostgresCurrentProofCoverage>[1][number]
const NULL_JSON = sql`'null'::jsonb`
const refValue = (...segments: string[]) => sql`p.provenance_json #> ${sql.param(segments)}::text[]`
const jsonEqual = (saved: SQL, actual: SQL) => sql`coalesce((${saved})::jsonb,${NULL_JSON}) = coalesce((${actual})::jsonb,${NULL_JSON})`
const legacyJsonFields = new Set(['qualityFlags', 'formalValidity', 'rawFields'])
const textJson = (value: SQL) => sql`to_json(${value})`
const tableColumn = (alias: string, column: string) => sql`${sql.identifier(alias)}.${sql.identifier(column)}`

function storedFields(table: Table, alias: string, saved: SQL, versioned = false) {
  return sql.join(Object.entries(getTableColumns(table)).map(([key, column]) => {
    const value = tableColumn(alias, column.name)
    const actual = legacyJsonFields.has(key) ? sql`${value}::json`
      : versioned && key === 'revision' ? textJson(sql`nullif(${value},1)`) : textJson(value)
    return jsonEqual(sql`(${saved})->${key}::text`, actual)
  }), sql` AND `)
}

function eventMatches(id: SQL, predecessor = false) {
  const prefix = predecessor ? ['predecessor'] : []
  const evidence = refValue(...prefix, 'officialEvidence')
  const file = sql`jsonb_build_object('id',f.id,'relPath',f.rel_path,'bytes',f.bytes,'sha256',f.sha256,'removedAt',f.removed_at)`
  return sql`CASE WHEN ${id} IS NULL THEN ${jsonEqual(refValue(...prefix, 'event'), NULL_JSON)}
    ELSE EXISTS (
      SELECT 1 FROM record_event ev JOIN record r ON r.id=ev.record_id JOIN enterprise e ON e.id=r.enterprise_id
      WHERE ev.id=${id}
        AND ${storedFields(recordEvent, 'ev', refValue(...prefix, 'event'), true)}
        AND ${storedFields(record, 'r', refValue(...prefix, 'record'))}
        AND ${storedFields(enterprise, 'e', refValue(...prefix, predecessor ? 'enterprise' : 'officialEnterprise'))}
        AND jsonb_array_length(${evidence})=(SELECT count(*) FROM record_evidence v WHERE v.record_event_id=ev.id)
        AND NOT EXISTS (
          SELECT 1 FROM record_evidence v LEFT JOIN stored_file f ON f.rel_path=v.source_file
          WHERE v.record_event_id=ev.id AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(${evidence}) AS s(saved)
            WHERE ${storedFields(recordEvidence, 'v', sql`saved->'evidence'`)}
              AND ${jsonEqual(sql`saved->'storedFile'`, sql`CASE WHEN f.id IS NOT NULL THEN ${file} END`)}
          )
        )
    ) END`
}

function relationMatches(assignment: { enterpriseId: SQL; matchBasis: SQL; verificationStatus: SQL }) {
  const cells = sql`json_array_elements(convert_from(snapshot.bytes,'UTF8')::json->'fields')`
  const text = sql`convert_from(decode(cell->>'hex','hex'),'UTF8')`
  const decoded = sql`CASE cell->>'storageClass'
    WHEN 'text' THEN to_json(${text})
    WHEN 'integer' THEN to_json((${text})::numeric)
    WHEN 'real' THEN to_json((${text})::double precision)
    ELSE 'null'::json END`
  const overrides = {
    id: sql`p.relation_id`, queryId: sql`qa.old_id`, ...assignment,
  }
  const fields = Object.entries(sourceRelationFields).map(([key, column]) => {
    const saved = refValue('relation', key)
    const actual = column.dataType === 'json'
      ? sql`CASE WHEN cell->>'storageClass' <> 'null' THEN (${text})::json END`
      : key in overrides ? textJson(overrides[key as keyof typeof overrides]) : decoded
    return sql`WHEN ${column.name} THEN cell->>'storageClass' <> 'blob' AND ${jsonEqual(saved, actual)}`
  })
  const query = Object.entries(sourceQueryFields).map(([key, column]) => {
    const archiveField = key === 'rawResponse' || key === 'collectionEvidence'
    const value = archiveField ? sql`(
      SELECT convert_from(v.bytes,'UTF8') FROM platform_collection_archive_ref r JOIN platform_archive_value v ON v.id=r.archive_id
      WHERE r.owner_id=c.id AND r.field=${key})` : key === 'id' ? sql`qa.old_id` : tableColumn('c', column.name)
    return jsonEqual(refValue('query', key), column.dataType === 'json' ? sql`(${value})::json` : textJson(value))
  })
  return sql`CASE WHEN p.observation_id IS NULL THEN
    ${jsonEqual(refValue('relation'), NULL_JSON)} AND ${jsonEqual(refValue('query'), NULL_JSON)}
    ELSE EXISTS(
      SELECT 1 FROM platform_business_observation o
      JOIN platform_collection c ON c.id=o.collection_id
      JOIN platform_legacy_query_alias qa ON qa.collection_id=c.id
      JOIN platform_observation_archive_ref r ON r.owner_id=o.id AND r.field='legacyRowSnapshot'
      JOIN platform_archive_value snapshot ON snapshot.id=r.archive_id
      WHERE o.id=p.observation_id
        AND (SELECT count(*) FROM ${cells} AS x(cell) WHERE cell->>'name'=ANY(${sql.param(Object.values(sourceRelationFields).map(column => column.name))}::text[]))=${fields.length}
        AND NOT EXISTS(SELECT 1 FROM ${cells} AS x(cell)
          WHERE NOT (CASE cell->>'name' ${sql.join(fields, sql` `)} ELSE true END))
        AND ${sql.join(query, sql` AND `)}
    ) END`
}

const exportMatches = sql`CASE WHEN p.export_row_id IS NULL THEN
  ${jsonEqual(refValue('exportRow'), NULL_JSON)} AND ${jsonEqual(refValue('exportBatch'), NULL_JSON)}
  ELSE EXISTS(SELECT 1 FROM platform_export_row e JOIN platform_export_batch b ON b.id=e.batch_id
    WHERE e.id=p.export_row_id AND ${storedFields(platformExportRow, 'e', refValue('exportRow'))}
      AND ${storedFields(platformExportBatch, 'b', refValue('exportBatch'))}) END`

type RefSources = { eventIds: number[]; relationIds: number[]; exportRowIds: number[] }
export async function readPostgresCorrespondenceRefs(db: Db, ids: readonly number[] | RefSources | { annualDecisionIds: number[] }, witnessTitle?: string) {
  const edge = recordCorrespondence, relation = platformLegacyRelationAlias
  const anyId = (ids: readonly number[]) => sql`ANY(${sql.param(ids)}::bigint[])`
  let where: SQL | undefined
  const annual = 'annualDecisionIds' in ids
  if (annual) {
    if (!ids.annualDecisionIds.length) return []
    where = eq(edge.id, anyId(ids.annualDecisionIds))
  } else if ('eventIds' in ids) {
    if (ids.eventIds.length + ids.relationIds.length + ids.exportRowIds.length === 0) return []
    const events = anyId(ids.eventIds)
    where = or(eq(edge.eventId, events), eq(edge.predecessorEventId, events),
      eq(relation.oldId, anyId(ids.relationIds)), eq(edge.exportRowId, anyId(ids.exportRowIds)))
  } else {
    if (!ids.length) return []
    where = eq(edge.enterpriseId, anyId(ids))
  }
  const selected = db.select({
    id: edge.id, type: edge.type, role: edge.role, status: edge.status, eventId: edge.eventId,
    predecessorEventId: edge.predecessorEventId, observationId: edge.observationId, exportRowId: edge.exportRowId,
    enterpriseId: edge.enterpriseId, titleCode: edge.titleCode, revision: edge.revision,
    relation: sql`${relation.oldId}`.as('relation_id'),
    provenance: sql`CASE WHEN ${annual ? sql`true` : eq(edge.status, 'confirmed')} THEN ${edge.provenance}::jsonb END`.as('provenance_json'),
  }).from(edge).leftJoin(relation, eq(relation.observationId, edge.observationId))
    .where(and(where, witnessTitle === undefined ? undefined : and(eq(edge.titleCode, witnessTitle),
      eq(edge.status, 'confirmed'), eq(edge.type, 'event_recognized'), eq(edge.role, 'recognized_corrob'),
      isNotNull(edge.eventId), isNotNull(relation.oldId))))
  const p = new QueryBuilder().$with('p').as(selected)
  const observation = platformBusinessObservation
  const a = platformObservationAssignment, query = platformLegacyQueryAlias
  const exportRow = platformExportRow, target = alias(enterprise, 'target'), business = platformBusinessProjection
  const assignment = db.select({ enterpriseId: a.enterpriseId, matchBasis: a.matchBasis, verificationStatus: a.verificationStatus })
    .from(a).where(eq(a.observationId, p.observationId)).orderBy(desc(a.revision)).limit(1).as('assignment')
  const collection = db.select({ id: observation.collectionId }).from(observation).where(eq(observation.id, p.observationId))
  const noOpaqueStatus = notExists(db.select({ id: business.id }).from(business)
    .where(and(eq(business.observationId, p.observationId), eq(business.storedStatusSqliteStorage, 'blob'))))
  const validate = annual ? sql`true` : eq(p.status, 'confirmed')
  const relationMatch = relationMatches({
    enterpriseId: sql`${assignment.enterpriseId}`,
    matchBasis: sql`${assignment.matchBasis}`,
    verificationStatus: sql`${assignment.verificationStatus}`,
  })
  const projected = db.select({
    ref: sql`json_build_object('id',${p.id},'type',${p.type},'role',${p.role},'status',${p.status},'eventId',${p.eventId},
      'predecessorEventId',${p.predecessorEventId},'relationId',p.relation_id,'exportRowId',${p.exportRowId},
      'enterpriseId',${p.enterpriseId},'titleCode',${p.titleCode},'revision',${p.revision})`.as('ref'),
    matches: sql`CASE WHEN ${validate} THEN ${and(
      eventMatches(sql`${p.eventId}`), eventMatches(sql`${p.predecessorEventId}`, true),
      relationMatch, exportMatches, noOpaqueStatus,
    )} ELSE true END`.as('matches'),
    attribution: sql`CASE WHEN ${validate} THEN json_build_object('type',${p.type},'enterpriseId',${p.enterpriseId},
      'relationEnterpriseId',${assignment.enterpriseId},'relationStatus',${assignment.verificationStatus},'relationUscc',${refValue('relation', 'usccRaw')},
      'ownerId',${enterprise.id},'ownerUscc',${enterprise.usccNorm},'targetId',${target.id},'targetUscc',${target.usccNorm},'targetTitle',${title.code})
    END`.as('attribution'),
    proof: sql`CASE WHEN ${and(eq(p.status, 'confirmed'), eq(p.type, 'recognized_export'), eq(p.role, 'same_current_row'))} THEN json_build_object(
      'ids',coalesce(p.provenance_json->'comparisonProofIds','[]'::jsonb),
      'queryId',${query.oldId},'batchId',${exportRow.batchId})
    END`.as('proof'),
  }).from(p).leftJoinLateral(assignment, sql`true`)
    .leftJoin(query, eq(query.collectionId, sql`(${collection})`))
    .leftJoin(exportRow, eq(exportRow.id, p.exportRowId))
    .leftJoin(enterprise, eq(enterprise.id, assignment.enterpriseId))
    .leftJoin(target, eq(target.id, p.enterpriseId)).leftJoin(title, eq(title.code, p.titleCode))
    .orderBy(p.id)
  // Drizzle cannot mark a CTE MATERIALIZED. Retain the planner boundary before
  // checking archived byte fields and saved JSON provenance.
  const { rows } = await db.execute<{
    ref: CorrespondenceRefRow; matches: boolean; attribution: CorrespondenceAttribution | null; proof: ProofReference | null
  }>(sql`WITH p AS MATERIALIZED (${selected}) ${projected}`)
  const covers = await readPostgresCurrentProofCoverage(db, rows.flatMap(row => row.proof ? [row.proof] : []))
  return rows.map(({ ref, matches, attribution, proof }) => ({
    ...ref, requiresRevalidation: !matches || attribution !== null && correspondenceAttributionChanged(attribution)
      || proof !== null && !covers(proof),
  }))
}
