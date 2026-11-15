import { spawnCompiledApp } from '../../support/owned-process.mjs'
import { CURRENT_RULE_VERSION, QUALIFICATION_ASSESSMENT_VERSION } from '../../../lib/roster/current-qualification'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { eq } from 'drizzle-orm'
import { newJobId } from '../../../lib/job'
import ExcelJS from 'exceljs'
import { initializeDb, schema as s } from '../../../db/client'
import { spawnOwnedChild as spawn, reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../../support/owned-process.mjs'

const dir = mkdtempSync(join(tmpdir(), 'task-export-121-'))
const dbPath = join(dir, 'synthetic.db'), db = initializeDb({ create: true,  dbPath })
const headers = { 'content-type': 'application/json', authorization: 'Bearer synthetic-121' }
let serverPid: number | undefined
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
async function startService(apiToken: string | null = 'synthetic-121') {
  const cwd = resolve(import.meta.dirname, '../../..'), port = await reserveLoopbackPort()
  baseUrl = `http://127.0.0.1:${port}`
  const env: NodeJS.ProcessEnv = { ...process.env, NUXT_BUILD_DIR: join(dir, 'build'), NUXT_DB_PATH: dbPath, NUXT_FILES_DIR: join(dir, 'files'), NUXT_INCOMING_DIR: join(dir, 'incoming') }
  delete env.NUXT_API_TOKEN
  if (apiToken !== null) env.NUXT_API_TOKEN = apiToken
  const child = spawnCompiledApp(port, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env })
  serverPid = child.pid
  let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-6000) })
  stop = () => stopOwnedChild(child)
  try { await waitForHttp(baseUrl + '/api/jobs/kinds', { child, timeoutMs: 60000 }) } catch (e) { throw new Error(String(e) + output) }
}
beforeAll(async () => {
  const enterprise = db.insert(s.enterprise).values({ name: '合成现名', nameNorm: '合成现名', usccNorm: '001234567890123456', city: '宁波市' }).returning().get()
  db.insert(s.enterpriseAlias).values({ enterpriseId: enterprise.id, name: '合成旧名', nameNorm: '合成旧名', sourceKind: 'manual', verificationStatus: 'confirmed' }).run()
  const record = db.insert(s.record).values({ enterpriseId: enterprise.id, source: 'jxj', titleCode: 'little_giant', nameRaw: '合成旧名' }).returning().get()
  const event = db.insert(s.recordEvent).values({ recordId: record.id, eventType: 'award', year: new Date().getFullYear() }).returning().get()
  db.insert(s.recordEvidence).values({ recordEventId: event.id, sourceFile: 'synthetic.xlsx', attachment: '合成公布名单' }).run()
  await startService()
}, 90000)

afterAll(async () => { await stop?.(); db.$client.close(); rmSync(dir, { recursive: true, force: true }) })

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
  const exports = await read('/api/task-center?tab=export&titleCode=little_giant&state=done')
  expect(exports).toMatchObject({ exportReady: true, total: 1, counts: { export: 1 } })
  expect(exports.rows.map((row: any) => row.id)).toEqual([id])
  expect((await read('/api/task-center?tab=export&titleCode=innovative_sme')).rows).toEqual([])
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
})

