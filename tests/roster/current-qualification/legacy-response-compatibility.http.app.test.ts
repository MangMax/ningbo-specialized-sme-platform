import '../../support/compiled-enterprise-reader'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as h3 from 'h3'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { initializeDb, schema } from '../../../db/client'
import { executeNativeImport, startRosterApi } from '../imports/fixtures/import-server'
import { enterpriseReads } from '../../../layers/sme-roster/server/utils/enterprise-read'
import { readEvidenceToken113 } from '../../../layers/sme-roster/server/utils/evidence-impact-113'

const active = vi.hoisted(() => ({ db: null as ReturnType<typeof initializeDb> | null }))
vi.mock('@db', () => ({ useDb: () => active.db }))
vi.mock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (tool: unknown) => tool }))
const dir = mkdtempSync(join(tmpdir(), 'main-a9bc-qualification-'))
const db = initializeDb({ create: true,  dbPath: join(dir, 'synthetic.sqlite') }); active.db = db
let imports: Awaited<ReturnType<typeof startRosterApi>>, server: ReturnType<typeof createServer>, base: string
let mcp: { handler(input: Record<string, unknown>): Promise<any> }
const headers = { authorization: 'Bearer synthetic-a9bc', 'content-type': 'application/json' }
const qualification = { titleCode: 'specialized_sme', validFrom: '2025-01-01T00:00:00Z', validUntil: '2028-01-01T00:00:00Z', awardYear: 2025,
  basis: 'Synthetic explicit external award evidence', publicationCheck: { status: 'not_found', scope: 'Synthetic new-grant publications only' } }
const uscc = '91330211255994457P'
let enterpriseId: number, relationId: number, serial = 0
beforeAll(async () => {
  await enterpriseReads.start()
  for (const [key, value] of Object.entries(h3)) vi.stubGlobal(key, value)
  vi.stubGlobal('useRuntimeConfig', () => ({ apiToken: 'synthetic-a9bc', filesDir: dir }))
  imports = await startRosterApi({ db, apiToken: 'synthetic-a9bc', executeImport: executeNativeImport })
  // All synthetic business facts enter through the public preflight/commit contract.
  const body = { idempotencyKey: 'main-a9bc-synthetic-seed', sourceKind: 'announcement', sourceIdentity: 'synthetic/a9bc.pdf', payload: {
    announcement: { sourceDocument: { source: 'jxj', title: 'Synthetic qualification compatibility' }, records: [
      { enterprise: { name: '合成兼容企业', uscc }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year: 2022, batchSeq: 1 }] },
    ] }, platformQueries: [{ interface: 'business_list', queryKey: '  91330211255994457p\t', titleCode: 'specialized_sme', rdjb: '2',
      queriedAt: '2026-10-20T00:00:00Z', status: 'success', rawResponse: 'synthetic-archive'.repeat(2048),
      relations: [{ sequenceNo: 1, usccRaw: uscc, nameRaw: '合成兼容企业', verificationStatus: 'confirmed', matchBasis: 'uscc' }] }],
  } }
  const preflight = await fetch(imports.baseUrl + '/api/roster/import/preflight', { method: 'POST', headers, body: JSON.stringify(body) })
  expect(preflight.status).toBe(200)
  const committed = await fetch(imports.baseUrl + '/api/roster/import/commit', { method: 'POST', headers, body: JSON.stringify(body) })
  expect(committed.status).toBe(200)
  expect(await committed.json()).toMatchObject({ status: 'committed', summary: { failed: 0 } })
  // Read IDs from this owned synthetic DB; no SQL writes or copied fixtures.
  enterpriseId = db.select({ id: schema.enterprise.id }).from(schema.enterprise).get()!.id
  relationId = db.select({ id: schema.platformLegacyRelationAlias.oldId }).from(schema.platformLegacyRelationAlias).get()!.id
  const processImpacts = (await import('../../../layers/sme-roster/server/api/roster/evidence-impacts/commands.post')).default
  const commands = (await import('../../../layers/sme-roster/server/api/roster/decision-lifecycle/commands.post')).default
  const detail = (await import('../../../layers/sme-roster/server/api/roster/enterprises/[id].get')).default
  const differences = (await import('../../../layers/sme-roster/server/api/roster/differences.get')).default
  const current = (await import('../../../layers/sme-roster/server/api/roster/decision-lifecycle/current.get')).default
  mcp = (await import('../../../layers/sme-roster/server/mcp/tools/list_differences')).default as unknown as typeof mcp
  const router = h3.createRouter().post('/api/roster/decision-lifecycle/commands', commands)
    .post('/api/roster/evidence-impacts/commands', processImpacts)
    .get('/api/roster/decision-lifecycle/current', current).get('/api/roster/enterprises/:id', detail).get('/api/roster/differences', differences)
  server = createServer(h3.toNodeListener(h3.createApp({ debug: false }).use(router)))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  await enterpriseReads.close(); await imports?.close(); db.$client.close()
  rmSync(dir, { recursive: true, force: true }); vi.unstubAllGlobals()
})
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
  const tool = (await mcp.handler({ direction: 'extra_in_miit', pageSize: 1 })).rows[0]
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
  const processed = await fetch(base + '/api/roster/evidence-impacts/commands', { method: 'POST', headers, body: JSON.stringify({
    action: 'process', limit: 100, idempotencyKey: 'synthetic-a9bc-process', actor: { type: 'agent', id: 'synthetic-a9bc' }, basis: 'Process synthetic imported evidence before explicit review',
  }) })
  expect(processed.status).toBe(200)
  const token = readEvidenceToken113(db, scope())
  expect(token.projectionReady).toBe(true)
  const reviewed = await post({ ...command('maintain', accepted.body.versionId), reviewedEvidence: { latestRevisionId: token.latestRevisionId, projectionReady: true } })
  expect(reviewed.status).toBe(200)
  await assertAssessments(qualification, 'valid', accepted.body.versionId)
  const current = await (await fetch(base + '/api/roster/decision-lifecycle/current?' + new URLSearchParams({ enterpriseId: String(enterpriseId), titleCode: 'specialized_sme', direction: 'extra_in_miit' as const }))).json()
  expect(current.current.currentQualification).toEqual(qualification)
  const withdrawn = await post(command('withdraw', accepted.body.versionId)); expect(withdrawn.status).toBe(200)
  await assertAssessments(null, 'not_applicable', withdrawn.body.versionId, true)
}, 30000)
