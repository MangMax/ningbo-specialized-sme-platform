import { desc, eq } from 'drizzle-orm'
import { importReceipt } from '../../../../db/postgresql/import-tables'
import { rosterAnnouncementIntake as intake } from '../../../../db/postgresql/roster-selection-tables'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { RosterImportRequest, RosterImportItemResult } from '../../lib/roster-import-client'
import { announcementIntakeDigest, checkAnnouncementRemoval, projectAnnouncementIntake, stagedAnnouncement, validateAnnouncementIntakeRows, type IntakeRow } from './announcement-intake'
import { ImportReceiptError } from './import-receipts'
import { committedPostgresImportResult, lockPostgresRosterImportBatch, lockPostgresRosterImportKey } from './roster-export-import-postgres'
import { usePostgresRosterDb } from './postgres-roster-db'

export async function readPostgresIntakeRow(db: Pick<NodePgDatabase, 'select'>, id: number, lock = false): Promise<IntakeRow> {
  const query = db.select({
    id: intake.id, digest: intake.digest, request: intake.request, removed_reason: intake.removedReason,
    supplement_digest: intake.supplementDigest, reviewed_request: intake.reviewedRequest, receipt: intake.receipt,
  }).from(intake).where(eq(intake.id, id))
  const [row] = await (lock ? query.for('update') : query)
  if (!row) throw new ImportReceiptError(404, 'intake_not_found', 'Announcement intake not found')
  return row
}

export async function readPostgresAnnouncementIntake(db: NodePgDatabase, id: number) {
  return projectAnnouncementIntake(await readPostgresIntakeRow(db, id))
}

export function removePostgresAnnouncementIntake(db: NodePgDatabase, id: number, sourceDigest: string, reason: string) {
  return db.transaction(async tx => {
    const row = await readPostgresIntakeRow(tx, id, true)
    const removed = checkAnnouncementRemoval(row, sourceDigest, reason)
    if (row.removed_reason === null) await tx.update(intake).set({ removedReason: reason }).where(eq(intake.id, id))
    return removed
  })
}

export async function stagePostgresAnnouncement(request: RosterImportRequest, pageErrors: readonly RosterImportItemResult[]) {
  const db = usePostgresRosterDb(true)
  if (!db) return undefined
  const invalid = validateAnnouncementIntakeRows(request, pageErrors)
  if (invalid) return invalid
  const digest = announcementIntakeDigest(request)
  return db.transaction(async tx => {
    await lockPostgresRosterImportKey(tx, request.idempotencyKey)
    const [previous] = await tx.select({ id: intake.id, digest: intake.digest }).from(intake)
      .where(eq(intake.idempotencyKey, request.idempotencyKey))
    if (previous && previous.digest !== digest) {
      throw new ImportReceiptError(409, 'idempotency_conflict', 'The key already identifies different source rows')
    }
    const batch = await lockPostgresRosterImportBatch(tx, request.idempotencyKey)
    const sourceSha256 = request.sourceSha256 ?? null
    if (batch && (batch.kind !== request.sourceKind || batch.identity !== request.sourceIdentity || batch.sha256 !== sourceSha256)) {
      throw new ImportReceiptError(409, 'idempotency_conflict', 'Idempotency key belongs to a different source')
    }
    if (previous) return stagedAnnouncement(request, previous.id, digest)
    if (batch?.status === 'committed') {
      const [receipt] = await tx.select({ status: importReceipt.status, hash: importReceipt.requestHash })
        .from(importReceipt).where(eq(importReceipt.batchId, batch.id)).orderBy(desc(importReceipt.id)).limit(1)
      if (receipt && ['committed', 'processing'].includes(receipt.status) &&
          receipt.hash !== announcementIntakeDigest({ ...request, sourceSha256 })) {
        throw new ImportReceiptError(409, 'idempotency_conflict', 'Idempotency key belongs to a different request')
      }
      return committedPostgresImportResult(batch, 'commit')
    }
    const [created] = await tx.insert(intake).values({ idempotencyKey: request.idempotencyKey, digest, request: JSON.stringify(request) })
      .returning({ id: intake.id })
    return stagedAnnouncement(request, created!.id, digest)
  })
}
