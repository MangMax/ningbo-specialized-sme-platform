import { and, desc, eq, getTableColumns, isNotNull, notExists, or, sql, type SQL, type Table } from 'drizzle-orm'
import { alias, QueryBuilder } from 'drizzle-orm/pg-core'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { enterprise } from '../../../../db/postgresql/enterprise-tables'
import { title } from '../../../../db/postgresql/title-table'
import {
  platformBusinessProjection, platformExportBatch, platformExportRow,
  platformBusinessObservation, platformObservationAssignment,
} from '../../../../db/postgresql/platform-tables'
import { recordCorrespondence } from '../../../../db/postgresql/qualification-tables'
import { record, recordEvent, recordEvidence } from '../../../../db/postgresql/ledger-tables'
import { sourceQueryFields, sourceRelationFields } from '../../lib/platform/source-snapshot-fields'
import { correspondenceAttributionChanged, type CorrespondenceAttribution } from './record-correspondence-attribution'
import type { CorrespondenceRefRow } from './record-correspondence'

type Db = Pick<NodePgDatabase, 'execute' | 'select'>
const NULL_JSON = sql`'null'::jsonb`
const refValue = (...segments: string[]) => sql`p.provenance_json #> ${sql.param(segments)}::text[]`
const jsonEqual = (saved: SQL, actual: SQL) => sql`coalesce((${saved})::jsonb,${NULL_JSON}) = coalesce((${actual})::jsonb,${NULL_JSON})`
const legacyJsonFields = new Set(['qualityFlags', 'formalValidity', 'rawFields'])
const textJson = (value: SQL) => sql`to_json(${value})`
const tableColumn = (alias: string, column: string) => sql`${sql.identifier(alias)}.${sql.identifier(column)}`

function storedFields(table: Table, alias: string, saved: SQL, versioned = false) {
  return and(...Object.entries(getTableColumns(table)).map(([key, column]) => {
    const value = tableColumn(alias, column.name)
    const actual = legacyJsonFields.has(key) ? sql`${value}::json`
      : versioned && key === 'revision' ? textJson(sql`nullif(${value},1)`) : textJson(value)
    return jsonEqual(sql`(${saved})->${key}::text`, actual)
  }))
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
  const overrides = { id: sql`p.relation_id`, queryId: sql`c.public_id`, ...assignment }
  const fields = Object.keys(sourceRelationFields).filter(key => key !== 'rawFields' && key !== 'sourceText').map(key => {
    const actual = key in overrides ? textJson(overrides[key as keyof typeof overrides]) : sql`o.relation_facts->${key}::text`
    return jsonEqual(refValue('relation', key), actual)
  })
  const query = Object.entries(sourceQueryFields).map(([key, column]) => {
    if (key === 'rawResponse') {
      const saved = sql`coalesce(${refValue('query', 'rawResponseSha256')} #>> '{}', CASE
        WHEN jsonb_typeof(${refValue('query', 'rawResponse')})='string'
        THEN encode(sha256(convert_to(${refValue('query', 'rawResponse')} #>> '{}','UTF8')),'hex') END)`
      return sql`${saved} IS NOT DISTINCT FROM c.raw_response_sha256`
    }
    if (key === 'collectionEvidence') {
      const saved = refValue('query', key)
      const structured = sql`CASE WHEN jsonb_typeof(${saved})='object' THEN (${saved}) - ARRAY['rows','dataRows','rawData'] ELSE (${saved}) END`
      return or(jsonEqual(structured, sql`c.source_coverage`),
        and(jsonEqual(saved, NULL_JSON), sql`c.evidence_sha256 IS NULL`))
    }
    return jsonEqual(refValue('query', key), textJson(key === 'id' ? sql`c.public_id` : tableColumn('c', column.name)))
  })
  return sql`CASE WHEN p.observation_id IS NULL THEN
    ${jsonEqual(refValue('relation'), NULL_JSON)} AND ${jsonEqual(refValue('query'), NULL_JSON)}
    ELSE EXISTS(
      SELECT 1 FROM platform_business_observation o
      JOIN platform_collection c ON c.id=o.collection_id
      WHERE o.id=p.observation_id AND o.relation_facts IS NOT NULL
        AND ${and(...fields)}
        AND ${and(...query)}
    ) END`
}

