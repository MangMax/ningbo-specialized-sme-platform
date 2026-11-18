import { spawnCompiledApp } from '../../support/owned-process.mjs'
import { submitNativePlatformQuery } from '../../platform/fixtures/native-query'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { writeOcrResult } from '../../../layers/core/server/utils/ocr-result'
import { initializeDb, schema } from '../../../db/client'
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
  const child = spawnCompiledApp(port, {
    cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NUXT_API_TOKEN: 'b3-synthetic', NUXT_BUILD_DIR: join(dir, 'build'), NUXT_DB_PATH: dbPath, NUXT_FILES_DIR: root, NUXT_INCOMING_DIR: join(dir, 'incoming') },
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
it('historical OCR stays readable and unknown through REST and MCP across replacement and recovery', async () => {
  writeFileSync(join(root, 'history.pdf'), 'abc')
  const registered = await rest('/api/files/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ relPath: 'history.pdf' }) })
  const file = await registered.json()
  writeOcrResult(db, { fileId: file.id, channel: 'upload', sourceRelPath: 'history.pdf', pages: [{ page: 1, markdown: 'old paid text', raw: { paid: 'retained' } }] })
  const before = db.select().from(schema.ocrResult).all()
  for (const [bytes, status] of [['abc', 'verified'], ['xyz', 'file_content_conflict'], ['abc', 'verified']]) {
    writeFileSync(join(root, 'history.pdf'), bytes!)
    for (const value of [await (await rest(`/api/files/${file.id}/ocr-pages/1`)).json(), (await rpc('get_ocr_result', { fileId: file.id, includeVersion: true })).value]) {
      expect(value.markdown).toContain('old paid text')
      expect(value.contentIdentity).toMatchObject({ status, historical: 'unknown', registered: { fileId: file.id, bytes: 3 } })
      expect(value.results[0].historicalBinding).toEqual({ status: 'unknown' })
      const list = await (await rest(`/api/ocr-results?fileId=${file.id}&markdown=1&includeVersion=1`)).json()
      expect(list.contentIdentity.status).toBe(status)
      expect(list.pages[0]).toMatchObject({ markdown: 'old paid text', historicalBinding: { status: 'unknown' } })
      const exported = await rest(`/api/ocr-results/markdown?fileId=${file.id}`)
      expect(exported.headers.get('x-file-content-status')).toBe(status)
      expect(exported.headers.get('x-file-historical-identity')).toBe('unknown')
      expect(await exported.text()).toContain('old paid text')
    }
  }
  expect(db.select().from(schema.ocrResult).all()).toEqual(before)
})

it.each(['unreadable', 'missing'] as const)('historical OCR and markdown remain available when the current source is %s', async kind => {
  const relPath = `${kind}-history.pdf`, path = join(root, relPath)
  writeFileSync(path, 'abc')
  const file = await (await rest('/api/files/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ relPath }) })).json()
  writeOcrResult(db, { fileId: file.id, channel: 'upload', sourceRelPath: relPath, pages: [{ page: 1, markdown: 'retained unavailable-source text', raw: { paid: 'retained' } }] })
  const before = db.select().from(schema.ocrResult).all()
  if (kind === 'unreadable') chmodSync(path, 0)
  else rmSync(path)
  try {
    const expected = { status: kind === 'unreadable' ? 'unavailable' : 'missing', historical: 'unknown', registered: { fileId: file.id, bytes: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' } }
    const response = await rest(`/api/files/${file.id}/ocr-pages/1`)
    expect(response.status).toBe(200)
    for (const value of [await response.json(), (await rpc('get_ocr_result', { fileId: file.id, includeVersion: true })).value]) {
      expect(value.markdown).toContain('retained unavailable-source text')
      expect(value.contentIdentity).toMatchObject(expected)
      expect(value.results[0].historicalBinding).toEqual({ status: 'unknown' })
    }
    const listResponse = await rest(`/api/ocr-results?fileId=${file.id}&markdown=1&includeVersion=1`)
    expect(listResponse.status).toBe(200)
    expect((await listResponse.json()).contentIdentity).toMatchObject(expected)
    const exported = await rest(`/api/ocr-results/markdown?fileId=${file.id}`)
    expect(exported.status).toBe(200)
    expect(exported.headers.get('x-file-content-status')).toBe(expected.status)
    expect(await exported.text()).toContain('retained unavailable-source text')
    expect(db.select().from(schema.ocrResult).all()).toEqual(before)
  } finally { if (kind === 'unreadable') chmodSync(path, 0o644) }
})

it('lazy public parts preserve legacy row IDs and catalog registration never certifies historical evidence', async () => {
  const relPath = 'jxj/announcement/2024/2/legacy.pdf'
  mkdirSync(join(root, 'jxj/announcement/2024/2'), { recursive: true })
  writeFileSync(join(root, relPath), 'abc')
  const registered = await rest('/api/files/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ relPath }) })
  const file = await registered.json()
  const enterprise = db.insert(schema.enterprise).values({ name: 'B3 fixture', nameNorm: 'B3 fixture' }).returning().get()
  const record = db.insert(schema.record).values({ enterpriseId: enterprise.id, source: 'jxj', titleCode: 'specialized_sme' }).returning().get()
  const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2024 }).returning().get()
  const evidence = db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: relPath, listNo: 1 }).returning().get()
  const part = db.insert(schema.storedFilePart).values({ fileId: file.id, titleCode: 'specialized_sme', eventKind: 'award', year: 2024, rowCount: 1, origin: 'legacy' }).returning().get()
  for (const bytes of ['abc', 'xyz', 'abc']) {
    writeFileSync(join(root, relPath), bytes)
    const detail = (await rpc('list_file_parts', { fileId: file.id })).value
    expect(detail.parts).toHaveLength(1)
    expect((await rpc('get_file', { fileId: file.id })).value.contentIdentity).toMatchObject({ registered: { fileId: file.id, bytes: 3 }, status: bytes === 'xyz' ? 'file_content_conflict' : 'verified' })
    const rescanned = await rest('/api/files?rescan=1')
    expect(rescanned.status).toBe(200)
    expect(db.select().from(schema.storedFilePart).all()).toContainEqual(part)
    expect(detail.partsBinding).toEqual({ historical: 'unknown', inputLineage: { status: 'unknown' } })
    expect(detail.contentIdentity).toMatchObject({ status: bytes === 'xyz' ? 'file_content_conflict' : 'verified', registered: { fileId: file.id } })
    const catalog = await (await rest('/api/roster/record-comparison/sources?kind=official_document')).json()
    expect(catalog.rows.find((row: any) => row.path === relPath)).toMatchObject({ id: -evidence.id, contentIdentity: { registered: { fileId: file.id, bytes: 3 }, status: 'unknown', historical: 'unknown' } })
  }
  expect(db.select().from(schema.storedFilePart).all()).toContainEqual(part)
  expect(db.select().from(schema.recordEvidence).all()).toContainEqual(evidence)
})

it('comparison REST and MCP evidence retain stable registration alongside old path and unknown binding', async () => {
  const relPath = 'directory-only.pdf'
  writeFileSync(join(root, relPath), 'abc')
  const file = await (await rest('/api/files/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ relPath }) })).json()
  const enterprise = db.insert(schema.enterprise).values({ name: 'Independent directory fixture', nameNorm: 'Independent directory fixture' }).returning().get()
  const record = db.insert(schema.record).values({ enterpriseId: enterprise.id, source: 'jxj', titleCode: 'specialized_sme' }).returning().get()
  const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2024 }).returning().get()
  const evidence = db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: relPath, listNo: 1 }).returning().get()
  const query = { id: submitNativePlatformQuery(db, { interface: 'business_list', queryKey: 'B3', queriedAt: '2026-11-05T00:00:00Z', status: 'success', rawResponse: 'Explicit synthetic empty source' }).queryId }
  const value = await (await rest(`/api/roster/record-comparison?queryIds=${query.id}&exportBatchIds=&officialSourceDocumentIds=${-evidence.id}`)).json()
  const selectedRow = value.rows.find((row: { event: { id: number } }) => row.event.id === event.id)
  expect(selectedRow.evidence).toContainEqual(expect.objectContaining({ id: evidence.id, sourceFile: relPath, inSelectedSource: true, contentIdentity: { registered: expect.objectContaining({ fileId: file.id, bytes: 3 }), status: 'unknown', historical: 'unknown' } }))
  expect((await rpc('list_record_comparison', { queryIds: [query.id], exportBatchIds: [], officialSourceDocumentIds: [-evidence.id] })).value).toEqual(value)
})

it('known capture and parse inputRef remain distinct from legacy provenance and current file checks', async () => {
  writeFileSync(join(root, 'captured.pdf'), 'abc')
  const response = await rest('/api/files/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ relPath: 'captured.pdf' }) })
  const file = await response.json()
  const input = { taskId: 'synthetic-309', sourceSha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', imageSha256: '1'.repeat(64), variant: 'original', jobId: 'synthetic-paid-receipt', createdAt: '2026-11-05T00:00:00Z' }
  writeOcrResult(db, { fileId: file.id, channel: 'api', pages: [{ page: 1, markdown: 'captured text', raw: { paid: 'raw' }, capture: input }] })
  const captured = (await rpc('get_ocr_result', { fileId: file.id, includeVersion: true })).value
  expect(captured.results[0].historicalBinding).toEqual({ status: 'captured', input })
  const post = async (path: string, body: unknown) => {
    const result = await rest(`/api/files/${file.id}/parse-result/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer b3-synthetic' }, body: JSON.stringify(body) })
    expect(result.status).toBe(200)
    return result.json()
  }
  const plan = await post('preflight', { kind: 'ocr', pages: [{ page: 1, version: captured.results[0].version }] })
  await post('commit', { expectedVersion: plan.expectedVersion, inputRef: plan.inputRef, parts: [{ titleCode: 'specialized_sme', eventKind: 'award', year: 2024, rowCount: 1 }], idempotencyKey: 'b3-bound', actor: { type: 'agent', id: 'b3' }, reason: 'isolated fixture' })
  const parts = (await rpc('list_file_parts', { fileId: file.id })).value
  expect(parts.partsBinding).toEqual({ historical: 'unknown', inputLineage: { status: 'bound', inputRef: plan.inputRef } })
  for (const value of [(await rpc('list_files', { q: 'captured.pdf' })).value, await (await rest('/api/files?q=captured.pdf')).json()]) {
    expect(value.rows[0].partsBinding).toEqual(parts.partsBinding)
    expect(value.rows[0].contentIdentity).toMatchObject({ status: 'unknown', historical: 'unknown', registered: { fileId: file.id } })
  }
  writeFileSync(join(root, 'captured.pdf'), 'xyz')
  const changed = (await rpc('get_ocr_result', { fileId: file.id, includeVersion: true })).value
  expect(changed.contentIdentity.status).toBe('file_content_conflict')
  expect(changed.results[0].historicalBinding).toEqual({ status: 'captured', input })
  writeOcrResult(db, { fileId: file.id, channel: 'upload', pages: [{ page: 1, markdown: 'human revision' }] })
  const edited = (await rpc('get_ocr_result', { fileId: file.id, includeVersion: true })).value
  expect(edited.markdown).toContain('human revision')
  expect(edited.results[0].historicalBinding).toEqual({ status: 'unknown' })
  const raw = db.select().from(schema.ocrResult).all().find(row => row.fileId === file.id)!.raw as any
  expect(raw.captures[0].input).toEqual(input)
  expect(raw.captures[0].raw).toEqual({ paid: 'raw' })
})
