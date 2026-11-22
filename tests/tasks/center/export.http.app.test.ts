import { spawnCompiledApp } from '../../support/owned-process.mjs'
import { CURRENT_RULE_VERSION } from '../../../layers/sme-roster/lib/roster/current-qualification'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import pg from 'pg'
import { newJobId } from '../../../layers/core/lib/job'
import ExcelJS from 'exceljs'
import { reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../../support/owned-process.mjs'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import { readDevelopmentDiscovery } from '../../roster/current-export/fixtures/specialized-export'

const dir = mkdtempSync(join(tmpdir(), 'task-export-121-'))
const headers = { 'content-type': 'application/json', authorization: 'Bearer synthetic-121' }
const exportDir = join(dir, 'exports')
let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
let pool: pg.Pool
let baseUrl: string, stop: () => Promise<void>
const request = (path: string, init?: RequestInit) => fetch(baseUrl + path, init)
const read = async (path: string, authorized = true) => (await request(path, { headers: authorized ? headers : undefined })).json()
async function submit(clientRequestId: string, extra = {}) {
  const response = await request('/api/roster/exports/current/little-giant', { method: 'POST', headers, body: JSON.stringify({ clientRequestId, ...extra }) })
  expect(response.status).toBe(202)
  return (await response.json()).jobId as string
}
async function terminal(id: string) {
  for (let n = 0; n < 600; n++) {
    const summary = await read('/api/task-center/' + id)
    if (['done', 'failed', 'cancelled'].includes(summary.state)) return summary
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  throw new Error('No terminal task ' + id)
}
async function blockExportSnapshot() {
  const blocker = await pool.connect()
  try {
    await blocker.query('BEGIN')
    await blocker.query('LOCK TABLE business.enterprise IN ACCESS EXCLUSIVE MODE')
  } catch (error) {
    blocker.release(true)
    throw error
  }
  return async () => {
    try { await blocker.query('ROLLBACK') }
    finally { blocker.release() }
  }
}
async function waitForBlockedSnapshot(id: string) {
  await expect.poll(async () => (await pool.query(`
    SELECT EXISTS (
      SELECT FROM pg_locks WHERE relation='business.enterprise'::regclass AND NOT granted
    ) AS waiting
  `)).rows[0].waiting, { timeout: 15_000 }).toBe(true)
  expect((await read('/api/task-center/' + id)).state).toBe('running')
}
async function startService(apiToken: string | null = 'synthetic-121') {
  const cwd = resolve(import.meta.dirname, '../../..'), port = await reserveLoopbackPort()
  baseUrl = `http://127.0.0.1:${port}`
  const env: NodeJS.ProcessEnv = { ...process.env, ...postgres!.env, NUXT_BUILD_DIR: join(dir, 'build'), NUXT_ROSTER_EXPORT_DIR: exportDir, NUXT_DB_READONLY: '0', NUXT_FILES_DIR: join(dir, 'files'), NUXT_INCOMING_DIR: join(dir, 'incoming') }
  env.NUXT_API_TOKEN = apiToken ?? ''
  const child = spawnCompiledApp(port, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env })
  let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-6000) })
  stop = () => stopOwnedChild(child)
  try { await waitForHttp(baseUrl + '/api/health', { child, timeoutMs: 60000 }) } catch (e) { throw new Error(String(e) + output) }
}
beforeAll(async () => {
  postgres = await postgresRuntimeFixture({ dir })
  pool = new pg.Pool({ connectionString: postgres.url })
  const { rows: [enterprise] } = await pool.query(
    "INSERT INTO business.enterprise (name, name_norm, uscc_norm, city) VALUES ('合成现名', '合成现名', '001234567890123456', '宁波市') RETURNING id",
  )
  await pool.query(`INSERT INTO business.enterprise_alias (enterprise_id, name, name_norm, source_kind, verification_status, created_at)
    VALUES ($1, '合成旧名', '合成旧名', 'manual', 'confirmed', '2026-01-01T00:00:00Z')`, [enterprise.id])
  const { rows: [record] } = await pool.query(
    "INSERT INTO business.record (enterprise_id, source, title_code, name_raw) VALUES ($1, 'jxj', 'little_giant', '合成旧名') RETURNING id", [enterprise.id],
  )
  const { rows: [event] } = await pool.query(
    "INSERT INTO business.record_event (record_id, event_type, year) VALUES ($1, 'award', $2) RETURNING id", [record.id, new Date().getFullYear()],
  )
  await pool.query(`INSERT INTO business.record_evidence (record_event_id, source_file, attachment)
    VALUES ($1, 'synthetic.xlsx', '合成公布名单')`, [event.id])
  await startService()
}, 90000)

