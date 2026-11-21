import { and, count, desc, eq, gt, inArray, isNull, lte, max, ne, notExists, or, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { platformExportBatch as batchTable, platformExportRow as rowTable } from '../../../../db/postgresql/platform-tables'
import { enterprise, enterpriseAlias } from '../../../../db/postgresql/enterprise-tables'
import { evidenceRevisionEvent113 } from '../../../../db/postgresql/evidence-review-tables'
import { record, recordEvent } from '../../../../db/postgresql/ledger-tables'
import { recordCorrespondence } from '../../../../db/postgresql/qualification-tables'
import type { RosterImportExportSnapshot, RosterImportItemResult, RosterImportPreflight } from '../../lib/roster-import-client'
import { exportSnapshotRowConflict, projectExportSnapshotRow, validateExportSnapshot } from './roster-import'
import { appendPostgresEvidenceRevision } from './evidence-revision-postgres'
import { evidenceDigest113, type Snapshot113 } from './evidence-impact-113'

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
type Reader = Pick<NodePgDatabase, 'select'>

async function currentSnapshot(tx: Tx, titleCode: string) {
  const last = tx.select({ id: max(rowTable.id) }).from(rowTable).where(eq(rowTable.batchId, batchTable.id))
  const [row] = await tx.select({
    id: batchTable.id, year: batchTable.year, collectedOn: batchTable.collectedOn,
    // A correlated scalar subquery requires a Drizzle SQL expression in the select list.
    maxRowId: sql`(${last})`.mapWith(rowTable.id),
  }).from(batchTable).where(eq(batchTable.titleCode, titleCode)).orderBy(desc(batchTable.year), desc(batchTable.id)).limit(1)
  return row ? { ...row, maxRowId: row.maxRowId ?? 0 } : null
}

export async function postgresSnapshotDigest(tx: Reader, ref: Snapshot113 | null, enterpriseId?: number) {
  if (!ref) return evidenceDigest113([])
  // Drizzle does not expose PostgreSQL's trim/upper normalization for a column expression.
  const trimmed = sql<string>`trim(${rowTable.usccRaw})`
  const owned = enterpriseId === undefined ? undefined : or(
    eq(sql<string>`upper(${trimmed})`, tx.select({ value: enterprise.usccNorm }).from(enterprise).where(eq(enterprise.id, enterpriseId))),
    and(
      or(isNull(rowTable.usccRaw), eq(trimmed, '')),
      inArray(rowTable.nameRaw, tx.select({ name: enterprise.name }).from(enterprise).where(eq(enterprise.id, enterpriseId))
        .union(tx.select({ name: enterpriseAlias.name }).from(enterpriseAlias)
          .where(and(eq(enterpriseAlias.enterpriseId, enterpriseId), eq(enterpriseAlias.verificationStatus, 'confirmed'))))),
      notExists(tx.select({ id: enterprise.id }).from(enterprise)
        .where(and(ne(enterprise.id, enterpriseId), eq(enterprise.name, rowTable.nameRaw)))),
      notExists(tx.select({ id: enterpriseAlias.id }).from(enterpriseAlias)
        .where(and(ne(enterpriseAlias.enterpriseId, enterpriseId), eq(enterpriseAlias.name, rowTable.nameRaw),
          eq(enterpriseAlias.verificationStatus, 'confirmed')))),
    ),
  )
  let cursor = 0
  const hashes = new Set<string>()
  for (;;) {
    const rows = await tx.select({
      id: rowTable.id, uscc: rowTable.usccRaw, name: rowTable.nameRaw, district: rowTable.district,
      province: rowTable.province, city: rowTable.city, status: rowTable.regStatus,
    }).from(rowTable).where(and(eq(rowTable.batchId, ref.id), gt(rowTable.id, cursor), lte(rowTable.id, ref.maxRowId), owned))
      .orderBy(rowTable.id).limit(200)
    for (const row of rows) hashes.add(evidenceDigest113([row.uscc, row.name, row.district, row.province, row.city, row.status]))
    if (rows.length < 200) break
    cursor = rows.at(-1)!.id
  }
  return evidenceDigest113({ year: ref.year, collectedOn: ref.collectedOn, rows: [...hashes].sort() })
}

async function captureSelection(tx: Tx, titleCode: string, before: Snapshot113 | null) {
  const after = await currentSnapshot(tx, titleCode)
  if (!after || (before?.id === after.id && before.maxRowId === after.maxRowId)) return
  const revision = await appendPostgresEvidenceRevision(tx, { sourceKind: 'selected_snapshot', sourceKey: titleCode,
    sourceVersion: `${after.id}:${after.maxRowId}`, titleCode, beforeFactDigest: await postgresSnapshotDigest(tx, before),
    factDigest: await postgresSnapshotDigest(tx, after), metadata: { before, after } })
  if (revision === null) return
  await tx.insert(evidenceRevisionEvent113).select(tx.select({
    revisionId: sql<number>`${revision}::bigint`.as('revision_id'), eventId: recordEvent.id,
    enterpriseId: record.enterpriseId, titleCode: record.titleCode,
  }).from(rowTable).innerJoin(recordCorrespondence, and(eq(recordCorrespondence.exportRowId, rowTable.id),
    eq(recordCorrespondence.status, 'confirmed')))
    .innerJoin(recordEvent, or(eq(recordEvent.id, recordCorrespondence.eventId), eq(recordEvent.id, recordCorrespondence.predecessorEventId)))
    .innerJoin(record, eq(record.id, recordEvent.recordId))
    .where(and(eq(record.titleCode, titleCode), or(
      before ? and(eq(rowTable.batchId, before.id), lte(rowTable.id, before.maxRowId)) : undefined,
      and(eq(rowTable.batchId, after.id), lte(rowTable.id, after.maxRowId)),
    )))).onConflictDoNothing()
}

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
  const before = await currentSnapshot(tx, snapshot.titleCode)
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
  await captureSelection(tx, snapshot.titleCode, before)
  return { ok: true, kind: 'export_batch', ref: `export:${batch!.id}`, detail: { rows: ids.sort((a,b) => a-b), skipped: 0, rowsWritten: 1 + ids.length } }
}
