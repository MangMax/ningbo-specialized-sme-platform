import { submitNewFixtureAnnouncement } from '../../imports/fixtures/reviewed-announcement'
import type { RosterImportRequest } from '../../../../layers/sme-roster/lib/roster-import-client'
/** M2-specific public-write fixture, also used by the relocated built probe.
 * No database access: synthetic truth enters through the current HTTP API. */
import assert from 'node:assert/strict'

export const m2Note = '证据"\\\n🙂'.repeat(500)
export const m2Name = (n: number) => `M2R合成${String(n).padStart(2, '0')}`
export async function seedDifferenceReadFixture(base: string, token: string) {
  let sequence = 0
  const commit = async (payload: unknown) => {
    const body = { idempotencyKey: `m2-rich-${++sequence}`, sourceKind: 'announcement', sourceIdentity: `synthetic/m2-rich/${sequence}`, payload }
    const post = async (action: string) => {
      const r = await fetch(base + '/api/roster/import/' + action, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
      assert.equal(r.status, 200); return r.json()
    }
    await post('preflight')
    const receipt = await submitNewFixtureAnnouncement(base, token, body as RosterImportRequest)
    assert.ok(receipt.status === 'supplemented' || receipt.status === 'committed', JSON.stringify(receipt))
    return receipt
  }
  await commit({ announcement: { sourceDocument: { source: 'jxj', title: 'M2 synthetic complete DTO' }, records: [
    ...Array.from({ length: 8 }, (_, n) => ({ enterprise: { name: m2Name(n), ...(n === 0 ? { uscc: '91330211255994457P', district: '鄞州区' } : {}) }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year: 2022, evidence: [{ sourceFile: 'synthetic/m2.pdf', attachment: '附件"一', listNo: n + 1, page: 3 }] }] })),
    { enterprise: { name: 'M2R仅比较坐标' }, titleCode: 'innovative_sme', events: [{ eventType: 'nurture', year: 2021 }] },
  ] } })
  await commit({ differences: Array.from({ length: 8 }, (_, n) => (['missing_in_miit', 'extra_in_miit']).map(direction => ({ enterpriseName: m2Name(n), titleCode: 'specialized_sme', direction, status: 'needs_review', measureCode: 'manual_review', reasonNote: m2Note, recordedAt: '2026-10-18T00:00:00.000Z' }))).flat() })
  await commit({
    platformQueries: [{ interface: 'business_list', queryKey: 'name:M2R合成00', rdjb: '2', titleCode: 'specialized_sme', queriedAt: '2026-10-19T00:00:00.000Z', status: 'failed', rawResponse: 'SYNTHETIC_RAW_ONLY', failureReason: 'synthetic failure', relations: [{ sequenceNo: 1, nameRaw: 'M2R旧名称', usccRaw: '91330211255994457P', verificationStatus: 'confirmed' }, { sequenceNo: 2, nameRaw: 'unmatched synthetic' }] }, { interface:'business_list',queryKey:'91330211255994457P',rdjb:'2',titleCode:'specialized_sme',queriedAt:'2026-10-19T00:00:00.000Z',status:'failed',rawResponse:'SYNTHETIC_TIED',relations:[] }, { interface:'business_list',queryKey:'name:M2R合成01',rdjb:'2',titleCode:'specialized_sme',queriedAt:'2026-10-19T00:00:00.000Z',status:'partial',rawResponse:'SYNTHETIC_PARTIAL',relations:[] }],
    aliases: [{ enterpriseName: m2Name(0), name: 'M2R旧名称', sourceKind: 'platform_business', verificationStatus: 'confirmed', sourceRelationRef: { interface: 'business_list', queryKey: 'name:M2R合成00', rdjb: '2', sequenceNo: 1 } }],
    differences: [
      { enterpriseName: m2Name(0), titleCode: 'specialized_sme', direction: 'missing_in_miit', status: 'confirmed_reason', reasonCode: 'pending_review', measureCode: 'follow_review', reasonNote: m2Note, verificationStatus: 'confirmed', recordedAt: '2026-10-19T00:00:00.000Z', evidenceQueryRef: { interface: 'business_list', queryKey: 'name:M2R合成00', rdjb: '2' } },
      { enterpriseName: m2Name(1), titleCode: 'specialized_sme', direction: 'extra_in_miit', status: 'confirmed_no_diff', measureCode: 'none', reasonNote: m2Note, verificationStatus: 'confirmed', recordedAt: '2026-10-19T00:00:00.000Z' },
    ],
  })
  return { commit }
}

