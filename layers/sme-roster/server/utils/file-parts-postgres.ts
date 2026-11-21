import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from '../../../../db/schema'
import { normalizeAttachment } from '../../lib/attachment'
import { aggregateParts, partKey, type PartEvidence } from '../../lib/file-parts'
import { readPostgresRosterRowsById } from '../../lib/roster/postgres-rows'

type Db = Pick<NodePgDatabase,'execute'>
const pathsSql = (paths: string[]) => sql`${sql.param(paths)}::text[]`

export async function lockPostgresFilePaths(tx: Db, paths: Iterable<string>) {
  const names = [...new Set(paths)]
  if (names.length) await tx.execute(sql`SELECT id FROM stored_file WHERE rel_path=ANY(${pathsSql(names)}) ORDER BY id FOR UPDATE`)
}

export async function refreshPostgresDerivedFileParts(tx: Db, paths: Iterable<string>) {
  const names = [...new Set(paths)]
  if (!names.length) return
  const files = await readPostgresRosterRowsById(tx, schema.storedFile, sql`FROM stored_file p WHERE rel_path=ANY(${pathsSql(names)})`)
  const { rows } = await tx.execute<{ [K in keyof PartEvidence]: PartEvidence[K] } & { relPath: string }>(sql`
    SELECT v.source_file AS "relPath",r.title_code AS "titleCode",e.event_type AS "eventKind",e.year::float8 AS year,
      e.batch_seq::float8 AS batch,v.attachment
    FROM record_evidence v JOIN record_event e ON e.id=v.record_event_id JOIN record r ON r.id=e.record_id
    WHERE v.source_file=ANY(${pathsSql(names)})`)
  const byPath = Map.groupBy(rows, row => row.relPath)
  for (const file of files) {
    const parts = aggregateParts((byPath.get(file.relPath) ?? []).map(row => ({ ...row, attachment: normalizeAttachment(row.attachment) })))
    const declared = await readPostgresRosterRowsById(tx, schema.storedFilePart, sql`
      FROM stored_file_part p WHERE file_id=${file.id} AND origin IN ('agent','legacy')`)
    const derivedByKey = new Map(parts.map(part => [partKey(part), part]))
    const declaredKeys = new Set(declared.map(partKey))
    for (const row of declared) {
      const matching = derivedByKey.get(partKey(row))
      await tx.execute(sql`UPDATE stored_file_part SET has_conflict=${Number(!!matching && matching.rowCount !== row.rowCount)} WHERE id=${row.id}`)
    }
    await tx.execute(sql`DELETE FROM stored_file_part WHERE file_id=${file.id} AND origin='derived'`)
    for (const part of parts) {
      if (declaredKeys.has(partKey(part))) continue
      await tx.execute(sql`INSERT INTO stored_file_part(file_id,title_code,event_kind,year,batch,attachment,row_count,origin,has_conflict)
        VALUES(${file.id},${part.titleCode},${part.eventKind},${part.year},${part.batch},${part.attachment},${part.rowCount},'derived',0)`)
    }
  }
}
