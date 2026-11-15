
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { initializeDb } from '../../../db/client'
import { spawnOwnedChild as spawn, reserveLoopbackPort, stopOwnedChild, waitForHttp } from '../../support/owned-process.mjs'
import { minimalPdf } from '../../support/minimal-pdf'
import { startMiniOcrApi, type ModelApiFixture } from '../../files/ocr/fixtures/provider-api'

const dir = mkdtempSync(join(tmpdir(), 'logging-186-'))
const files = join(dir, 'files')
const logDir = join(dir, 'logs')
const privateText = 'PRIVATE186_OCR_BODY'
const privatePath = 'PRIVATE186_SOURCE.pdf'
const fixture: ModelApiFixture = { pages: [privateText], failOnPage: { page: 2, message: 'PRIVATE186_PROVIDER_FAILURE' + 'x'.repeat(30_000) } }
let api: Awaited<ReturnType<typeof startMiniOcrApi>>
let child: ReturnType<typeof spawn>
let origin: string
let output = ''
let sequence = 0
const taskRequests = new Map<string, string>()
const observations: Array<{ filter: string; rows: unknown[] }> = []
async function call(path: string, method = 'GET', body?: unknown, authorized = true) {
  const response = await fetch(origin + path, { method, headers: { ...(authorized ? { authorization: 'Bearer PRIVATE186_API_TOKEN' } : {}), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const text = await response.text()
  let value: any
  try { value = JSON.parse(text) } catch { value = text }
  return { status: response.status, body: value, requestId: response.headers.get('x-request-id') }
}
async function job(kind: string, paths: string[]) {
  const submitted = await call('/api/jobs', 'POST', { kind, params: { files: paths } })
  expect(submitted.status).toBe(202)
  taskRequests.set(submitted.body.jobId, submitted.requestId!)
  return submitted.body.jobId as string
}
async function terminal(id: string) {
  for (let i = 0; i < 400; i++) {
    const response = await call(`/api/jobs/${id}`)
    if (['done', 'failed', 'cancelled'].includes(response.body.state)) return response.body
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('Synthetic task did not terminate')
}
async function logs(filter: string, operation?: string, count = 1) {
  for (let i = 0; i < 80; i++) {
    const response = await call(`/api/logs?limit=100&${filter}`)
    expect(response.status).toBe(200)
    if (!operation || response.body.rows.filter((r: any) => r.operation === operation).length >= count) {
      observations.push({ filter, rows: response.body.rows })
      return response.body.rows as any[]
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Missing semantic event ${operation}`)
}
async function register(pages = 3) {
  const relPath = `${++sequence}-${privatePath}`
  writeFileSync(join(files, relPath), minimalPdf({ pages, widthPt: 220, heightPt: 60 }))
  const response = await call('/api/files/register', 'POST', { relPath })
  expect(response.status).toBe(201)
  return { id: response.body.id as number, relPath, requestId: response.requestId }
}
async function start(extra: Record<string, string> = {}) {
  const port = await reserveLoopbackPort()
  origin = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['.output/server/index.mjs'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'production', NUXT_BUILD_DIR: join(dir, 'nuxt'), NUXT_DB_PATH: join(dir, 'business.db'), NUXT_FILES_DIR: files, NUXT_LOG_DIR: logDir, NUXT_INCOMING_DIR: join(dir, 'incoming'), NUXT_CURATED_PATH: join(dir, 'curated.json'), NUXT_RECONCILE_PATH: join(dir, 'reconcile.json'), NUXT_API_TOKEN: 'PRIVATE186_API_TOKEN', NUXT_MCP_TOKEN: 'PRIVATE186_MCP_TOKEN', NUXT_OCR_TOKEN: 'PRIVATE186_OCR_TOKEN', NUXT_OCR_BASE_URL: api.origin, NUXT_OCR_POLL_TIMEOUT_MS: '20', PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN: '', MIIT_COOKIE: '', MIIT_COOKIE_FILE: '', PADDLEOCR_MCP_AISTUDIO_BASE_URL: '', NUXT_PLATFORM_COOKIE: '', ...extra },
  })
  child.stdout!.on('data', chunk => { output += chunk })
  child.stderr!.on('data', chunk => { output += chunk })
  await waitForHttp(`${origin}/api/health`, { child, timeoutMs: 90_000 })
}
beforeAll(async () => {
  mkdirSync(files)
  initializeDb({ dbPath: join(dir, 'business.db'), create: true }).$client.close()
  api = await startMiniOcrApi(fixture)
  await start()
}, 240_000)
afterAll(async () => {
  await stopOwnedChild(child)
  await api?.close()
  rmSync(dir, { recursive: true, force: true })
})

it('actual Nuxt preserves full-PDF atomicity and recovers only the failed source page through the protected log seam', async () => {
  const file = await register()
  const renderId = await job('render-pages', [file.relPath])
  expect((await terminal(renderId)).state).toBe('done')
  const failedId = await job('ocr', [file.relPath])
  expect((await terminal(failedId)).state).toBe('failed')
  expect((await call(`/api/ocr-results?fileId=${file.id}&markdown=1`)).body.pages).toEqual([])
  const failed = await logs(`taskId=${failedId}`, 'ocr.file')
  expect(failed.filter(r => r.source === 'ocr').every(r => r.requestId === taskRequests.get(failedId))).toBe(true)
  expect(failed.filter(r => r.operation === 'ocr.page' && r.outcome === 'failure')).toMatchObject([{ fileId: file.id, page: 2 }])
  expect(failed.find(r => r.operation === 'ocr.file' && r.outcome === 'partial')).toMatchObject({ fileId: file.id })
  fixture.failOnPage = undefined
  const recoveryId = await job('ocr', [file.relPath])
  const completed = await terminal(recoveryId)
  expect(completed.state).toBe('done')
  expect(completed.result.files[0]).toMatchObject({ fileId: file.id, cachedPages: 2, pages: 3 })
  expect(api.stats.submits).toBe(4)
  const result = await call(`/api/ocr-results?fileId=${file.id}&markdown=1`)
  expect(result.body.pages.map((p: any) => [p.page, p.markdown])).toEqual([[1, privateText], [2, privateText], [3, privateText]])
  const recovered = await logs(`taskId=${recoveryId}`, 'ocr.file')
  expect(recovered.filter(r => r.source === 'ocr').every(r => r.requestId === taskRequests.get(recoveryId))).toBe(true)
  const rendering = await logs(`taskId=${renderId}`, 'file.render')
  expect(rendering.find(r => r.operation === 'file.render')).toMatchObject({ requestId: taskRequests.get(renderId), fileId: file.id })
  expect(completed.params).not.toHaveProperty('logContext')
  expect(recovered.filter(r => r.operation === 'ocr.page' && r.outcome === 'success')).toMatchObject([{ page: 2, fileId: file.id }])
  expect(recovered.filter(r => r.operation === 'ocr.page.cache').map(r => r.page).sort()).toEqual([1, 3])
  expect((await logs(`fileId=${file.id}`, 'file.register')).find(r => r.operation === 'file.register')).toMatchObject({ requestId: file.requestId })
  const before = recovered.filter(r => r.operation === 'ocr.file').length
  for (let i = 0; i < 4; i++) await call(`/api/jobs/${recoveryId}`)
  expect((await logs(`taskId=${recoveryId}`)).filter(r => r.operation === 'ocr.file')).toHaveLength(before)
  expect((await call('/api/logs', 'GET', undefined, false)).status).toBe(401)
  const details = await Promise.all([...failed, ...recovered].map(r => call(`/api/logs/${r.id}`)))
  const serialized = JSON.stringify(details)
  for (const marker of ['PRIVATE186_', dir, api.origin]) expect(serialized).not.toContain(marker)
  for (const result of details) expect(Buffer.byteLength(JSON.stringify(result.body))).toBeLessThanOrEqual(8192)
  // The independent sink itself is checked, not just its public projection.
  for (const name of readdirSync(logDir)) {
    if (name.startsWith('events.db')) expect(readFileSync(join(logDir, name)).includes(Buffer.from('PRIVATE186_'))).toBe(false)
  }
  const semanticOutput = output.split('\n').filter(line => /"source":"(?:file|ocr)"/.test(line)).join('\n')
  expect(semanticOutput).not.toContain('PRIVATE186_')
}, 120_000)

it('actual upload and render log once per semantic phase and retain idempotence and stale-page cleanup', async () => {
  const bytes = minimalPdf({ pages: 3, widthPt: 120, heightPt: 60 })
  const create = await fetch(origin + '/api/uploads', { method: 'POST', headers: { 'tus-resumable': '1.0.0', 'upload-length': String(bytes.length), 'upload-metadata': Object.entries({ filename: 'PRIVATE186_UPLOAD.pdf', source: 'jxj', kind: 'announcement' }).map(([k, v]) => `${k} ${Buffer.from(v).toString('base64')}`).join(',') } })
  expect(create.status).toBe(201)
  const location = new URL(create.headers.get('location')!, origin).href
  const uploaded = await fetch(location, { method: 'PATCH', headers: { 'tus-resumable': '1.0.0', 'upload-offset': '0', 'content-type': 'application/offset+octet-stream' }, body: new Uint8Array(bytes) })
  expect(uploaded.status).toBe(204)
  const relPath = decodeURIComponent(uploaded.headers.get('x-upload-path')!)
  const registration = await call('/api/files/register', 'POST', { relPath })
  expect(registration.status).toBe(201)
  const fileId = registration.body.id
  const first = await call('/api/pdf-pages', 'POST', { file: relPath })
  expect(first.body).toMatchObject({ written: 3, removed: 0 })
  expect((await call('/api/pdf-pages', 'POST', { file: relPath })).body).toMatchObject({ written: 0, skipped: 3 })
  const pageDir = join(files, relPath.replace(/[^/]+$/, name => `.${name}.pages`))
  for (const page of ['p004.png', 'p005.png']) copyFileSync(join(pageDir, 'p001.png'), join(pageDir, page))
  expect((await call('/api/pdf-pages', 'POST', { file: relPath, force: true })).body).toMatchObject({ written: 3, removed: 2 })
  expect(readdirSync(pageDir).filter(n => n.endsWith('.png'))).toEqual(['p001.png', 'p002.png', 'p003.png'])
  expect(readFileSync(join(files, relPath)).equals(bytes)).toBe(true)
  const rendered = await logs(`fileId=${fileId}`, 'file.render', 3)
  expect(rendered.filter(r => r.operation === 'file.render').map(r => r.outcome).sort()).toEqual(['skipped', 'success', 'success'])
  expect(rendered.filter(r => r.operation === 'file.render.page').map(r => r.page).sort()).toEqual([1, 1, 2, 2, 3, 3])
  const uploadLogs = await logs(`requestId=${uploaded.headers.get('x-request-id')}`, 'file.upload')
  expect(uploadLogs.filter(r => r.operation === 'file.upload')).toMatchObject([{ outcome: 'success' }])
  for (let i = 0; i < 3; i++) await fetch(location, { method: 'HEAD', headers: { 'tus-resumable': '1.0.0' } })
  expect((await logs(`requestId=${uploaded.headers.get('x-request-id')}`)).filter(r => r.operation === 'file.upload')).toHaveLength(1)
  const brokenPath = `${++sequence}-${privatePath}`
  writeFileSync(join(files, brokenPath), 'PRIVATE186_BROKEN_PDF')
  const brokenRegistration = await call('/api/files/register', 'POST', { relPath: brokenPath })
  expect(brokenRegistration.status).toBe(201)
  const broken = { id: brokenRegistration.body.id, relPath: brokenPath }
  const badId = await job('render-pages', [broken.relPath])
  expect((await terminal(badId)).state).toBe('failed')
  expect((await logs(`taskId=${badId}`, 'file.render')).find(r => r.operation === 'file.render')).toMatchObject({ fileId: broken.id, outcome: 'failure' })
}, 120_000)

it('source page revisions and parse receipt replay retain independent file audits after runtime logs are cleared', async () => {
  const file = await register(6)
  expect((await terminal(await job('render-pages', [file.relPath]))).state).toBe('done')
  const pageUrl = `/api/files/${file.id}/ocr-pages/5`
  expect((await call(pageUrl, 'PUT', { markdown: privateText, expectedVersion: null })).status).toBe(200)
  const first = await call(pageUrl)
  const version = first.body.results[0].version
  expect((await call(pageUrl, 'PUT', { markdown: 'PRIVATE186_REVISION', expectedVersion: version })).status).toBe(200)
  const revised = await call(pageUrl)
  expect(revised.body.markdown).toContain('PRIVATE186_REVISION')
  expect(revised.body.results[0].version).not.toBe(version)
  expect((await call(pageUrl, 'PUT', { markdown: 'PRIVATE186_LOST_UPDATE', expectedVersion: version })).status).toBe(409)
  expect((await call(pageUrl, 'DELETE', { expectedVersion: revised.body.results[0].version })).body).toMatchObject({ deleted: 1, remaining: 0 })
  expect((await call(pageUrl)).status).toBe(404)
  expect((await call(`/api/pdf-pages?file=${encodeURIComponent(file.relPath)}`)).body.rendered).toBe(6)
  const parseUrl = `/api/files/${file.id}/parse-result`
  const initialParse = await call(parseUrl)
  const parse = { expectedVersion: initialParse.body.version, idempotencyKey: 'PRIVATE186_PARSE_KEY', actor: { type: 'agent', id: 'PRIVATE186_ACTOR' }, reason: 'PRIVATE186_REASON', parts: [{ titleCode: 'specialized_sme', eventKind: 'award', year: 2024, attachment: 'PRIVATE186_ATTACHMENT' }] }
  const committed = await call(parseUrl, 'PUT', parse)
  expect(committed.status).toBe(200)
  expect(committed.body.replayed).toBe(false)
  const replay = await call(parseUrl, 'PUT', parse)
  expect(replay.body).toMatchObject({ receiptId: committed.body.receiptId, replayed: true, state: committed.body.state })
  expect((await call(parseUrl, 'PUT', { ...parse, idempotencyKey: 'PRIVATE186_OTHER_KEY' })).status).toBe(409)
  const maintenance = { displayName: 'PRIVATE186_DISPLAY.pdf', expectedRevision: 0, idempotencyKey: 'PRIVATE186_MAINT_KEY', actor: 'PRIVATE186_ACTOR', basis: 'PRIVATE186_BASIS' }
  expect((await call(`/api/files/${file.id}`, 'PATCH', maintenance)).status).toBe(200)
  expect((await call(`/api/files/${file.id}`, 'PATCH', maintenance)).status).toBe(200)
  const audit = await call(`/api/files/${file.id}/maintenance`)
  expect(audit.body).toMatchObject({ total: 1, revision: 1, rows: [{ action: 'update', actor: 'PRIVATE186_ACTOR', basis: 'PRIVATE186_BASIS' }] })
  const entries = await logs(`fileId=${file.id}`, 'file.maintenance.update', 2)
  expect(entries.filter(r => r.operation === 'ocr.page.revise' && r.outcome === 'success')).toMatchObject([{ page: 5 }, { page: 5 }])
  expect(entries.find(r => r.operation === 'ocr.page.revise' && r.outcome === 'denied')).toMatchObject({ page: 5 })
  expect(entries.find(r => r.operation === 'ocr.page.delete')).toMatchObject({ page: 5, outcome: 'success' })
  expect(entries.find(r => r.operation === 'file.maintenance.update')).toMatchObject({ outcome: 'success' })
  const revisedLog = entries.find(r => r.operation === 'file.parse.revise' && r.outcome === 'success')!
  expect((await call(`/api/logs/${revisedLog.id}`)).body).toMatchObject({ receiptId: committed.body.receiptId })
  const detail = await Promise.all(entries.map(r => call(`/api/logs/${r.id}`)))
  expect(JSON.stringify(detail)).not.toContain('PRIVATE186_')
  expect((await call('/api/logs/clear', 'POST', { from: '2000-01-01', to: '2100-01-01', fileId: file.id, confirm: true })).status).toBe(200)
  expect((await call(`/api/files/${file.id}/maintenance`)).body).toEqual(audit.body)
  const history = await call(`${parseUrl}/history?receiptId=${committed.body.receiptId}`)
  expect(history.body).toMatchObject({ id: committed.body.receiptId, reason: 'PRIVATE186_REASON', actor: { id: 'PRIVATE186_ACTOR' } })
  expect((await call(parseUrl)).body).toEqual(committed.body.state)
}, 120_000)

it('controlled OCR cancellation and timeout remain distinct without committing partial formal results', async () => {
  const cancelledFile = await register(1)
  expect((await terminal(await job('render-pages', [cancelledFile.relPath]))).state).toBe('done')
  let release: () => void = () => {}
  let entered: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const polled = new Promise<void>(resolve => { entered = resolve })
  fixture.waitForPoll = () => { entered(); return gate }
  try {
    const cancelledId = await job('ocr', [cancelledFile.relPath])
    await Promise.race([polled, new Promise((_, reject) => setTimeout(() => reject(new Error('Controlled OCR poll not reached')), 5000))])
    expect((await call(`/api/jobs/${cancelledId}`, 'DELETE')).status).toBe(202)
    release()
    const cancelled = await terminal(cancelledId)
    expect(cancelled.state).toBe('cancelled')
    expect(cancelled.result).toMatchObject({ cancelled: true, pages: 0 })
    expect((await call(`/api/ocr-results?fileId=${cancelledFile.id}`)).body.pages).toEqual([])
    const entries = await logs(`taskId=${cancelledId}`, 'ocr.file')
    expect(entries.find(r => r.operation === 'ocr.file')).toMatchObject({ outcome: 'cancelled', fileId: cancelledFile.id })
    expect(entries.some(r => r.operation === 'ocr.file' && r.outcome === 'success')).toBe(false)
  } finally { release(); fixture.waitForPoll = undefined }
  fixture.doneAfterPolls = 100_000
  try {
    const timeoutFile = await register(1)
    expect((await terminal(await job('render-pages', [timeoutFile.relPath]))).state).toBe('done')
    const timeoutId = await job('ocr', [timeoutFile.relPath])
    expect((await terminal(timeoutId)).state).toBe('failed')
    const entries = await logs(`taskId=${timeoutId}`, 'ocr.file')
    expect(entries.find(r => r.operation === 'ocr.page')).toMatchObject({ outcome: 'timeout', page: 1, fileId: timeoutFile.id })
    expect(entries.find(r => r.operation === 'ocr.file')).toMatchObject({ outcome: 'timeout', fileId: timeoutFile.id })
    expect((await call(`/api/ocr-results?fileId=${timeoutFile.id}`)).body.pages).toEqual([])
  } finally { fixture.doneAfterPolls = undefined }
}, 120_000)

it('actual MCP writes use the same page identity and preserve the original public results', async () => {
  const file = await register(6)
  const requestIds: Record<string, string> = {}
  async function rpc(name: string, input: unknown) {
    const response = await fetch(origin + '/mcp', { method: 'POST', headers: { authorization: 'Bearer PRIVATE186_MCP_TOKEN', 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method: 'tools/call', params: { name, arguments: input } }) })
    expect(response.status).toBe(200)
    requestIds[name] = response.headers.get('x-request-id')!
    const text = await response.text()
    const message = JSON.parse(text.split('\n').find(line => line.startsWith('data: '))?.slice(6) ?? text)
    expect(message.result.isError).not.toBe(true)
    return JSON.parse(message.result.content[0].text)
  }
  expect(await rpc('save_ocr_result', { fileId: file.id, page: 5, markdown: privateText })).toMatchObject({ written: 1, pages: [5] })
  const page = await rpc('get_ocr_result', { fileId: file.id, page: 5, includeVersion: true })
  expect(page.markdown).toContain(privateText)
  expect(await rpc('delete_ocr_result', { fileId: file.id, page: 5, expectedVersion: page.results[0].version })).toMatchObject({ page: 5, deleted: 1, remaining: 0 })
  expect(await rpc('save_parse_result', { fileId: file.id, parts: [], parseState: 'parsed' })).toMatchObject({ parts: [], parseState: 'parsed' })
  expect(await rpc('set_file_category', { fileId: file.id, year: 2024 })).toMatchObject({ file: { id: file.id, year: 2024 } })
  const entries = await logs(`fileId=${file.id}`, 'file.maintenance.update')
  expect(entries.find(r => r.operation === 'ocr.page.revise')).toMatchObject({ page: 5, outcome: 'success' })
  expect(entries.find(r => r.operation === 'ocr.page.delete')).toMatchObject({ page: 5, outcome: 'success' })
  expect(entries.find(r => r.operation === 'file.parse.revise')).toMatchObject({ outcome: 'success', requestId: requestIds.save_parse_result })
  expect(entries.find(r => r.operation === 'ocr.page.revise')).toMatchObject({ requestId: requestIds.save_ocr_result })
  expect(entries.find(r => r.operation === 'ocr.page.delete')).toMatchObject({ requestId: requestIds.delete_ocr_result })
  expect(entries.find(r => r.operation === 'file.maintenance.update')).toMatchObject({ requestId: requestIds.set_file_category })
  const controls = { actor: 'PRIVATE186_ACTOR', basis: 'PRIVATE186_BASIS' }
  expect(await rpc('update_file', { fileId: file.id, patch: { displayName: 'PRIVATE186_MCP_DISPLAY.pdf' }, ...controls, expectedRevision: 1, idempotencyKey: 'PRIVATE186_MCP_UPDATE' })).toMatchObject({ file: { id: file.id } })
  expect(await rpc('remove_file', { fileId: file.id, ...controls, expectedRevision: 2, idempotencyKey: 'PRIVATE186_MCP_REMOVE' })).toMatchObject({ removed: true })
  expect(await rpc('restore_file', { fileId: file.id, ...controls, expectedRevision: 3, idempotencyKey: 'PRIVATE186_MCP_RESTORE' })).toMatchObject({ file: { id: file.id, removedAt: null } })
  const maintenanceLogs = await logs(`fileId=${file.id}`, 'file.maintenance.restore')
  for (const [name, operation] of [['update_file', 'file.maintenance.update'], ['remove_file', 'file.maintenance.remove'], ['restore_file', 'file.maintenance.restore']]) {
    expect(maintenanceLogs.some(r => r.operation === operation && r.requestId === requestIds[name!])).toBe(true)
  }
  const parseState = await call(`/api/files/${file.id}/parse-result`)
  const parseCommand = { fileId: file.id, parts: [], expectedVersion: parseState.body.version, idempotencyKey: 'PRIVATE186_MCP_PARSE', actor: { type: 'agent', id: 'PRIVATE186_ACTOR' }, reason: 'PRIVATE186_REASON' }
  const receipt = await rpc('save_parse_result', parseCommand)
  expect(receipt.replayed).toBe(false)
  expect(await rpc('save_parse_result', parseCommand)).toMatchObject({ receiptId: receipt.receiptId, replayed: true })
  expect((await logs(`fileId=${file.id}`, 'file.parse.replay')).find(r => r.operation === 'file.parse.replay')).toMatchObject({ requestId: requestIds.save_parse_result })
}, 120_000)

it('partial rendering names the actual failed PDF page and recovers without publishing a partial manifest', async () => {
  const file = await register(3)
  const pagesDirectory = join(files, `.${file.relPath}.pages`)
  // A real owned filesystem fault: page two's final PNG name is occupied by a directory.
  const blockedPage = join(pagesDirectory, 'p002.png')
  mkdirSync(blockedPage, { recursive: true })
  const failedId = await job('render-pages', [file.relPath])
  expect((await terminal(failedId)).state).toBe('failed')
  const entries = await logs(`taskId=${failedId}`, 'file.render')
  expect(entries.find(r => r.operation === 'file.render')).toMatchObject({ outcome: 'partial', fileId: file.id })
  expect(entries.find(r => r.operation === 'file.render.page' && r.outcome === 'failure')).toMatchObject({ page: 2, fileId: file.id })
  expect((await call(`/api/pdf-pages?file=${encodeURIComponent(file.relPath)}`)).body).toMatchObject({ rendered: 0, upToDate: false })
  rmSync(blockedPage, { recursive: true })
  const recovered = await terminal(await job('render-pages', [file.relPath]))
  expect(recovered).toMatchObject({ state: 'done', result: { files: [{ written: 3, rendered: 3 }] } })
  expect(readdirSync(pagesDirectory).some(name => name.endsWith('.tmp'))).toBe(false)
}, 120_000)

it('soft removal and verified restoration retain source bytes OCR pages and authoritative maintenance history', async () => {
  const file = await register(1)
  const pageUrl = `/api/files/${file.id}/ocr-pages/1`
  expect((await call(pageUrl, 'PUT', { markdown: privateText, expectedVersion: null })).status).toBe(200)
  const original = readFileSync(join(files, file.relPath))
  const control = { expectedRevision: 0, idempotencyKey: 'PRIVATE186_REMOVE_KEY', actor: 'PRIVATE186_ACTOR', basis: 'PRIVATE186_BASIS' }
  expect((await call(`/api/files/${file.id}`, 'DELETE', control)).body).toMatchObject({ removed: true, diskDeleted: false })
  expect((await call(`/api/files/${file.id}/restore`, 'POST', { ...control, expectedRevision: 1, idempotencyKey: 'PRIVATE186_RESTORE_KEY' })).status).toBe(200)
  expect(readFileSync(join(files, file.relPath)).equals(original)).toBe(true)
  expect((await call(pageUrl)).body.markdown).toContain(privateText)
  expect((await call(`/api/files/${file.id}/maintenance`)).body).toMatchObject({ total: 2, revision: 2, rows: [{ action: 'remove' }, { action: 'restore' }] })
  const entries = await logs(`fileId=${file.id}`, 'file.maintenance.restore')
  expect(entries.find(r => r.operation === 'file.maintenance.remove')).toMatchObject({ outcome: 'success' })
  expect(entries.find(r => r.operation === 'file.maintenance.restore')).toMatchObject({ outcome: 'success' })
}, 120_000)

it('unavailable independent log storage leaves registration OCR and receipt replay intact with safe fallback', async () => {
  await stopOwnedChild(child)
  const blocked = join(dir, 'blocked-log-directory')
  writeFileSync(blocked, 'synthetic non-directory')
  await start({ NUXT_LOG_DIR: blocked })
  const file = await register(1)
  expect((await terminal(await job('render-pages', [file.relPath]))).state).toBe('done')
  expect((await terminal(await job('ocr', [file.relPath]))).state).toBe('done')
  expect((await call(`/api/ocr-results?fileId=${file.id}&markdown=1`)).body.pages.map((p: any) => [p.page, p.markdown])).toEqual([[1, privateText]])
  const parseUrl = `/api/files/${file.id}/parse-result`
  const before = await call(parseUrl)
  const command = { parts: [], expectedVersion: before.body.version, idempotencyKey: 'PRIVATE186_FAULT_KEY', actor: { type: 'agent', id: 'PRIVATE186_ACTOR' }, reason: 'PRIVATE186_REASON' }
  const receipt = await call(parseUrl, 'PUT', command)
  expect(receipt.status).toBe(200)
  expect((await call(parseUrl, 'PUT', command)).body).toMatchObject({ replayed: true, receiptId: receipt.body.receiptId, state: receipt.body.state })
  expect((await call(`${parseUrl}/history?receiptId=${receipt.body.receiptId}`)).body).toMatchObject({ id: receipt.body.receiptId, reason: 'PRIVATE186_REASON' })
  let fault: any
  for (let i = 0; i < 80; i++) {
    fault = await call('/api/logs')
    if (fault.status === 503 && fault.body.status?.dropped > 0) break
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  expect(fault.status).toBe(503)
  expect(fault.body.status).toMatchObject({ unavailable: true })
  expect(fault.body.status.dropped).toBeGreaterThan(0)
  expect(JSON.stringify(fault.body)).not.toContain(blocked)
  expect(output).toContain('"operation":"logging.drain"')
  // Includes the real container/fallback stdout and stderr of BOTH processes.
  expect(output).not.toContain('PRIVATE186_')
  expect(output).not.toContain(files)
  for (const name of readdirSync(logDir)) if (name.startsWith('events.db')) expect(readFileSync(join(logDir, name)).includes(Buffer.from('PRIVATE186_'))).toBe(false)
}, 120_000)