export function assertDifferenceReadState(rest: any, mcp?: any) {
  assert.equal(rest.total, 17); assert.equal(rest.page, 1); assert.equal(rest.pageSize, 50)
  assert.deepEqual(rest.counts, { little_giant: { missing_in_miit: 0, extra_in_miit: 0 }, specialized_sme: { missing_in_miit: 8, extra_in_miit: 8 }, innovative_sme: { missing_in_miit: 1, extra_in_miit: 0 } })
  assert.deepEqual(rest.rows.map((r: any) => [r.name, r.direction]), [...['extra_in_miit', 'missing_in_miit'].flatMap(d => Array.from({ length: 8 }, (_, n) => [m2Name(n), d])), ['M2R仅比较坐标', 'missing_in_miit']])
  const row = rest.rows[8], absent = rest.rows[16]
  assert.equal(row.reasonNote, m2Note); assert.equal(row.status, 'confirmed_reason'); assert.equal(row.reasonCode, 'pending_review'); assert.equal(row.measureCode, 'follow_review')
  assert.equal(row.queryCoverage.status, 'failed'); assert.equal(row.queryCoverage.sources[0].outcome, 'unknown'); assert.equal(row.assessment, 'decided')
  assert.equal(row.currentDecision.versionId, row.explanationId); assert.equal(row.currentDecision.current.status, 'confirmed_reason')
  assert.equal(row.explanationValidity.status, 'unknown'); assert.deepEqual(row.explanationValidity.evidenceQueryIds, [row.evidence.queryId])
  assert.equal(row.evidence.failureReason, 'synthetic failure'); assert.equal(row.evidence.relationIds.length, 2); assert.equal(new Set(row.evidence.relationIds).size, 2)
  assert.equal(rest.rows[1].status, 'confirmed_no_diff'); assert.equal(rest.rows[1].queryCoverage.status, 'partial'); assert.equal(rest.rows[2].queryCoverage.status, 'not_queried')
  assert.equal(absent.status, 'not_queried'); assert.equal(absent.explanationId, null); assert.equal(absent.evidence, null); assert.equal(absent.currentDecision.current, null); assert.equal(absent.assessment, 'not_queried')
  if (mcp) {
    assert.equal(mcp.rows.length, 16); assert.deepEqual(mcp.counts, { specialized_sme: { extra_in_miit: 8, missing_in_miit: 8 } })
    assert.equal(mcp.rows.some((r: any) => r.name === absent.name), false)
    assert.deepEqual(mcp.rows.slice(0, 4).map((r: any) => [r.name, r.direction]), [[m2Name(0), 'extra_in_miit'], [m2Name(0), 'missing_in_miit'], [m2Name(1), 'extra_in_miit'], [m2Name(1), 'missing_in_miit']])
    const stored = mcp.rows[1]
    assert.deepEqual(stored.evidence, { queryId: row.evidence.queryId, queriedAt: '2026-10-19T00:00:00.000Z', interface: 'business_list', status: 'failed' })
    for (const field of ['reasonNote', 'explanationId', 'uscc', 'district']) assert.equal(field in stored, false)
    for (const field of ['queryCoverage', 'currentDecision', 'explanationValidity', 'assessment']) assert.deepEqual(stored[field], row[field])
    assert.deepEqual(Object.keys(mcp).sort(), ['counts', 'rows'])
  }
}
