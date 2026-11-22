import { eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { expect } from 'vitest'
import { differenceReason } from '../../../db/postgresql/roster-selection-tables'

type RetainedValidity = NonNullable<typeof differenceReason.$inferInsert.retiredEvidenceValidity>

export async function seedRetiredEvidenceState(db: NodePgDatabase, decisionId: number, validity: RetainedValidity = 'valid') {
  // Model a decision already evaluated before evidence tracking was retired.
  const decisions = await db.update(differenceReason)
    .set({ retiredEvidenceValidity: validity, retiredEvidenceReviewed: true })
    .where(eq(differenceReason.id, decisionId))
    .returning({ id: differenceReason.id })
  expect(decisions).toEqual([{ id: decisionId }])
}
