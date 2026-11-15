import { createHash } from 'node:crypto'
import { get } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import ExcelJS from 'exceljs'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { initializeDb, schema as s } from '../../../db/client'
import { spawnOwnedChild as spawn, reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../../support/owned-process.mjs'
import { exportCandidate, seedDisconnectedExportFixture } from './fixtures/disconnected-export'

// Actual Nuxt HTTP and its native subprocess/drain. Only setup/fault injection
// touches the isolated synthetic fixture; all export/log assertions use public HTTP.
const root = mkdtempSync('/tmp/export-188-')
const dbPath = join(root, 'synthetic.db'), logDir = join(root, 'logs')
const db = initializeDb({ create: true,  dbPath })
const token = 'synthetic-export-188-token'
const privateText = 'PRIVATE_EXPORT188_CONTENT'
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
const endpoint = '/api/roster/exports/current/specialized-sme'
let child: ReturnType<typeof spawn>, baseUrl = '', output = ''
const url = (path: string) => baseUrl + path
async function json(response: Response) { return response.json() as Promise<any> }
async function logs(filter: Record<string, string> = {}) {
  const response = await fetch(url('/api/logs?' + new URLSearchParams({ limit: '100', ...filter })), { headers })
  expect(response.status, output.slice(-3000)).toBe(200)
  const listed = await json(response)
  return Promise.all(listed.rows.map(async (row: any) => {
    const detail = await fetch(url('/api/logs/' + row.id), { headers })
    expect(detail.status).toBe(200)
    return json(detail)
  }))
}
async function waitLogs(filter: Record<string, string>, check: (events: any[]) => void) {
  const deadline = Date.now() + 10000
  let last: unknown
  while (Date.now() < deadline) {
    try { const events = await logs(filter); check(events); return events } catch (error) { last = error }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw last
}
async function terminal(id: string, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const response = await fetch(url('/api/jobs/' + id)); expect(response.status).toBe(200)
    const job = await json(response)
    if (['done', 'failed', 'cancelled'].includes(job.state)) return job
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  throw new Error('synthetic export did not finish')
}
async function submit(key: string, extra = {}) {
  const response = await fetch(url(endpoint), { method: 'POST', headers: { ...headers, 'x-request-id': privateText }, body: JSON.stringify({ clientRequestId: key, ...extra }) })
  expect(response.status).toBe(202)
  return { accepted: await json(response), requestId: response.headers.get('x-request-id')! }
}
async function original(path: string, name: string) {
  const response = await fetch(url(path), { headers })
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('spreadsheetml.sheet')
  const bytes = Buffer.from(await response.arrayBuffer())
  writeFileSync(join(root, name + '.xlsx'), bytes)
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(bytes as any)
  return { wb, bytes, response }
}
function businessDigest() {
  const hash = createHash('sha256')
  for (const table of ['enterprise', 'enterprise_alias', 'record', 'record_event', 'record_evidence', 'platform_collection', 'platform_business_observation', 'platform_observation_assignment', 'platform_archive_value', 'platform_collection_archive_ref', 'platform_observation_archive_ref', 'difference_reason', 'record_correspondence']) {
    for (const row of db.$client.prepare('select * from ' + table + ' order by rowid').iterate()) hash.update(JSON.stringify(row))
  }
  return hash.digest('hex')
}
function candidate(name: string, titleCode = 'specialized_sme') {
  return exportCandidate(db, name, titleCode)
}
async function start(logDirectory = logDir) {
  const cwd = resolve(import.meta.dirname, '../../..'), port = await reserveLoopbackPort()
  // Native modules resolve from the emitted chunk under this external buildDir.
  if (!existsSync(join(root, 'node_modules'))) symlinkSync(join(cwd, 'node_modules'), join(root, 'node_modules'), 'dir')
  baseUrl = `http://127.0.0.1:${port}`
  const built = process.env.EXPORT188_BUILT === '1'
  child = spawn(process.execPath, built ? ['.output/server/index.mjs'] : [join(cwd, 'node_modules/nuxt/bin/nuxt.mjs'), 'dev', '--host', '127.0.0.1', '--port', String(port)], {
    cwd, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, NUXT_BUILD_DIR: join(root, 'build'), NUXT_DB_PATH: dbPath, NUXT_LOG_DIR: logDirectory,
      NUXT_API_TOKEN: token, NUXT_MCP_TOKEN: 'synthetic-mcp-188', NUXT_OCR_TOKEN: 'synthetic-ocr-188',
      NUXT_BROWSER_TASKS_ENABLED: 'false',
      NUXT_FILES_DIR: join(root, 'files'), NUXT_INCOMING_DIR: join(root, 'incoming'),
      NUXT_CURATED_PATH: join(root, 'curated.json'), NUXT_RECONCILE_PATH: join(root, 'reconcile.json'),
      HOST: '127.0.0.1', PORT: String(port), NITRO_HOST: '127.0.0.1', NITRO_PORT: String(port),
    },
  })
  for (const stream of [child.stdout!, child.stderr!]) stream.on('data', data => { output += data.toString() })
  await waitForHttp(url('/api/jobs/kinds'), { timeoutMs: 60000, child })
  expect(output).toContain(`127.0.0.1:${port}`)
  writeFileSync(join(root, 'fixture.txt'), root)
}
beforeAll(async () => {
  candidate(privateText)
  await start()
}, 90000)
afterAll(async () => {
  await stopOwnedChild(child)
  writeFileSync(join(root, 'server.log'), output)
  db.$client.close()
})

it('exports an original XLSX with correlated summary workbook publish and download events', async () => {
  const digest = businessDigest()
  const { accepted, requestId } = await submit(privateText)
  const job = await terminal(accepted.jobId)
  expect(job.state, JSON.stringify(job)).toBe('done')
  expect(job.result.counts).toEqual({ eligible: 1, pending: 0, excluded: 0 })
  const { wb, bytes, response } = await original(job.result.artifact.downloadUrl, 'async-original')
  expect(wb.worksheets.map(sheet => sheet.name)).toEqual(['有效企业', '已到期', '已注销（吊销）', '已迁出', '未认定', '口径说明'])
  expect(wb.getWorksheet('有效企业')!.getRow(2).getCell(2).value).toBe(privateText)
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(job.result.artifact.sha256)
  expect(bytes.length).toBe(job.result.artifact.size)
  const events = await waitLogs({ taskId: job.id }, events => {
    for (const operation of ['export.current.summary', 'export.current.workbook', 'export.current.publish', 'export.current.cleanup', 'export.artifact.download']) {
      expect(events.filter(row => row.operation === operation && row.outcome === 'success'), operation).toHaveLength(1)
    }
  })
  for (const event of events.filter(row => row.operation.startsWith('export.current.'))) expect(event.requestId).toBe(requestId)
  expect(events.find(row => row.operation === 'export.artifact.download')!.requestId).toBe(response.headers.get('x-request-id'))
  expect(events.find(row => row.operation === 'export.current.summary' && row.outcome === 'success')!.counts).toEqual({ done: 1, total: 1 })
  const serialized = JSON.stringify(events)
  expect(serialized).not.toContain(privateText)
  expect(serialized).not.toContain(token)
  expect(serialized).not.toContain(root)
  expect(readFileSync(join(logDir, 'events.db')).toString()).not.toContain(privateText)
  expect(businessDigest()).toBe(digest)
}, 45000)

it('preserves both legacy original XLSX downloads and records their separate phases', async () => {
  for (const [path, kind, sheet] of [['/api/export', 'records', '台账'], ['/api/roster/export', 'enterprises', '企业总表']] as const) {
    const { wb, response } = await original(path, 'legacy-' + kind)
    const ws = wb.getWorksheet(sheet)!
    expect(ws.rowCount).toBe(3)
    expect(ws.getRow(3).getCell(1).value).toBe(privateText)
    const events = await waitLogs({ requestId: response.headers.get('x-request-id')! }, events => {
      for (const phase of ['summary', 'workbook', 'download', 'cleanup']) {
        expect(events.filter(row => row.operation === `export.legacy.${kind}.${phase}` && row.outcome === 'success'), phase).toHaveLength(1)
      }
    })
    expect(JSON.stringify(events)).not.toContain(privateText)
    expect(JSON.stringify(events)).not.toContain(root)
  }
}, 45000)

it('distinguishes denied invalid missing and expired artifacts without publishing a replacement', async () => {
  const { accepted } = await submit('188-download-boundaries')
  const job = await terminal(accepted.jobId)
  const path = job.result.artifact.downloadUrl
  for (const authorization of ['', 'Bearer invalid-synthetic']) {
    const response = await fetch(url(path), { headers: { authorization } })
    expect(response.status).toBe(401)
    const events = await waitLogs({ requestId: response.headers.get('x-request-id')! }, events => {
      expect(events.filter(row => row.operation === 'export.artifact.download')).toHaveLength(1)
    })
    const denied = events.find(row => row.operation === 'export.artifact.download')!
    expect(denied).toMatchObject({ outcome: 'denied', errorCode: 'artifact_access_denied', statusCode: 401 })
    expect(denied).not.toHaveProperty('taskId')
  }
  const invalid = await fetch(url('/api/job-artifacts/PRIVATE_EXPORT188_INVALID'), { headers })
  expect(invalid.status).toBe(400)
  await waitLogs({ requestId: invalid.headers.get('x-request-id')! }, events => {
    expect(events.find(row => row.operation === 'export.artifact.download')).toMatchObject({ errorCode: 'invalid_artifact_id', statusCode: 400 })
    expect(JSON.stringify(events)).not.toContain('PRIVATE_EXPORT188_INVALID')
  })
  db.update(s.job).set({ result: { ...job.result, artifact: { ...job.result.artifact, expiresAt: '2000-01-01T00:00:00Z' } } }).where(eq(s.job.id, job.id)).run()
  const expired = await fetch(url(path), { headers }); expect(expired.status).toBe(410)
  await waitLogs({ requestId: expired.headers.get('x-request-id')! }, events => {
    expect(events.find(row => row.operation === 'export.artifact.download')).toMatchObject({ taskId: job.id, errorCode: 'artifact_expired', statusCode: 410 })
  })
  expect(existsSync(join(dbPath + '.exports', job.id + '.xlsx'))).toBe(false)
  expect((await terminal(job.id)).state).toBe('done')
  const next = await submit('188-missing-artifact'), missing = await terminal(next.accepted.jobId)
  rmSync(join(dbPath + '.exports', missing.id + '.xlsx'))
  const absent = await fetch(url(missing.result.artifact.downloadUrl), { headers }); expect(absent.status).toBe(404)
  await waitLogs({ requestId: absent.headers.get('x-request-id')! }, events => {
    expect(events.find(row => row.operation === 'export.artifact.download')).toMatchObject({ errorCode: 'artifact_unavailable', statusCode: 404 })
  })
}, 45000)

it('preserves rejected export requests and records semantic denials without query or body text', async () => {
  for (const [path, init, operation, status] of [
    [endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientRequestId: privateText }) }, 'export.current.submission', 401],
    [endpoint, { method: 'POST', headers, body: JSON.stringify({ clientRequestId: privateText, titleCode: privateText }) }, 'export.current.submission', 400],
    ['/api/export?mode=comparison&q=' + privateText, { headers }, 'export.legacy.comparison.summary', 400],
    ['/api/roster/export?title=' + privateText, { headers }, 'export.legacy.enterprises.summary', 400],
  ] as const) {
    const response = await fetch(url(path), init)
    expect(response.status).toBe(status)
    expect(response.headers.get('content-disposition')).toBeNull()
    expect((await json(response)).statusCode).toBe(status)
    await waitLogs({ requestId: response.headers.get('x-request-id')! }, events => {
      expect(events.filter(row => row.operation === operation)).toContainEqual(expect.objectContaining({ outcome: 'denied', statusCode: status }))
      expect(JSON.stringify(events)).not.toContain(privateText)
      expect(events.some(row => row.operation.endsWith('.publish'))).toBe(false)
    })
  }
}, 45000)