afterAll(async () => {
  try { await stop?.() }
  finally {
    await pool?.end()
    postgres?.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, 45_000)

it('discovers module and subgroup filters in development OpenAPI and lists all startup JobSpecs', async () => {
  const contract = await readDevelopmentDiscovery()
  const parameters = contract.paths['/api/task-center'].get.parameters
  expect(parameters).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'tab', in: 'query', schema: { type: 'string', default: 'all' } }),
    expect.objectContaining({ name: 'group', in: 'query', schema: { type: 'string' } }),
  ]))
  expect(contract.paths['/api/jobs/kinds'].get.responses['200']).toBeDefined()
  const { kinds } = await read('/api/jobs/kinds', false)
  expect(kinds.map((entry: { kind: string }) => entry.kind)).toEqual([
    'current-roster-export', 'difference-snapshot', 'event-annual-correspondence', 'event-archive-candidates',
    'lead-lists-version-export', 'ocr', 'platform-query-batch', 'reconcile', 'render-pages', 'roster_export_cleanup', 'roster_task_history_cleanup',
  ])
  const snapshot = await request('/api/jobs', { method: 'POST', headers, body: JSON.stringify({ kind: 'difference-snapshot' }) })
  expect(snapshot.status).toBe(400)
  expect(await snapshot.text()).toContain('dedicated difference-snapshots endpoint')
}, 120000)

it('discovers a real export in both tabs and downloads the named workbook through its safe summary', async () => {
  // Independent legacy seed in beforeAll has no batch, page or list number.
  const expectedDisplay = Object.freeze({
    8: `${new Date().getFullYear()}年认定，《synthetic.xlsx》：未逐出处核实`,
    9: '合成旧名',
    11: '逐出处公布名见公布名称列；现用名见企业名称列；已确认曾用名仅见该列',
    12: `${new Date().getFullYear()}年认定：宁波经信来源资料\n《synthetic.xlsx》，附件：合成公布名单，未逐出处核实`,
  })
  const id = await submit('first')
  const done = await terminal(id)
  expect(done).toMatchObject({ id, group: 'export', state: 'done', export: { titleCode: 'little_giant', ruleVersion: CURRENT_RULE_VERSION, artifact: { id, availability: 'available', filename: 'current-little_giant.xlsx' } } })
  const exports = await read('/api/task-center?tab=sme-roster&group=export&titleCode=little_giant&state=done')
  expect(exports).toMatchObject({ exportReady: true, total: 1, counts: { 'sme-roster': 1 } })
  expect(exports.rows.map((row: any) => row.id)).toEqual([id])
  expect((await read('/api/task-center?tab=sme-roster&group=export&titleCode=innovative_sme')).rows).toEqual([])
  expect((await read('/api/task-center?tab=all')).rows.map((row: any) => row.id)).toContain(id)
  const response = await request(done.export.artifact.downloadUrl, { headers })
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  expect(response.headers.get('content-disposition')).toContain('current-little_giant.xlsx')
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await response.arrayBuffer()) as any)
  expect(wb.worksheets.map(w => w.name)).toEqual(['有效企业', '已到期', '已注销（吊销）', '已迁出', '未认定', '口径说明'])
  const row = wb.getWorksheet('有效企业')!.getRow(2)
  expect(row.getCell(3).value).toBe('001234567890123456')
  expect(row.getCell(2).value).toBe('合成现名')
  expect({ 8: row.getCell(8).value, 9: row.getCell(9).value, 11: row.getCell(11).value, 12: row.getCell(12).value }).toEqual(expectedDisplay)
  expect(row.getCell(9).value).toBe('合成旧名')
  expect(row.getCell(11).value).not.toContain('现已更名为')
}, 30_000)

