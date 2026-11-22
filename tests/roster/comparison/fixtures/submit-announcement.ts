import { createRosterImportClient, type RosterImportRequest, type SupplementAnnouncementRequest } from '../../../../layers/sme-roster/lib/roster-import-client'

/** The receiving scenario supplies already-reviewed decisions for its new rows. */
export async function submitNewFixtureAnnouncement(baseUrl: string, token: string, request: RosterImportRequest) {
  const client = createRosterImportClient({ baseUrl, token })
  const staged = await client.commit(request)
  if (staged.status !== 'staged') return staged
  const review: SupplementAnnouncementRequest = {
    sourceDigest: staged.sourceDigest,
    basis: 'Synthetic fixture uses new identities',
    rows: request.payload.announcement!.records.map(({ enterprise }) => ({
      action: 'create',
      fields: { name: enterprise.name, ...(enterprise.uscc === undefined ? {} : { uscc: enterprise.uscc }) },
    })),
  }
  if (!staged.officialEvidencePreflightRequired) return client.supplement(staged.intakeId, review)
  const preview = await client.preflightSupplement(staged.intakeId, review)
  return client.supplement(staged.intakeId, { ...review, officialEvidencePlanHash: preview.officialEvidencePlanHash })
}
