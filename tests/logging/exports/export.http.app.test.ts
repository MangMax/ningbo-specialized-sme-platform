import { createHash } from 'node:crypto'
import { get } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import ExcelJS from 'exceljs'
import { afterAll, beforeAll, expect, it } from 'vitest'
import pg from 'pg'
import { spawnOwnedChild as spawn, reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../../support/owned-process.mjs'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'

// Actual Nuxt HTTP and its native subprocess/drain. Only setup/fault injection
// touches the isolated synthetic fixture; all export/log assertions use public HTTP.
const root = mkdtempSync('/tmp/export-188-')
const exportDir = join(root, 'workbooks')
const token = 'synthetic-export-188-token'
const privateText = 'PRIVATE_EXPORT188_CONTENT'
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
const endpoint = '/api/roster/exports/current/specialized-sme'
let runtime: Awaited<ReturnType<typeof postgresRuntimeFixture>>
let postgres: pg.Pool
let child: ReturnType<typeof spawn>, baseUrl = '', output = ''
const url = (path: string) => baseUrl + path
async function json(response: Response) { return response.json() as Promise<any> }
// Event details are immutable. Poll only for new rows, rather than rereading
// every previously observed detail over HTTP on every drain retry.
const eventDetails = new Map<string, any>()
let lastLogStatus: unknown
async function logs(filter: Record<string, string> = {}) {
  const response = await fetch(url('/api/logs?' + new URLSearchParams({ limit: '100', ...filter })), { headers })
  expect(response.status, output.slice(-3000)).toBe(200)
  const listed = await json(response)
  lastLogStatus = listed.status
  return Promise.all(listed.rows.map(async (row: any) => {
    if (eventDetails.has(row.id)) return eventDetails.get(row.id)
    const detail = await fetch(url('/api/logs/' + row.id), { headers })
    expect(detail.status).toBe(200)
    const event = await json(detail)
    eventDetails.set(row.id, event)
    return event
  }))
}
async function waitLogs(filter: Record<string, string>, check: (events: any[]) => void) {
  const deadline = Date.now() + 10000
  let last: unknown, observed: any[] = []
  while (Date.now() < deadline) {
    try { const events = await logs(filter); observed = events; check(events); return events } catch (error) { last = error }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  // Preserve evidence when best-effort worker logging loses a terminal event.
  // Business completion and publish success do not prove the worker drain.
  writeFileSync(join(root, 'missing-log-event.json'), JSON.stringify({ filter, observed, parentLogStatus: lastLogStatus, assertion: String(last), output }, null, 2))
  throw new Error(`${String(last)}; diagnostics: ${join(root, 'missing-log-event.json')}`, { cause: last })
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
async function businessDigest() {
  const client = await postgres.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const hash = createHash('sha256')
    for (const table of ['enterprise', 'enterprise_alias', 'record', 'record_event', 'record_evidence', 'platform_collection', 'platform_business_observation', 'platform_observation_assignment', 'platform_business_record_version', 'difference_reason']) {
      const result = await client.query<{ content: string }>(`SELECT to_jsonb(t)::text AS content FROM business.${table} t ORDER BY content`)
      for (const row of result.rows) hash.update(row.content)
    }
    return hash.digest('hex')
  } finally {
    try { await client.query('ROLLBACK') } finally { client.release() }
  }
}

async function postgresCandidate(client: Pick<pg.ClientBase, 'query'>, name: string, titleCode = 'specialized_sme', attachments = ['合成名单']) {
  const { rows: [enterprise] } = await client.query<{ id: string }>(
    "INSERT INTO business.enterprise (name, name_norm, district) VALUES ($1, $1, '鄞州区') RETURNING id", [name])
  const id = enterprise!.id
  await client.query('INSERT INTO business.roster_legacy_member (enterprise_id) VALUES ($1)', [id])
  const { rows: [record] } = await client.query<{ id: string }>(
    "INSERT INTO business.record (enterprise_id, name_raw, title_code, district, source) VALUES ($1, $2, $3, '鄞州区', 'jxj') RETURNING id",
    [id, name, titleCode])
  const { rows: [event] } = await client.query<{ id: string }>(
    "INSERT INTO business.record_event (record_id, event_type, year, batch_seq) VALUES ($1, 'award', $2, 1) RETURNING id",
    [record!.id, new Date().getFullYear()])
  await client.query(`INSERT INTO business.record_evidence (record_event_id, source_file, attachment, list_no)
    SELECT $1, 'jxj/announcement/synthetic-188.xlsx', attachment, ordinal
    FROM unnest($2::text[]) WITH ORDINALITY AS a(attachment, ordinal) ORDER BY ordinal`,
  [event!.id, attachments])
  return id
}

async function start() {
  const cwd = resolve(import.meta.dirname, '../../..'), port = await reserveLoopbackPort()
  baseUrl = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['.output/server/index.mjs'], {
    cwd, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, NUXT_BUILD_DIR: join(root, 'build'), NUXT_ROSTER_EXPORT_DIR: exportDir, ...runtime.env,
      NUXT_API_TOKEN: token, NUXT_MCP_TOKEN: 'synthetic-mcp-188', NUXT_OCR_TOKEN: 'synthetic-ocr-188',
      NUXT_BROWSER_TASKS_ENABLED: 'false',
      NUXT_FILES_DIR: join(root, 'files'), NUXT_INCOMING_DIR: join(root, 'incoming'),
      HOST: '127.0.0.1', PORT: String(port), NITRO_HOST: '127.0.0.1', NITRO_PORT: String(port),
    },
  })
  for (const stream of [child.stdout!, child.stderr!]) stream.on('data', data => { output += data.toString() })
  await waitForHttp(url('/api/jobs/kinds'), { timeoutMs: 60000, child })
  expect(output).toContain(`127.0.0.1:${port}`)
  writeFileSync(join(root, 'fixture.txt'), root)
}
beforeAll(async () => {
  runtime = await postgresRuntimeFixture({ dir: root })
  postgres = new pg.Pool({ connectionString: runtime.url })
  await postgresCandidate(postgres, privateText)
  await start()
}, 90000)
afterAll(async () => {
  try { await stopOwnedChild(child) } finally {
    writeFileSync(join(root, 'server.log'), output)
    await postgres?.end()
    runtime?.close()
  }
})

