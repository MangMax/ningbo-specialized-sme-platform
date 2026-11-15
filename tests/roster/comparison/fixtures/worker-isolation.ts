import { expect } from 'vitest'

export const m3Raw = 'M3原始关系\\"\n'.repeat(12000)
export const m3Uscc = '91330211255994457P'
export async function seedWorkerComparisonFixture(base: string, token: string) {
  let sequence = 0
  const commit = async (payload: unknown) => {
    const response = await fetch(base + '/api/roster/import/commit', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({
      idempotencyKey: `m3-${++sequence}`, sourceKind: 'announcement', sourceIdentity: `synthetic/m3-${sequence}`, payload,
    }) })
    expect(response.status).toBe(200)
    const receipt = await response.json()
    expect(receipt, JSON.stringify(receipt)).toMatchObject({ status: 'committed' })
    return receipt
  }
  await commit({ announcement: { sourceDocument: { source: 'jxj', title: 'M3合成公布' }, records: [
    { enterprise: { name: 'M3Alpha企业', uscc: m3Uscc, district: '镇海区' }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year: 2021 }] },
    { enterprise: { name: 'M3Beta企业', district: '余姚市' }, titleCode: 'specialized_sme', events: [] },
    { enterprise: { name: 'M3Gamma企业' }, titleCode: 'innovative_sme', events: [] },
  ] }, aliases: [
    { uscc: m3Uscc, name: 'M3Alpha旧名', sourceKind: 'manual', verificationStatus: 'confirmed' },
    { uscc: m3Uscc, name: 'M3待核旧名', sourceKind: 'manual', verificationStatus: 'pending' },
  ], platformQueries: [
    { interface: 'business_list', queryKey: m3Uscc, rdjb: '2', queriedAt: '2026-10-20T00:00:00Z', status: 'success', rawResponse: 'M3原档', relations: [
      { sequenceNo: 1, nameRaw: 'M3Alpha企业', usccRaw: m3Uscc, matchBasis: 'uscc', verificationStatus: 'confirmed', rawFields: { large: m3Raw } },
      { sequenceNo: 2, nameRaw: 'M3未分配候选', matchBasis: 'none', verificationStatus: 'pending', rawFields: { original: 'M3未分配原文' } },
      { sequenceNo: 3, nameRaw: 'M3Alpha企业', usccRaw: m3Uscc, matchBasis: 'uscc', verificationStatus: 'pending', rawFields: { original: 'M3关联候选原文' } },
    ] },
    { interface: 'apply_list', queryKey: 'name:M3Gamma企业', queriedAt: '2026-10-20T00:00:00Z', status: 'failed', failureReason: 'M3合成失败', rawResponse: 'M3失败原档' },
    { interface: 'business_list', queryKey: 'name:M3Gamma企业', rdjb: '1', queriedAt: '2026-10-20T00:00:01Z', status: 'no_record', rawResponse: 'M3空结果原档' },
  ], differences: [{ uscc: m3Uscc, titleCode: 'specialized_sme', direction: 'missing_in_miit', status: 'confirmed_reason', reasonCode: 'platform_stale', measureCode: 'mark_platform_snapshot', verificationStatus: 'confirmed', recordedAt: '2026-10-20T01:00:00Z' }] })
  return { commit }
}

export function workerReconciliationSnapshot(code = 'on_platform', generatedAt = 'M3-cache-1') {
  return JSON.stringify({ generatedAt, entries: [{ key: JSON.stringify([m3Uscc, 'specialized_sme', 'missing_in_miit']), titleCode: 'specialized_sme', direction: 'missing_in_miit', explanation: { code, note: 'M3旧解释' }, evidence: { records: [{ original: 'M3缓存原文'.repeat(15000) }] } }] })
}

export function assertWorkerComparisonState(body: any) {
  expect(body).toMatchObject({ view: 'summary', total: 3, counts: { little_giant: { missing_in_miit: 0, extra_in_miit: 0 }, specialized_sme: { missing_in_miit: 2, extra_in_miit: 0 }, innovative_sme: { missing_in_miit: 1, extra_in_miit: 0 } }, platform: { withEvidence: 2, withExplanation: 1, withoutExplanation: 2 }, reconcile: { generatedAt: 'M3-cache-1', matched: 1 } })
  expect(body.rows.map((r: any) => r.name)).toEqual(['M3Alpha企业', 'M3Beta企业', 'M3Gamma企业'])
  expect(body.rows[0]).toMatchObject({ evidenceIncluded: false, explanation: { code: 'on_platform' }, platform: { aliasCount: 2, confirmedAliasCount: 1, queryCount: 1, sourceRelationCount: 3, disposition: { status: 'confirmed_reason', reasonCode: 'platform_stale', verificationStatus: 'confirmed' } } })
  expect(body.rows[1].platform).toMatchObject({ queryCount: 0, sourceRelationCount: 0, disposition: { status: 'not_queried', explanationId: null } })
  expect(body.rows[2].platform).toMatchObject({ queryCount: 2, sourceRelationCount: 0, disposition: { status: 'not_queried', explanationId: null } })
  for (const row of body.rows) {
    expect(row.evidenceIncluded).toBe(false)
    expect(row.platform).not.toHaveProperty('queries')
    expect(row.platform).not.toHaveProperty('aliases')
    expect(row).not.toHaveProperty('note')
    if (row.explanation) expect(row.explanation).not.toHaveProperty('evidence')
  }
}
