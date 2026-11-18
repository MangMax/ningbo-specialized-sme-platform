import { createClassifiedFile } from '../../../server/utils/roster-file-classification'
import { assertEnterpriseDetailSnapshotEqual } from '../../roster/assertions/enterprise-detail-snapshot'
import { readDevelopmentDiscovery } from '../../roster/current-export/fixtures/specialized-export'
import { initializeDb } from '../../../db/client'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { useDb, schema } from '../../../db'
import { minimalPdf } from '../../support/minimal-pdf'

import { spawnCompiledApp, reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../../support/owned-process.mjs'

const dir = mkdtempSync(join(tmpdir(), 'ocr-lifecycle-106-'))
const dbPath = join(dir, 'test.sqlite')
const root = join(dir, 'files')
mkdirSync(root)
const db = initializeDb({ create: true, dbPath })
const file = createClassifiedFile(db, { relPath: 'synthetic.pdf', filename: 'synthetic.pdf', ext: 'pdf', bytes: 12, sha256: 'synthetic' }, {})
writeFileSync(join(root, file.relPath), minimalPdf({ pages: 6 }))
let app: { baseUrl: string; stop(): Promise<void> }
let rpcId = 0
async function rpc(method: string, params: unknown, token: string | null = 'synthetic-mcp-106') {
  const response = await fetch(`${app.baseUrl}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) })
  const text = await response.text()
  return { status: response.status, body: JSON.parse(text.split('\n').find(line => line.startsWith('data: '))?.slice(6) ?? text) }
}
async function call(name: string, args: unknown) {
  const response = await rpc('tools/call', { name, arguments: name === 'get_ocr_result' ? { ...(args as object), includeVersion: true } : args })
  expect(response.status).toBe(200)
  expect(response.body.error).toBeUndefined()
  expect(response.body.result.isError).not.toBe(true)
  return JSON.parse(response.body.result.content[0].text)
}
async function rest(method: string, page?: number, body?: unknown) {
  return fetch(`${app.baseUrl}/api/ocr-results?includeVersion=1&fileId=${file.id}${page === undefined ? '' : `&page=${page}`}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
let discovery: any
beforeAll(async () => {
  discovery = await readDevelopmentDiscovery()
  const port = await reserveLoopbackPort()
  const baseUrl = `http://127.0.0.1:${port}`
  const child = spawnCompiledApp(port, { env: { ...process.env, NUXT_BUILD_DIR: join(dir, 'nuxt'), NUXT_DB_PATH: dbPath, NUXT_FILES_DIR: root, NUXT_API_TOKEN: 'synthetic-api-106', NUXT_MCP_TOKEN: 'synthetic-mcp-106', NUXT_OCR_TOKEN: '', PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN: '', MIIT_COOKIE: '', MIIT_COOKIE_FILE: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
  app = { baseUrl, stop: () => stopOwnedChild(child) }
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  try { await waitForHttp(`${baseUrl}/api/health`, { child }) } catch (error) { throw new Error(`${error}\n${output}`) }
  const coldPath = 'jxj/announcement/2024/1/cold.pdf'
  mkdirSync(join(root, 'jxj/announcement/2024/1'), { recursive: true })
  writeFileSync(join(root, coldPath), minimalPdf({ pages: 1 }))
  const cold = await fetch(`${baseUrl}/api/ocr-results?file=${encodeURIComponent(coldPath)}`)
  expect(cold.status).toBe(200)
  expect(await cold.json()).toMatchObject({
    file: { relPath: coldPath, filename: 'cold.pdf', ext: 'pdf', parseState: 'unparsed' },
    count: 0,
  })
}, 120_000)
afterAll(async () => { await app?.stop(); db.$client.close(); rmSync(dir, { recursive: true, force: true }) })
beforeEach(async () => {
  db.$client.prepare('DELETE FROM ocr_result WHERE file_id=?').run(file.id)
  await call('save_ocr_result', { fileId: file.id, markdown: '<!-- page: 1 -->\nbaseline one\n<!-- page: 2 -->\nbaseline two' })
})

it('MCP single-page deletion matches REST and missing-page deletion is idempotent', async () => {
  await call('save_ocr_result', { fileId: file.id, markdown: '<!-- page: 1 -->\none\n<!-- page: 2 -->\ntwo\n<!-- page: 3 -->\nthree' })
  const mcp = await call('delete_ocr_result', { fileId: file.id, page: 2, expectedVersion: (await call('get_ocr_result', { fileId: file.id, page: 2 })).results[0].version })
  expect(mcp).toMatchObject({ file: { id: file.id }, page: 2, deleted: 1, remaining: 2 })
  expect(await call('delete_ocr_result', { fileId: file.id, page: 2, expectedVersion: null })).toEqual({ ...mcp, deleted: 0 })
  expect(await (await rest('DELETE', 3)).json()).toMatchObject({ page: 3, deleted: 1, remaining: 1 })
  expect(await (await rest('GET')).json()).toMatchObject({ count: 1, pages: [{ page: 1 }] })
})

it('read versions reject stale overwrite and delete across transports and survive delete-recreate', async () => {
  await call('save_ocr_result', { fileId: file.id, page: 1, markdown: 'first' })
  const first = await call('get_ocr_result', { fileId: file.id, page: 1 })
  const version = first.results[0].version
  expect(version).toMatch(/^\d+:\d+$/)
  expect((await pageRequest('PUT', 1, { markdown: 'create-only conflict', expectedVersion: null })).status).toBe(409)
  const updated = await rest('POST', undefined, { fileId: file.id, page: 1, markdown: 'second', expectedVersion: version })
  expect(updated.status).toBe(200)
  const second = await (await rest('GET', 1)).json()
  expect(second.pages[0].version).not.toBe(version)
  const stale = await rest('POST', undefined, { fileId: file.id, page: 1, markdown: 'lost update', expectedVersion: version })
  expect(stale.status).toBe(409)
  const denied = await rpc('tools/call', { name: 'delete_ocr_result', arguments: { fileId: file.id, page: 1, expectedVersion: version } })
  expect(JSON.stringify(denied.body)).toContain('409')
  expect((await call('get_ocr_result', { fileId: file.id, page: 1 })).markdown).toContain('second')
  await call('delete_ocr_result', { fileId: file.id, page: 1, expectedVersion: second.pages[0].version })
  await call('save_ocr_result', { fileId: file.id, page: 1, markdown: 'recreated', expectedVersion: null })
  const recreated = await call('get_ocr_result', { fileId: file.id, page: 1 })
  expect(recreated.results[0].version).not.toBe(version)
  const aba = await rest('POST', undefined, { fileId: file.id, page: 1, markdown: 'ABA overwrite', expectedVersion: second.pages[0].version })
  expect(aba.status).toBe(409)
  expect((await call('get_ocr_result', { fileId: file.id, page: 1 })).markdown).toContain('recreated')
})

it("workbench versioned commands reject stale HTTP save and delete after MCP updates", async () => {
  const snapshot = await (await rest('GET', 1)).json()
  const version = snapshot.pages[0].version
  const mcpRead = await call('get_ocr_result', { fileId: file.id, page: 1 })
  expect(version).toBe(mcpRead.results[0].version)
  await call('save_ocr_result', { fileId: file.id, page: 1, markdown: 'B window new text', expectedVersion: version, mode: 'versioned' })
  const stale = await rest('POST', undefined, { file: file.relPath, page: 1, markdown: 'A window draft', expectedVersion: version, mode: 'versioned' })
  expect(stale.status).toBe(409)
  const staleDelete = await fetch(`${app.baseUrl}/api/ocr-results?file=${encodeURIComponent(file.relPath)}&page=1&mode=versioned&expectedVersion=${encodeURIComponent(version)}`, { method: 'DELETE' })
  expect(staleDelete.status).toBe(409)
  expect((await call('get_ocr_result', { fileId: file.id, page: 1 })).markdown).toBe('<!-- page: 1 -->\n\nB window new text')
  const created = await rest('POST', undefined, { file: file.relPath, page: 3, markdown: 'new page', expectedVersion: null, mode: 'versioned' })
  expect(created.status).toBe(200)
  expect((await rest('POST', undefined, { file: file.relPath, page: 3, markdown: 'create-only overwrite', expectedVersion: null, mode: 'versioned' })).status).toBe(409)
  expect((await rest('POST', undefined, { file: file.relPath, page: 3, markdown: 'missing precondition', mode: 'versioned' })).status).toBe(400)
  expect((await call('get_ocr_result', { fileId: file.id, page: 3 })).markdown).toBe('<!-- page: 3 -->\n\nnew page')
  // Compatibility commands retain their existing policy for agents that did not opt in.
  expect((await rest('POST', undefined, { file: file.relPath, page: 3, markdown: 'legacy agent' })).status).toBe(200)
})

async function pageRequest(method: string, page: number | string, body?: unknown, token: string | null = 'synthetic-api-106', fileId = file.id) {
  return fetch(`${app.baseUrl}/api/files/${fileId}/ocr-pages/${page}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
it('authenticated stable-ID REST pages share MCP write validation and exact readback', async () => {
  const denied = await pageRequest('PUT', 4, { markdown: 'four' }, null)
  expect(denied.status).toBe(401)
  expect((await pageRequest('PUT', 4, { markdown: 'four' }, 'synthetic-mcp-106')).status).toBe(401)
  const saved = await pageRequest('PUT', 4, { markdown: 'four', expectedVersion: null })
  expect(saved.status).toBe(200)
  const read = await pageRequest('GET', 4, undefined, null)
  expect(read.status).toBe(200)
  expect(await read.json()).toEqual(await call('get_ocr_result', { fileId: file.id, page: 4 }))
  const current = await call('get_ocr_result', { fileId: file.id, page: 4 })
  expect(current.markdown).toBe('<!-- page: 4 -->\n\nfour')
  expect((await pageRequest('DELETE', 4, { expectedVersion: current.results[0].version })).status).toBe(200)
  expect(await (await pageRequest('DELETE', 4, { expectedVersion: null })).json()).toMatchObject({ deleted: 0 })
  expect((await pageRequest('GET', 4, undefined, null)).status).toBe(404)
  const unauthorizedMcp = await rpc('tools/call', { name: 'delete_ocr_result', arguments: { fileId: file.id, page: 1 } }, null)
  expect(unauthorizedMcp.status).toBe(401)
  expect((await rpc('tools/call', { name: 'delete_ocr_result', arguments: { fileId: file.id, page: 1 } }, 'synthetic-api-106')).status).toBe(401)
  expect((await rpc('tools/list', {}, null)).body.result.tools.map((t: any) => t.name)).not.toContain('delete_ocr_result')
  expect((await rpc('tools/list', {})).body.result.tools.map((t: any) => t.name)).toContain('delete_ocr_result')
})

it('explicit page scope and invalid fields cannot widen OCR writes or deletions', async () => {
  expect((await rest('DELETE')).status).toBe(400)
  const missingPage = await rpc('tools/call', { name: 'delete_ocr_result', arguments: { fileId: file.id } })
  expect(Boolean(missingPage.body.error || missingPage.body.result?.isError)).toBe(true)
  for (const page of [0, 2001, '1.5', 'abc']) {
    expect((await pageRequest('DELETE', page)).status).toBe(400)
    expect((await pageRequest('PUT', page, { markdown: 'bad' })).status).toBe(400)
  }
  for (const body of [{ markdown: 'bad', page: 2 }, { markdown: 'bad', replaceExistingPages: true }, { markdown: 'bad', expectedVersion: 'bogus' }, { markdown: 7 }, null]) {
    expect((await pageRequest('PUT', 1, body && typeof body === 'object' ? { expectedVersion: (await call('get_ocr_result', { fileId: file.id, page: 1 })).results[0].version, ...body } : body)).status).toBe(400)
  }
  expect((await pageRequest('DELETE', 1, { all: true })).status).toBe(400)
  expect((await rest('POST', undefined, { fileId: file.id, markdown: '<!-- page: 1 -->\nunsafe', expectedVersion: null })).status).toBe(400)
  const mixed = await rpc('tools/call', { name: 'save_ocr_result', arguments: { fileId: file.id, relPath: file.relPath, page: 1, markdown: 'ambiguous' } })
  expect(JSON.stringify(mixed.body)).toContain('400')
  expect((await pageRequest('GET', 1, undefined, null, 999999)).status).toBe(404)
  expect((await pageRequest('PUT', 7, { markdown: 'out of PDF', expectedVersion: null })).status).toBe(400)
  const outOfBounds = await rpc('tools/call', { name: 'save_ocr_result', arguments: { fileId: file.id, page: 7, markdown: 'out of PDF' } })
  expect(JSON.stringify(outOfBounds.body)).toContain('400')
  const nonPdf = createClassifiedFile(db, { relPath: 'synthetic.docx', filename: 'synthetic.docx', ext: 'docx', bytes: 5, sha256: 'synthetic' }, {})
  writeFileSync(join(root, 'synthetic.docx'), 'dummy')
  expect((await pageRequest('PUT', 1, { markdown: 'wrong source', expectedVersion: null }, 'synthetic-api-106', nonPdf.id)).status).toBe(415)
  const wrongSource = await rpc('tools/call', { name: 'save_ocr_result', arguments: { fileId: nonPdf.id, page: 1, markdown: 'wrong source' } })
  expect(JSON.stringify(wrongSource.body)).toContain('415')
  expect((await call('get_ocr_result', { fileId: file.id, page: 1 })).markdown).toContain('baseline one')
})

it('two writers with one expected version admit exactly one change and retain other pages', async () => {
  const current = await call('get_ocr_result', { fileId: file.id, page: 1 })
  const other = await call('get_ocr_result', { fileId: file.id, page: 2 })
  const results = await Promise.all(['writer A', 'writer B'].map(markdown => pageRequest('PUT', 1, { markdown, expectedVersion: current.results[0].version })))
  expect(results.map(response => response.status).sort()).toEqual([200, 409])
  const winner = await call('get_ocr_result', { fileId: file.id, page: 1 })
  expect(['<!-- page: 1 -->\n\nwriter A', '<!-- page: 1 -->\n\nwriter B']).toContain(winner.markdown)
  expect((await pageRequest('DELETE', 1, { expectedVersion: current.results[0].version })).status).toBe(409)
  const staleSave = await rpc('tools/call', { name: 'save_ocr_result', arguments: { fileId: file.id, page: 1, markdown: 'stale MCP', expectedVersion: current.results[0].version } })
  expect(JSON.stringify(staleSave.body)).toContain('409')
  expect((await call('get_ocr_result', { fileId: file.id, page: 1 })).markdown).toBe(winner.markdown)
  expect(await call('get_ocr_result', { fileId: file.id, page: 2 })).toEqual(other)
})

it('failed multi-page overwrite rolls back every page and its version', async () => {
  await call('save_ocr_result', { fileId: file.id, markdown: '<!-- page: 1 -->\noriginal one\n<!-- page: 2 -->\noriginal two' })
  const before = await call('get_ocr_result', { fileId: file.id })
  db.$client.exec(`CREATE TRIGGER synthetic_106_failure BEFORE UPDATE ON ocr_result WHEN NEW.file_id=${file.id} AND NEW.page_no=2 BEGIN SELECT RAISE(ABORT, 'synthetic transaction failure'); END`)
  try {
    const failed = await rpc('tools/call', { name: 'save_ocr_result', arguments: { fileId: file.id, markdown: '<!-- page: 1 -->\nchanged one\n<!-- page: 2 -->\nchanged two' } })
    expect(failed.body.result.isError).toBe(true)
    expect(await call('get_ocr_result', { fileId: file.id })).toEqual(before)
  } finally { db.$client.exec('DROP TRIGGER synthetic_106_failure') }
})

it('page redo and deletion preserve source bytes, images, file parts, formal events and evidence', async () => {
  const owner = db.insert(schema.enterprise).values({ name: 'OCR 边界合成企业', nameNorm: 'OCR 边界合成企业' }).returning().get()
  const record = db.insert(schema.record).values({ enterpriseId: owner.id, source: 'jxj', titleCode: 'specialized_sme' }).returning().get()
  const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2024, decidedYear: 2024, batchSeq: 1 }).returning().get()
  db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: file.relPath, attachment: '附件1', page: 1, listNo: 9 }).run()
  db.insert(schema.storedFilePart).values({ fileId: file.id, titleCode: 'specialized_sme', eventKind: 'award', year: 2024, batch: 1, rowCount: 1, origin: 'agent' }).run()
  const pageDir = join(root, '.synthetic.pdf.pages')
  mkdirSync(pageDir, { recursive: true })
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY1sAAAAASUVORK5CYII=', 'base64')
  writeFileSync(join(pageDir, 'p001.png'), png)
  // OCR and PDF reads leave source-derived parts to file maintenance.
  expect((await rest('GET')).status).toBe(200)
  expect((await call('get_ocr_result', { fileId: file.id, page: 1 })).results).toHaveLength(1)
  expect(await call('list_page_images', { fileId: file.id })).toMatchObject({ file: { id: file.id, relPath: file.relPath }, pageCount: 6 })
  expect(db.select().from(schema.storedFilePart).all()).toMatchObject([{ origin: 'agent' }])
  const fileBefore = await call('get_file', { fileId: file.id })
  expect(fileBefore.parts).toEqual(expect.arrayContaining([expect.objectContaining({ origin: 'derived' })]))
  const detailUrl = `${app.baseUrl}/api/roster/enterprises/${owner.id}`
  const before = await (await fetch(detailUrl)).json()
  expect(before.events).toEqual(expect.arrayContaining([expect.objectContaining({ id: event.id })]))
  expect(before.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ page: 1, listNo: 9 })]))
  const other = await call('get_ocr_result', { fileId: file.id, page: 2 })
  expect((await pageRequest('PUT', 1, { markdown: 'redo exactly one', expectedVersion: (await call('get_ocr_result', { fileId: file.id, page: 1 })).results[0].version })).status).toBe(200)
  const afterRedo = await call('get_ocr_result', { fileId: file.id, page: 1 })
  const deleted = await call('delete_ocr_result', { fileId: file.id, page: 1, expectedVersion: afterRedo.results[0].version })
  expect(deleted).toMatchObject({ deleted: 1, remaining: 1 })
  expect(await call('get_ocr_result', { fileId: file.id, page: 2 })).toEqual(other)
  expect(await call('get_file', { fileId: file.id })).toEqual(fileBefore)
  // Detail must be unchanged apart from the qualification scope's execution-time
  // asOf and its snapshot digest, which are per-read timing, not stored facts.
  assertEnterpriseDetailSnapshotEqual(await (await fetch(detailUrl)).json(), before)
  expect(Buffer.from(await (await fetch(`${app.baseUrl}/api/files/synthetic.pdf`)).arrayBuffer())).toEqual(minimalPdf({ pages: 6 }))
  expect(Buffer.from(await (await fetch(`${app.baseUrl}/api/files/.synthetic.pdf.pages/p001.png`)).arrayBuffer())).toEqual(png)
})

it('exact page reads and deletes exclude unrelated text and raw while coverage stays file scoped', async () => {
  await call('save_ocr_result', { fileId: file.id, page: 1, markdown: 'target 🙂' })
  const other = createClassifiedFile(db, { relPath: 'unrelated.pdf', filename: 'unrelated.pdf', ext: 'pdf', bytes: 1, sha256: 'unrelated' }, {})
  writeFileSync(join(root, 'unrelated.pdf'), 'x')
  db.$client.transaction(() => {
    const insert = db.$client.prepare('INSERT INTO ocr_result(file_id,page_no,markdown,raw,channel,created_at) VALUES(?,?,?, ?,\'api\',\'2026-10-19\')')
    for (let page = 1; page <= 128; page++) insert.run(other.id, page, 'UNRELATED'.repeat(2048), '{invalid unrelated raw')
    db.$client.prepare('UPDATE ocr_result SET raw=? WHERE file_id=?').run('{invalid target raw', file.id)
  })()
  const result = await pageRequest('GET', 1, undefined, null)
  const text = await result.text()
  expect(result.status).toBe(200)
  expect(Buffer.byteLength(text)).toBeLessThan(2048)
  expect(text).toContain('target 🙂')
  expect(text).not.toContain('UNRELATED')
  expect(text).not.toContain('raw')
  expect((await call('get_ocr_result', { fileId: file.id, page: 1 })).markdown).toContain('target 🙂')
  expect(await (await pageRequest('DELETE', 1, { expectedVersion: (await call('get_ocr_result', { fileId: file.id, page: 1 })).results[0].version })).json()).toMatchObject({ deleted: 1, remaining: 1 })
  expect((await call('get_ocr_result', { fileId: other.id, page: 128 })).markdown).toContain('UNRELATED')
  expect((await (await rest('GET')).json()).pages.map((p: any) => p.page)).toEqual([2])
})

it('public OpenAPI and MCP schemas discover page lifecycle and expected versions', async () => {
  const spec = discovery
  const route = spec.paths['/api/files/{id}/ocr-pages/{page}']
  expect(route.get).toBeDefined()
  expect(route.put.security).toEqual([{ bearerAuth: [] }])
  expect(route.delete.requestBody.content['application/json'].schema.properties.expectedVersion).toMatchObject({ type: 'string', nullable: true })
  expect(route.put.responses['409']).toBeDefined()
  const tools = (await rpc('tools/list', {})).body.result.tools
  expect(tools.find((tool: any) => tool.name === 'delete_ocr_result').inputSchema.required).toEqual(expect.arrayContaining(['page', 'expectedVersion']))
  expect(tools.find((tool: any) => tool.name === 'save_ocr_result').inputSchema.properties.expectedVersion).toBeDefined()
})

it('legacy OCR aliases distinguish malformed references and invalid pages from missing targets', async () => {
  for (const query of [`fileId=${file.id}&file=synthetic.pdf`, 'fileId=true', `fileId=${file.id}&page=2001`, `fileId=${file.id}&page=1&page=2`]) {
    expect((await fetch(`${app.baseUrl}/api/ocr-results?${query}`)).status).toBe(400)
  }
  for (const ref of [{ fileId: true }, { fileId: file.id, file: file.relPath }, { relPath: file.relPath, file: file.relPath }, { fileId: 0 }]) {
    expect((await rest('POST', undefined, { ...ref, page: 1, markdown: 'invalid ref' })).status).toBe(400)
  }
  expect((await fetch(`${app.baseUrl}/api/ocr-results?fileId=999999`)).status).toBe(404)
  expect((await rest('GET', 1)).status).toBe(200)
})

it('removed files remain readable while both write transports reject them', async () => {
  const before = await call('get_ocr_result', { fileId: file.id, page: 1 })
  db.$client.prepare('UPDATE stored_file SET removed_at=? WHERE id=?').run('2026-10-19T00:00:00.000Z', file.id)
  try {
    expect(await (await pageRequest('GET', 1, undefined, null)).json()).toEqual(before)
    expect((await pageRequest('PUT', 1, { markdown: 'removed write', expectedVersion: before.results[0].version })).status).toBe(404)
    expect((await pageRequest('DELETE', 1, { expectedVersion: before.results[0].version })).status).toBe(404)
    for (const name of ['save_ocr_result', 'delete_ocr_result']) {
      const denied = await rpc('tools/call', { name, arguments: { fileId: file.id, page: 1, expectedVersion: before.results[0].version, ...(name === 'save_ocr_result' ? { markdown: 'removed write' } : {}) } })
      expect(JSON.stringify(denied.body)).toContain('404')
    }
    expect(await call('get_ocr_result', { fileId: file.id, page: 1 })).toEqual(before)
  } finally { db.$client.prepare('UPDATE stored_file SET removed_at=NULL WHERE id=?').run(file.id) }
})

it('exact baseline REST and MCP payloads retain legacy response shapes and invalidate modern versions', async () => {
  const before = await call('get_ocr_result', { fileId: file.id, page: 1 })
  const saved = await rpc('tools/call', { name: 'save_ocr_result', arguments: { fileId: file.id, page: 1, markdown: 'legacy MCP' } })
  expect(saved.body.result.isError).not.toBe(true)
  expect(JSON.parse(saved.body.result.content[0].text)).toEqual({ file: { id: file.id, relPath: file.relPath, filename: file.filename }, channel: 'mcp', written: 1, pages: [1] })
  const oldRead = await rpc('tools/call', { name: 'get_ocr_result', arguments: { fileId: file.id, page: 1 } })
  const legacy = JSON.parse(oldRead.body.result.content[0].text)
  expect(Object.keys(legacy).sort()).toEqual(['file', 'markdown', 'page', 'pages', 'results'])
  expect(Object.keys(legacy.results[0]).sort()).toEqual(['channel', 'chars', 'createdAt', 'engine', 'model', 'page', 'pageRelPath', 'url'])
  expect(legacy.markdown).toBe('<!-- page: 1 -->\n\nlegacy MCP')
  const modern = await call('get_ocr_result', { fileId: file.id, page: 1 })
  expect(modern.results[0].version).not.toBe(before.results[0].version)
  expect((await pageRequest('PUT', 1, { markdown: 'stale before legacy MCP', expectedVersion: before.results[0].version })).status).toBe(409)
  const legacyPost = await fetch(`${app.baseUrl}/api/ocr-results`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileId: file.id, page: 1, markdown: 'legacy REST' }) })
  expect(legacyPost.status).toBe(200)
  expect(Object.keys(await legacyPost.json()).sort()).toEqual(['channel', 'file', 'pageCount', 'pages', 'renderedPageImages', 'source', 'warning', 'written'])
  const oldList = await (await fetch(`${app.baseUrl}/api/ocr-results?fileId=${file.id}&page=1&markdown=1`)).json()
  expect(Object.keys(oldList).sort()).toEqual(['channels', 'count', 'file', 'pages'])
  expect(Object.keys(oldList.pages[0]).sort()).toEqual(['channel', 'chars', 'createdAt', 'engine', 'markdown', 'model', 'page', 'pageRelPath', 'url'])
  expect((await pageRequest('PUT', 1, { markdown: 'stale modern edit', expectedVersion: modern.results[0].version })).status).toBe(409)
  expect((await call('get_ocr_result', { fileId: file.id, page: 1 })).markdown).toContain('legacy REST')
  const legacyDelete = await fetch(`${app.baseUrl}/api/ocr-results?fileId=${file.id}&page=1`, { method: 'DELETE' })
  expect(legacyDelete.status).toBe(200)
  expect(await legacyDelete.json()).toEqual({ file: { id: file.id, relPath: file.relPath, filename: file.filename }, page: 1, deleted: 1, remaining: 1 })
})

it('new commands require versions and partial versioned legacy envelopes never downgrade to blind writes', async () => {
  expect((await pageRequest('PUT', 1, { markdown: 'missing guard' })).status).toBe(400)
  expect((await pageRequest('DELETE', 1)).status).toBe(400)
  const missing = await rpc('tools/call', { name: 'delete_ocr_result', arguments: { fileId: file.id, page: 1 } })
  expect(Boolean(missing.body.error || missing.body.result?.isError)).toBe(true)
  const partial = { fileId: file.id, page: 1, markdown: 'partial versioned command', mode: 'versioned' }
  expect((await rest('POST', undefined, partial)).status).toBe(400)
  expect((await fetch(`${app.baseUrl}/api/ocr-results?fileId=${file.id}&page=1&mode=versioned`, { method: 'DELETE' })).status).toBe(400)
  const partialMcp = await rpc('tools/call', { name: 'save_ocr_result', arguments: partial })
  expect(JSON.stringify(partialMcp.body)).toContain('400')
  expect((await call('get_ocr_result', { fileId: file.id, page: 1 })).markdown).toContain('baseline one')
})
