import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { checkAnnouncementRemoval, projectAnnouncementIntake, type IntakeRow } from './announcement-intake'
import { ImportReceiptError } from './import-receipts'

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