it('cleans a failed workbook and regenerates once while duplicate submission reuses the published artifact', async () => {
  const broken = candidate('PRIVATE_EXPORT188_TOO_LONG')
  db.update(s.enterprise).set({ name: 'X'.repeat(33000) }).where(eq(s.enterprise.id, broken.id)).run()
  const first = await submit('188-failure'), failed = await terminal(first.accepted.jobId)
  expect(failed.state).toBe('failed')
  expect(failed.error).toContain('Excel')
  expect(failed.result.artifact).toBeUndefined()
  for (const ext of ['.part', '.xlsx']) expect(existsSync(join(dbPath + '.exports', failed.id + ext))).toBe(false)
  await waitLogs({ taskId: failed.id }, events => {
    expect(events.find(row => row.operation === 'export.current.workbook' && row.outcome === 'failure')).toMatchObject({ errorCode: 'workbook_limit' })
    expect(events.find(row => row.operation === 'export.current.cleanup')).toMatchObject({ outcome: 'success' })
    expect(events.some(row => row.operation === 'export.current.publish' && row.outcome === 'success')).toBe(false)
  })
  db.update(s.enterprise).set({ name: 'PRIVATE_EXPORT188_TOO_LONG' }).where(eq(s.enterprise.id, broken.id)).run()
  const next = await submit('188-regenerate', { regenerateOf: failed.id }), done = await terminal(next.accepted.jobId)
  expect(done.state).toBe('done')
  expect(done.result.counts).toEqual({ eligible: 2, pending: 0, excluded: 0 })
  const originalBytes = (await original(done.result.artifact.downloadUrl, 'regenerated-original')).bytes
  expect((await submit('188-regenerate', { regenerateOf: failed.id })).accepted.jobId).toBe(done.id)
  expect((await original(done.result.artifact.downloadUrl, 'deduplicated-original')).bytes).toEqual(originalBytes)
  await waitLogs({ taskId: done.id }, events => {
    expect(events.filter(row => row.operation === 'export.current.publish' && row.outcome === 'success')).toHaveLength(1)
    expect(events.filter(row => row.operation === 'export.current.workbook' && row.outcome === 'success')).toHaveLength(1)
    expect(events.find(row => row.operation === 'export.current.regenerate')).toMatchObject({ resourceType: 'export_job', resourceId: failed.id, taskId: done.id })
  })
}, 45000)

