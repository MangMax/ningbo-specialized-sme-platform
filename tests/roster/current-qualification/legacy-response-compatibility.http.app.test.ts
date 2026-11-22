import { submitNewFixtureAnnouncement } from '../imports/fixtures/reviewed-announcement'
import type { RosterImportRequest } from '../../../layers/sme-roster/lib/roster-import-client'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { nativeAppAdapter } from '../../support/native-app'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { seedRetiredEvidenceState } from '../fixtures/retired-evidence-state'

const dir = mkdtempSync(join(tmpdir(), 'main-a9bc-qualification-'))
const app = nativeAppAdapter({ dir, token: 'synthetic-a9bc' })
let pool: pg.Pool
let base: string
const headers = { authorization: 'Bearer synthetic-a9bc', 'content-type': 'application/json' }
const qualification = { titleCode: 'specialized_sme', validFrom: '2025-01-01T00:00:00Z', validUntil: '2028-01-01T00:00:00Z', awardYear: 2025,
  basis: 'Synthetic explicit external award evidence', publicationCheck: { status: 'not_found', scope: 'Synthetic new-grant publications only' } }
const uscc = '91330211255994457P'
let enterpriseId: number, relationId: number, serial = 0
beforeAll(async () => {
  await app.start()
  base = app.url('')
  pool = new pg.Pool({ connectionString: app.postgresUrl })
  // All synthetic business facts enter through the public preflight/commit contract.
  const body = { idempotencyKey: 'main-a9bc-synthetic-seed', sourceKind: 'announcement', sourceIdentity: 'synthetic/a9bc.pdf', payload: {
    announcement: { sourceDocument: { source: 'jxj', title: 'Synthetic qualification compatibility' }, records: [
      { enterprise: { name: '合成兼容企业', uscc }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year: 2022, batchSeq: 1 }] },
    ] }, platformQueries: [{ interface: 'business_list', queryKey: '  91330211255994457p\t', titleCode: 'specialized_sme', rdjb: '2',
      queriedAt: '2026-10-20T00:00:00Z', status: 'success', rawResponse: 'synthetic-archive'.repeat(2048),
      relations: [{ sequenceNo: 1, usccRaw: uscc, nameRaw: '合成兼容企业', verificationStatus: 'confirmed', matchBasis: 'uscc' }] }],
  } }
  const preflight = await fetch(base + '/api/roster/import/preflight', { method: 'POST', headers, body: JSON.stringify(body) })
  expect(preflight.status).toBe(200)
  const committed = await submitNewFixtureAnnouncement(base, headers.authorization.slice('Bearer '.length), body as RosterImportRequest)
  expect(committed).toMatchObject({ status: 'supplemented', summary: { failed: 0 } })
  // Read IDs from this owned synthetic DB; the historical validity fixture is staged after the decision is created.
  enterpriseId = Number((await pool.query('SELECT id FROM business.enterprise')).rows[0]!.id)
  relationId = Number((await pool.query('SELECT public_id FROM business.platform_business_observation')).rows[0]!.public_id)
}, 90000)
afterAll(async () => {
  try { await pool?.end() } finally {
    try { await app.close() } finally { rmSync(dir, { recursive: true, force: true }) }
  }
})
async function listDifferences() {
  const response = await fetch(base + '/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_differences', arguments: { direction: 'extra_in_miit', pageSize: 1 } } }),
  })
  expect(response.status).toBe(200)
  const raw = await response.text()
  const wire = JSON.parse(raw.startsWith('event:') ? raw.split('\n').find(line => line.startsWith('data: '))!.slice(6) : raw)
  return wire.result.structuredContent ?? JSON.parse(wire.result.content[0].text)
}
const scope = () => ({ enterpriseId, titleCode: 'specialized_sme', direction: 'extra_in_miit' as const })
function command(action: string, expectedCurrentId: number | null, decision?: unknown) {
  return { ...scope(), action, expectedCurrentId, idempotencyKey: 'synthetic-a9bc-command-' + (++serial),
    actor: { type: 'agent', id: 'synthetic-a9bc' }, basis: 'Synthetic explicitly reviewed evidence', ruleVersion: 'synthetic-a9bc', effectiveAt: '2026-10-20T00:00:00Z', ...(decision ? { decision } : {}) }
}
async function post(body: unknown, authorized = true) {
  const response = await fetch(base + '/api/roster/decision-lifecycle/commands?view=summary', { method: 'POST',
    headers: authorized ? headers : { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json() }
}
async function assertAssessments(expectedQualification: typeof qualification | null, validity: string, versionId: number, withdrawn = false) {
  const detailResponse = await fetch(base + '/api/roster/enterprises/' + enterpriseId)
  expect(detailResponse.status).toBe(200)
  const detail = await detailResponse.json()
  const single = detail.titleAssessments.find((a: any) => a.titleCode === 'specialized_sme' && a.direction === 'extra_in_miit')
  const response = await fetch(base + '/api/roster/differences?direction=extra_in_miit&pageSize=1')
  expect(response.status).toBe(200)
  const rest = (await response.json()).rows[0]
  const tool = (await listDifferences()).rows[0]
  for (const row of [single, rest, tool]) {
    expect(row).toMatchObject({ currentDecision: { versionId }, assessment: withdrawn ? 'withdrawn' : 'decided', explanationValidity: { status: validity }, queryCoverage: { status: 'unknown', truncated: false } })
    if (withdrawn) expect(row.currentDecision.current).toBeNull()
    else expect(row.currentDecision.current.currentQualification).toEqual(expectedQualification)
    expect(row.queryCoverage.sources).toHaveLength(1)
    expect(row.queryCoverage.sources[0]).toMatchObject({ interface: 'business_list', subjectMatch: 'exact_uscc', status: 'unknown', outcome: 'unknown' })
  }
  // Cross-adapter equality supplements, never replaces, the literal expectations above.
  expect(rest.currentDecision).toEqual(single.currentDecision); expect(tool.currentDecision).toEqual(single.currentDecision)
  expect(rest.explanationValidity).toEqual(single.explanationValidity); expect(tool.queryCoverage).toEqual(single.queryCoverage)
}

it('preserves main qualification and evidence validity across single REST and page-local REST/MCP assessments', async () => {
  const legacy = await post(command('replace', null, { status: 'needs_review', measureCode: 'manual_review', verificationStatus: 'pending' }))
  expect(legacy.status).toBe(200)
  await assertAssessments(null, 'unknown', legacy.body.versionId)
  const decision = { status: 'confirmed_reason', reasonCode: 'moved_in', measureCode: 'record_moved_in', verificationStatus: 'confirmed', evidenceRelationId: relationId, currentQualification: qualification }
  const replacement = command('replace', legacy.body.versionId, decision)
  expect((await post(replacement, false)).status).toBe(401)
  const accepted = await post(replacement); expect(accepted.status, JSON.stringify(accepted.body)).toBe(200)
  await assertAssessments(qualification, 'unknown', accepted.body.versionId)
  await seedRetiredEvidenceState(drizzle(pool), accepted.body.versionId)
  await assertAssessments(qualification, 'valid', accepted.body.versionId)
  const current = await (await fetch(base + '/api/roster/decision-lifecycle/current?' + new URLSearchParams({ enterpriseId: String(enterpriseId), titleCode: 'specialized_sme', direction: 'extra_in_miit' as const }))).json()
  expect(current.current.currentQualification).toEqual(qualification)
  const withdrawn = await post(command('withdraw', accepted.body.versionId)); expect(withdrawn.status).toBe(200)
  await assertAssessments(null, 'not_applicable', withdrawn.body.versionId, true)
}, 30000)
