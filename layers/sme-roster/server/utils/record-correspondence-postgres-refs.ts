import { getTableColumns, sql, type SQL, type Table } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from '../../../../db/schema'
import { sourceQueryFields, sourceRelationFields } from '../../lib/platform/source-snapshot-fields'
import { readPostgresCurrentProofCoverage } from './comparison-scope-proof-postgres'
import { correspondenceAttributionChanged, type CorrespondenceAttribution } from './record-correspondence-ref-validity'
import type { CorrespondenceRefRow } from './record-correspondence'

type Db = Pick<NodePgDatabase, 'execute'>
type ProofReference = Parameters<typeof readPostgresCurrentProofCoverage>[1][number]
const NULL_JSON = sql`'null'::jsonb`
const refValue = (...segments: string[]) => sql`p.provenance_json #> ${sql.param(segments)}::text[]`
const jsonEqual = (saved: SQL, actual: SQL) => sql`coalesce((${saved})::jsonb,${NULL_JSON}) = coalesce((${actual})::jsonb,${NULL_JSON})`
const textJson = (value: SQL) => sql`to_json(${value})`
const tableColumn = (alias: string, column: string) => sql`${sql.identifier(alias)}.${sql.identifier(column)}`

function storedFields(table: Table, alias: string, saved: SQL, versioned = false) {
  return sql.join(Object.entries(getTableColumns(table)).map(([key, column]) => {
    const value = tableColumn(alias, column.name)
    const actual = column.dataType === 'json' ? sql`${value}::json`
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
        AND ${storedFields(schema.recordEvent, 'ev', refValue(...prefix, 'event'), true)}
        AND ${storedFields(schema.record, 'r', refValue(...prefix, 'record'))}
        AND ${storedFields(schema.enterprise, 'e', refValue(...prefix, predecessor ? 'enterprise' : 'officialEnterprise'))}
        AND jsonb_array_length(${evidence})=(SELECT count(*) FROM record_evidence v WHERE v.record_event_id=ev.id)
        AND NOT EXISTS (
          SELECT 1 FROM record_evidence v LEFT JOIN stored_file f ON f.rel_path=v.source_file
          WHERE v.record_event_id=ev.id AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(${evidence}) AS s(saved)
            WHERE ${storedFields(schema.recordEvidence, 'v', sql`saved->'evidence'`)}
              AND ${jsonEqual(sql`saved->'storedFile'`, sql`CASE WHEN f.id IS NOT NULL THEN ${file} END`)}
          )
        )
    ) END`
}

function relationMatches() {
  const cells = sql`json_array_elements(convert_from(snapshot.bytes,'UTF8')::json->'fields')`
  const text = sql`convert_from(decode(cell->>'hex','hex'),'UTF8')`
  const decoded = sql`CASE cell->>'storageClass'
    WHEN 'text' THEN to_json(${text})
    WHEN 'integer' THEN to_json((${text})::numeric)
    WHEN 'real' THEN to_json((${text})::double precision)
    ELSE 'null'::json END`
  const overrides = {
    id: sql`p.relation_id`, queryId: sql`qa.old_id`, enterpriseId: sql`a.enterprise_id`,
    matchBasis: sql`a.match_basis`, verificationStatus: sql`a.verification_status`,
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
    WHERE e.id=p.export_row_id AND ${storedFields(schema.platformExportRow, 'e', refValue('exportRow'))}
      AND ${storedFields(schema.platformExportBatch, 'b', refValue('exportBatch'))}) END`

type RefSources = { eventIds: number[]; relationIds: number[]; exportRowIds: number[] }
export async function readPostgresCorrespondenceRefs(db: Db, ids: readonly number[] | RefSources | { annualDecisionIds: number[] }, witnessTitle?: string) {
  let where: SQL
  const annual = 'annualDecisionIds' in ids
  if (annual) {
    if (!ids.annualDecisionIds.length) return []
    where = sql`p.id=ANY(${sql.param(ids.annualDecisionIds)}::bigint[])`
  } else if ('eventIds' in ids) {
    if (ids.eventIds.length + ids.relationIds.length + ids.exportRowIds.length === 0) return []
    const events = sql`${sql.param(ids.eventIds)}::bigint[]`
    where = sql`(p.event_id=ANY(${events}) OR p.predecessor_event_id=ANY(${events})
      OR ra.old_id=ANY(${sql.param(ids.relationIds)}::bigint[]) OR p.export_row_id=ANY(${sql.param(ids.exportRowIds)}::bigint[]))`
  } else {
    if (!ids.length) return []
    where = sql`p.enterprise_id=ANY(${sql.param(ids)}::bigint[])`
  }
  const validate = annual ? sql`true` : sql`p.status='confirmed'`
  const { rows } = await db.execute<{
    ref: CorrespondenceRefRow; matches: boolean; attribution: CorrespondenceAttribution | null; proof: ProofReference | null
  }>(sql`
    WITH selected AS MATERIALIZED (
      SELECT p.id,p.type,p.role,p.status,p.event_id,p.predecessor_event_id,p.observation_id,p.export_row_id,
        p.enterprise_id,p.title_code,p.revision,ra.old_id AS relation_id,
        CASE WHEN ${validate} THEN p.provenance::jsonb END AS provenance_json
      FROM record_correspondence p LEFT JOIN platform_legacy_relation_alias ra ON ra.observation_id=p.observation_id
      WHERE ${where}
      ${witnessTitle === undefined ? sql.empty() : sql`AND p.title_code=${witnessTitle}
        AND p.status='confirmed' AND p.type='event_recognized' AND p.role='recognized_corrob' AND p.event_id IS NOT NULL AND ra.old_id IS NOT NULL`}
    )
    SELECT json_build_object('id',p.id,'type',p.type,'role',p.role,'status',p.status,'eventId',p.event_id,
      'predecessorEventId',p.predecessor_event_id,'relationId',p.relation_id,'exportRowId',p.export_row_id,
      'enterpriseId',p.enterprise_id,'titleCode',p.title_code,'revision',p.revision) AS ref,
      CASE WHEN ${validate} THEN (
        (${eventMatches(sql`p.event_id`)}) AND (${eventMatches(sql`p.predecessor_event_id`, true)}) AND
        (${relationMatches()}) AND (${exportMatches})
        AND NOT EXISTS (SELECT 1 FROM platform_business_projection bp WHERE bp.observation_id=p.observation_id AND bp.stored_status_sqlite_storage='blob')
      ) ELSE true END AS matches,
      CASE WHEN ${validate} THEN json_build_object('type',p.type,'enterpriseId',p.enterprise_id,
        'relationEnterpriseId',a.enterprise_id,'relationStatus',a.verification_status,'relationUscc',${refValue('relation', 'usccRaw')},
        'ownerId',e.id,'ownerUscc',e.uscc_norm,'targetId',target.id,'targetUscc',target.uscc_norm,'targetTitle',t.code)
      END AS attribution,
      CASE WHEN p.status='confirmed' AND p.type='recognized_export' AND p.role='same_current_row' THEN json_build_object(
        'ids',coalesce(p.provenance_json->'comparisonProofIds','[]'::jsonb),
        'queryId',qa.old_id,'batchId',export.batch_id)
      END AS proof
    FROM selected p
    LEFT JOIN LATERAL (SELECT enterprise_id,match_basis,verification_status FROM platform_observation_assignment
      WHERE observation_id=p.observation_id ORDER BY revision DESC LIMIT 1) a ON true
    LEFT JOIN platform_legacy_query_alias qa ON qa.collection_id=(SELECT collection_id FROM platform_business_observation WHERE id=p.observation_id)
    LEFT JOIN platform_export_row export ON export.id=p.export_row_id
    LEFT JOIN enterprise e ON e.id=a.enterprise_id
    LEFT JOIN enterprise target ON target.id=p.enterprise_id LEFT JOIN title t ON t.code=p.title_code
    ORDER BY p.id`)
  const covers = await readPostgresCurrentProofCoverage(db, rows.flatMap(row => row.proof ? [row.proof] : []))
  return rows.map(({ ref, matches, attribution, proof }) => ({
    ...ref, requiresRevalidation: !matches || attribution !== null && correspondenceAttributionChanged(attribution)
      || proof !== null && !covers(proof),
  }))
}
