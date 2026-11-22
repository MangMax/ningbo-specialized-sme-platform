import { ok } from 'node:assert/strict'
import { seedPostgresPlatformQuery } from '../../platform/fixtures/postgres-query'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { writePostgresOcrResult } from '../../../layers/core/server/utils/ocr-result-postgres'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { enterprise } from '../../../db/postgresql/enterprise-tables'
import { record, recordEvent, recordEvidence } from '../../../db/postgresql/ledger-tables'
import { ocrResult } from '../../../db/postgresql/file-tables'
import { storedFilePart } from '../../../db/postgresql/roster-file-tables'
import { spawnCompiledApp, reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../../support/owned-process.mjs'

const dir = mkdtempSync(join(tmpdir(), 'read-311b-http-'))
const root = join(dir, 'files')
mkdirSync(root)
let runtime: Awaited<ReturnType<typeof postgresRuntimeFixture>>
let pool: pg.Pool
let db: ReturnType<typeof drizzle<Record<string, never>>>
let queryId: number
let service: { baseUrl: string; stop(): Promise<void> }
let output = ''
beforeAll(async () => {
  runtime = await postgresRuntimeFixture({ dir })
  pool = new pg.Pool({ connectionString: runtime.url, options: '-c search_path=business,public' })
  db = drizzle<Record<string, never>>(pool)
  ;({ queryId } = await seedPostgresPlatformQuery(db, {
    interface: 'business_list', queryKey: 'B3', queriedAt: '2026-11-05T00:00:00Z',
    status: 'success', rawResponse: 'Explicit synthetic empty source',
  }))
  const port = await reserveLoopbackPort()
  const child = spawnCompiledApp(port, {
    cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...runtime.env, NUXT_API_TOKEN: 'b3-synthetic', NUXT_BUILD_DIR: join(dir, 'build'), NUXT_FILES_DIR: root, NUXT_INCOMING_DIR: join(dir, 'incoming') },
  })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-10000) })
  service = { baseUrl: `http://127.0.0.1:${port}`, stop: () => stopOwnedChild(child) }
  try { await waitForHttp(`${service.baseUrl}/api/health`, { timeoutMs: 60000, child }) }
  catch (error) { await service.stop(); throw new Error(`${error}\n${output}`) }
}, 90000)
afterAll(async () => { await service?.stop(); await pool?.end(); runtime?.close(); rmSync(dir, { recursive: true, force: true }) })
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
  await writePostgresOcrResult(db, { fileId: file.id, channel: 'upload', sourceRelPath: 'history.pdf', pages: [{ page: 1, markdown: 'old paid text', raw: { paid: 'retained' } }] })
  const before = await db.select().from(ocrResult)
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
  expect(await db.select().from(ocrResult)).toEqual(before)
})

it.each(['unreadable', 'missing'] as const)('historical OCR and markdown remain available when the current source is %s', async kind => {
  const relPath = `${kind}-history.pdf`, path = join(root, relPath)
  writeFileSync(path, 'abc')
  const file = await (await rest('/api/files/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ relPath }) })).json()
  await writePostgresOcrResult(db, { fileId: file.id, channel: 'upload', sourceRelPath: relPath, pages: [{ page: 1, markdown: 'retained unavailable-source text', raw: { paid: 'retained' } }] })
  const before = await db.select().from(ocrResult)
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
    expect(await db.select().from(ocrResult)).toEqual(before)
  } finally { if (kind === 'unreadable') chmodSync(path, 0o644) }
})

it('lazy public parts preserve legacy row IDs and catalog registration never certifies historical evidence', async () => {
  const relPath = 'jxj/announcement/2024/2/legacy.pdf'
  mkdirSync(join(root, 'jxj/announcement/2024/2'), { recursive: true })
  writeFileSync(join(root, relPath), 'abc')
  const registered = await rest('/api/files/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ relPath }) })
  const file = await registered.json()
  const [enterpriseRow] = await db.insert(enterprise).values({ name: 'B3 fixture', nameNorm: 'B3 fixture' }).returning()
  ok(enterpriseRow, 'Enterprise fixture insert did not return a row')
  const [recordRow] = await db.insert(record).values({ enterpriseId: enterpriseRow.id, source: 'jxj', titleCode: 'specialized_sme' }).returning()
  ok(recordRow, 'Record fixture insert did not return a row')
  const [eventRow] = await db.insert(recordEvent).values({ recordId: recordRow.id, eventType: 'award', year: 2024 }).returning()
  ok(eventRow, 'Record event fixture insert did not return a row')
  const [evidenceRow] = await db.insert(recordEvidence).values({ recordEventId: eventRow.id, sourceFile: relPath, listNo: 1 }).returning()
  ok(evidenceRow, 'Record evidence fixture insert did not return a row')
  const [partRow] = await db.insert(storedFilePart).values({ fileId: file.id, titleCode: 'specialized_sme', eventKind: 'award', year: 2024, rowCount: 1, origin: 'legacy' }).returning()
  ok(partRow, 'File part fixture insert did not return a row')
  for (const bytes of ['abc', 'xyz', 'abc']) {
    writeFileSync(join(root, relPath), bytes)
    const detail = (await rpc('list_file_parts', { fileId: file.id })).value
    expect(detail.parts).toHaveLength(1)
    expect((await rpc('get_file', { fileId: file.id })).value.contentIdentity).toMatchObject({ registered: { fileId: file.id, bytes: 3 }, status: bytes === 'xyz' ? 'file_content_conflict' : 'verified' })
    const fileList = await rest('/api/files')
    expect(fileList.status).toBe(200)
    expect(await db.select().from(storedFilePart)).toContainEqual(partRow)
    expect(detail.partsBinding).toEqual({ historical: 'unknown', inputLineage: { status: 'unknown' } })
    expect(detail.contentIdentity).toMatchObject({ status: bytes === 'xyz' ? 'file_content_conflict' : 'verified', registered: { fileId: file.id } })
  }
  expect(await db.select().from(storedFilePart)).toContainEqual(partRow)
  expect(await db.select().from(recordEvidence)).toContainEqual(evidenceRow)
})

it('known capture and parse inputRef remain distinct from legacy provenance and current file checks', async () => {
  writeFileSync(join(root, 'captured.pdf'), 'abc')
  const response = await rest('/api/files/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ relPath: 'captured.pdf' }) })
  const file = await response.json()
  const input = { taskId: 'synthetic-309', sourceSha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', imageSha256: '1'.repeat(64), variant: 'original', jobId: 'synthetic-paid-receipt', createdAt: '2026-11-05T00:00:00Z' }
  await writePostgresOcrResult(db, { fileId: file.id, channel: 'api', pages: [{ page: 1, markdown: 'captured text', raw: { paid: 'raw' }, capture: input }] })
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
  await writePostgresOcrResult(db, { fileId: file.id, channel: 'upload', pages: [{ page: 1, markdown: 'human revision' }] })
  const edited = (await rpc('get_ocr_result', { fileId: file.id, includeVersion: true })).value
  expect(edited.markdown).toContain('human revision')
  expect(edited.results[0].historicalBinding).toEqual({ status: 'unknown' })
  const raw = JSON.parse((await db.select().from(ocrResult)).find(row => row.fileId === file.id)!.raw!)
  expect(raw.captures[0].input).toEqual(input)
  expect(raw.captures[0].raw).toEqual({ paid: 'raw' })
})
