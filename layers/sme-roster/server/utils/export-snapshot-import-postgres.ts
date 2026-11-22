import { and, count, eq, inArray, ne, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { platformExportBatch as batchTable, platformExportRow as rowTable } from '../../../../db/postgresql/platform-tables'
import type { RosterImportExportSnapshot, RosterImportItemResult, RosterImportPreflight } from '../../lib/roster-import-client'
import { exportSnapshotRowConflict, projectExportSnapshotRow, validateExportSnapshot } from './roster-import-model'

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]

export async function planPostgresExportSnapshot(tx: Tx, snapshot: RosterImportExportSnapshot) {
  let conflict = validateExportSnapshot(snapshot)
  let existing: number | null = null, replaces: number | null = null
  const rows = Array.isArray(snapshot?.rows) ? snapshot.rows : []
  if (!conflict) {
    const scope = and(eq(batchTable.titleCode, snapshot.titleCode), eq(batchTable.year, snapshot.year))
    // Drizzle's aggregate builders do not expose PostgreSQL FILTER.
    const [batches] = await tx.select({
      matching: sql`max(${batchTable.id}) filter (where ${eq(batchTable.sha256, snapshot.sha256)})`.mapWith(batchTable.id),
      previous: sql`max(${batchTable.id}) filter (where ${ne(batchTable.sha256, snapshot.sha256)})`.mapWith(batchTable.id),
    }).from(batchTable).where(scope)
    existing = batches?.matching ?? null
    replaces = batches?.previous ?? null
    if (existing !== null) {
      const [rowCount] = await tx.select({ n: count() }).from(rowTable).where(eq(rowTable.batchId, existing))
      if (rowCount!.n !== rows.length) conflict = { ok: false, kind: 'export_batch', ref: `export:${existing}`, error: {
        code: 'export_row_set_conflict', field: 'rows', message: 'Replay must retain the original file row set',
      } }
      for (let i = 0; !conflict && i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200)
        const archived = await tx.select().from(rowTable).where(and(eq(rowTable.batchId, existing),
          inArray(rowTable.sourceRowNo, chunk.map(row => row.sourceRowNo)))).orderBy(rowTable.id)
        conflict = exportSnapshotRowConflict(chunk, new Map(archived.map(row => [row.sourceRowNo, {
          ...row, rawFields: row.rawFields === null ? null : JSON.parse(row.rawFields),
        }])))
      }
    }
  }
  const preflight: RosterImportPreflight = { add: conflict || existing !== null ? 0 : 1, update: 0, remove: 0, review: 0,
    conflicts: conflict ? [conflict] : [], evidenceRepoints: 0, duplicateCandidates: [] }
  return { existing, replaces, rows, preflight, conflict }
}

export async function writePostgresExportSnapshot(tx: Tx, snapshot: RosterImportExportSnapshot, importId: number, plan: Awaited<ReturnType<typeof planPostgresExportSnapshot>>): Promise<RosterImportItemResult> {
  if (plan.conflict) return plan.conflict
  if (plan.existing !== null) return { ok: true, kind: 'export_batch', ref: `export:${plan.existing}`,
    detail: { rows: [], skipped: plan.rows.length, rowsWritten: 0 } }
  const [batch] = await tx.insert(batchTable).values({
    titleCode: snapshot.titleCode, year: snapshot.year, collectedOn: snapshot.collectedOn,
    originalFilename: snapshot.originalFilename, sha256: snapshot.sha256, rowCount: plan.rows.length,
    importStatus: 'imported', importBatchId: importId, replacedBatchId: plan.replaces, createdAt: new Date().toISOString(),
  }).returning({ id: batchTable.id })
  const ids: number[] = []
  type Row = ReturnType<typeof projectExportSnapshotRow>
  let chunk: Row[] = [], bytes = 0
  const flush = async () => {
    if (!chunk.length) return
    const rows = await tx.insert(rowTable).values(chunk).returning({ id: rowTable.id })
    ids.push(...rows.map(row => row.id))
    chunk = []; bytes = 0
  }
  for (const source of plan.rows) {
    const row = projectExportSnapshotRow(batch!.id, source)
    const size = Object.values(row).reduce<number>((total, value) => total + Buffer.byteLength(String(value ?? '')), 0)
    if (chunk.length === 200 || (chunk.length > 0 && bytes + size > 1048576)) await flush()
    chunk.push(row); bytes += size
  }
  await flush()
  return { ok: true, kind: 'export_batch', ref: `export:${batch!.id}`, detail: { rows: ids.sort((a,b) => a-b), skipped: 0, rowsWritten: 1 + ids.length } }
}
