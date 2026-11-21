import { and, eq, inArray, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { storedFile } from '../../../../db/postgresql/file-tables'
import { record, recordEvent, recordEvidence } from '../../../../db/postgresql/ledger-tables'
import { storedFilePart } from '../../../../db/postgresql/roster-file-tables'
import { normalizeAttachment } from '../../lib/attachment'
import { aggregateParts, partKey } from '../../lib/file-parts'

type Db = Pick<NodePgDatabase, 'select' | 'update' | 'delete' | 'insert'>
const pathsSql = (paths: string[]) => sql`${sql.param(paths)}::text[]`

export async function lockPostgresFilePaths(tx: Pick<Db, 'select'>, paths: Iterable<string>) {
  const names = [...new Set(paths)]
  if (names.length) {
    await tx.select({ id: storedFile.id }).from(storedFile)
      .where(sql`${storedFile.relPath} = ANY(${pathsSql(names)})`).orderBy(storedFile.id).for('update')
  }
}

export async function refreshPostgresDerivedFileParts(tx: Db, paths: Iterable<string>) {
  const names = [...new Set(paths)]
  if (!names.length) return
  const files = await tx.select({ id: storedFile.id, relPath: storedFile.relPath }).from(storedFile)
    .where(sql`${storedFile.relPath} = ANY(${pathsSql(names)})`)
  const rows = await tx.select({
    relPath: recordEvidence.sourceFile, titleCode: record.titleCode, eventKind: recordEvent.eventType,
    year: recordEvent.year, batch: recordEvent.batchSeq, attachment: recordEvidence.attachment,
  }).from(recordEvidence).innerJoin(recordEvent, eq(recordEvent.id, recordEvidence.recordEventId))
    .innerJoin(record, eq(record.id, recordEvent.recordId))
    .where(sql`${recordEvidence.sourceFile} = ANY(${pathsSql(names)})`)
  const byPath = Map.groupBy(rows, row => row.relPath)
  for (const file of files) {
    const parts = aggregateParts((byPath.get(file.relPath) ?? []).map(row => ({ ...row, attachment: normalizeAttachment(row.attachment) })))
    const fileParts = eq(storedFilePart.fileId, file.id)
    const declared = await tx.select().from(storedFilePart)
      .where(and(fileParts, inArray(storedFilePart.origin, ['agent', 'legacy']))).orderBy(storedFilePart.id)
    const derivedByKey = new Map(parts.map(part => [partKey(part), part]))
    const declaredKeys = new Set(declared.map(partKey))
    for (const row of declared) {
      const matching = derivedByKey.get(partKey(row))
      await tx.update(storedFilePart).set({ hasConflict: Number(!!matching && matching.rowCount !== row.rowCount) })
        .where(eq(storedFilePart.id, row.id))
    }
    await tx.delete(storedFilePart).where(and(fileParts, eq(storedFilePart.origin, 'derived')))
    for (const part of parts) {
      if (declaredKeys.has(partKey(part))) continue
      await tx.insert(storedFilePart).values({ ...part, fileId: file.id, origin: 'derived', hasConflict: 0 })
    }
  }
}