it('cancels a running export through HTTP and removes its unpublished artifact', async () => {
  const { accepted } = await submit('188-running-cancel')
  // Submission starts the job immediately; the subprocess has a real startup
  // boundary before work can finish. Observe running before requesting cancel.
  const running = await json(await fetch(url('/api/jobs/' + accepted.jobId)))
  expect(running.state).toBe('running')
  const cancel = await fetch(url('/api/jobs/' + accepted.jobId), { method: 'DELETE', headers })
  expect(cancel.status).toBe(202)
  const job = await terminal(accepted.jobId); expect(job.state).toBe('cancelled')
  for (const ext of ['.part', '.xlsx']) expect(existsSync(join(dbPath + '.exports', job.id + ext))).toBe(false)
  await waitLogs({ taskId: job.id }, events => {
    expect(events.find(row => row.operation === 'export.current.process' && row.outcome === 'cancelled')).toMatchObject({ errorCode: 'export_cancelled' })
    expect(events.find(row => row.operation === 'export.current.cleanup')).toMatchObject({ outcome: 'success' })
    expect(events.some(row => row.operation === 'export.current.publish' && row.outcome === 'success')).toBe(false)
  })
}, 45000)

it('reports an atomic publication fault and unsuccessful cleanup without exposing an artifact', async () => {
  const { accepted } = await submit('188-publish-fault')
  const finalPath = join(dbPath + '.exports', accepted.jobId + '.xlsx')
  mkdirSync(finalPath, { recursive: true }) // External filesystem fault, isolated fixture only.
  try {
    const failed = await terminal(accepted.jobId)
    expect(failed.state).toBe('failed')
    expect(failed.result.artifact).toBeUndefined()
    expect((await fetch(url('/api/job-artifacts/' + failed.id), { headers })).status).toBe(404)
    expect(existsSync(join(dbPath + '.exports', failed.id + '.part'))).toBe(false)
    await waitLogs({ taskId: failed.id }, events => {
      expect(events.find(row => row.operation === 'export.current.publish' && row.outcome === 'failure')).toMatchObject({ errorCode: 'artifact_publish_failed' })
      expect(events.find(row => row.operation === 'export.current.cleanup')).toMatchObject({ outcome: 'failure', counts: { failed: 1 } })
      expect(events.some(row => row.operation === 'export.current.publish' && row.outcome === 'success')).toBe(false)
    })
  } finally { rmSync(finalPath, { recursive: true, force: true }) }
}, 45000)

