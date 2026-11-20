import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { RosterImportRequest, RosterImportItemResult } from '../../lib/roster-import-client'
import { announcementIntakeDigest, checkAnnouncementRemoval, projectAnnouncementIntake, stagedAnnouncement, validateAnnouncementIntakeRows, type IntakeRow } from './announcement-intake'
import { ImportReceiptError } from './import-receipts'
import { committedPostgresImportResult, lockPostgresRosterImportBatch, lockPostgresRosterImportKey } from './roster-export-import-postgres'
import { usePostgresRosterDb } from './postgres-roster-db'

async function readIntake(db: Pick<NodePgDatabase, 'execute'>, id: number, lock = false) {
  const { rows: [row] } = await db.execute<IntakeRow>(sql`
    SELECT id::float8 AS id,digest,request,removed_reason,supplement_digest,reviewed_request,receipt
    FROM roster_announcement_intake WHERE id=${id} ${lock ? sql`FOR UPDATE` : sql.empty()}`)
  if (!row) throw new ImportReceiptError(404, 'intake_not_found', 'Announcement intake not found')
  return row
}

export async function readPostgresAnnouncementIntake(db: NodePgDatabase, id: number) {
  return projectAnnouncementIntake(await readIntake(db, id))
}

export function removePostgresAnnouncementIntake(db: NodePgDatabase, id: number, sourceDigest: string, reason: string) {
  return db.transaction(async tx => {
    const row = await readIntake(tx, id, true)
    const removed = checkAnnouncementRemoval(row, sourceDigest, reason)
    if (row.removed_reason === null) await tx.execute(sql`UPDATE roster_announcement_intake SET removed_reason=${reason} WHERE id=${id}`)
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
    const { rows: [previous] } = await tx.execute<{ id: number; digest: string }>(sql`
      SELECT id::float8 AS id,digest FROM roster_announcement_intake WHERE idempotency_key=${request.idempotencyKey}`)
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
      const { rows: [receipt] } = await tx.execute<{ status: string; hash: string }>(sql`
        SELECT status,request_hash AS hash FROM import_receipt WHERE batch_id=${batch.id} ORDER BY id DESC LIMIT 1`)
      if (receipt && ['committed', 'processing'].includes(receipt.status) &&
          receipt.hash !== announcementIntakeDigest({ ...request, sourceSha256 })) {
        throw new ImportReceiptError(409, 'idempotency_conflict', 'Idempotency key belongs to a different request')
      }
      return committedPostgresImportResult(batch, 'commit')
    }
    const { rows: [created] } = await tx.execute<{ id: number }>(sql`
      INSERT INTO roster_announcement_intake(idempotency_key,digest,request)
      VALUES (${request.idempotencyKey},${digest},${JSON.stringify(request)}) RETURNING id::float8 AS id`)
    return stagedAnnouncement(request, created!.id, digest)
  })
}