it('rechecks artifact availability and permissions without leaking raw results or treating history as a downloadable file', async () => {
  const id = await submit('availability'), done = await terminal(id)
  const { rows: [raw] } = await pool.query('SELECT params, result FROM business.job WHERE id = $1', [id])
  const result = JSON.parse(raw.result)
  await pool.query('UPDATE business.job SET params=$1,result=$2 WHERE id=$3', [
    JSON.stringify({ ...JSON.parse(raw.params), token: 'PRIVATE_TOKEN' }),
    JSON.stringify({ ...result, raw: 'PRIVATE_RAW'.repeat(100000), privatePath: '/Users/private/export', artifact: { ...done.export.artifact, filename: '/Users/private/export.xlsx', downloadUrl: 'https://invalid.example/PRIVATE_TOKEN' } }),
    id,
  ])
  const unauthorized = await read('/api/task-center/' + id, false)
  expect(unauthorized.export).toMatchObject({ canDownload: false, canRegenerate: false, artifact: { filename: 'current-little_giant.xlsx', downloadUrl: '/api/job-artifacts/' + id } })
  expect((await request('/api/job-artifacts/' + id)).status).toBe(401)
  expect((await read('/api/task-center/' + id)).export.canDownload).toBe(true)
  for (const path of ['/api/task-center?tab=sme-roster&group=export', '/api/task-center/' + id]) {
    const response = await request(path), body = await response.text()
    expect(response.headers.get('cache-control')).toBe('no-store')
    for (const secret of ['PRIVATE_', '/Users/', 'invalid.example', '"params"', '"raw"']) expect(body).not.toContain(secret)
    expect(body.length).toBeLessThan(16000)
  }
  await pool.query('UPDATE business.job SET result=$1 WHERE id=$2', [
    JSON.stringify({ ...result, artifact: { ...done.export.artifact, expiresAt: '2000-01-01T00:00:00Z' } }), id,
  ])
  expect(await read('/api/task-center/' + id)).toMatchObject({ state: 'done', export: { canDownload: false, canRegenerate: true, artifact: { availability: 'expired' } } })
  expect((await request('/api/job-artifacts/' + id, { headers })).status).toBe(410)
  const missing = await submit('missing'), second = await terminal(missing)
  rmSync(join(exportDir, missing + '.xlsx'))
  expect(await read('/api/task-center/' + missing)).toMatchObject({ state: 'done', export: { canDownload: false, artifact: { availability: 'missing' } } })
  expect((await request(second.export.artifact.downloadUrl, { headers })).status).toBe(404)
  const regenerated = await submit('new-generation', { regenerateOf: id })
  expect(regenerated).not.toBe(id)
  const summary = await terminal(regenerated)
  expect(summary).toMatchObject({ state: 'done', export: { regenerateOf: id, canRegenerate: true }, capabilities: { retry: false } })
  expect(summary.capabilities.reason).toContain('重新生成')
  expect(await submit('new-generation', { regenerateOf: id })).toBe(regenerated)
}, 45_000)

