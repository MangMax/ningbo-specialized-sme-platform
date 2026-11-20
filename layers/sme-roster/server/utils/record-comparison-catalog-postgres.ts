import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from '../../../../db/schema'
import { normalizeName } from '../../lib/domain'
import { postgresRosterRow } from '../../lib/roster/postgres-rows'
import { comparisonSourceCatalogInput, type ComparisonSourceCatalogInput } from '../../lib/roster/record-comparison'
import { officialSourceDirectory, type OfficialSourceDocument } from './official-source-directory'
import type { StoredFileContentIdentity } from '../../../core/server/utils/file-content-identity'
import { comparisonCatalogWindows, projectCatalogDocument, projectCatalogExport, projectCatalogQuery, projectSourceEnterpriseLinks } from './record-comparison'

type Reader = Pick<NodePgDatabase, 'execute'>
const ids = (values: readonly number[]) => sql`${sql.param(values)}::bigint[]`

export async function readPostgresComparisonIdentities(db: Reader, queryIds: readonly number[]) {
  return (await db.execute<Parameters<typeof projectSourceEnterpriseLinks>[0][number]>(sql`
    SELECT ra.old_id::float8 AS id,ra.old_id::float8 AS "relationId",o.id::float8 AS "observationId",
      q.old_id::float8 AS "queryId",o.sequence_no::float8 AS "sequenceNo",o.source_relation_key AS "relationKey",
      a.enterprise_id::float8 AS "enterpriseId",e.name AS "enterpriseName",a.match_basis AS "matchBasis",
      a.verification_status AS "verificationStatus",original.name_raw AS "nameRaw",original.uscc_raw AS "usccRaw"
    FROM platform_legacy_query_alias q JOIN platform_business_observation o ON o.collection_id=q.collection_id
    JOIN platform_legacy_relation_alias ra ON ra.observation_id=o.id
    JOIN platform_observation_assignment original ON original.observation_id=o.id AND original.revision=1
    JOIN LATERAL (SELECT enterprise_id,match_basis,verification_status FROM platform_observation_assignment
      WHERE observation_id=o.id ORDER BY revision DESC LIMIT 1) a ON true
    LEFT JOIN enterprise e ON e.id=a.enterprise_id WHERE q.old_id=ANY(${ids(queryIds)}) ORDER BY ra.old_id`)).rows
}

async function readQueryEnterpriseLinks(db: Reader, queryIds: number[]) {
  const rows = await readPostgresComparisonIdentities(db, queryIds)
  const confirmed = rows.filter(row => row.verificationStatus === 'confirmed' && row.enterpriseId != null && row.enterpriseName != null)
  const aliases = await db.execute<{ enterpriseId: number; nameNorm: string; note: string | null }>(sql`
    SELECT enterprise_id::float8 AS "enterpriseId",name_norm AS "nameNorm",note
    FROM enterprise_alias WHERE verification_status='confirmed'
      AND enterprise_id=ANY(${ids([...new Set(confirmed.map(row => row.enterpriseId!))])})
      AND name_norm=ANY(${sql.param([...new Set(confirmed.flatMap(row => row.nameRaw ? [normalizeName(row.nameRaw)] : []))])}::text[])`)
  return projectSourceEnterpriseLinks(rows, new Map(aliases.rows.map(row => [`${row.enterpriseId}\u0000${row.nameNorm}`, row])))
}

