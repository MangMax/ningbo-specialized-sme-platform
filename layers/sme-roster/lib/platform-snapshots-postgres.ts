import { and, asc, inArray, sql, type SQL } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { platformExportBatch as batch, platformExportRow as row } from '../../../db/postgresql/platform-tables'
import type { PlatformSnapshotBatch, PlatformSnapshotQuery, SnapshotRow } from './platform-snapshots'

export async function readPostgresSnapshotBatches(
  db: NodePgDatabase, { title, year, batchIds }: PlatformSnapshotQuery & { batchIds?: number[] },
): Promise<PlatformSnapshotBatch[]> {
  const conditions: SQL[] = []
  if (title?.length) conditions.push(inArray(batch.titleCode, title.filter(value => !value.includes('\0'))))
  if (year?.length) conditions.push(inArray(batch.year, year.filter(Number.isSafeInteger)))
  if (batchIds) conditions.push(inArray(batch.id, batchIds.filter(Number.isSafeInteger)))
  // Drizzle 0.45 has no collation operator. Preserve bytewise title ordering.
  return db.select().from(batch).where(and(...conditions))
    .orderBy(asc(sql`${batch.titleCode} COLLATE "C"`), asc(batch.year), asc(batch.id))
}

export async function readPostgresSnapshotRows(db: NodePgDatabase, batchIds: number[]) {
  const rows = await db.select({
    batchId: row.batchId,
    sourceRowNo: row.sourceRowNo,
    usccRaw: row.usccRaw,
    nameRaw: row.nameRaw,
    province: row.province,
    city: row.city,
    district: row.district,
    regStatus: row.regStatus,
  }).from(row).where(inArray(row.batchId, batchIds)).orderBy(asc(row.batchId), asc(row.sourceRowNo))
  const result = new Map<number, SnapshotRow[]>()
  for (const { batchId, ...entry } of rows) {
    const entries = result.get(batchId) ?? []
    entries.push(entry)
    result.set(batchId, entries)
  }
  return result
}