it('keeps export cancellation pending until terminal and offers explicit regeneration after a real execution failure', async () => {
  const release = await blockExportSnapshot()
  try {
    const id = await submit('cancel-running')
    await waitForBlockedSnapshot(id)
    const running = await read('/api/task-center/' + id)
    expect(running).toMatchObject({ state: 'running', export: { canDownload: false, canRegenerate: false } })
    const queuedId = await submit('cancel-queued')
    expect(await read('/api/task-center/' + queuedId)).toMatchObject({ state: 'queued', progress: { total: null }, export: { artifact: null } })
    const denied = await request('/api/task-center/' + queuedId + '/cancel', { method: 'POST' })
    expect(denied.status).toBe(401)
    const queued = await request('/api/task-center/' + queuedId + '/cancel', { method: 'POST', headers })
    expect(await queued.json()).toMatchObject({ cancelRequested: false, task: { state: 'cancelled', export: { artifact: null, canDownload: false } } })
    const accepted = await request('/api/task-center/' + id + '/cancel', { method: 'POST', headers })
    expect(accepted.status).toBe(202)
    expect(await accepted.json()).toMatchObject({ cancelRequested: true, task: { state: 'running' } })
    expect(await terminal(id)).toMatchObject({ state: 'cancelled', export: { artifact: null, canDownload: false, canRegenerate: true }, capabilities: { cancel: false, retry: false } })
    expect((await request('/api/job-artifacts/' + id, { headers })).status).toBe(404)
  } finally { await release() }
  // A real Excel cell-limit failure, not an invented frontend terminal state.
  await pool.query('UPDATE business.enterprise SET name=$1', ['超'.repeat(33000)])
  const failed = await submit('cell-limit'), summary = await terminal(failed)
  expect(summary).toMatchObject({ state: 'failed', export: { artifact: null, canDownload: false, canRegenerate: true }, capabilities: { retry: false } })
  expect(summary.error).toContain('重新生成')
  expect((await request('/api/task-center/' + failed + '/retry', { method: 'POST', headers })).status).toBe(409)
  expect((await request('/api/job-artifacts/' + failed, { headers })).status).toBe(404)
}, 45_000)


it('restores completed artifacts and interrupted history through the task center after a real service restart', async () => {
  const completed = await submit('first'), before = await terminal(completed)
  await stop()
  const interrupted = newJobId()
  await pool.query(`
    INSERT INTO business.job(id,kind,state,params,progress,created_at)
    VALUES ($1,'current-roster-export','running','{"titleCode":"little_giant","clientRequestId":"interrupted"}','{"done":1,"total":5}',$2)
  `, [interrupted, new Date().toISOString()])
  await startService()
  expect(await read('/api/task-center/' + interrupted)).toMatchObject({ state: 'failed', export: { artifact: null, canDownload: false, canRegenerate: true } })
  expect((await read('/api/task-center/' + interrupted)).error).toContain('重启')
  const restored = await read('/api/task-center/' + completed)
  expect(restored).toMatchObject({ state: 'done', export: { artifact: { availability: 'available', sha256: before.export.artifact.sha256 } } })
  const download = await request(restored.export.artifact.downloadUrl, { headers })
  expect(download.status).toBe(200)
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await download.arrayBuffer()) as any)
  expect(wb.getWorksheet('有效企业')!.getRow(2).getCell(2).value).toBe('合成现名')
  expect(await submit('first')).toBe(completed)
}, 90000)

it('cross-site and missing-marker requests retain the external REST token path', async () => {
  await pool.query('UPDATE business.enterprise SET name=$1', ['合成现名'])
  for (const [name, browser] of Object.entries<Record<string, string>>({
    crossSite: { 'x-task-center-browser': '1', 'sec-fetch-site': 'cross-site', origin: 'http://evil.invalid' },
    missingMarker: { 'sec-fetch-site': 'same-origin', origin: baseUrl },
  })) {
    const path = '/api/roster/exports/current/little-giant'
    const body = JSON.stringify({ clientRequestId: 'fallback-' + name })
    expect((await request(path, { method: 'POST', headers: { ...browser, 'content-type': 'application/json' }, body })).status).toBe(401)
    const accepted = await request(path, { method: 'POST', headers: { ...browser, ...headers }, body })
    expect(accepted.status).toBe(202)
    const id = (await accepted.json()).jobId
    await terminal(id)
    expect(await read('/api/task-center/' + id)).toMatchObject({ export: { canDownload: true, canRegenerate: true } })
  }
}, 40_000)

