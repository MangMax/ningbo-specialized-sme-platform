import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { RosterImportRequest } from '../../../../layers/sme-roster/lib/roster-import-client'
import { readPostgresAnnouncementIntake } from '../../../../layers/sme-roster/server/utils/announcement-intake-postgres'
import { supplementPostgresAnnouncement } from '../../../../layers/sme-roster/server/utils/announcement-supplement-postgres'
import { reviewPostgresFixtureRows } from './reviewed-announcement-postgres'

/** Complete the staged response through the same review command as the public route. */
export async function completeInProcessPostgresIntake(
  db: NodePgDatabase,
  response: unknown,
  request: RosterImportRequest,
  filesDir?: string,
): Promise<unknown> {
  if (!response || typeof response !== 'object' || !('status' in response) || response.status !== 'staged') return response
  if (!('intakeId' in response) || typeof response.intakeId !== 'number') throw new Error('Fixture intake ID missing')
  const id = response.intakeId
  const state = await readPostgresAnnouncementIntake(db, id)
  const review = state.review ?? await reviewPostgresFixtureRows(db, state.sourceDigest, request)
  const preview = state.status === 'staged' && state.officialEvidencePreflightRequired
    ? await supplementPostgresAnnouncement(db, id, { ...review, preflight: true }, filesDir)
    : undefined
  if (preview && preview.status !== 'preflighted') throw new Error('Expected announcement preflight')
  const receipt = await supplementPostgresAnnouncement(db, id, {
    ...review,
    ...(preview?.officialEvidencePlanHash ? { officialEvidencePlanHash: preview.officialEvidencePlanHash } : {}),
  }, filesDir)
  if (receipt.status !== 'supplemented') return receipt
  const { intakeId, owners, sourceIds, ...batch } = receipt
  return { ...batch, status: 'committed' }
}