const exportMatches = sql`CASE WHEN p.export_row_id IS NULL THEN
  ${jsonEqual(refValue('exportRow'), NULL_JSON)} AND ${jsonEqual(refValue('exportBatch'), NULL_JSON)}
  ELSE EXISTS(SELECT 1 FROM platform_export_row e JOIN platform_export_batch b ON b.id=e.batch_id
    WHERE e.id=p.export_row_id AND ${storedFields(platformExportRow, 'e', refValue('exportRow'))}
      AND ${storedFields(platformExportBatch, 'b', refValue('exportBatch'))}) END`

type RefSources = { eventIds: number[]; relationIds: number[]; exportRowIds: number[] }
export async function readPostgresCorrespondenceRefs(db: Db, ids: readonly number[] | RefSources | { annualDecisionIds: number[] } | { validityIds: number[] }, witnessTitle?: string) {
  const edge = recordCorrespondence, relation = platformBusinessObservation
  const anyId = (ids: readonly number[]) => sql`ANY(${sql.param(ids)}::bigint[])`
  let where: SQL | undefined
  const explicitValidity = 'annualDecisionIds' in ids || 'validityIds' in ids
  if (explicitValidity) {
    const selectedIds = 'annualDecisionIds' in ids ? ids.annualDecisionIds : ids.validityIds
    if (!selectedIds.length) return []
    where = eq(edge.id, anyId(selectedIds))
  } else if ('eventIds' in ids) {
    if (ids.eventIds.length + ids.relationIds.length + ids.exportRowIds.length === 0) return []
    const events = anyId(ids.eventIds)
    where = or(eq(edge.eventId, events), eq(edge.predecessorEventId, events),
      eq(relation.publicId, anyId(ids.relationIds)), eq(edge.exportRowId, anyId(ids.exportRowIds)))
  } else {
    if (!ids.length) return []
    where = eq(edge.enterpriseId, anyId(ids))
  }
  const selected = db.select({
    id: edge.id, type: edge.type, role: edge.role, status: edge.status, eventId: edge.eventId,
    predecessorEventId: edge.predecessorEventId, observationId: edge.observationId, exportRowId: edge.exportRowId,
    enterpriseId: edge.enterpriseId, titleCode: edge.titleCode, revision: edge.revision,
    relation: sql`${relation.publicId}`.as('relation_id'),
    provenance: sql`CASE WHEN ${explicitValidity ? sql`true` : eq(edge.status, 'confirmed')} THEN ${edge.provenance}::jsonb END`.as('provenance_json'),
  }).from(edge).leftJoin(relation, eq(relation.id, edge.observationId))
    .where(and(where, witnessTitle === undefined ? undefined : and(eq(edge.titleCode, witnessTitle),
      eq(edge.status, 'confirmed'), eq(edge.type, 'event_recognized'), eq(edge.role, 'recognized_corrob'),
      isNotNull(edge.eventId), isNotNull(relation.publicId))))
  const p = new QueryBuilder().$with('p').as(selected)
  const a = platformObservationAssignment
  const target = alias(enterprise, 'target'), business = platformBusinessProjection
  const assignment = db.select({ enterpriseId: a.enterpriseId, matchBasis: a.matchBasis, verificationStatus: a.verificationStatus })
    .from(a).where(eq(a.observationId, p.observationId)).orderBy(desc(a.revision)).limit(1).as('assignment')
  const noOpaqueStatus = notExists(db.select({ id: business.id }).from(business)
    .where(and(eq(business.observationId, p.observationId), eq(business.storedStatusSqliteStorage, 'blob'))))
  const validate = explicitValidity ? sql`true` : eq(p.status, 'confirmed')
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
  }).from(p).leftJoinLateral(assignment, sql`true`)
    .leftJoin(enterprise, eq(enterprise.id, assignment.enterpriseId))
    .leftJoin(target, eq(target.id, p.enterpriseId)).leftJoin(title, eq(title.code, p.titleCode))
    .orderBy(p.id)
  // Drizzle cannot mark a CTE MATERIALIZED. Retain the planner boundary before
  // checking retained source fields and saved JSON provenance.
  const { rows } = await db.execute<{
    ref: CorrespondenceRefRow; matches: boolean; attribution: CorrespondenceAttribution | null
  }>(sql`WITH p AS MATERIALIZED (${selected}) ${projected}`)
  return rows.map(({ ref, matches, attribution }) => ({
    ...ref, requiresRevalidation: !matches || attribution !== null && correspondenceAttributionChanged(attribution),
  }))
}