it('rechecks artifact availability and permissions without leaking raw results or treating history as a downloadable file', async () => {
  const id = await submit('availability'), done = await terminal(id)
  const raw = db.select().from(s.job).where(eq(s.job.id, id)).get()!
  db.update(s.job).set({ params: { ...raw.params, token: 'PRIVATE_TOKEN' }, result: { ...(raw.result as object), raw: 'PRIVATE_RAW'.repeat(100000), privatePath: '/Users/private/export', artifact: { ...done.export.artifact, filename: '/Users/private/export.xlsx', downloadUrl: 'https://invalid.example/PRIVATE_TOKEN' } } }).where(eq(s.job.id, id)).run()
  const unauthorized = await read('/api/task-center/' + id, false)
  expect(unauthorized.export).toMatchObject({ canDownload: false, canRegenerate: false, artifact: { filename: 'current-little_giant.xlsx', downloadUrl: '/api/job-artifacts/' + id } })
  expect((await request('/api/job-artifacts/' + id)).status).toBe(401)
  expect((await read('/api/task-center/' + id)).export.canDownload).toBe(true)
  for (const path of ['/api/task-center?tab=export', '/api/task-center/' + id]) {
    const response = await request(path), body = await response.text()
    expect(response.headers.get('cache-control')).toBe('no-store')
    for (const secret of ['PRIVATE_', '/Users/', 'invalid.example', '"params"', '"raw"']) expect(body).not.toContain(secret)
    expect(body.length).toBeLessThan(16000)
  }
  db.update(s.job).set({ result: { ...(raw.result as any), artifact: { ...done.export.artifact, expiresAt: '2000-01-01T00:00:00Z' } } }).where(eq(s.job.id, id)).run()
  expect(await read('/api/task-center/' + id)).toMatchObject({ state: 'done', export: { canDownload: false, canRegenerate: true, artifact: { availability: 'expired' } } })
  expect((await request('/api/job-artifacts/' + id, { headers })).status).toBe(410)
  const missing = await submit('missing'), second = await terminal(missing)
  rmSync(join(dbPath + '.exports', missing + '.xlsx'))
  expect(await read('/api/task-center/' + missing)).toMatchObject({ state: 'done', export: { canDownload: false, artifact: { availability: 'missing' } } })
  expect((await request(second.export.artifact.downloadUrl, { headers })).status).toBe(404)
  const regenerated = await submit('new-generation', { regenerateOf: id })
  expect(regenerated).not.toBe(id)
  const summary = await terminal(regenerated)
  expect(summary).toMatchObject({ state: 'done', export: { regenerateOf: id, canRegenerate: true }, capabilities: { retry: false } })
  expect(summary.capabilities.reason).toContain('重新生成')
  expect(await submit('new-generation', { regenerateOf: id })).toBe(regenerated)
})

it('keeps export cancellation pending until terminal and offers explicit regeneration after a real execution failure', async () => {
  const id = await submit('cancel-running')
  let pid: number | undefined
  for (let n = 0; n < 100 && !pid; n++) {
    const line = execFileSync('ps', ['-Ao', 'pid=,ppid=,args='], { encoding: 'utf8' }).split('\n').find(l => Number(l.trim().split(/\s+/)[1]) === serverPid && l.includes('/current-export-worker.mjs'))
    if (line) pid = Number(line.trim().split(/\s+/)[0])
    else await new Promise(r => setTimeout(r, 10))
  }
  expect(pid).toBeGreaterThan(0)
  process.kill(pid!, 'SIGSTOP')
  try {
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
  } finally { try { process.kill(pid!, 'SIGCONT') } catch {} }
  // A real Excel cell-limit failure, not an invented frontend terminal state.
  db.update(s.enterprise).set({ name: '超'.repeat(33000) }).run()
  const failed = await submit('cell-limit'), summary = await terminal(failed)
  expect(summary).toMatchObject({ state: 'failed', export: { artifact: null, canDownload: false, canRegenerate: true }, capabilities: { retry: false } })
  expect(summary.error).toContain('重新生成')
  expect((await request('/api/task-center/' + failed + '/retry', { method: 'POST', headers })).status).toBe(409)
  expect((await request('/api/job-artifacts/' + failed, { headers })).status).toBe(404)
})


it('restores completed artifacts and interrupted history through the task center after a real service restart', async () => {
  const completed = await submit('first'), before = await terminal(completed)
  await stop()
  const interrupted = newJobId()
  db.insert(s.job).values({ id: interrupted, kind: 'current-roster-export', state: 'running', params: { titleCode: 'little_giant', clientRequestId: 'interrupted' }, progress: { done: 1, total: 5 } }).run()
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
  db.update(s.enterprise).set({ name: '合成现名' }).run()
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
})

it('default same-origin browser flow submits views cancels regenerates and downloads without API token', async () => {
  await stop()
  db.update(s.enterprise).set({ name: '合成现名' }).run()
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
    const list = await browserRead('/api/task-center?tab=export')
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
  const id = await browserSubmit('browser-cancel')
  let pid: number | undefined
  for (let n = 0; n < 100 && !pid; n++) {
    const line = execFileSync('ps', ['-Ao', 'pid=,ppid=,args='], { encoding: 'utf8' }).split('\n').find(l => Number(l.trim().split(/\s+/)[1]) === serverPid && l.includes('/current-export-worker.mjs'))
    if (line) pid = Number(line.trim().split(/\s+/)[0])
    else await new Promise(r => setTimeout(r, 10))
  }
  expect(pid).toBeGreaterThan(0)
  process.kill(pid!, 'SIGSTOP')
  try {
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
  } finally { try { process.kill(pid!, 'SIGCONT') } catch {} }
}, 90000)
