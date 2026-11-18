/** Transport must provide authenticated HTTP get(path) and post(path, body). */
export async function stageAnnouncement(transport, request) {
  const staged = await transport.post('/api/roster/import/commit', request)
  if (staged.status !== 'staged') return staged
  const intake = await transport.get(`/api/roster/import/intake/${staged.intakeId}`)
  if (intake.sourceDigest !== staged.sourceDigest) throw new Error('Announcement intake digest changed')
  return intake
}

export async function supplementReviewedAnnouncement(transport, intakeId, review) {
  const path = `/api/roster/import/intake/${intakeId}`
  const intake = await transport.get(path)
  if (intake.sourceDigest !== review.sourceDigest) throw new Error('Review belongs to a different source version')
  if (review.rows.length !== intake.announcement.records.length) throw new Error('Review must account for each original row')
  if (intake.status === 'staged' && intake.officialEvidencePreflightRequired) {
    const preview = await transport.post(path + '/supplement', { ...review, preflight: true })
    if (preview.status !== 'preflighted' || preview.conflicts.length || !preview.officialEvidencePlanHash) {
      throw new Error('Reviewed announcement failed preflight: ' + JSON.stringify(preview.conflicts))
    }
    return transport.post(path + '/supplement', { ...review, officialEvidencePlanHash: preview.officialEvidencePlanHash })
  }
  return transport.post(path + '/supplement', review)
}