it('distinguishes actual HTTP disconnects for artifact and both legacy streams while retaining published bytes', async () => {
  // Exceed the OS socket buffers. A small XLSX can be fully sent before the
  // client's first data callback, in which case server-side success is correct.
  // Keep socket EOF/idle timers responsive while preparing the large fixture.
  await seedDisconnectedExportFixture(dbPath)
  const response = await fetch(url('/api/roster/exports/current/innovative-sme'), { method: 'POST', headers, body: JSON.stringify({ clientRequestId: '188-disconnect' }) })
  expect(response.status).toBe(202)
  const job = await terminal((await json(response)).jobId, 90000)
  expect(job.state).toBe('done')
  expect(job.result.counts).toEqual({ eligible: 30000, pending: 0, excluded: 0 })
  async function disconnect(path: string) {
    return new Promise<string>((resolve, reject) => {
      const request = get(url(path), { headers }, res => {
        if (res.statusCode !== 200) { res.resume(); reject(new Error('download status ' + res.statusCode)); return }
        if (Number(res.headers['content-length']) < 4 * 1024 * 1024) { res.resume(); reject(new Error('fixture too small for a real stream disconnect')); return }
        res.once('data', () => { const requestId = String(res.headers['x-request-id']); res.destroy(); request.destroy(); resolve(requestId) })
      })
      request.once('error', reject)
    })
  }
  for (const [path, operation] of [[job.result.artifact.downloadUrl, 'export.artifact.download'], ['/api/export?title=innovative_sme', 'export.legacy.records.download'], ['/api/roster/export?title=innovative_sme', 'export.legacy.enterprises.download']]) {
    const requestId = await disconnect(path)
    await waitLogs({ requestId }, events => {
      expect(events.filter(row => row.operation === operation)).toHaveLength(1)
      expect(events.find(row => row.operation === operation)).toMatchObject({ outcome: 'cancelled', errorCode: 'download_disconnected' })
      expect(events.filter(row => row.operation === 'http.request')).toHaveLength(1)
      if (operation.startsWith('export.legacy.')) expect(events.find(row => row.operation === operation.replace('.download', '.cleanup'))).toMatchObject({ outcome: 'success' })
    })
  }
  const { bytes, wb } = await original(job.result.artifact.downloadUrl, 'after-disconnect-original')
  expect(wb.getWorksheet('有效企业')!.rowCount).toBe(30001)
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(job.result.artifact.sha256)
}, 180000)

