import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { minimalPdf } from '../../support/minimal-pdf'
import { initializeDb } from '../../../db/client'
import { spawnOwnedChild as spawn, reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../../support/owned-process.mjs'

const dir = mkdtempSync(join(tmpdir(), 'read-311b-http-'))
const root = join(dir, 'files')
mkdirSync(root)
const dbPath = join(dir, 'fixture.sqlite')
const db = initializeDb({ create: true,  dbPath })
let service: { baseUrl: string; stop(): Promise<void> }
let output = ''
beforeAll(async () => {
  const port = await reserveLoopbackPort()
  const child = spawn(process.execPath, [resolve('node_modules/nuxt/bin/nuxt.mjs'), 'dev', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NUXT_BUILD_DIR: join(dir, 'build'), NUXT_DB_PATH: dbPath, NUXT_FILES_DIR: root, NUXT_INCOMING_DIR: join(dir, 'incoming') },
  })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-10000) })
  service = { baseUrl: `http://127.0.0.1:${port}`, stop: () => stopOwnedChild(child) }
  try { await waitForHttp(`${service.baseUrl}/api/health`, { timeoutMs: 60000, child }) }
  catch (error) { await service.stop(); throw new Error(`${error}\n${output}`) }
}, 90000)
afterAll(async () => { await service?.stop(); db.$client.close(); rmSync(dir, { recursive: true, force: true }) })
const rest = (url: string, init?: RequestInit) => fetch(service.baseUrl + url, init)
async function rpc(name: string, args: unknown) {
  const res = await rest('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
  const raw = await res.text()
  const body = JSON.parse(raw.startsWith('event:') ? raw.split('\n').find(line => line.startsWith('data: '))!.slice(6) : raw)
  return { result: body.result, value: JSON.parse(body.result.content[0].text) }
}
it('public raw ID/path Range HEAD and PDF/MCP reads retain registration across replacement and recovery', async () => {
  writeFileSync(join(root, 'public.pdf'), 'abc')
  const registration = await rest('/api/files/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ relPath: 'public.pdf' }) })
  expect(registration.status).toBe(201)
  const file = await registration.json() as { id: number }
  const original = await rest(`/api/files/${file.id}`)
  expect(original.status).toBe(200)
  expect(await original.text()).toBe('abc')
  expect(original.headers.get('cache-control')).toContain('no-store')
  expect(original.headers.get('x-file-id')).toBe(String(file.id))
  writeFileSync(join(root, 'public.pdf'), 'xyz')
  for (const url of ['/api/files/public.pdf', `/api/files/${file.id}`, `/api/pdf-pages?fileId=${file.id}`, '/api/pdf-pages?file=public.pdf&page=1']) {
    const response = await rest(url, { headers: { range: 'bytes=0-0' } })
    expect(response.status, url).toBe(409)
    expect(await response.json()).toMatchObject({ data: { code: 'file_content_conflict' } })
  }
  expect((await rest('/api/files/public.pdf', { method: 'HEAD' })).status).toBe(409)
  const detail = await rpc('get_file', { fileId: file.id })
  expect(detail.value).toMatchObject({ id: file.id, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', contentIdentity: { status: 'file_content_conflict', historical: 'unknown' } })
  // MCP error text is transport-owned; do not JSON-parse its human error envelope.
  const pageResponse = await rest('/api/pdf-pages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: 'public.pdf' }) })
  expect(pageResponse.status).toBe(409)
  writeFileSync(join(root, 'public.pdf'), 'abc')
  const range = await rest(`/api/files/${file.id}`, { headers: { range: 'bytes=1-2' } })
  expect(range.status).toBe(206)
  expect(await range.text()).toBe('bc')
  const restored = await rpc('get_file', { fileId: file.id })
  expect(restored.value.contentIdentity).toMatchObject({ status: 'verified', historical: 'unknown', registered: { fileId: file.id, bytes: 3 } })
  writeFileSync(join(root, 'legacy.txt'), 'unknown legacy')
  const legacy = await rest('/api/files/legacy.txt')
  expect(await legacy.text()).toBe('unknown legacy')
  expect(legacy.headers.get('x-file-content-status')).toBe('unknown')
})


it.each(['render.pdf', 'render.v1.pdf', 'nested.v1/render.final.pdf'])('public rendered pages preserve source lineage and reject equal-size replacement before cache reuse: %s', async fileName => {
  const original = minimalPdf({ pages: 1 })
  const replacement = Buffer.from(original)
  const marker = replacement.indexOf('400 200')
  expect(marker).toBeGreaterThan(0)
  replacement.write('401 200', marker, 'ascii')
  mkdirSync(dirname(join(root, fileName)), { recursive: true })
  writeFileSync(join(root, fileName), original)
  const registered = await rest('/api/files/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ relPath: fileName }) })
  expect(registered.status).toBe(201)
  const file = await registered.json() as { id: number }
  const rendered = await rest('/api/pdf-pages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: fileName, dpi: 72 }) })
  expect(rendered.status).toBe(200)
  const state = await rendered.json() as { pages: { url: string }[] }
  expect(state.pages).toHaveLength(1)
  const pageUrl = state.pages[0]!.url
  const page = await rest(pageUrl)
  expect(page.status).toBe(200)
  const png = Buffer.from(await page.arrayBuffer())
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  const manifestPath = join(root, dirname(fileName), `.${basename(fileName)}.pages`, '.pages.json')
  const originalManifest = readFileSync(manifestPath, 'utf8')
  writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(originalManifest), file: 'foreign.pdf' }))
  const foreign = await rest(pageUrl)
  expect(foreign.status).toBe(409)
  expect(await foreign.json()).toMatchObject({ data: { code: 'file_content_conflict', reason: 'page_source_mismatch' } })
  expect(readFileSync(join(root, fileName))).toEqual(original)
  rmSync(manifestPath)
  const legacyPage = await rest(pageUrl)
  expect(legacyPage.status).toBe(200)
  expect(legacyPage.headers.get('x-file-content-status')).toBe('unknown')
  expect(Buffer.from(await legacyPage.arrayBuffer())).toEqual(png)
  writeFileSync(manifestPath, originalManifest)
  const listed = await rpc('list_page_images', { fileId: file.id, dpi: 72 })
  expect(listed.value).toMatchObject({ upToDate: true, file: { id: file.id, contentIdentity: { status: 'verified', historical: 'unknown' } } })
  writeFileSync(join(root, fileName), replacement)
  for (const url of [pageUrl, `/api/pdf-pages?file=${fileName}&page=1`, `/api/pdf-pages?fileId=${file.id}`]) expect((await rest(url)).status, url).toBe(409)
  writeFileSync(join(root, fileName), original)
  const recovered = await rest(pageUrl)
  expect(recovered.status).toBe(200)
  expect(Buffer.from(await recovered.arrayBuffer())).toEqual(png)
})
