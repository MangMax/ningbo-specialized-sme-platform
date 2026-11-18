/** Transport must provide authenticated HTTP get(path) and post(path, body). */
export async function stageAnnouncement(transport, request) {
  const preview = await transport.post('/api/roster/import/preflight', request)
  if (preview.preflight?.conflicts?.length !== 0) {
    throw new Error('Resolve announcement preflight conflicts before submission')
  }
  const planHash = preview.preflight.officialEvidencePlanHash
  const submission = planHash ? { ...request, payload: { ...request.payload, officialEvidencePlanHash: planHash } } : request
  const staged = await transport.post('/api/roster/import/commit', submission)
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
  return transport.post(path + '/supplement', review)
}