it('default same-origin browser flow submits views cancels regenerates and downloads without API token', async () => {
  await stop()
  await pool.query('UPDATE business.enterprise SET name = $1 WHERE uscc_norm = $2', ['合成现名', '001234567890123456'])
  await startService(null)
  const browserHeaders = {
    'x-task-center-browser': '1', 'sec-fetch-site': 'same-origin',
    origin: baseUrl, referer: baseUrl + '/tasks', 'content-type': 'application/json',
  }
  const browserRead = async (path: string) => {
    const response = await request(path, { headers: browserHeaders })
    expect(response.status).toBe(200)
    return response.json()
  }
  const browserSubmit = async (key: string, extra = {}, title = 'little-giant') => {
    const response = await request('/api/roster/exports/current/' + title, { method: 'POST', headers: browserHeaders, body: JSON.stringify({ clientRequestId: key, ...extra }) })
    expect(response.status).toBe(202)
    return (await response.json()).jobId as string
  }
  for (const title of ['little-giant', 'specialized-sme', 'innovative-sme']) {
    const id = await browserSubmit('browser-' + title, {}, title)
    expect(await browserSubmit('browser-' + title, {}, title)).toBe(id)
    await terminal(id)
    const summary = await browserRead('/api/task-center/' + id)
    expect(summary).toMatchObject({ state: 'done', export: { canDownload: true, canRegenerate: true } })
    const list = await browserRead('/api/task-center?tab=sme-roster&group=export')
    expect(list.rows.some((row: any) => row.id === id)).toBe(true)
    const download = await request(summary.export.artifact.downloadUrl, { headers: browserHeaders })
    expect(download.status).toBe(200)
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await download.arrayBuffer()) as any)
    expect(wb.worksheets.map(w => w.name)).toEqual(['有效企业', '已到期', '已注销（吊销）', '已迁出', '未认定', '口径说明'])
    expect((await request(summary.export.artifact.downloadUrl)).status).toBe(401)
    const regenerated = await browserSubmit('browser-regenerate-' + title, { regenerateOf: id }, title)
    expect(regenerated).not.toBe(id)
    expect(await terminal(regenerated)).toMatchObject({ state: 'done', export: { regenerateOf: id } })
  }
  const release = await blockExportSnapshot()
  try {
    const id = await browserSubmit('browser-cancel')
    await waitForBlockedSnapshot(id)
    const queuedId = await browserSubmit('browser-cancel-queued')
    expect(await browserRead('/api/task-center/' + queuedId)).toMatchObject({ state: 'queued', capabilities: { cancel: true } })
    const path = '/api/task-center/' + queuedId + '/cancel'
    for (const invalid of [{ ...browserHeaders, 'sec-fetch-site': 'cross-site' }, { ...browserHeaders, 'x-task-center-browser': '' }]) {
      expect((await request(path, { method: 'POST', headers: invalid, body: '{}' })).status).toBe(401)
    }
    const cancelled = await request(path, { method: 'POST', headers: browserHeaders, body: '{}' })
    expect(cancelled.status).toBe(200)
    expect(await cancelled.json()).toMatchObject({ task: { state: 'cancelled' }, cancelRequested: false })
    const running = await request('/api/task-center/' + id + '/cancel', { method: 'POST', headers: browserHeaders, body: '{}' })
    expect(running.status).toBe(202)
    expect(await running.json()).toMatchObject({ task: { state: 'running' }, cancelRequested: true })
    expect(await terminal(id)).toMatchObject({ state: 'cancelled' })
  } finally { await release() }
}, 150_000)
