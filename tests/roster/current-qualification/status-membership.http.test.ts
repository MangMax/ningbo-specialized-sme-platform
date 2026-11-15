import { CURRENT_RULE_VERSION, QUALIFICATION_ASSESSMENT_VERSION } from '../../../lib/roster/current-qualification'
import { createHash } from 'node:crypto'
import { writeFileSync, renameSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { fileMatrix408 } from '../../helpers/current-qualified-408'
import type { CurrentQualifiedResult } from '../../../lib/roster/current-qualified-query'
import type { CurrentQualificationSnapshot } from '../../../lib/roster/current-qualification'
import { spawnOwnedChild, reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../../helpers/isolated-local-services.mjs'

let fixture: ReturnType<typeof fileMatrix408> | undefined
let child: ReturnType<typeof spawnOwnedChild> | undefined
let client: Client | undefined
let base = '', output = '', year = 0
let eligibleId = 0, pendingId = 0, reviewId = 0
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
// Opens only on an explicitly granted future HTTP test run. No reader/native mocks.
beforeAll(async () => {
  fixture = fileMatrix408()
  const f = fixture
  year = new Date().getUTCFullYear()
  const eligible = f.formal('synthetic_408_public_eligible', [{ eventType: 'award', year, decidedYear: year, batchSeq: 1 }], { uscc: '91330200000000408X' })
  const pending = f.formal('synthetic_408_public_pending', [{ eventType: 'award', year: year - 4, decidedYear: year - 4, batchSeq: 1 }, { eventType: 'review', year: year - 4, decidedYear: null, batchSeq: 1, reviewOutcome: null }], { uscc: '913302000000004091' })
  eligibleId = eligible.enterprise.id; pendingId = pending.enterprise.id; reviewId = pending.events[1]!.id
  f.platform(eligibleId, 'failed')
  f.recognized(pendingId, pending.events[0]!.id, { rddqrq: '2028-06-01', whpc: '2024-2' })
  const cwd = resolve(import.meta.dirname, '../../..'), root = dirname(f.sqlite.name)
  writeFileSync(join(root, 'empty.env'), '')
  const port = await reserveLoopbackPort()
  base = `http://127.0.0.1:${port}`
  child = spawnOwnedChild(process.execPath, [join(cwd, 'node_modules/nuxt/bin/nuxt.mjs'), 'dev', '--host', '127.0.0.1', '--port', String(port), '--dotenv', join(root, 'empty.env')], {
    cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NUXT_BUILD_DIR: join(root, 'nuxt'), NUXT_LOG_DIR: join(root, 'logs'), NUXT_OCR_TOKEN: 'synthetic408-ocr-token', MIIT_COOKIE: 'synthetic408-cookie', NUXT_DB_PATH: f.sqlite.name, NUXT_FILES_DIR: join(root, 'files'), NUXT_INCOMING_DIR: join(root, 'incoming'), NUXT_API_TOKEN: 'synthetic408-http-token', NUXT_MCP_TOKEN: 'synthetic408-mcp-token' },
  })
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', data => { output = (output + String(data)).slice(-12000) })
  try {
    await waitForHttp(base + '/api/jobs/kinds', { timeoutMs: 60000, child })
    client = new Client({ name: 'synthetic408-public-contract', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp')))
  } catch (error) {
    const failures: unknown[] = [error]
    try { await client?.close() } catch (closeError) { failures.push(closeError) }
    client = undefined
    try { if (child) await stopOwnedChild(child) } catch (stopError) { failures.push(stopError) }
    child = undefined
    try { f.close() } catch (dbError) { failures.push(dbError) }
    fixture = undefined
    throw new AggregateError(failures, 'Synthetic408 Nuxt startup failed: ' + output)
  }
}, 90000)
afterAll(async () => {
  try { await client?.close() } finally {
    try { if (child) await stopOwnedChild(child) } finally { fixture?.close() }
  }
})

function databaseContent() {
  const db = fixture!.sqlite
  // All main database DDL and table content, including jobs/receipts/decisions,
  // not merely result rows. These tests submit no work or business writes.
  const schema = db.prepare("select type,name,tbl_name,sql from sqlite_master order by type,name").all()
  const tables = db.prepare("select name from sqlite_master where type='table' order by name").all() as { name: string }[]
  const rows = tables.map(({ name }) => {
    const quoted = '"' + name.replaceAll('"', '""') + '"'
    return [name, db.prepare(`select * from ${quoted}`).all().map(row => JSON.stringify(row)).sort()]
  })
  return hash([schema, rows])
}
function verifySnapshot(snapshot: CurrentQualificationSnapshot, result: CurrentQualifiedResult) {
  expect(snapshot.asOf).toBe(result.snapshotStartedAt)
  expect(new Date(snapshot.asOf).getUTCFullYear()).toBe(year)
  expect(snapshot.ruleVersion).toBe(CURRENT_RULE_VERSION)
  expect(snapshot.assessmentVersion).toBe(QUALIFICATION_ASSESSMENT_VERSION)
  expect(snapshot.titles.map(t => t.titleCode)).toEqual(['little_giant', 'specialized_sme', 'innovative_sme'])
  const scope = { enterpriseId: snapshot.enterpriseId, asOf: snapshot.asOf, ruleVersion: snapshot.ruleVersion, assessmentVersion: snapshot.assessmentVersion }
  expect(snapshot.snapshotId).toBe(hash([scope, snapshot.titles]))
}
async function http(query: Record<string, string> = {}) {
  const before = databaseContent(), started = Date.now()
  const response = await fetch(base + '/api/roster/current-enterprises?' + new URLSearchParams({ titleCode: 'innovative_sme', ...query }))
  const body: CurrentQualifiedResult = await response.json()
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toContain('no-store')
  expect(Date.parse(body.snapshotStartedAt)).toBeGreaterThanOrEqual(started)
  expect(Date.parse(body.snapshotStartedAt)).toBeLessThanOrEqual(Date.now())
  expect(new Date(body.snapshotStartedAt).getUTCFullYear()).toBe(year)
  for (const row of [...body.rows, ...body.publishedPending.rows]) verifySnapshot(row.qualificationAssessment, body)
  expect(databaseContent()).toBe(before)
  return body
}
async function sdk(args: Record<string, unknown> = {}) {
  const before = databaseContent(), started = Date.now()
  const result = CallToolResultSchema.parse(await client!.callTool({ name: 'list_current_qualified_enterprises', arguments: { titleCode: 'innovative_sme', ...args } }, CallToolResultSchema))
  expect(result.isError).not.toBe(true)
  const content = result.content.find(block => block.type === 'text')
  if (!content || content.type !== 'text') throw new Error('Missing actual SDK text result')
  const body: CurrentQualifiedResult = JSON.parse(content.text)
  expect(Date.parse(body.snapshotStartedAt)).toBeGreaterThanOrEqual(started)
  expect(Date.parse(body.snapshotStartedAt)).toBeLessThanOrEqual(Date.now())
  expect(new Date(body.snapshotStartedAt).getUTCFullYear()).toBe(year)
  for (const row of [...body.rows, ...body.publishedPending.rows]) verifySnapshot(row.qualificationAssessment, body)
  expect(databaseContent()).toBe(before)
  return body
}
function sameCurrentFacts(left: CurrentQualifiedResult, right: CurrentQualifiedResult) {
  // Both asOf values have already been checked in the same UTC evaluation year.
  // Seeded facts/decisions have no boundary between these two requests. Compare
  // full titles and all input versions, NOT time-dependent snapshot identities.
  expect([left.responseVersion, left.titleCode, left.ruleVersion, left.page, left.pageSize]).toEqual([right.responseVersion, right.titleCode, right.ruleVersion, right.page, right.pageSize])
  expect(left.publishedPending.rows.map(row => row.filterMatch)).toEqual(right.publishedPending.rows.map(row => row.filterMatch))
  expect(left.rows.map(row => row.enterpriseId)).toEqual(right.rows.map(row => row.enterpriseId))
  expect(left.publishedPending.rows.map(row => row.enterpriseId)).toEqual(right.publishedPending.rows.map(row => row.enterpriseId))
  for (const [a, b] of [[left.rows, right.rows], [left.publishedPending.rows, right.publishedPending.rows]] as const) {
    a.forEach((row, index) => {
      const other = b[index]!
      expect(row.qualificationAssessment.enterpriseId).toBe(other.qualificationAssessment.enterpriseId)
      expect(row.qualificationAssessment.titles).toEqual(other.qualificationAssessment.titles)
    })
  }
  expect([left.total, left.uncertainTotal, left.publishedPending.total, left.publishedPending.requested, left.options])
    .toEqual([right.total, right.uncertainTotal, right.publishedPending.total, right.publishedPending.requested, right.options])
}

it('real_http_and_sdk_share_effective_and_expired_states_without_platform_veto_408', async () => {
  const a = await http({ q: 'synthetic_408_public' }), b = await sdk({ q: 'synthetic_408_public' })
  expect(a.responseVersion).toBe('current-qualified-478-v2')
  expect(a.rows.map(row => row.enterpriseId)).toEqual([eligibleId])
  expect(a.publishedPending.rows).toEqual([])
  expect(a).toMatchObject({ total: 1, uncertainTotal: 0, publishedPending: { requested: true, total: 0 } })
  expect(a.rows[0]!.qualificationAssessment.titles[2]!.platform.status).toBe('query_failed')
  sameCurrentFacts(a, b)
  const expired = await http({ q: 'synthetic_408_public', status: 'expired' })
  expect(expired.rows.map(row => row.enterpriseId)).toEqual([pendingId])
  expect(expired).toMatchObject({ total: 1, uncertainTotal: 0, publishedPending: { requested: true, rows: [], total: 0 } })
  expect(expired.rows[0]!.qualificationAssessment.titles[2]!.effectiveQualification?.status).toBe('expired')
  expect(expired.rows[0]!.qualificationAssessment.titles[2]!.completeness.fieldGaps).toEqual([
    { eventId: reviewId, field: 'decidedYear', valueState: 'unknown', inputState: 'null' },
    { eventId: reviewId, field: 'reviewOutcome', valueState: 'unknown', inputState: 'null' },
  ])
  sameCurrentFacts(expired, await sdk({ q: 'synthetic_408_public', status: 'expired' }))
})

it('real_transports_distinguish_unrequested_pending_and_requested_empty_408', async () => {
  const absent = await http(), absentSdk = await sdk()
  expect(absent.publishedPending).toMatchObject({ requested: false, rows: [], total: 0 })
  sameCurrentFacts(absent, absentSdk)
  const empty = await http({ q: 'synthetic_408_no_such_enterprise' })
  expect(empty).toMatchObject({ rows: [], total: 0, uncertainTotal: 0, publishedPending: { requested: true, rows: [], total: 0 } })
  sameCurrentFacts(empty, await sdk({ q: 'synthetic_408_no_such_enterprise' }))
})

it.each([
  { id: 'different_valid_year', args: { validYear: 2027 } },
  { id: 'unknown_batch', args: { maintenanceYear: 2024, maintenanceBatch: 2 } },
])('real_expired_identity_is_not_a_definite_filter_hit_408_$id', async ({ args }) => {
  const known = await http({ q: 'synthetic_408_public_pending', status: 'expired', validYear: '2028', maintenanceYear: '2024' })
  expect(known.rows.map(row => row.enterpriseId)).toEqual([pendingId])
  expect(known.rows[0]).toMatchObject({ matchedValidYears: [2028], matchedMaintenance: [{ year: 2024, batch: null }] })
  sameCurrentFacts(known, await sdk({ q: 'synthetic_408_public_pending', status: 'expired', validYear: 2028, maintenanceYear: 2024 }))
  const query = Object.fromEntries(Object.entries(args).map(([key, value]) => [key, String(value)]))
  const a = await http({ q: 'synthetic_408_public_pending', ...query })
  expect(a).toMatchObject({ rows: [], total: 0, uncertainTotal: 0, publishedPending: { rows: [], total: 0 } })
  sameCurrentFacts(a, await sdk({ q: 'synthetic_408_public_pending', ...args }))
  const expired = await http({ q: 'synthetic_408_public_pending', status: 'expired', ...query })
  expect(expired).toMatchObject({ rows: [], total: 0, uncertainTotal: 0, publishedPending: { rows: [], total: 0 } })
  sameCurrentFacts(expired, await sdk({ q: 'synthetic_408_public_pending', status: 'expired', ...args }))
})

it('real_date_precision_and_deep_pages_keep_legacy_totals_408', async () => {
  const full = await http({ recognitionFrom: `${year}-01-01`, recognitionTo: `${year}-12-31`, pageSize: '1' })
  expect(full).toMatchObject({ total: 1, uncertainTotal: 0, options: { recognitionYears: [year] } })
  const partial = await http({ recognitionFrom: `${year}-02-01`, recognitionTo: `${year}-12-31` })
  expect(partial).toMatchObject({ rows: [], total: 0, uncertainTotal: 1 })
  sameCurrentFacts(partial, await sdk({ recognitionFrom: `${year}-02-01`, recognitionTo: `${year}-12-31` }))
  const deep = await http({ q: 'synthetic_408_public', page: '9', pageSize: '1' })
  expect(deep).toMatchObject({ rows: [], total: 1, publishedPending: { rows: [], total: 0 }, page: 9 })
  const expired = await http({ q: 'synthetic_408_public', status: 'expired', page: '9', pageSize: '1' })
  expect(expired).toMatchObject({ rows: [], total: 1, publishedPending: { rows: [], total: 0 }, page: 9 })
  sameCurrentFacts(expired, await sdk({ q: 'synthetic_408_public', status: 'expired', page: 9, pageSize: 1 }))
  sameCurrentFacts(deep, await sdk({ q: 'synthetic_408_public', page: 9, pageSize: 1 }))
})

it('real_http_400_and_sdk_original_argument_validation_keep_bounds_408', async () => {
  const before = databaseContent()
  for (const args of [{ titleCode: 'invalid' }, { pageSize: 201 }, { maintenanceBatch: 2 }, { recognitionFrom: '2024-02-30', recognitionTo: '2024-12-31' }, { unsupported408: true }]) {
    const response = await fetch(base + '/api/roster/current-enterprises?' + new URLSearchParams({ titleCode: 'innovative_sme', ...Object.fromEntries(Object.entries(args).map(([key, value]) => [key, String(value)])) }))
    expect(response.status).toBe(400)
    await expect(client!.callTool({ name: 'list_current_qualified_enterprises', arguments: { titleCode: 'innovative_sme', ...args } }, CallToolResultSchema))
      .rejects.toMatchObject({ code: 400, message: expect.stringContaining('Invalid or unsupported current qualified enterprise query parameters') })
  }
  // Public pageSize200 is allowed; this tiny fixture is NOT max-frame capacity evidence.
  expect((await http({ pageSize: '200' })).pageSize).toBe(200)
  expect(databaseContent()).toBe(before)
})

it('real_executor_unavailable_is_503_then_retry_recovers_not_zero_408', async () => {
  const before = databaseContent(), path = fixture!.sqlite.name, unavailable = path + '.temporarily-unavailable'
  // Only this owned synthetic file is renamed, with no writes while absent.
  // The actual native executor realpath check must fail; nothing is mocked.
  renameSync(path, unavailable)
  try {
    const response = await fetch(base + '/api/roster/current-enterprises?titleCode=innovative_sme')
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('"rows":[]')
  } finally { renameSync(unavailable, path) }
  expect((await http()).rows.map(row => row.enterpriseId)).toEqual([eligibleId])
  expect(databaseContent()).toBe(before)
})

it('dev_generated_openapi_and_actual_sdk_describe_five_states_and_empty_pending_408', async () => {
  // Actual dev-generated spec, not a static route string or compiled artifact claim.
  const response = await fetch(base + '/_openapi.json')
  expect(response.status).toBe(200)
  const spec = await response.json()
  const operation = spec.paths['/api/roster/current-enterprises'].get
  expect(operation.responses['400']).toBeDefined(); expect(operation.responses['503']).toBeDefined()
  expect(JSON.stringify(operation)).toContain('publishedPending')
  expect(JSON.stringify(operation)).toContain('current-qualified-478-v2')
  expect(operation.parameters.find((parameter: { name: string }) => parameter.name === 'status').schema.enum).toEqual(['effective', 'expired', 'terminated', 'moved_out', 'unrecognized'])
  const tools = await client!.listTools()
  const tool = tools.tools.find(entry => entry.name === 'list_current_qualified_enterprises')!
  expect(tool.annotations?.readOnlyHint).toBe(true)
  expect(tool.description).toContain('publishedPending')
  expect(tool.description).toContain('current-qualified-478-v2')
})
