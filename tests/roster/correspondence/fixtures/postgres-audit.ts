import { eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { recordCorrespondenceAudit } from '../../../../db/postgresql/qualification-tables'

export function readFixtureAudit(db: NodePgDatabase, id: number) {
  return db.select().from(recordCorrespondenceAudit).where(eq(recordCorrespondenceAudit.correspondenceId, id)).orderBy(recordCorrespondenceAudit.id)
}
