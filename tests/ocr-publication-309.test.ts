import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as h3 from 'h3'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { useDb, schema } from '../db'
import { whenIdle } from '../server/utils/job-runner'
import { DEFAULT_DPI } from '../lib/pdf-page'
import { pageImageRelPath } from '../lib/pdf-page'
import { renderPdfPages } from '../server/utils/pdf-pages'
import { minimalPdf } from './helpers/minimal-pdf'
import { startMiniOcrApi } from './helpers/ocr-mini-api'
import type { ModelApiFixture } from './helpers/ocr-mini-api'
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
const db = useDb({ dbPath })
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
  const post = (await import('../server/api/jobs/index.post')).default
  const get = (await import('../server/api/jobs/[id].get')).default
  const cancel = (await import('../server/api/jobs/[id].delete')).default
  const read = (await import('../server/api/files/[id]/ocr-pages/[page].get')).default
  const save = (await import('../server/api/files/[id]/ocr-pages/[page].put')).default
  const router = h3.createRouter().post('/api/jobs', post).get('/api/jobs/:id', get).delete('/api/jobs/:id', cancel)
    .get('/api/files/:id/ocr-pages/:page', read).put('/api/files/:id/ocr-pages/:page', save)
  server = createServer(h3.toNodeListener(h3.createApp({ debug: false }).use(router)))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  // Real SDK transport + real tool handlers/schema. Nitro toolkit registration
  // and its auth middleware are outside this focused harness.
  mcp = new McpServer({ name: 'issue309', version: '1' })
  for (const name of ['get_ocr_result', 'save_ocr_result']) {
    const tool = (await import(`../server/mcp/tools/${name}.ts`)).default as unknown as { inputSchema: ZodRawShape; handler: (input: Record<string, unknown>) => Promise<unknown> }
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
async function setup(pages = 1, fixture: Partial<ModelApiFixture> = {}) {
  await api?.close()
  const file = `synthetic-${++sequence}.pdf`
  writeFileSync(join(filesDir, file), minimalPdf({ pages }))
  const row = db.insert(schema.storedFile).values({ relPath: file, filename: file, ext: 'pdf', bytes: 1, sha256: createHash('sha256').update(readFileSync(join(filesDir, file))).digest('hex') }).returning().get()
  await renderPdfPages(filesDir, file, { dpi: DEFAULT_DPI })
  const wait = new Promise<void>(resolve => { gate = resolve })
  api = await startMiniOcrApi({ pages: ['paid original'], waitForPoll: () => wait, ...fixture })
  vi.stubEnv('NUXT_OCR_BASE_URL', api.origin)
  return { file, row, pagePath: `/api/files/${row.id}/ocr-pages/1` }
}
async function submit(file: string, resumeJobId?: string) {
  const response = await request('/api/jobs', 'POST', { kind: 'ocr', params: { files: [file], ...(resumeJobId ? { resumeJobId } : {}) } })
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
  const { ocrPageCacheDirAbs } = await import('../server/utils/ocr-page-cache')
  rmSync(ocrPageCacheDirAbs(filesDir, file), { recursive: true, force: true })
  const retry = await submit(file, id)
  await whenIdle()
  expect((await status(retry)).state).toBe('done')
  expect(api!.stats.submits).toBe(3)
  expect((await (await request(pagePath)).json()).markdown).toContain('paid original')
  expect((await status(id)).result).toEqual(failed.result)
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

async function childHost() {
  const child = spawn(process.execPath, ['tests/helpers/issue309-ocr-child.mjs'], { cwd: process.cwd(), env: { ...process.env, NUXT_DB_PATH: dbPath, NUXT_FILES_DIR: filesDir, NUXT_API_TOKEN: 'issue309-api', NUXT_OCR_TOKEN: 'issue309-synthetic-ocr', NUXT_OCR_BASE_URL: api!.origin, MIIT_COOKIE: '', MIIT_COOKIE_FILE: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
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
    const { ocrPageCacheDirAbs } = await import('../server/utils/ocr-page-cache')
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
  } finally { releaseSecond(); base = savedBase }
})

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
  writeFileSync(join(filesDir, file), minimalPdf({ pages: 2 }))
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
