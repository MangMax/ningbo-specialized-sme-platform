import { createClassifiedFile } from '../../../layers/sme-roster/server/utils/roster-file-classification'
import { initializeDb } from '../../../db/client'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as h3 from 'h3'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { useDb, schema } from '../../../db'
import { whenIdle } from '../../../layers/core/server/utils/job-runner'
import { DEFAULT_DPI } from '../../../layers/core/lib/pdf-page'
import { pageDirRelPath, PAGES_MANIFEST_NAME, pageImageRelPath } from '../../../layers/core/lib/pdf-page'
import { renderPdfPages } from '../../../layers/core/server/utils/pdf-pages'
import { minimalPdf } from '../../support/minimal-pdf'
import { startMiniOcrApi } from './fixtures/provider-api'
import type { ModelApiFixture } from './fixtures/provider-api'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { eq } from 'drizzle-orm'
import type { ZodRawShape } from 'zod'

vi.mock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (tool: unknown) => tool }))

// Actual route handlers, runner, SQLite and provider HTTP. Only Nitro globals
// are supplied here; no Nuxt dev/transport service or paid provider is started.
const dir = mkdtempSync(join(tmpdir(), 'issue309-public-'))
const filesDir = join(dir, 'files')
mkdirSync(filesDir)
const dbPath = join(dir, 'synthetic.sqlite')
const db = initializeDb({ create: true, dbPath })
let server: ReturnType<typeof createServer>, base: string
let api: Awaited<ReturnType<typeof startMiniOcrApi>> | undefined
let gate: (() => void) | undefined
let sequence = 0
let client: Client, mcp: McpServer
const children: ChildProcess[] = []
afterEach(async () => { gate?.(); await whenIdle() })
beforeAll(async () => {
  vi.stubEnv('NUXT_DB_PATH', dbPath)
  vi.stubEnv('NUXT_FILES_DIR', filesDir)
  vi.stubEnv('NUXT_OCR_TOKEN', 'issue309-synthetic-ocr')
  vi.stubEnv('MIIT_COOKIE', '')
  for (const key of ['defineEventHandler', 'getQuery', 'getRouterParam', 'readBody', 'createError', 'setHeader', 'setResponseStatus'] as const) vi.stubGlobal(key, h3[key])
  vi.stubGlobal('useRuntimeConfig', () => ({ filesDir, apiToken: 'issue309-api', ocrToken: 'issue309-synthetic-ocr', ocrBaseUrl: api?.origin }))
  const post = (await import('../../../layers/core/server/api/jobs/index.post')).default
  const get = (await import('../../../layers/core/server/api/jobs/[id].get')).default
  const cancel = (await import('../../../layers/core/server/api/jobs/[id].delete')).default
  const read = (await import('../../../layers/core/server/api/files/[id]/ocr-pages/[page].get')).default
  const save = (await import('../../../layers/core/server/api/files/[id]/ocr-pages/[page].put')).default
  const router = h3.createRouter().post('/api/jobs', post).get('/api/jobs/:id', get).delete('/api/jobs/:id', cancel)
    .get('/api/files/:id/ocr-pages/:page', read).put('/api/files/:id/ocr-pages/:page', save)
  server = createServer(h3.toNodeListener(h3.createApp({ debug: false }).use(router)))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  // Real SDK transport + real tool handlers/schema. Nitro toolkit registration
  // and its auth middleware are outside this focused harness.
  mcp = new McpServer({ name: 'issue309', version: '1' })
  for (const name of ['get_ocr_result', 'save_ocr_result']) {
    const tool = (await import(`../../../layers/core/server/mcp/tools/${name}.ts`)).default as unknown as { inputSchema: ZodRawShape; handler: (input: Record<string, unknown>) => Promise<unknown> }
    mcp.registerTool(name, { inputSchema: tool.inputSchema }, async input => ({ content: [{ type: 'text', text: JSON.stringify(await tool.handler(input)) }] }))
  }
  client = new Client({ name: 'issue309-client', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([mcp.connect(a), client.connect(b)])
})
afterAll(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit') }
  gate?.()
  await whenIdle()
  await api?.close()
  await client.close(); await mcp.close()
  await new Promise<void>(resolve => server.close(() => resolve()))
  db.$client.close()
  vi.unstubAllGlobals(); vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})
async function request(path: string, method = 'GET', body?: unknown) {
  return fetch(base + path, { method, headers: { authorization: 'Bearer issue309-api', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
async function seed(pages = 1) {
  const file = `synthetic-${++sequence}.pdf`
  // Publication checks need real distinct page images, not a large raster.
  // Two 20pt marks fit this canvas; keep the actual default-DPI renderer.
  writeFileSync(join(filesDir, file), minimalPdf({ pages, widthPt: 100, heightPt: 60 }))
  const row = createClassifiedFile(db, { relPath: file, filename: file, ext: 'pdf', bytes: readFileSync(join(filesDir, file)).length, sha256: createHash('sha256').update(readFileSync(join(filesDir, file))).digest('hex') }, {})
  await renderPdfPages(filesDir, file, { dpi: DEFAULT_DPI })
  return { file, row, pagePath: `/api/files/${row.id}/ocr-pages/1` }
}
async function setup(pages = 1, fixture: Partial<ModelApiFixture> = {}) {
  await api?.close()
  const seeded = await seed(pages)
  const wait = new Promise<void>(resolve => { gate = resolve })
  api = await startMiniOcrApi({ pages: ['paid original'], waitForPoll: () => wait, ...fixture })
  vi.stubEnv('NUXT_OCR_BASE_URL', api.origin)
  return seeded
}
async function submit(file: string, resumeJobId?: string, extra: Record<string, unknown> = {}) {
  const response = await request('/api/jobs', 'POST', { kind: 'ocr', params: { files: [file], ...(resumeJobId ? { resumeJobId } : {}), ...extra } })
  expect(response.status).toBe(202)
  return (await response.json()).jobId as string
}
async function status(id: string) { return (await request(`/api/jobs/${id}`)).json() }
async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args })
  expect(result.isError).not.toBe(true)
  return JSON.parse((result.content as Array<{ text: string }>)[0]!.text)
}

it('delayed publication rejects a human revision, retains paid output, and explicit resume does not charge or overwrite', async () => {
  const { file, row, pagePath } = await setup()
  expect((await request(pagePath, 'PUT', { markdown: 'baseline', expectedVersion: null })).status).toBe(200)
  const original = await (await request(pagePath)).json()
  const id = await submit(file)
  await vi.waitFor(() => expect(api!.stats.submits).toBe(1))
  await call('save_ocr_result', { fileId: row.id, page: 1, markdown: 'human correction', expectedVersion: original.results[0].version, engine: 'human', model: 'B' })
  gate!()
  await whenIdle()
  expect((await (await request(pagePath)).json()).markdown).toContain('human correction')
  expect((await call('get_ocr_result', { fileId: row.id, page: 1, includeVersion: true })).markdown).toContain('human correction')
  const result = await status(id)
  expect(result.state).toBe('failed')
  expect(result.result.files[0].error).toContain('版本冲突')
  expect(result.result.publication.files[0].captures[0]).toMatchObject({ page: 1, markdown: 'paid original', raw: { markdown: { text: 'paid original' } } })
  const retry = await submit(file, id)
  await whenIdle()
  expect((await status(retry)).state).toBe('failed')
  expect(api!.stats.submits).toBe(1)
  expect((await (await request(pagePath)).json()).markdown).toContain('human correction')
})

it('checks all target versions atomically and leaves unprocessed legacy pages untouched', async () => {
  const { file, row, pagePath } = await setup(2)
  for (const page of [1, 2]) expect((await request(pagePath.replace(/1$/, String(page)), 'PUT', { markdown: `baseline ${page}`, expectedVersion: null })).status).toBe(200)
  // Historical out-of-range page is deliberately not a modern valid write.
  db.insert(schema.ocrResult).values({ fileId: row.id, pageNo: 9, markdown: 'legacy untouched', raw: { old: 'raw' }, channel: 'upload', engine: 'legacy', createdAt: 'old' }).run()
  const legacy = db.select().from(schema.ocrResult).where(eq(schema.ocrResult.fileId, row.id)).all().find(r => r.pageNo === 9)
  const id = await submit(file)
  await vi.waitFor(() => expect(api!.stats.submits).toBe(2))
  await call('save_ocr_result', { fileId: row.id, page: 2, markdown: 'human creates target', expectedVersion: (await call('get_ocr_result', { fileId: row.id, page: 2, includeVersion: true })).results[0].version })
  gate!(); await whenIdle()
  expect((await status(id)).state).toBe('failed')
  expect((await (await request(pagePath)).json()).markdown).toContain('baseline 1')
  expect((await call('get_ocr_result', { fileId: row.id, page: 2 })).markdown).toContain('human creates target')
  expect(db.select().from(schema.ocrResult).where(eq(schema.ocrResult.fileId, row.id)).all().find(r => r.pageNo === 9)).toEqual(legacy)
})

it('cancelled accepted request resumes its remote ID without another charge and replays publication without touching a later edit', async () => {
  const { file, row, pagePath } = await setup()
  const id = await submit(file)
  await vi.waitFor(async () => expect((await status(id)).result?.publication.files[0].requests['1']).toMatchObject({ state: 'accepted', jobId: 'JOB-1' }))
  expect((await request(`/api/jobs/${id}`, 'DELETE')).status).toBe(202)
  gate!(); await whenIdle()
  expect((await status(id)).state).toBe('cancelled')
  expect((await request(pagePath)).status).toBe(404)
  const retry = await submit(file, id)
  await whenIdle()
  expect((await status(retry)).state).toBe('done')
  expect(api!.stats.submits).toBe(1)
  const published = await (await request(pagePath)).json()
  await call('save_ocr_result', { fileId: row.id, page: 1, markdown: 'later human edit', expectedVersion: published.results[0].version })
  const replay = await submit(file, retry)
  await whenIdle()
  expect((await status(replay)).state).toBe('done')
  expect((await status(replay)).result).toMatchObject({ pages: 0, files: [{ replayed: true, writtenPages: 0 }] })
  expect((await (await request(pagePath)).json()).markdown).toContain('later human edit')
  expect(api!.stats.submits).toBe(1)
})

it('partial rejection retains successful raw in the task and explicit retry only submits the refused page', async () => {
  const { file, pagePath } = await setup(2, { submitStatuses: [0, 429] })
  const id = await submit(file)
  gate!(); await whenIdle()
  const failed = await status(id)
  expect(failed.state).toBe('failed')
  expect(failed.result.publication.files[0].captures).toHaveLength(1)
  expect(failed.result.publication.files[0].captures[0].raw).toEqual({ markdown: { text: 'paid original' } })
  expect((await request(pagePath)).status).toBe(404)
  // Discard the accelerator; retained paid output must come from job.result.
  const { ocrPageCacheDirAbs } = await import('../../../layers/core/server/utils/ocr-page-cache')
  rmSync(ocrPageCacheDirAbs(filesDir, file), { recursive: true, force: true })
  const retry = await submit(file, id)
  await whenIdle()
  expect((await status(retry)).state).toBe('done')
  expect(api!.stats.submits).toBe(3)
  expect((await (await request(pagePath)).json()).markdown).toContain('paid original')
  const { ocrRecovery, ...originalResult } = (await status(id)).result
  expect(originalResult).toEqual(failed.result)
  expect(ocrRecovery.version).toBe(1)
  const { result: _oldResult, ...oldState } = failed
  const { result: _newResult, ...newState } = await status(id)
  expect(newState).toEqual(oldState)
})

it('legacy raw ownership stays unknown and new source text does not acquire the retained paid capture', async () => {
  const { row, pagePath } = await setup()
  db.insert(schema.ocrResult).values({ fileId: row.id, pageNo: 1, markdown: 'legacy text', raw: { paid: 'legacy raw' }, channel: 'mcp', engine: 'mutable B', model: 'B', createdAt: 'old' }).run()
  const version = (await call('get_ocr_result', { fileId: row.id, page: 1, includeVersion: true })).results[0].version
  await call('save_ocr_result', { fileId: row.id, page: 1, markdown: 'new text', expectedVersion: version, engine: 'new C', model: 'C' })
  expect((await (await request(pagePath)).json()).results[0]).toMatchObject({ engine: 'new C', model: 'C', channel: 'mcp' })
  const raw = db.select({ raw: schema.ocrResult.raw }).from(schema.ocrResult).where(eq(schema.ocrResult.fileId, row.id)).get()!.raw
  expect(raw).toMatchObject({ format: 'ocr-provenance-v1', captures: [{ raw: { paid: 'legacy raw' }, source: null, markdown: null }], revisions: [{ markdown: 'legacy text', engine: 'mutable B', capture: null }, { markdown: 'new text', engine: 'new C', model: 'C', capture: 0 }] })
  expect(api!.stats.submits).toBe(0)
})

async function childHost(extraEnv: Record<string, string> = {}) {
  const child = spawn(process.execPath, ['tests/files/ocr/fixtures/publication-server.mjs'], { cwd: process.cwd(), env: { ...process.env, NUXT_DB_PATH: dbPath, NUXT_FILES_DIR: filesDir, NUXT_API_TOKEN: 'issue309-api', NUXT_OCR_TOKEN: 'issue309-synthetic-ocr', NUXT_OCR_BASE_URL: api!.origin, MIIT_COOKIE: '', MIIT_COOKIE_FILE: '', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  let output = '', errors = ''
  child.stdout!.on('data', chunk => { output += chunk })
  child.stderr!.on('data', chunk => { errors += chunk })
  await Promise.race([
    once(child.stdout!, 'data'),
    once(child, 'exit').then(() => { throw new Error(`OCR child exited before readiness: ${errors}`) }),
  ])
  expect(child.exitCode, errors).toBe(null)
  return { child, base: JSON.parse(output.trim().split('\n').find(line => line.startsWith('{"base"'))!).base as string }
}

it('SIGKILL after a paid-page checkpoint preserves raw across restart and resumes accepted IDs with no new POST', async () => {
  let polls = 0
  const { file, pagePath } = await setup(2)
  let releaseSecond!: () => void
  const second = new Promise<void>(resolve => { releaseSecond = resolve })
  await api!.close()
  polls = 0
  api = await startMiniOcrApi({ pages: ['paid original'], waitForPoll: () => ++polls === 1 ? Promise.resolve() : second })
  vi.stubEnv('NUXT_OCR_BASE_URL', api.origin)
  const childStart = children.length
  const first = await childHost()
  const savedBase = base
  try {
    base = first.base
    const id = await submit(file)
    await vi.waitFor(async () => {
      const result = await status(id)
      expect(result.result?.publication.files[0].captures).toHaveLength(1)
      expect(Object.values(result.result.publication.files[0].requests)).toHaveLength(2)
    })
    first.child.kill('SIGKILL'); await once(first.child, 'exit')
    // Remove all optional caches. SQLite task receipts are the recovery source.
    const { ocrPageCacheDirAbs } = await import('../../../layers/core/server/utils/ocr-page-cache')
    rmSync(ocrPageCacheDirAbs(filesDir, file), { recursive: true, force: true })
    const restarted = await childHost()
    base = restarted.base
    const interrupted = await status(id)
    expect(interrupted.state).toBe('failed')
    expect(interrupted.result.publication.files[0].captures[0].raw).toEqual({ markdown: { text: 'paid original' } })
    const retry = await submit(file, id)
    releaseSecond()
    await vi.waitFor(async () => expect((await status(retry)).state).toBe('done'))
    expect(api!.stats.submits).toBe(2)
    expect((await (await request(pagePath)).json()).markdown).toContain('paid original')
    expect((await status(id)).state).toBe('failed')
    restarted.child.kill('SIGKILL'); await once(restarted.child, 'exit')
  } finally {
    releaseSecond()
    // A failed checkpoint assertion must not leave a second runner consuming
    // subsequent tests' paid requests against the same database.
    for (const child of children.slice(childStart)) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL'); await once(child, 'exit')
      }
    }
    base = savedBase
  }
}, 15000)

it('unknown submission is reported and explicit resume never repeats a possibly paid POST', async () => {
  const { file } = await setup(1, { submitStatuses: [503] })
  const id = await submit(file)
  await whenIdle()
  const failed = await status(id)
  expect(failed.state).toBe('failed')
  expect(failed.result.publication.files[0].requests['1']).toEqual({ state: 'unknown', taskId: id })
  const retry = await submit(file, id)
  await whenIdle()
  expect((await status(retry)).result.files[0].error).toContain('提交结果未知')
  expect(api!.stats.submits).toBe(1)
})

it('revalidates actual PDF bytes before publication and retains the paid result', async () => {
  const { file, pagePath } = await setup()
  const id = await submit(file)
  await vi.waitFor(() => expect(api!.stats.submits).toBe(1))
  writeFileSync(join(filesDir, file), minimalPdf({ pages: 2, widthPt: 100, heightPt: 60 }))
  gate!(); await whenIdle()
  expect((await request(pagePath)).status).toBe(404)
  const result = await status(id)
  expect(result.state).toBe('failed')
  expect(result.result.files[0].error).toContain('输入')
  expect(result.result.publication.files[0].captures[0].markdown).toBe('paid original')
})

it.each(['page-image', 'registered-hash'] as const)('revalidates %s input before publishing', async change => {
  const { file, row, pagePath } = await setup()
  const id = await submit(file)
  await vi.waitFor(() => expect(api!.stats.submits).toBe(1))
  if (change === 'page-image') writeFileSync(join(filesDir, pageImageRelPath(file, 1)), 'changed after upload')
  else db.update(schema.storedFile).set({ sha256: 'different content identity' }).where(eq(schema.storedFile.id, row.id)).run()
  gate!(); await whenIdle()
  expect((await request(pagePath)).status).toBe(404)
  const result = await status(id)
  expect(result.state).toBe('failed')
  expect(result.result.publication.files[0]).toMatchObject({ state: 'conflict', captures: [{ markdown: 'paid original' }] })
})

it('a target absent at submission cannot overwrite a page created while recognition is running', async () => {
  const { file, row, pagePath } = await setup()
  const id = await submit(file)
  await vi.waitFor(() => expect(api!.stats.submits).toBe(1))
  await call('save_ocr_result', { fileId: row.id, page: 1, markdown: 'human newly created', expectedVersion: null })
  gate!(); await whenIdle()
  expect((await status(id)).state).toBe('failed')
  expect((await (await request(pagePath)).json()).markdown).toContain('human newly created')
})

it('a rolled-back multi-page publication retains both paid pages and can resume without charging', async () => {
  const { file, row, pagePath } = await setup(2)
  const id = await submit(file)
  await vi.waitFor(() => expect(api!.stats.submits).toBe(2))
  db.$client.exec(`CREATE TRIGGER issue309_fail_page BEFORE INSERT ON ocr_result WHEN NEW.file_id = ${row.id} AND NEW.page_no = 2 BEGIN SELECT RAISE(ABORT, 'issue309 injected publication failure'); END`)
  try {
    gate!(); await whenIdle()
    expect((await status(id)).state).toBe('failed')
    expect((await request(pagePath)).status).toBe(404)
    expect((await status(id)).result.publication.files[0].captures).toHaveLength(2)
  } finally { db.$client.exec('DROP TRIGGER issue309_fail_page') }
  const retry = await submit(file, id)
  await whenIdle()
  expect((await status(retry)).state).toBe('done')
  expect(api!.stats.submits).toBe(2)
  expect((await (await request(pagePath)).json()).markdown).toContain('paid original')
})

it("same rejected parent concurrent resumes share one paid attempt", async () => {
  const { file } = await setup(1, { submitStatuses: [429] })
  const parent = await submit(file)
  await whenIdle()
  expect((await status(parent)).state).toBe('failed')
  const [a, b] = await Promise.all([submit(file, parent), submit(file, parent)])
  try {
    await vi.waitFor(async () => {
      const rows = await Promise.all([status(a), status(b)])
      expect(rows.every(row => row.state === 'failed' || row.result?.publication.files[0].requests['1']?.state === 'accepted')).toBe(true)
    })
    expect(api!.stats.submits).toBe(2)
  } finally { gate!(); await whenIdle() }
})

it("unknown recovery cannot be bypassed by resuming the old rejected parent", async () => {
  const { file } = await setup(1, { submitStatuses: [429, 503] })
  gate!()
  const parent = await submit(file)
  await whenIdle()
  const a = await submit(file, parent)
  await whenIdle()
  expect((await status(a)).result.publication.files[0].requests['1'].state).toBe('unknown')
  const b = await submit(file, parent)
  await whenIdle()
  expect(api!.stats.submits).toBe(2)
  expect((await status(b)).state).toBe('failed')
  expect((await status(b)).result.publication.files[0].captures).toHaveLength(0)
})

it("completed recovery is replayed when resuming its old rejected parent", async () => {
  const { file, pagePath } = await setup(1, { submitStatuses: [429] })
  gate!()
  const parent = await submit(file)
  await whenIdle()
  const a = await submit(file, parent)
  await whenIdle()
  expect((await status(a)).state).toBe('done')
  const published = await (await request(pagePath)).json()
  const b = await submit(file, parent)
  await whenIdle()
  expect(api!.stats.submits).toBe(2)
  expect((await status(b)).result).toMatchObject({ pages: 0, files: [{ replayed: true }] })
  expect(await (await request(pagePath)).json()).toEqual(published)
})

it("rejected receipts replay, aliases and caller keys cannot retry, only the terminal attempt owner is a new anchor", async () => {
  const { file } = await setup(1, { submitStatuses: [429, 429] })
  gate!()
  const parent = await submit(file)
  await whenIdle()
  const initial = await status(parent)
  const a = await submit(file, parent)
  await whenIdle()
  expect((await status(a)).state).toBe('failed')
  const b = await submit(file, parent, { clientRequestId: 'new caller key', recovery: { sourceJobId: 'invented' }, anchorJobId: 'invented' })
  await whenIdle()
  const alias = await submit(file, b)
  await whenIdle()
  expect(api!.stats.submits).toBe(2)
  expect((await status(b)).result.publication.files[0].claims['1']).toMatchObject({ ownerTaskId: a, state: 'rejected' })
  expect((await status(alias)).state).toBe('failed')
  const retry = await submit(file, a)
  await whenIdle()
  expect((await status(retry)).state).toBe('done')
  expect(api!.stats.submits).toBe(3)
  const old = await submit(file, parent)
  await whenIdle()
  expect((await status(old)).result.pages).toBe(0)
  expect(api!.stats.submits).toBe(3)
  const final = await status(parent)
  const { ocrRecovery, ...historical } = final.result
  expect(historical).toEqual(initial.result)
  expect(final.state).toBe(initial.state)
  expect(final.error).toBe(initial.error)
  const page = Object.values(ocrRecovery.pages)[0] as { attempts: Array<{ state: string; ownerTaskId: string }> }
  expect(page.attempts.map(a => a.state)).toEqual(['rejected', 'rejected', 'complete'])
  expect(page.attempts.map(a => a.ownerTaskId)).toEqual([parent, a, retry])
})

it("unknown attempt remains blocked through child aliases and different caller keys", async () => {
  const { file } = await setup(1, { submitStatuses: [429, 503] })
  gate!()
  const parent = await submit(file)
  await whenIdle()
  const a = await submit(file, parent)
  await whenIdle()
  const b = await submit(file, a, { clientRequestId: 'another-key' })
  await whenIdle()
  const c = await submit(file, b)
  await whenIdle()
  const d = await submit(file, parent)
  await whenIdle()
  for (const id of [a, b, c, d]) {
    const result = await status(id)
    expect(result.state).toBe('failed')
    expect(result.result.publication.files[0].captures).toHaveLength(0)
    expect(result.result.publication.files[0].requests['1'].state).toBe('unknown')
  }
  expect(api!.stats.submits).toBe(2)
})

it("confirmed remote failure needs its actual terminal owner as the next retry anchor", async () => {
  const { file } = await setup(1, { submitStatuses: [429], failOnSubmit: { submit: 1, message: 'known remote terminal failure' } })
  gate!()
  const parent = await submit(file)
  await whenIdle()
  const a = await submit(file, parent)
  await whenIdle()
  expect((await status(a)).result.publication.files[0].requests['1']).toMatchObject({ state: 'failed', jobId: 'JOB-2' })
  const old = await submit(file, parent)
  await whenIdle()
  expect((await status(old)).state).toBe('failed')
  expect(api!.stats.submits).toBe(2)
  const retry = await submit(file, a)
  await whenIdle()
  expect((await status(retry)).state).toBe('done')
  expect(api!.stats.submits).toBe(3)
})

it("concurrent accepted followers use the first durable capture and one publication", async () => {
  const { file } = await setup()
  const original = await childHost()
  try {
    const response = await at(original.base, '/api/jobs', 'POST', { kind: 'ocr', params: { files: [file] } })
    expect(response.status).toBe(202)
    const parent = (await response.json()).jobId as string
    await vi.waitFor(async () => expect((await status(parent)).result?.publication.files[0].requests['1'].state).toBe('accepted'))
    await stopChild(original.child)
    const { reconcileInterruptedJobs } = await import('../../../layers/core/server/utils/job-store')
    expect(reconcileInterruptedJobs(db)).toBe(1)
    const [a, b] = await Promise.all([submit(file, parent), submit(file, parent)])
    await vi.waitFor(async () => {
      for (const id of [a, b]) {
        const row = await status(id)
        expect(row.result?.publication.files[0].claims['1'].state).toBe('accepted')
        expect(row.result.publication.files[0].captures).toHaveLength(0)
      }
    })
    gate!(); await whenIdle()
    expect(api!.stats.submits).toBe(1)
    const canonical = (Object.values((await status(parent)).result.ocrRecovery.pages)[0] as any).attempts.at(-1).capture
    for (const id of [a, b]) expect((await status(id)).result.publication.files[0].captures).toEqual([canonical])
    const rows = await Promise.all([status(a), status(b)])
    expect(rows.every(row => row.state === 'done')).toBe(true)
    expect(rows.filter(row => row.result.files[0].replayed)).toHaveLength(1)
  } finally { gate!(); await stopChild(original.child) }
})

it("terminal source claim metadata survives stale checkpoints, finishes, reconciliation and enqueue", async () => {
  const { file } = await setup(1, { submitStatuses: [429, 503] })
  gate!()
  const parent = await submit(file)
  await whenIdle()
  await submit(file, parent)
  await whenIdle()
  const before = await status(parent)
  const { setJobResult, setJobProgress, markJobRunning, finishJob, reconcileInterruptedJobs } = await import('../../../layers/core/server/utils/job-store')
  const { enqueuePersistedJob } = await import('../../../layers/core/server/utils/job-runner')
  setJobResult(db, parent, { publication: 'stale whole result' })
  setJobProgress(db, parent, { done: 0, total: 99 })
  expect(markJobRunning(db, parent)).toBe(null)
  finishJob(db, parent, { state: 'done', result: { stale: true } })
  expect(reconcileInterruptedJobs(db)).toBe(0)
  expect(enqueuePersistedJob(db, parent, filesDir)).toBe(false)
  expect(await status(parent)).toEqual(before)
  const old = await submit(file, parent)
  await whenIdle()
  expect((await status(old)).state).toBe('failed')
  expect(api!.stats.submits).toBe(2)
})

it("late capture after descendant restart reconciliation preserves the shared claim and original history", async () => {
  const { file, pagePath } = await setup(1, { submitStatuses: [429] })
  const parent = await submit(file)
  await whenIdle()
  const initial = await status(parent)
  const a = await submit(file, parent)
  await vi.waitFor(async () => expect((await status(a)).result?.publication.files[0].requests['1'].state).toBe('accepted'))
  const { reconcileInterruptedJobs } = await import('../../../layers/core/server/utils/job-store')
  expect(reconcileInterruptedJobs(db)).toBe(1)
  const interrupted = await status(a)
  expect(interrupted.state).toBe('failed')
  const b = await submit(file, parent)
  await vi.waitFor(async () => expect((await status(b)).result?.publication.files[0].claims['1']).toMatchObject({ state: 'accepted', ownerTaskId: a }))
  gate!(); await whenIdle()
  expect(api!.stats.submits).toBe(2)
  expect(await status(a)).toEqual(interrupted)
  expect((await status(b)).state).toBe('done')
  expect((await (await request(pagePath)).json()).markdown).toContain('paid original')
  const { ocrRecovery, ...historic } = (await status(parent)).result
  expect(historic).toEqual(initial.result)
  expect((Object.values(ocrRecovery.pages)[0] as any).attempts.at(-1)).toMatchObject({ state: 'complete', ownerTaskId: a, capture: { taskId: a, jobId: 'JOB-2', raw: { markdown: { text: 'paid original' } } } })
})

it.each(['accepted-without-id', 'complete-without-capture'] as const)("malformed %s shared receipt fails closed without a paid POST", async malformed => {
  const { file, pagePath } = await setup(1, { submitStatuses: [429, 429] })
  gate!()
  const parent = await submit(file)
  await whenIdle()
  await submit(file, parent)
  await whenIdle()
  const before = await status(parent)
  const result = structuredClone(before.result)
  const claim = (Object.values(result.ocrRecovery.pages)[0] as any).attempts.at(-1)
  claim.state = malformed === 'accepted-without-id' ? 'accepted' : 'complete'
  db.update(schema.job).set({ result }).where(eq(schema.job.id, parent)).run()
  const old = await submit(file, parent)
  await whenIdle()
  const failed = await status(old)
  expect(failed.state).toBe('failed')
  expect(failed.result.files[0].error).toContain('共享认领回执不完整')
  expect((await status(parent)).result).toEqual(result)
  expect((await request(pagePath)).status).toBe(404)
  expect(api!.stats.submits).toBe(2)
})

it("claims isolate actual pages, file content and model and preserve sibling claim metadata", async () => {
  const { file } = await setup(2, { submitStatuses: [429, 429, 429, 429, 429] })
  const other = await seed(1)
  gate!()
  const p = await submit(file)
  await whenIdle()
  const q = await submit(other.file)
  await whenIdle()
  const r = await submit(file, undefined, { model: 'another-model' })
  await whenIdle()
  expect(api!.stats.submits).toBe(5)
  const changedModel = await request('/api/jobs', 'POST', { kind: 'ocr', params: { files: [file], resumeJobId: p, model: 'another-model' } })
  expect(changedModel.status).toBe(409)
  const [a, b, c] = await Promise.all([submit(file, p), submit(other.file, q), submit(file, r, { model: 'another-model' })])
  await whenIdle()
  expect(api!.stats.submits).toBe(10)
  for (const [source, child, count, model] of [[p, a, 2, 'PaddleOCR-VL-1.6'], [q, b, 1, 'PaddleOCR-VL-1.6'], [r, c, 2, 'another-model']] as const) {
    const root = await status(source)
    const pages = Object.values(root.result.ocrRecovery.pages) as Array<{ attempts: Array<{ state: string; capture?: { model: string } }> }>
    expect(pages).toHaveLength(count)
    expect(pages.every(page => page.attempts.at(-1)!.state === 'complete' && page.attempts.at(-1)!.capture!.model === model)).toBe(true)
    expect((await status(child)).result.publication.files[0].captures).toHaveLength(count)
  }
  expect(Object.keys((await status(p)).result.ocrRecovery.pages)).not.toEqual(Object.keys((await status(r)).result.ocrRecovery.pages))
})

async function at(host: string, path: string, method = 'GET', body?: unknown) {
  return fetch(host + path, { method, headers: { authorization: 'Bearer issue309-api', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
async function submitAt(host: string, file: string, resumeJobId?: string) {
  const response = await at(host, '/api/jobs', 'POST', { kind: 'ocr', params: { files: [file], ...(resumeJobId ? { resumeJobId } : {}) } })
  expect(response.status).toBe(202)
  return (await response.json()).jobId as string
}
async function stopChild(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit') }
}

it("independent HTTP processes share SQLite claims and old parent results after one publication", async () => {
  // Observe provider polls rather than giving two cold processes vi.waitFor's
  // default one-second scheduling window to acquire their durable receipts.
  let polls = 0, ready!: () => void, release!: () => void
  const bothPolling = new Promise<void>(resolve => { ready = resolve })
  const pollGate = new Promise<void>(resolve => { release = resolve })
  const { file } = await setup(2, { submitStatuses: [429, 429], waitForPoll: () => {
    if (++polls === 2) ready()
    return pollGate
  } })
  const parent = await submit(file)
  await whenIdle()
  const initial = await status(parent)
  const [one, two] = await Promise.all([childHost(), childHost()])
  try {
    // Both startup reconciliations finish before either child is submitted.
    expect((await at(one.base, `/api/jobs/${parent}`)).status).toBe(200)
    expect((await at(two.base, `/api/jobs/${parent}`)).status).toBe(200)
    const [a, b] = await Promise.all([submitAt(one.base, file, parent), submitAt(two.base, file, parent)])
    await bothPolling
    // Provider polling and each process's persisted job result are separate signals.
    await vi.waitFor(async () => {
      const accepted = await Promise.all([at(one.base, `/api/jobs/${a}`).then(r => r.json()), at(two.base, `/api/jobs/${b}`).then(r => r.json())])
      // A peer's blocked-page snapshot can remain claimed. Only its owner
      // submits that page; owners may split the two pages between processes.
      const ownedRequests = accepted.flatMap(row => Object.entries(row.result?.publication.files[0].requests ?? {})
        .filter(([, request]: [string, any]) => request.taskId === row.id)
        .map(([page, request]: [string, any]) => ({ page: Number(page), state: request.state, jobId: request.jobId })))
      expect(ownedRequests.map(request => request.page).sort(), JSON.stringify(accepted)).toEqual([1, 2])
      for (const request of ownedRequests) {
        expect(request.state).toBe('accepted')
        expect(request.jobId).toEqual(expect.any(String))
      }
    }, { timeout: 5000 })
    expect(api!.stats.submits).toBe(4)
    release()
    const idle = await Promise.all([at(one.base, '/issue309/idle'), at(two.base, '/issue309/idle')])
    expect(idle.map(r => r.status)).toEqual([200, 200])
    const completed = await Promise.all([at(one.base, `/api/jobs/${a}`).then(r => r.json()), at(two.base, `/api/jobs/${b}`).then(r => r.json())])
    expect(completed.map(row => row.state).every(state => ['done', 'failed'].includes(state))).toBe(true)
    // Split ownership may leave both jobs partial; the retained claims allow
    // the next resume to publish both completed pages without another POST.
    const old = await submitAt(two.base, file, parent)
    expect((await at(two.base, '/issue309/idle')).status).toBe(200)
    expect((await (await at(two.base, `/api/jobs/${old}`)).json()).state).toBe('done')
    expect(api!.stats.submits).toBe(4)
    const final = await status(parent)
    const { ocrRecovery, ...historic } = final.result
    expect(historic).toEqual(initial.result)
    expect(Object.values(ocrRecovery.pages)).toHaveLength(2)
    expect((Object.values(ocrRecovery.pages) as any[]).every(page => page.attempts.length === 2 && page.attempts.at(-1).state === 'complete')).toBe(true)
  } finally { release(); gate!(); await stopChild(one.child); await stopChild(two.child) }
}, 15000)

it.each(['claimed', 'complete'] as const)("SIGKILL after committed %s claim never repeats POST and preserves the original receipt", async phase => {
  const { file, pagePath } = await setup(1, { submitStatuses: [429] })
  gate!()
  const parent = await submit(file)
  await whenIdle()
  const initial = await status(parent)
  const stopped = join(dir, `issue309-${parent}-${phase}.json`)
  const one = await childHost({ ISSUE309_STOP_CLAIM_SOURCE: parent, ISSUE309_STOP_CLAIM_STATE: phase, ISSUE309_STOP_FILE: stopped })
  expect((await at(one.base, `/api/jobs/${parent}`)).status).toBe(200)
  const pending = submitAt(one.base, file, parent).catch(() => null)
  let two: Awaited<ReturnType<typeof childHost>> | undefined
  try {
    await vi.waitFor(() => expect(() => JSON.parse(readFileSync(stopped, 'utf8'))).not.toThrow())
    const root = await status(parent)
    const claim = (Object.values(root.result.ocrRecovery.pages)[0] as any).attempts.at(-1)
    expect(claim.state).toBe(phase)
    expect(api!.stats.submits).toBe(phase === 'claimed' ? 1 : 2)
    await stopChild(one.child); await pending
    const { ocrPageCacheDirAbs } = await import('../../../layers/core/server/utils/ocr-page-cache')
    rmSync(ocrPageCacheDirAbs(filesDir, file), { recursive: true, force: true })
    two = await childHost()
    expect((await at(two.base, `/api/jobs/${parent}`)).status).toBe(200)
    const retry = await submitAt(two.base, file, parent)
    await vi.waitFor(async () => expect((await (await at(two!.base, `/api/jobs/${retry}`)).json()).state).toBe(phase === 'claimed' ? 'failed' : 'done'))
    if (phase === 'claimed') {
      const throughOwner = await submitAt(two.base, file, claim.ownerTaskId)
      await vi.waitFor(async () => expect((await (await at(two!.base, `/api/jobs/${throughOwner}`)).json()).state).toBe('failed'))
      expect((await request(pagePath)).status).toBe(404)
    } else {
      expect(claim.capture.raw).toEqual({ markdown: { text: 'paid original' } })
      expect((await (await request(pagePath)).json()).markdown).toContain('paid original')
    }
    expect(api!.stats.submits).toBe(phase === 'claimed' ? 1 : 2)
    const { ocrRecovery: _metadata, ...historical } = (await status(parent)).result
    expect(historical).toEqual(initial.result)
  } finally { gate!(); await stopChild(one.child); await pending; if (two) await stopChild(two.child) }
})

it("SIGKILL after provider accepts but before ID receipt leaves shared unknown across processes", async () => {
  let release!: () => void
  const accepted = new Promise<void>(resolve => { release = resolve })
  const { file, pagePath } = await setup(1, { submitStatuses: [429], waitForSubmitResponse: n => n === 2 ? accepted : Promise.resolve() })
  const parent = await submit(file)
  await whenIdle()
  const one = await childHost()
  expect((await at(one.base, `/api/jobs/${parent}`)).status).toBe(200)
  const a = await submitAt(one.base, file, parent)
  let two: Awaited<ReturnType<typeof childHost>> | undefined
  try {
    await vi.waitFor(() => expect(api!.stats.submits).toBe(2))
    expect((Object.values((await status(parent)).result.ocrRecovery.pages)[0] as any).attempts.at(-1)).toMatchObject({ state: 'unknown', ownerTaskId: a })
    await stopChild(one.child)
    release()
    two = await childHost()
    expect((await at(two.base, `/api/jobs/${parent}`)).status).toBe(200)
    const b = await submitAt(two.base, file, parent)
    await vi.waitFor(async () => expect((await (await at(two!.base, `/api/jobs/${b}`)).json()).state).toBe('failed'))
    expect((await request(pagePath)).status).toBe(404)
    expect(api!.stats.submits).toBe(2)
    expect((Object.values((await status(parent)).result.ocrRecovery.pages)[0] as any).attempts.at(-1)).toMatchObject({ state: 'unknown', ownerTaskId: a })
  } finally { release(); gate!(); await stopChild(one.child); if (two) await stopChild(two.child) }
})

it("SIGKILL after accepted recovery lets an old parent resume the same remote ID across processes", async () => {
  const { file, pagePath } = await setup(1, { submitStatuses: [429] })
  const parent = await submit(file)
  await whenIdle()
  const one = await childHost()
  expect((await at(one.base, `/api/jobs/${parent}`)).status).toBe(200)
  const a = await submitAt(one.base, file, parent)
  let two: Awaited<ReturnType<typeof childHost>> | undefined
  try {
    await vi.waitFor(async () => expect((Object.values((await status(parent)).result.ocrRecovery.pages)[0] as any).attempts.at(-1)).toMatchObject({ state: 'accepted', ownerTaskId: a, jobId: 'JOB-2' }))
    await stopChild(one.child)
    two = await childHost()
    expect((await at(two.base, `/api/jobs/${parent}`)).status).toBe(200)
    const b = await submitAt(two.base, file, parent)
    gate!()
    await vi.waitFor(async () => expect((await (await at(two!.base, `/api/jobs/${b}`)).json()).state).toBe('done'))
    expect((await (await request(pagePath)).json()).markdown).toContain('paid original')
    expect(api!.stats.submits).toBe(2)
    const claim = (Object.values((await status(parent)).result.ocrRecovery.pages)[0] as any).attempts.at(-1)
    expect(claim.capture).toMatchObject({ taskId: a, jobId: 'JOB-2', raw: { markdown: { text: 'paid original' } } })
  } finally { gate!(); await stopChild(one.child); if (two) await stopChild(two.child) }
})

it.each(['accepted', 'published'] as const)("original stale cache miss is fenced after reconciliation while recovery is %s", async phase => {
  let releaseProvider!: () => void
  const providerWait = new Promise<void>(resolve => { releaseProvider = resolve })
  const { file, pagePath } = await setup(1, { waitForPoll: id => id === 'JOB-1' ? providerWait : Promise.resolve() })
  // Prime only the test process. The second child must perform its own real
  // first-request reconciliation while the first child's runner remains alive.
  expect((await request('/api/jobs/00000000000000000000000000')).status).toBe(404)
  const hit = join(dir, `issue309-cache-hit-${sequence}.json`)
  const release = join(dir, `issue309-cache-release-${sequence}`)
  const one = await childHost({ ISSUE309_CACHE_GATE_HIT: hit, ISSUE309_CACHE_GATE_RELEASE: release })
  let two: Awaited<ReturnType<typeof childHost>> | undefined
  try {
    const parent = await submitAt(one.base, file)
    await vi.waitFor(() => expect(JSON.parse(readFileSync(hit, 'utf8')).cacheMiss).toBe(true))
    const running = await status(parent)
    expect(running.state).toBe('running')
    expect(running.result.publication.files[0].requests).toEqual({})
    two = await childHost()
    const interrupted = await (await at(two.base, `/api/jobs/${parent}`)).json()
    expect(interrupted.state).toBe('failed')
    const a = await submitAt(two.base, file, parent)
    await vi.waitFor(async () => expect((await status(a)).result?.publication.files[0].requests['1']).toMatchObject({ state: 'accepted', jobId: 'JOB-1' }))
    if (phase === 'published') {
      releaseProvider()
      await vi.waitFor(async () => expect((await status(a)).state).toBe('done'))
    }
    // Cache miss was frozen before A existed; no cache deletion is needed.
    writeFileSync(release, 'release')
    expect(await (await at(one.base, '/issue309/idle')).json()).toEqual({ idle: true })
    expect(api!.stats.submits).toBe(1)
    releaseProvider()
    await vi.waitFor(async () => expect((await status(a)).state).toBe('done'))
    expect((await (await request(pagePath)).json()).markdown).toContain('paid original')
    const final = await status(parent)
    const { ocrRecovery, ...historical } = final.result
    expect(historical).toEqual(interrupted.result)
    const { result: _before, ...originalState } = interrupted
    const { result: _after, ...finalState } = final
    expect(finalState).toEqual(originalState)
    expect((Object.values(ocrRecovery.pages)[0] as any).attempts.at(-1)).toMatchObject({ state: 'complete', ownerTaskId: a, capture: { jobId: 'JOB-1', raw: { markdown: { text: 'paid original' } } } })
  } finally {
    writeFileSync(release, 'release'); releaseProvider(); gate!()
    await stopChild(one.child); if (two) await stopChild(two.child)
  }
})

it("original POST unknown at reconciliation retains its late paid receipt and never grants a second POST", async () => {
  let releaseId!: () => void
  const idWait = new Promise<void>(resolve => { releaseId = resolve })
  const { file, pagePath } = await setup(1, { waitForSubmitResponse: () => idWait })
  expect((await request('/api/jobs/00000000000000000000000000')).status).toBe(404)
  const one = await childHost()
  let two: Awaited<ReturnType<typeof childHost>> | undefined
  try {
    const parent = await submitAt(one.base, file)
    await vi.waitFor(() => expect(api!.stats.submits).toBe(1))
    expect((await status(parent)).result.publication.files[0].requests['1'].state).toBe('unknown')
    two = await childHost()
    const interrupted = await (await at(two.base, `/api/jobs/${parent}`)).json()
    expect(interrupted.state).toBe('failed')
    const a = await submitAt(two.base, file, parent)
    await vi.waitFor(async () => expect((await status(a)).state).toBe('failed'))
    expect((await status(a)).result.files[0].error).toContain('提交结果未知')
    expect(api!.stats.submits).toBe(1)
    releaseId(); gate!()
    expect(await (await at(one.base, '/issue309/idle')).json()).toEqual({ idle: true })
    const root = await status(parent)
    expect((Object.values(root.result.ocrRecovery.pages)[0] as any).attempts.at(-1)).toMatchObject({ state: 'complete', ownerTaskId: parent, capture: { jobId: 'JOB-1', taskId: parent, raw: { markdown: { text: 'paid original' } } } })
    const { ocrRecovery: _metadata, ...historical } = root.result
    expect(historical).toEqual(interrupted.result)
    // A terminal original executor keeps the paid result for explicit recovery;
    // its still-live stack does not publish pages behind the failed task row.
    expect((await request(pagePath)).status).toBe(404)
    const recovered = await submitAt(two.base, file, parent)
    await vi.waitFor(async () => expect((await status(recovered)).state).toBe('done'))
    expect((await (await request(pagePath)).json()).markdown).toContain('paid original')
    expect(api!.stats.submits).toBe(1)
  } finally { releaseId(); gate!(); await stopChild(one.child); if (two) await stopChild(two.child) }
})

it.each(['continue', 'SIGKILL'] as const)("committed original unknown fences recovery before POST when original will %s", async disposition => {
  const { file, pagePath } = await setup()
  expect((await request('/api/jobs/00000000000000000000000000')).status).toBe(404)
  const stopped = join(dir, `issue309-original-unknown-${sequence}.json`)
  const one = await childHost({ ISSUE309_STOP_ORIGINAL_UNKNOWN: '1', ISSUE309_STOP_FILE: stopped })
  const pending = submitAt(one.base, file).catch(() => null)
  let two: Awaited<ReturnType<typeof childHost>> | undefined
  try {
    await vi.waitFor(() => expect(JSON.parse(readFileSync(stopped, 'utf8')).committedState).toBe('original-unknown'))
    const parent = JSON.parse(readFileSync(stopped, 'utf8')).taskId as string
    expect((await status(parent)).result.publication.files[0].requests['1']).toEqual({ state: 'unknown', taskId: parent })
    expect(api!.stats.submits).toBe(0)
    two = await childHost()
    expect((await (await at(two.base, `/api/jobs/${parent}`)).json()).state).toBe('failed')
    const a = await submitAt(two.base, file, parent)
    await vi.waitFor(async () => expect((await status(a)).state).toBe('failed'))
    expect((await status(a)).result.files[0].error).toContain('提交结果未知')
    expect(api!.stats.submits).toBe(0)
    if (disposition === 'SIGKILL') {
      await stopChild(one.child); await pending
      const b = await submitAt(two.base, file, parent)
      await vi.waitFor(async () => expect((await status(b)).state).toBe('failed'))
      expect((await request(pagePath)).status).toBe(404)
      expect(api!.stats.submits).toBe(0)
      expect((Object.values((await status(parent)).result.ocrRecovery.pages)[0] as any).attempts.at(-1)).toMatchObject({ state: 'unknown', ownerTaskId: parent })
    } else {
      one.child.kill('SIGCONT'); await pending; gate!()
      expect(await (await at(one.base, '/issue309/idle')).json()).toEqual({ idle: true })
      expect(api!.stats.submits).toBe(1)
      const b = await submitAt(two.base, file, parent)
      await vi.waitFor(async () => expect((await status(b)).state).toBe('done'))
      expect((await (await request(pagePath)).json()).markdown).toContain('paid original')
      expect(api!.stats.submits).toBe(1)
    }
  } finally { gate!(); await stopChild(one.child); await pending; if (two) await stopChild(two.child) }
})

it("different original pages share durable authority after reconciliation without overwriting sibling receipts", async () => {
  const { file, pagePath } = await setup(2)
  expect((await request('/api/jobs/00000000000000000000000000')).status).toBe(404)
  const hit = join(dir, `issue309-multi-hit-${sequence}.json`)
  const release = join(dir, `issue309-multi-release-${sequence}`)
  const one = await childHost({ ISSUE309_CACHE_GATE_HIT: hit, ISSUE309_CACHE_GATE_RELEASE: release })
  let two: Awaited<ReturnType<typeof childHost>> | undefined
  try {
    const parent = await submitAt(one.base, file)
    await vi.waitFor(() => expect(JSON.parse(readFileSync(hit, 'utf8')).cacheMiss).toBe(true))
    await vi.waitFor(async () => expect((await status(parent)).result.publication.files[0].requests['2']).toMatchObject({ state: 'accepted', jobId: 'JOB-1' }))
    two = await childHost()
    const interrupted = await (await at(two.base, `/api/jobs/${parent}`)).json()
    expect(interrupted.state).toBe('failed')
    const a = await submitAt(two.base, file, parent)
    await vi.waitFor(async () => {
      const requests = (await status(a)).result.publication.files[0].requests
      expect(requests['1']).toMatchObject({ state: 'accepted', jobId: 'JOB-2' })
      expect(requests['2']).toMatchObject({ state: 'accepted', jobId: 'JOB-1' })
    })
    writeFileSync(release, 'release'); gate!()
    expect(await (await at(one.base, '/issue309/idle')).json()).toEqual({ idle: true })
    expect(await (await at(two.base, '/issue309/idle')).json()).toEqual({ idle: true })
    expect((await status(a)).state).toBe('done')
    expect(api!.stats.submits).toBe(2)
    for (const page of [1, 2]) expect((await (await request(pagePath.replace(/1$/, String(page)))).json()).markdown).toContain('paid original')
    const { ocrRecovery, ...historical } = (await status(parent)).result
    expect(historical).toEqual(interrupted.result)
    const claims = (Object.values(ocrRecovery.pages) as any[]).map(record => record.attempts.at(-1))
    expect(claims).toHaveLength(2)
    expect(claims.find(c => c.capture.page === 1)).toMatchObject({ state: 'complete', ownerTaskId: a, capture: { jobId: 'JOB-2', taskId: a } })
    expect(claims.find(c => c.capture.page === 2)).toMatchObject({ state: 'complete', ownerTaskId: parent, capture: { jobId: 'JOB-1', taskId: parent } })
  } finally { writeFileSync(release, 'release'); gate!(); await stopChild(one.child); if (two) await stopChild(two.child) }
})

it("legacy cache with unknown capture time retains null provenance without inventing a timestamp or paying", async () => {
  const { file, row, pagePath } = await setup()
  const { ocrRequestVariant } = await import('../../../layers/core/server/utils/ocr-api')
  const { ocrPageCacheDirAbs, ocrPageCacheKey } = await import('../../../layers/core/server/utils/ocr-page-cache')
  const model = 'PaddleOCR-VL-1.6', variant = ocrRequestVariant(model)
  const imageSha256 = createHash('sha256').update(readFileSync(join(filesDir, pageImageRelPath(file, 1)))).digest('hex')
  const cache = ocrPageCacheDirAbs(filesDir, file)
  mkdirSync(cache, { recursive: true })
  const cachePath = join(cache, `${ocrPageCacheKey(imageSha256, variant)}.json`)
  const legacy = { version: 1, imageSha256, variant, jobId: 'LEGACY-JOB', model, markdown: 'legacy cache text', raw: { original: 'legacy paid raw' } }
  writeFileSync(cachePath, JSON.stringify(legacy))
  const parent = await submit(file)
  await whenIdle()
  expect((await status(parent)).state).toBe('done')
  expect((await status(parent)).result.publication.files[0].captures[0]).toMatchObject({ createdAt: null, taskId: null, sourceSha256: null, raw: legacy.raw })
  expect((await (await request(pagePath)).json()).markdown).toContain('legacy cache text')
  const raw = db.select({ raw: schema.ocrResult.raw }).from(schema.ocrResult).where(eq(schema.ocrResult.fileId, row.id)).get()!.raw
  expect(raw).toMatchObject({ captures: [{ raw: legacy.raw, source: { createdAt: null }, input: { createdAt: null, taskId: null } }] })
  expect(JSON.parse(readFileSync(cachePath, 'utf8'))).toEqual(legacy)
  expect(api!.stats.submits).toBe(0)
})


it('B2 changed source with freshly matching pages is rejected before any paid OCR and original recovery keeps the ID', async () => {
  const { file, row, pagePath } = await setup()
  const original = readFileSync(join(filesDir, file))
  const replacement = Buffer.from(original.toString('latin1').replace('0 0 0 rg', '1 0 0 rg'), 'latin1')
  expect(replacement.length).toBe(original.length)
  expect(replacement.equals(original)).toBe(false)
  writeFileSync(join(filesDir, file), replacement)
  await renderPdfPages(filesDir, file, { dpi: DEFAULT_DPI, force: true })
  gate!()
  const rejected = await submit(file)
  await whenIdle()
  expect((await status(rejected)).state).toBe('failed')
  expect((await status(rejected)).result.files[0].error).toContain('内容身份冲突')
  expect(api!.stats.submits).toBe(0)
  expect((await request(pagePath)).status).toBe(404)
  expect(db.select().from(schema.storedFile).where(eq(schema.storedFile.id, row.id)).get()).toEqual(row)
  writeFileSync(join(filesDir, file), original)
  await renderPdfPages(filesDir, file, { dpi: DEFAULT_DPI, force: true })
  gate!()
  const restored = await submit(file)
  await whenIdle()
  expect((await status(restored)).state).toBe('done')
  expect((await status(restored)).result.files[0].fileId).toBe(row.id)
  expect(api!.stats.submits).toBe(1)
})

it('B2 incorrect registered byte size blocks paid OCR even when the digest matches', async () => {
  const { file, row } = await setup()
  gate!()
  db.update(schema.storedFile).set({ bytes: row.bytes + 1 }).where(eq(schema.storedFile.id, row.id)).run()
  const id = await submit(file)
  await whenIdle()
  expect((await status(id)).state).toBe('failed')
  expect((await status(id)).result.files[0].error).toContain('内容身份冲突')
  expect(api!.stats.submits).toBe(0)
})

it('B2 replacement after provider acceptance preserves paid raw but cannot publish or pay again on resume', async () => {
  const { file, pagePath } = await setup()
  const id = await submit(file)
  await vi.waitFor(() => expect(api!.stats.submits).toBe(1))
  const original = readFileSync(join(filesDir, file))
  writeFileSync(join(filesDir, file), Buffer.from(original.toString('latin1').replace('0 0 0 rg', '1 0 0 rg'), 'latin1'))
  gate!(); await whenIdle()
  const failed = await status(id)
  expect(failed.state).toBe('failed')
  expect(failed.result.publication.files[0].captures[0]).toMatchObject({ raw: { markdown: { text: 'paid original' } } })
  expect((await request(pagePath)).status).toBe(404)
  const resumed = await submit(file, id)
  await whenIdle()
  expect((await status(resumed)).state).toBe('failed')
  expect(api!.stats.submits).toBe(1)
  expect((await status(id)).result).toEqual(failed.result)
})

it('B2 historical checkpoint without byte identity stays unknown and retains its paid capture on resume', async () => {
  const { file, pagePath } = await setup()
  const id = await submit(file)
  await vi.waitFor(() => expect(api!.stats.submits).toBe(1))
  expect((await request(pagePath, 'PUT', { markdown: 'human retained', expectedVersion: null })).status).toBe(200)
  gate!(); await whenIdle()
  const old = await status(id)
  expect(old.state).toBe('failed')
  expect(old.result.publication.files[0].captures[0].raw).toEqual({ markdown: { text: 'paid original' } })
  const legacy = structuredClone(old.result)
  delete legacy.publication.files[0].registeredBytes
  delete legacy.publication.files[0].sourceBytes
  db.update(schema.job).set({ result: legacy }).where(eq(schema.job.id, id)).run()
  const resumed = await submit(file, id)
  await whenIdle()
  const result = await status(resumed)
  expect(result.state).toBe('failed')
  expect(result.result.files[0].error).toContain('内容身份未知')
  expect(result.result.publication.files[0].captures).toEqual(legacy.publication.files[0].captures)
  expect((await status(id)).result).toEqual(legacy)
  expect((await (await request(pagePath)).json()).markdown).toContain('human retained')
  expect(api!.stats.submits).toBe(1)
})

async function submitRender(files: string[]) {
  const response = await request('/api/jobs', 'POST', { kind: 'render-pages', params: { files, force: true } })
  expect(response.status).toBe(202)
  return (await response.json()).jobId as string
}

it('B2 async rendering rejects replacement without touching pages and restores the registered identity', async () => {
  const { file, row } = await setup()
  const manifestPath = join(filesDir, pageDirRelPath(file), PAGES_MANIFEST_NAME)
  const manifest = readFileSync(manifestPath)
  const original = readFileSync(join(filesDir, file))
  writeFileSync(join(filesDir, file), Buffer.from(original.toString('latin1').replace('0 0 0 rg', '1 0 0 rg'), 'latin1'))
  const bad = await submitRender([file])
  await whenIdle()
  expect((await status(bad)).state).toBe('failed')
  expect((await status(bad)).result.files[0].error).toContain('file_content_conflict')
  expect(readFileSync(manifestPath).equals(manifest)).toBe(true)
  writeFileSync(join(filesDir, file), original)
  const recovered = await submitRender([file])
  await whenIdle()
  expect((await status(recovered)).state).toBe('done')
  expect((await status(recovered)).result.files[0].contentIdentity).toEqual({ fileId: row.id, relPath: file, sha256: row.sha256, bytes: original.length })
})

it('B2 queued render cannot rebind its locator to a different registered ID', async () => {
  const { file, row } = await setup()
  const blocking = await submit(file)
  await vi.waitFor(() => expect(api!.stats.submits).toBe(1))
  const queued = await submitRender([file])
  expect((await status(queued)).state).toBe('queued')
  db.update(schema.storedFile).set({ relPath: file + '.old' }).where(eq(schema.storedFile.id, row.id)).run()
  createClassifiedFile(db, { relPath: file, filename: file, ext: 'pdf', bytes: row.bytes, sha256: row.sha256 }, {})
  gate!(); await whenIdle()
  expect((await status(blocking)).state).toBe('failed')
  expect((await status(queued)).state).toBe('failed')
  expect((await status(queued)).result.files[0].error).toContain('file_content_conflict')
})

it('B2 async render leaves unregistered input pending unknown without publishing pages', async () => {
  const file = `unregistered-${++sequence}.pdf`
  writeFileSync(join(filesDir, file), minimalPdf({ pages: 1, widthPt: 100, heightPt: 60 }))
  const id = await submitRender([file])
  await whenIdle()
  expect((await status(id)).state).toBe('failed')
  expect((await status(id)).result.files[0].error).toContain('file_content_unknown')
  expect(() => readFileSync(join(filesDir, pageDirRelPath(file), PAGES_MANIFEST_NAME))).toThrow()
})


it('B2 replacement during an awaited cache lookup is rejected at the paid POST boundary', async () => {
  const { file, pagePath } = await setup()
  expect((await request('/api/jobs/00000000000000000000000000')).status).toBe(404)
  const hit = join(dir, `issue311-cache-hit-${sequence}.json`)
  const release = join(dir, `issue311-cache-release-${sequence}`)
  const host = await childHost({ ISSUE309_CACHE_GATE_HIT: hit, ISSUE309_CACHE_GATE_RELEASE: release })
  try {
    const id = await submitAt(host.base, file)
    await vi.waitFor(() => expect(JSON.parse(readFileSync(hit, 'utf8')).cacheMiss).toBe(true))
    const original = readFileSync(join(filesDir, file))
    writeFileSync(join(filesDir, file), Buffer.from(original.toString('latin1').replace('0 0 0 rg', '1 0 0 rg'), 'latin1'))
    writeFileSync(release, 'release'); gate!()
    expect(await (await at(host.base, '/issue309/idle')).json()).toEqual({ idle: true })
    expect((await status(id)).state).toBe('failed')
    expect((await status(id)).result.files[0].error).toContain('内容身份冲突')
    expect((await status(id)).result.publication.files[0].requests).toEqual({})
    expect(api!.stats.submits).toBe(0)
    expect((await request(pagePath)).status).toBe(404)
  } finally { writeFileSync(release, 'release'); gate!(); await stopChild(host.child) }
})