it('exports an original XLSX with correlated summary workbook publish and download events', async () => {
  const digest = await businessDigest()
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
  const { rows: leaked } = await postgres.query(
    'SELECT id FROM runtime_logs.log_events WHERE position($1 in detail) > 0', [privateText])
  expect(leaked).toEqual([])
  expect(await businessDigest()).toBe(digest)
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
  await postgres.query('UPDATE business.job SET result = $1 WHERE id = $2', [
    JSON.stringify({ ...job.result, artifact: { ...job.result.artifact, expiresAt: '2000-01-01T00:00:00Z' } }), job.id,
  ])
  const expired = await fetch(url(path), { headers }); expect(expired.status).toBe(410)
  await waitLogs({ requestId: expired.headers.get('x-request-id')! }, events => {
    expect(events.find(row => row.operation === 'export.artifact.download')).toMatchObject({ taskId: job.id, errorCode: 'artifact_expired', statusCode: 410 })
  })
  expect(existsSync(join(exportDir, job.id + '.xlsx'))).toBe(false)
  expect((await terminal(job.id)).state).toBe('done')
  const next = await submit('188-missing-artifact'), missing = await terminal(next.accepted.jobId)
  rmSync(join(exportDir, missing.id + '.xlsx'))
  const absent = await fetch(url(missing.result.artifact.downloadUrl), { headers }); expect(absent.status).toBe(404)
  await waitLogs({ requestId: absent.headers.get('x-request-id')! }, events => {
    expect(events.find(row => row.operation === 'export.artifact.download')).toMatchObject({ errorCode: 'artifact_unavailable', statusCode: 404 })
  })
}, 45000)

it('preserves rejected export requests and records semantic denials without query or body text', async () => {
  for (const [path, init, operation, status] of [
    [endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientRequestId: privateText }) }, 'export.current.submission', 401],
    [endpoint, { method: 'POST', headers, body: JSON.stringify({ clientRequestId: privateText, titleCode: privateText }) }, 'export.current.submission', 400],
    ['/api/export?mode=comparison&q=' + privateText, { headers }, 'export.legacy.records.summary', 400],
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
  const broken = await postgresCandidate(postgres, 'PRIVATE_EXPORT188_TOO_LONG')
  await postgres.query('UPDATE business.enterprise SET name = $1 WHERE id = $2', ['X'.repeat(33000), broken])
  const first = await submit('188-failure'), failed = await terminal(first.accepted.jobId)
  expect(failed.state).toBe('failed')
  expect(failed.error).toContain('Excel')
  expect(failed.result.artifact).toBeUndefined()
  for (const ext of ['.part', '.xlsx']) expect(existsSync(join(exportDir, failed.id + ext))).toBe(false)
  await waitLogs({ taskId: failed.id }, events => {
    expect(events.find(row => row.operation === 'export.current.workbook' && row.outcome === 'failure')).toMatchObject({ errorCode: 'workbook_limit' })
    expect(events.find(row => row.operation === 'export.current.cleanup')).toMatchObject({ outcome: 'success' })
    expect(events.some(row => row.operation === 'export.current.publish' && row.outcome === 'success')).toBe(false)
  })
  await postgres.query('UPDATE business.enterprise SET name = $1 WHERE id = $2', ['PRIVATE_EXPORT188_TOO_LONG', broken])
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
  await expect.poll(async () => (await json(await fetch(url('/api/jobs/' + accepted.jobId)))).state).toBe('running')
  const cancel = await fetch(url('/api/jobs/' + accepted.jobId), { method: 'DELETE', headers })
  expect(cancel.status).toBe(202)
  const job = await terminal(accepted.jobId); expect(job.state).toBe('cancelled')
  for (const ext of ['.part', '.xlsx']) expect(existsSync(join(exportDir, job.id + ext))).toBe(false)
  await waitLogs({ taskId: job.id }, events => {
    expect(events.find(row => row.operation === 'export.current.process' && row.outcome === 'cancelled')).toMatchObject({ errorCode: 'export_cancelled' })
    expect(events.find(row => row.operation === 'export.current.cleanup')).toMatchObject({ outcome: 'success' })
    expect(events.some(row => row.operation === 'export.current.publish' && row.outcome === 'success')).toBe(false)
  })
}, 45000)

