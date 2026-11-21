import { and, eq, inArray, sql, type SQL } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { storedFile } from '../../../../db/postgresql/file-tables'
import { importBatch } from '../../../../db/postgresql/import-tables'
import { recordEvent, recordEvidence } from '../../../../db/postgresql/ledger-tables'
import type { recordEvent as sqliteRecordEvent } from '../../../../db/schema'
import { isPageCapable } from '../../lib/roster/evidence-page'

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]

export function announcementValues<T extends string | number>(column: AnyPgColumn<{ data: T }>, values: readonly T[]) {
  // inArray binds each value separately. Keep a single snapshot for large batches that can exceed PostgreSQL's 65,535 bind limit.
  if (values.length <= 30_000) return inArray(column, values)
  const parameter = sql.param(values)
  return typeof values[0] === 'number' ? sql`${column} = ANY(${parameter}::bigint[])` : sql`${column} = ANY(${parameter}::text[])`
}

export function readPostgresAnnouncementEvidenceHashes(tx: Tx, paths: Iterable<string>) {
  const pathsToRead = [...new Set(paths)]
  return tx.select({ path: importBatch.sourceIdentity, sha256: importBatch.sourceSha256 }).from(importBatch).where(and(
    eq(importBatch.status, 'committed'), eq(importBatch.sourceKind, 'announcement'), announcementValues(importBatch.sourceIdentity, pathsToRead),
  )).unionAll(tx.select({ path: storedFile.relPath, sha256: storedFile.sha256 }).from(storedFile)
    .where(announcementValues(storedFile.relPath, pathsToRead)))
}

export async function readPostgresAnnouncementEvents(tx: Tx, condition: SQL, lock = false): Promise<typeof sqliteRecordEvent.$inferSelect[]> {
  const query = tx.select().from(recordEvent).where(condition).orderBy(recordEvent.id)
  return (await (lock ? query.for('update') : query)).map(({ formalValidity, ...event }) => ({
    ...event, formalValidity: formalValidity === null ? null : JSON.parse(formalValidity),
  }))
}

export async function repointPostgresAnnouncementEvidence(tx: Tx, target: {
  id: number; recordEventId: number; fromSourceFile: string; sourceFile: string
}, replayRecordId?: number) {
  const keepPage = isPageCapable(target.sourceFile)
  const previous = tx.$with('previous').as(tx.select({
    id: recordEvidence.id, page: recordEvidence.page, revision: recordEvent.revision,
  }).from(recordEvidence).innerJoin(recordEvent, eq(recordEvent.id, recordEvidence.recordEventId)).where(and(
    eq(recordEvidence.id, target.id), eq(recordEvidence.recordEventId, target.recordEventId),
    eq(recordEvidence.sourceFile, target.fromSourceFile), replayRecordId === undefined ? undefined : eq(recordEvent.recordId, replayRecordId),
  )))
  const [changed] = await tx.with(previous).update(recordEvidence)
    .set({ sourceFile: target.sourceFile, page: keepPage ? recordEvidence.page : null }).from(previous).where(and(
      eq(recordEvidence.id, previous.id), replayRecordId === undefined ? undefined : eq(recordEvidence.sourceFile, target.fromSourceFile),
    )).returning({ page: previous.page, revision: previous.revision })
  return changed && { lostPage: !keepPage && changed.page !== null, revision: changed.revision }
}
