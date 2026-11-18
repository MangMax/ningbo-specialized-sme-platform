import type { RosterImportRequest } from '../../../../layers/sme-roster/lib/roster-import-client'
import { readAnnouncementIntake, supplementAnnouncement } from '../../../../layers/sme-roster/server/utils/announcement-intake'
import { reviewFixtureRows } from './reviewed-announcement'

/** Complete fixture setup through the native command when the H3 harness has no worker. */
export async function completeInProcessIntake(
  db: Parameters<typeof supplementAnnouncement>[0],
  response: unknown,
  request: RosterImportRequest,
  filesDir?: string,
): Promise<unknown> {
  if (!response || typeof response !== 'object' || !('status' in response) || response.status !== 'staged') return response
  if (!('intakeId' in response) || typeof response.intakeId !== 'number') throw new Error('Fixture intake ID missing')
  const state = readAnnouncementIntake(db, response.intakeId)
  const review = state.review ?? reviewFixtureRows(db, state.sourceDigest, request)
  const receipt = await supplementAnnouncement(db, response.intakeId, review, filesDir)
  if (receipt.status === 'failed') return receipt
  const { intakeId, owners, sourceIds, ...batch } = receipt
  return { ...batch, status: 'committed' }
}
