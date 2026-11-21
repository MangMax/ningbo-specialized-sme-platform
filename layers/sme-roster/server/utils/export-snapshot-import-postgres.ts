import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from '../../../../db/schema'
import type { RosterImportExportSnapshot, RosterImportItemResult, RosterImportPreflight } from '../../lib/roster-import-client'
import { readPostgresRosterRowsById } from '../../lib/roster/postgres-rows'
import { exportSnapshotRowConflict, projectExportSnapshotRow, validateExportSnapshot } from './roster-import'
import { appendPostgresEvidenceRevision } from './evidence-revision-postgres'
import { evidenceDigest113, type Snapshot113 } from './evidence-impact-113'

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
type Reader = Pick<NodePgDatabase, 'execute'>

async function currentSnapshot(tx: Tx, titleCode: string) {
  const { rows: [row] } = await tx.execute<Snapshot113>(sql`
    SELECT b.id::float8 AS id,b.year::float8 AS year,b.collected_on AS "collectedOn",
      coalesce((SELECT max(id) FROM platform_export_row WHERE batch_id=b.id),0)::float8 AS "maxRowId"
    FROM platform_export_batch b WHERE b.title_code=${titleCode} ORDER BY b.year DESC,b.id DESC LIMIT 1`)
  return row ?? null
}

export async function postgresSnapshotDigest(tx: Reader, ref: Snapshot113 | null, enterpriseId?: number) {
  if (!ref) return evidenceDigest113([])
  const owned = enterpriseId === undefined ? sql`true` : sql`(
    upper(trim(r.uscc_raw))=(SELECT uscc_norm FROM enterprise WHERE id=${enterpriseId})
    OR ((r.uscc_raw IS NULL OR trim(r.uscc_raw)='')
      AND r.name_raw IN (SELECT name FROM enterprise WHERE id=${enterpriseId}
        UNION SELECT name FROM enterprise_alias WHERE enterprise_id=${enterpriseId} AND verification_status='confirmed')
      AND NOT EXISTS (SELECT 1 FROM enterprise e WHERE e.id<>${enterpriseId} AND e.name=r.name_raw)
      AND NOT EXISTS (SELECT 1 FROM enterprise_alias a WHERE a.enterprise_id<>${enterpriseId}
        AND a.name=r.name_raw AND a.verification_status='confirmed'))
  )`
  let cursor = 0
  const hashes = new Set<string>()
  for (;;) {
    const { rows } = await tx.execute<{ id: number; values: (string | null)[] }>(sql`
      SELECT id::float8 AS id,json_build_array(uscc_raw,name_raw,district,province,city,reg_status) AS values
      FROM platform_export_row r WHERE batch_id=${ref.id} AND id>${cursor} AND id<=${ref.maxRowId} AND ${owned} ORDER BY id LIMIT 200`)
    for (const row of rows) hashes.add(evidenceDigest113(row.values))
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
  await tx.execute(sql`
    INSERT INTO evidence_revision_event_113(revision_id,event_id,enterprise_id,title_code)
    SELECT ${revision},e.id,r.enterprise_id,r.title_code FROM platform_export_row x
    JOIN record_correspondence c ON c.export_row_id=x.id AND c.status='confirmed'
    JOIN record_event e ON e.id=c.event_id OR e.id=c.predecessor_event_id JOIN record r ON r.id=e.record_id
    WHERE ((x.batch_id=${before?.id ?? null} AND x.id<=${before?.maxRowId ?? 0}) OR (x.batch_id=${after.id} AND x.id<=${after.maxRowId}))
      AND r.title_code=${titleCode} ON CONFLICT DO NOTHING`)
}

export async function planPostgresExportSnapshot(tx: Tx, snapshot: RosterImportExportSnapshot) {
  let conflict = validateExportSnapshot(snapshot)
  let existing: number | null = null, replaces: number | null = null
  const rows = Array.isArray(snapshot?.rows) ? snapshot.rows : []
  if (!conflict) {
    const { rows: [scope] } = await tx.execute<{ current: number | null; previous: number | null }>(sql`
      SELECT max(id) FILTER (WHERE sha256=${snapshot.sha256})::float8 AS current,
        max(id) FILTER (WHERE sha256<>${snapshot.sha256})::float8 AS previous
      FROM platform_export_batch WHERE title_code=${snapshot.titleCode} AND year=${snapshot.year}`)
    existing = scope!.current
    replaces = scope!.previous
    if (existing !== null) {
      const { rows: [count] } = await tx.execute<{ n: number }>(sql`SELECT count(*)::float8 AS n FROM platform_export_row WHERE batch_id=${existing}`)
      if (count!.n !== rows.length) conflict = { ok: false, kind: 'export_batch', ref: `export:${existing}`, error: {
        code: 'export_row_set_conflict', field: 'rows', message: 'Replay must retain the original file row set',
      } }
      for (let i = 0; !conflict && i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200)
        const archived = await readPostgresRosterRowsById(tx, schema.platformExportRow, sql`
          FROM platform_export_row p WHERE p.batch_id=${existing} AND p.source_row_no=ANY(${sql.param(chunk.map(row => row.sourceRowNo))}::bigint[])`)
        conflict = exportSnapshotRowConflict(chunk, new Map(archived.map(row => [row.sourceRowNo, row])))
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
  const { rows: [batch] } = await tx.execute<{ id: number }>(sql`
    INSERT INTO platform_export_batch(title_code,year,collected_on,original_filename,sha256,row_count,import_status,import_batch_id,replaced_batch_id,created_at)
    VALUES (${snapshot.titleCode},${snapshot.year},${snapshot.collectedOn},${snapshot.originalFilename},${snapshot.sha256},
      ${plan.rows.length},'imported',${importId},${plan.replaces},${new Date().toISOString()}) RETURNING id::float8 AS id`)
  const ids: number[] = []
  type Row = ReturnType<typeof projectExportSnapshotRow>
  let chunk: Row[] = [], bytes = 0
  const flush = async () => {
    if (!chunk.length) return
    const { rows } = await tx.execute<{ id: number }>(sql`
      INSERT INTO platform_export_row(batch_id,source_row_no,uscc_raw,name_raw,district,province,city,reg_status,raw_fields,created_at)
      VALUES ${sql.join(chunk.map(row => sql`(${row.batchId},${row.sourceRowNo},${row.usccRaw},${row.nameRaw},${row.district},
        ${row.province},${row.city},${row.regStatus},${row.rawFields},${row.createdAt})`),sql`, `)} RETURNING id::float8 AS id`)
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