export function readPostgresRecordComparisonSources(db: NodePgDatabase, input: ComparisonSourceCatalogInput, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const filter = comparisonSourceCatalogInput.parse(input)
  return db.transaction(async tx => {
    const docFilter = filter.ids === undefined ? sql`true` : sql`d.id=ANY(${ids(filter.ids)})`
    const queryFilter = filter.ids === undefined ? sql`true` : sql`q.old_id=ANY(${ids(filter.ids)})`
    const batchFilter = filter.ids === undefined ? sql`true` : sql`b.id=ANY(${ids(filter.ids)})`
    const { rows: [count] } = await tx.execute<{ official_document: number; query: number; export_batch: number }>(sql`
      SELECT (SELECT count(*) FROM ${officialSourceDirectory} d WHERE ${docFilter})::float8 AS official_document,
        (SELECT count(*) FROM platform_legacy_query_alias q WHERE ${queryFilter})::float8 AS query,
        (SELECT count(*) FROM platform_export_batch b WHERE ${batchFilter})::float8 AS export_batch`)
    const counts = count!
    signal?.throwIfAborted()
    const { dw, qw, bw } = comparisonCatalogWindows(filter, counts)
    const documents = dw.limit ? (await tx.execute<{ row: OfficialSourceDocument; registered: StoredFileContentIdentity | null }>(sql`
      SELECT json_build_object('id',d.id,'source',d.source,'title',d.title,'docNumber',d."docNumber",'issueDate',d."issueDate",'path',d.path) AS row,
        CASE WHEN f.id IS NOT NULL THEN json_build_object('fileId',f.id,'relPath',f.rel_path,'sha256',f.sha256,'bytes',f.bytes) END AS registered
      FROM ${officialSourceDirectory} d LEFT JOIN stored_file f ON f.rel_path=d.path WHERE ${docFilter}
      ORDER BY d.id LIMIT ${dw.limit} OFFSET ${dw.offset}`)).rows.map(({ row, registered }) => projectCatalogDocument(row, registered)) : []
    const batches = bw.limit ? (await tx.execute<{ row: typeof schema.platformExportBatch.$inferSelect }>(sql`
      SELECT ${postgresRosterRow(schema.platformExportBatch, 'b')} AS row FROM platform_export_batch b WHERE ${batchFilter}
      ORDER BY b.id LIMIT ${bw.limit} OFFSET ${bw.offset}`)).rows.map(({ row }) => projectCatalogExport(row)) : []
    const queryPage = qw.limit ? (await tx.execute<{ id: number; collection: typeof schema.platformCollection.$inferSelect; conditions: Record<string, unknown> | null }>(sql`
      SELECT q.old_id::float8 AS id,${postgresRosterRow(schema.platformCollection, 'c')} AS collection,
        CASE WHEN c.provenance_state IN ('captured','conflict') THEN (
          SELECT CASE WHEN count(*)>0 THEN coalesce(json_object_agg(p.name,CASE p.value_kind
            WHEN 'text' THEN to_json(p.text_value) WHEN 'boolean' THEN to_json(p.integer_value <> 0)
            ELSE to_json(p.integer_value) END ORDER BY p.name COLLATE "C") FILTER (WHERE p.value_kind <> 'absent'),'{}'::json) END
          FROM platform_collection_condition p WHERE p.collection_id=c.id
        ) END AS conditions
      FROM platform_legacy_query_alias q JOIN platform_collection c ON c.id=q.collection_id
      WHERE ${queryFilter} ORDER BY q.old_id LIMIT ${qw.limit} OFFSET ${qw.offset}`)).rows : []
    signal?.throwIfAborted()
    const links = queryPage.length ? await readQueryEnterpriseLinks(tx, queryPage.map(row => row.id)) : new Map()
    const queries = queryPage.map(({ id, collection, conditions }) => {
      const present = ['captured', 'conflict'].includes(collection.provenanceState)
      return projectCatalogQuery({ ...collection, id, completeness: present ? collection.completeness : 'unknown',
        fullRange: present ? collection.fullRange : null, conditions }, links)
    })
    signal?.throwIfAborted()
    return { rows: [...documents, ...queries, ...batches], total: filter.kind ? counts[filter.kind] : counts.official_document + counts.query + counts.export_batch,
      page: filter.page, pageSize: filter.pageSize, counts, selection: 'explicit', completeness: 'not_implied_by_catalog' }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}