it('reports an atomic publication fault and unsuccessful cleanup without exposing an artifact', async () => {
  const { accepted } = await submit('188-publish-fault')
  const finalPath = join(exportDir, accepted.jobId + '.xlsx')
  mkdirSync(finalPath, { recursive: true }) // External filesystem fault, isolated fixture only.
  try {
    const failed = await terminal(accepted.jobId)
    expect(failed.state).toBe('failed')
    expect(failed.result.artifact).toBeUndefined()
    expect((await fetch(url('/api/job-artifacts/' + failed.id), { headers })).status).toBe(404)
    expect(existsSync(join(exportDir, failed.id + '.part'))).toBe(false)
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
  // The two existing same-year specialized grants also qualify as innovative.
  // Keep this literal fixture oracle independent of the qualification reader.
  const expectedNames = [privateText, 'PRIVATE_EXPORT188_TOO_LONG', ...Array.from({ length: 200 }, (_, i) => '合成断开' + i)]
  const client = await postgres.connect()
  try {
    await client.query('BEGIN')
    for (let i = 0; i < 200; i++) {
      // Keep each attachment within the PostgreSQL provenance index's row size.
      // All three downloads concatenate the evidence pointers for each enterprise.
      const attachments = Array.from({ length: 15 }, (_, part) =>
        createHash('shake256', { outputLength: 1500 }).update(`${i}/${part}`).digest('base64'))
      await postgresCandidate(client, '合成断开' + i, 'innovative_sme', attachments)
    }
    await client.query('COMMIT')
  } finally {
    try { await client.query('ROLLBACK') } finally { client.release() }
  }
  const response = await fetch(url('/api/roster/exports/current/innovative-sme'), { method: 'POST', headers, body: JSON.stringify({ clientRequestId: '188-disconnect' }) })
  expect(response.status).toBe(202)
  const job = await terminal((await json(response)).jobId, 90000)
  expect(job.state).toBe('done')
  expect(job.result.counts).toEqual({ eligible: expectedNames.length, pending: 0, excluded: 0 })
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
  const eligible = wb.getWorksheet('有效企业')!
  expect(eligible.rowCount).toBe(expectedNames.length + 1)
  expect(eligible.getRows(2, expectedNames.length)!.map(row => row.getCell(2).value).sort()).toEqual([...expectedNames].sort())
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(job.result.artifact.sha256)
}, 180000)

it('returns independently readable originals when the real logging storage is unavailable', async () => {
  await stopOwnedChild(child)
  await postgres.query('ALTER SCHEMA runtime_logs RENAME TO unavailable_logs')
  await start()
  const { accepted } = await submit('188-log-fault'), job = await terminal(accepted.jobId)
  expect(job.state).toBe('done')
  const expected = (await original(job.result.artifact.downloadUrl, 'fault-async-original')).wb
  expect(expected.getWorksheet('有效企业')!.getRow(2).getCell(2).value).toBe(privateText)
  const digest = await businessDigest()
  const { rows: names } = await postgres.query<{ name: string }>(
    "SELECT name_raw AS name FROM business.record WHERE title_code = 'specialized_sme' ORDER BY id")
  const expectedNames = names.map(row => row.name)
  for (const [path, sheet] of [['/api/export?title=specialized_sme', '台账'], ['/api/roster/export?title=specialized_sme', '企业总表']] as const) {
    const { wb } = await original(path, 'fault-' + sheet)
    expect(wb.getWorksheet(sheet)!.getColumn(1).values).toContain(privateText)
    expect(wb.getWorksheet(sheet)!.rowCount).toBe(expectedNames.length+2)
    for(const name of expectedNames) expect(wb.getWorksheet(sheet)!.getColumn(1).values).toContain(name)
  }
  expect(await businessDigest()).toBe(digest)
  const response = await fetch(url('/api/logs'), { headers }); expect(response.status).toBe(503)
  const unavailable = await json(response)
  expect(unavailable.status).toMatchObject({ unavailable: true })
  expect(unavailable.status.dropped).toBeGreaterThan(0)
  expect(output).toContain('logging.drain')
  expect(output).not.toContain(privateText)
  expect(output).not.toContain(token)
}, 90000)

