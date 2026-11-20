import { sql, type SQL } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { PlatformSnapshotBatch, PlatformSnapshotQuery, SnapshotRow } from './platform-snapshots'

type NumericBatchField = 'id' | 'year' | 'rowCount'
type NullableBatchField = 'sourceDocumentId' | 'importBatchId' | 'replacedBatchId'
type BatchRow = Omit<PlatformSnapshotBatch, NumericBatchField | NullableBatchField>
  & Record<NumericBatchField, string> & Record<NullableBatchField, string | null>

export async function readPostgresSnapshotBatches(
  db: NodePgDatabase, { title, year, batchIds }: PlatformSnapshotQuery & { batchIds?: number[] },
): Promise<PlatformSnapshotBatch[]> {
  const conditions: SQL[] = []
  if (title?.length) conditions.push(sql`title_code = ANY(${sql.param(title.filter(value => !value.includes('\0')))}::text[])`)
  if (year?.length) conditions.push(sql`year = ANY(${sql.param(year.filter(Number.isSafeInteger))}::bigint[])`)
  if (batchIds) conditions.push(sql`id = ANY(${sql.param(batchIds.filter(Number.isSafeInteger))}::bigint[])`)
  const where = conditions.length ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql.empty()
  const { rows } = await db.execute<BatchRow>(sql`
    SELECT id, title_code AS "titleCode", year, collected_on AS "collectedOn", original_filename AS "originalFilename",
      sha256, row_count AS "rowCount", import_status AS "importStatus", source_document_id AS "sourceDocumentId",
      import_batch_id AS "importBatchId", replaced_batch_id AS "replacedBatchId", created_at AS "createdAt"
    FROM platform_export_batch ${where} ORDER BY title_code COLLATE "C", year, id`)
  const nullable = (value: string | null) => value === null ? null : Number(value)
  return rows.map(row => ({
    ...row, id: Number(row.id), year: Number(row.year), rowCount: Number(row.rowCount),
    sourceDocumentId: nullable(row.sourceDocumentId), importBatchId: nullable(row.importBatchId), replacedBatchId: nullable(row.replacedBatchId),
  }))
}

export async function readPostgresSnapshotRows(db: NodePgDatabase, batchIds: number[]) {
  const { rows } = await db.execute<Omit<SnapshotRow, 'sourceRowNo'> & { batchId: string; sourceRowNo: string }>(sql`
    SELECT batch_id AS "batchId", source_row_no AS "sourceRowNo", uscc_raw AS "usccRaw", name_raw AS "nameRaw",
      province, city, district, reg_status AS "regStatus"
    FROM platform_export_row WHERE batch_id = ANY(${sql.param(batchIds)}::bigint[])
    ORDER BY batch_id, source_row_no`)
  const result = new Map<number, SnapshotRow[]>()
  for (const { batchId, sourceRowNo, ...row } of rows) {
    const id = Number(batchId)
    const batch = result.get(id) ?? []
    batch.push({ ...row, sourceRowNo: Number(sourceRowNo) })
    result.set(id, batch)
  }
  return result
}
