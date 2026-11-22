import { spawnCompiledApp } from '../../support/owned-process.mjs'
import { assertEnterpriseDetailSnapshotEqual } from '../assertions/enterprise-detail-snapshot'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { createRosterImportClient, type RosterImportRequest } from '../../../layers/sme-roster/lib/roster-import-client'
import { seedComparisonSourceStatus } from './fixtures/source-status'
import { reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../../support/owned-process.mjs'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'

// A caller-owned service lets manual RED -> GREEN and browser acceptance share
// one dev compilation. Normal test runs still own and clean up their service.
const external = process.env.ISSUE301_BASE_URL
const dir = external ? process.env.ISSUE301_DIR! : mkdtempSync(join(tmpdir(), 'issue301-http-'))
let fixture: Awaited<ReturnType<typeof seedComparisonSourceStatus>>
let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
let base = external ?? ''
let stop: (() => Promise<void>) | undefined
let full: Awaited<ReturnType<typeof rest>>
let detail: Awaited<ReturnType<typeof rest>>
const businessTables = ['platform_collection', 'platform_business_observation', 'platform_business_record_version', 'platform_observation_assignment', 'difference_reason', 'record_correspondence', 'record_correspondence_audit']
async function persisted() {
  const connectionString = postgres?.url ?? process.env.NUXT_POSTGRES_DIRECTORY_URL
  if (!connectionString) throw new Error('An external comparison fixture requires its PostgreSQL URL')
  const client = new pg.Client({ connectionString })
  await client.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const state = []
    for (const table of businessTables) {
      const { rows } = await client.query(`SELECT row_to_json(t)::text AS row FROM business.${table} t ORDER BY row_to_json(t)::text COLLATE "C"`)
      state.push(rows)
    }
    await client.query('COMMIT')
    return state
  } finally { await client.end() }
}
let before: Awaited<ReturnType<typeof persisted>> | undefined
beforeAll(async () => {
  if (external) {
    fixture = JSON.parse(readFileSync(join(dir, 'fixture.json'), 'utf8'))
    await waitForHttp(`${base}/_openapi.json`); before = await persisted(); return
  }
  postgres = await postgresRuntimeFixture({ dir })
  const pool = new pg.Pool({ connectionString: postgres.url, options: '-c search_path=business,public' })
  try { fixture = await seedComparisonSourceStatus(drizzle(pool)) } finally { await pool.end() }
  const cwd = resolve(import.meta.dirname, '../../..')
  let port = await reserveLoopbackPort()
  while ([3480, 3516].includes(port)) port = await reserveLoopbackPort()
  const child = spawnCompiledApp(port, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...postgres.env, NUXT_BUILD_DIR: join(dir, 'build'), NUXT_FILES_DIR: join(dir, 'files'), NUXT_INCOMING_DIR: join(dir, 'incoming'), NUXT_CURATED_PATH: join(dir, 'curated.json'), NUXT_RECONCILE_PATH: join(dir, 'reconcile.json'), NUXT_API_TOKEN: 'issue301-synthetic', NUXT_MCP_TOKEN: 'issue301-synthetic' } })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-8000) })
  base = `http://127.0.0.1:${port}`
  stop = () => stopOwnedChild(child)
  try { await waitForHttp(`${base}/api/health`, { child }) }
  catch (error) { throw new Error(`${String(error)}\n${output}`) }
  before = await persisted()
}, 90000)
beforeAll(async () => {
  full = await rest(`/api/comparison?view=full&enterpriseId=${fixture.enterprise.id}`)
  expect(await rest(`/api/comparison?enterpriseId=${fixture.enterprise.id}`)).toEqual(full)
  detail = await rest(`/api/roster/enterprises/${fixture.enterprise.id}`)
  assertEnterpriseDetailSnapshotEqual(await mcp('get_enterprise_detail', { enterpriseId: fixture.enterprise.id }), detail)
}, 30000)
afterAll(async () => {
  try { if (before) expect(await persisted()).toEqual(before) }
  finally { try { await stop?.() } finally { postgres?.close(); if (!external) rmSync(dir, { recursive: true, force: true }) } }
})
async function rest(path: string) {
  const response = await fetch(base + path)
  expect(response.status).toBe(200)
  return response.json()
}
async function mcp(name: string, args: unknown) {
  const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer issue301-synthetic', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
  expect(response.status).toBe(200)
  const raw = await response.text()
  const payload = JSON.parse(raw.startsWith('event:') ? raw.split('\n').find(line => line.startsWith('data: '))!.slice(6) : raw)
  expect(payload.error).toBeUndefined()
  expect(payload.result.isError).not.toBe(true)
  return JSON.parse(payload.result.content[0].text)
}

it.each(['apply-raw', 'business-raw', 'unknown', 'missing', 'recognized-is-not-process'])('native full matches enterprise and HTTP/MCP archive facts without guessing: %s', async label => {
  const { query, relation, expected } = fixture.cases.find(item => item.label === label)!
  const actual = full.rows[0].platform.queries.find((q: { id: number }) => q.id === query.id).relations[0]
  const archive = await rest(`/api/platform/queries?queryId=${query.id}`)
  const remoteArchive = await mcp('list_platform_queries', { queryId: query.id })
  expect(remoteArchive).toEqual(archive)
  const conflicts: unknown[] = []
  const facts = { status: expected, normalizationConflicts: conflicts, declareKind: query.interface === 'recognized_list' ? null : 'apply', appliedAt: query.interface === 'recognized_list' ? null : '2025-01-02', year: query.interface === 'recognized_list' ? null : 2025 }
  for (const row of [actual, detail.platform.relations.find((r: { id: number }) => r.id === relation.id), archive.rows[0].relations[0]]) expect(row).toMatchObject({ id: relation.id, queryId: query.id, ...facts })
  expect(full.rows[0].platform.disposition).toMatchObject({ explanationId: fixture.decision.id, status: fixture.decision.status, evidenceRelationId: fixture.decision.evidenceRelationId })
})

it('rejects a conflicting stored and original process status before publishing any native collection', async () => {
  const client = createRosterImportClient({ baseUrl: base, token: 'issue301-synthetic' })
  const request: RosterImportRequest = { idempotencyKey: 'issue301-conflicting-status', sourceKind: 'alias_evidence', sourceIdentity: 'issue301-conflicting-status',
    payload: { platformQueries: [{
      interface: 'business_list', queryKey: fixture.enterprise.usccNorm!, rdjb: '2', queriedAt: '2026-10-30T00:00:00Z', status: 'success', rawResponse: 'Explicit synthetic conflicting source',
      relations: [{ sequenceNo: 1, enterpriseId: fixture.enterprise.id, status: '已退回', rawFields: { cszt: '终审通过' } }],
    }] },
  }
  expect((await client.preflight(request)).preflight.conflicts)
    .toEqual(expect.arrayContaining([expect.objectContaining({ error: expect.objectContaining({ code: 'platform_field_conflict' }) })]))
  expect((await client.commit(request)).status).toBe('failed')
  expect(await persisted()).toEqual(before)
})