it('returns independently readable originals when the real logging storage is unavailable', async () => {
  await stopOwnedChild(child)
  const blocked = join(root, 'log-directory-is-a-file'); writeFileSync(blocked, 'synthetic storage fault')
  await start(blocked)
  const { accepted } = await submit('188-log-fault'), job = await terminal(accepted.jobId)
  expect(job.state).toBe('done')
  const expected = (await original(job.result.artifact.downloadUrl, 'fault-async-original')).wb
  expect(expected.getWorksheet('有效企业')!.getRow(2).getCell(2).value).toBe(privateText)
  const digest = businessDigest()
  const expectedNames=(db.$client.prepare("select r.name_raw name from record r where r.title_code='specialized_sme' order by r.id").all() as {name:string}[]).map(row=>row.name)
  for (const [path, sheet] of [['/api/export?title=specialized_sme', '台账'], ['/api/roster/export?title=specialized_sme', '企业总表']] as const) {
    const { wb } = await original(path, 'fault-' + sheet)
    expect(wb.getWorksheet(sheet)!.getColumn(1).values).toContain(privateText)
    expect(wb.getWorksheet(sheet)!.rowCount).toBe(expectedNames.length+2)
    for(const name of expectedNames) expect(wb.getWorksheet(sheet)!.getColumn(1).values).toContain(name)
  }
  expect(businessDigest()).toBe(digest)
  const response = await fetch(url('/api/logs'), { headers }); expect(response.status).toBe(503)
  const unavailable = await json(response)
  expect(unavailable.status).toMatchObject({ unavailable: true })
  expect(unavailable.status.dropped).toBeGreaterThan(0)
  expect(output).toContain('logging.drain')
  expect(output).not.toContain(privateText)
  expect(output).not.toContain(token)
}, 90000)

