import { decodePostgresExactCell } from '../../../../db/postgresql/exact-cell'
import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { projectRecognizedWitnesses, type RecognizedWitnessRow } from './recognized-witness-target'
import type { RecognizedWitnessReader } from './recognized-witness-reader'

type Reader = Pick<NodePgDatabase, 'execute'>
type WitnessInput = Parameters<RecognizedWitnessReader['readMany']>[0]
type Cell = Buffer | null
type StoredWitness = {
  row: Omit<RecognizedWitnessRow, 'valid' | 'year' | 'batch'>
  valid: Cell; validStorage: string | null
  year: Cell; yearStorage: string | null
  batch: Cell; batchStorage: string | null
}

/** Fetch only typed witness/binding columns. The caller reuses the map within a pinned read. */
export async function readPostgresRecognizedWitnesses(db: Reader, ids: readonly number[]) {
  const target = new Map<number, RecognizedWitnessRow>()
  if (ids.length) {
    const { rows } = await db.execute<StoredWitness>(sql`
      SELECT json_build_object(
        'relationId', ra.old_id, 'observationId', o.id, 'collectionId', c.id, 'queryId', qa.old_id,
        'titleCode', c.title_code, 'rdjb', c.rdjb, 'interface', c.interface, 'status', c.status, 'sequenceNo', o.sequence_no,
        'identity', o.identity_state, 'content', o.content_state, 'recordInterface', b.interface,
        'assignmentId', a.observation_id, 'enterpriseId', a.enterprise_id, 'uscc', a.uscc_raw, 'verification', a.verification_status,
        'projectionId', p.id, 'rawValid', p.source_validity_date, 'rawMaintenanceBatch', p.source_maintenance_batch,
        'yearAbsent', p.source_maintenance_year_absent, 'state', c.witness_state, 'rule', c.witness_rule, 'gate', c.witness_gate,
        'archiveId', c.witness_archive_id, 'sha', c.witness_sha256, 'errorName', c.witness_error_name, 'error', c.witness_error,
        'refId', ref.archive_id, 'sealed', ref.sealed, 'archiveOwner', archive.id, 'archiveSha', archive.sha256,
        'positionState', o.witness_state, 'positionRule', o.witness_rule, 'positionCollection', o.witness_collection_id,
        'positionSequence', o.witness_sequence_no, 'positionArchive', o.witness_archive_id, 'positionSha', o.witness_sha256,
        'ordinal', o.witness_ordinal, 'key', o.witness_rdjb_key, 'pageKind', o.witness_page_kind,
        'positionErrorName', o.witness_error_name, 'positionError', o.witness_error,
        'validKind', valid.witness_kind, 'yearKind', yr.witness_kind, 'batchKind', batch.witness_kind
      ) AS row,
      valid.witness_value AS valid, valid.witness_value_sqlite_storage AS "validStorage",
      yr.witness_value AS year, yr.witness_value_sqlite_storage AS "yearStorage",
      batch.witness_value AS batch, batch.witness_value_sqlite_storage AS "batchStorage"
      FROM platform_legacy_relation_alias ra
      JOIN platform_business_observation o ON o.id = ra.observation_id
      JOIN platform_collection c ON c.id = o.collection_id
      LEFT JOIN platform_legacy_query_alias qa ON qa.collection_id = c.id
      LEFT JOIN LATERAL (SELECT * FROM platform_observation_assignment a WHERE a.observation_id = o.id ORDER BY revision DESC LIMIT 1) a ON true
      LEFT JOIN platform_business_record b ON b.id = o.record_id
      LEFT JOIN platform_recognized_projection p ON p.version_id = o.version_id AND p.record_id = o.record_id
      LEFT JOIN platform_collection_archive_ref ref ON ref.owner_id = c.id AND ref.field = 'collectionEvidence'
      LEFT JOIN platform_archive_value archive ON archive.id = ref.archive_id
      LEFT JOIN platform_collection_condition valid ON valid.collection_id = c.id AND valid.name = 'rddqrq'
      LEFT JOIN platform_collection_condition yr ON yr.collection_id = c.id AND yr.name = 'whpcyear'
      LEFT JOIN platform_collection_condition batch ON batch.collection_id = c.id AND batch.name = 'whpc'
      WHERE ra.old_id = ANY(${sql.param(ids)}::bigint[])`)
    for (const row of rows) target.set(row.row.relationId, {
      ...row.row,
      valid: decodePostgresExactCell(row.valid, row.validStorage), year: decodePostgresExactCell(row.year, row.yearStorage), batch: decodePostgresExactCell(row.batch, row.batchStorage),
    })
  }
  return (input: WitnessInput) => projectRecognizedWitnesses(input, input.relationIds.flatMap(id => {
    const row = target.get(id)
    return row ? [row] : []
  }))
}
