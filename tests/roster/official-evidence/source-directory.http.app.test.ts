import { spawnCompiledApp } from '../../support/owned-process.mjs'
import { seedPostgresPlatformQuery } from '../../platform/fixtures/postgres-query'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterAll, beforeAll, expect, it } from 'vitest'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { enterprise as enterpriseTable } from '../../../db/postgresql/enterprise-tables'
import { record as recordTable, recordEvent, recordEvidence } from '../../../db/postgresql/ledger-tables'
import { sourceDocument } from '../../../db/postgresql/official-evidence-tables'
import { postgresFixturePool, postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import { reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../../support/owned-process.mjs'

const dir = mkdtempSync(join(tmpdir(), 'official-source-directory-'))
mkdirSync(join(dir, 'files', 'nested'), { recursive: true })
writeFileSync(join(dir, 'files', 'known.pdf'), '%PDF-1.4\n')
writeFileSync(join(dir, 'files', 'nested', 'known.pdf'), '%PDF-1.4\n')
let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
let fixturePool: ReturnType<typeof postgresFixturePool> | undefined
let db: NodePgDatabase
let doc: typeof sourceDocument.$inferSelect
let pdf: Awaited<ReturnType<typeof add>>
let sameNumber: Awaited<ReturnType<typeof add>>
let word: Awaited<ReturnType<typeof add>>
let excel: Awaited<ReturnType<typeof add>>
let queryId: number
async function add(recordId: number, sourceFile: string, eventType: 'award' | 'review' | 'nurture' | 'maintain', attachment: string, page: number | null) {
  const [event] = await db.insert(recordEvent).values({ recordId, eventType, year: null }).returning()
  const [evidence] = await db.insert(recordEvidence).values({ recordEventId: event!.id, sourceFile, attachment, listNo: 1, page }).returning()
  return { event: event!, evidence: evidence! }
}
async function snapshot() {
  const pool = fixturePool!.pool
  const { rows } = await pool.query<{ tablename: string }>("select tablename from pg_tables where schemaname = 'business' order by tablename")
  return Promise.all(rows.map(async ({ tablename }) => {
    const table = pg.escapeIdentifier(tablename)
    const { rows } = await pool.query('select to_jsonb(fact)::text as value from business.' + table + ' as fact order by value')
    return [tablename, rows]
  }))
}
let service: { baseUrl: string; stop: () => Promise<void> }
beforeAll(async () => {
  postgres = await postgresRuntimeFixture({ dir })
  fixturePool = postgresFixturePool({ connectionString: postgres.url })
  db = drizzle({ client: fixturePool.pool })
  const [enterprise] = await db.insert(enterpriseTable).values({ name: '目录合成企业', nameNorm: '目录合成企业' }).returning()
  const [record] = await db.insert(recordTable).values({ enterpriseId: enterprise!.id, source: 'jxj', titleCode: 'specialized_sme' }).returning()
  const documents = await db.insert(sourceDocument).values([
    { source: 'jxj', title: '已登记公布文件', path: 'formal.pdf', docNumber: '原文号' },
    { source: 'jxj', title: '培育通知', path: 'notice.pdf' },
    { source: 'jxj', title: '重复登记', path: 'formal.pdf' },
  ]).returning()
  doc = documents[0]!
  pdf = await add(record!.id, 'formal.pdf', 'award', '附件一 / 名单一', 3)
  sameNumber = await add(record!.id, 'formal.pdf', 'review', '附件二 / 名单二', 8)
  word = await add(record!.id, 'unregistered.docx', 'award', '附件一', null)
  excel = await add(record!.id, 'unregistered.xlsx', 'review', '复核名单', null)
  await add(record!.id, 'notice.pdf', 'nurture', '入库培育', null)
  await add(record!.id, 'maintenance.pdf', 'maintain', '维护', null)
  queryId = (await seedPostgresPlatformQuery(db, { interface: 'business_list', queryKey: 'synthetic', queriedAt: '2026-10-23T00:00:00Z', status: 'success', rawResponse: 'Explicit synthetic empty source' })).queryId
  const port = await reserveLoopbackPort()
  const child = spawnCompiledApp(port, {
    cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NUXT_BUILD_DIR: join(dir, 'build'), ...postgres.env, NUXT_DB_READONLY: '1', NUXT_FILES_DIR: join(dir, 'files'), NUXT_INCOMING_DIR: join(dir, 'incoming') },
  })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-6000) })
  service = { baseUrl: `http://127.0.0.1:${port}`, stop: () => stopOwnedChild(child) }
  try { await waitForHttp(`${service.baseUrl}/api/health`, { timeoutMs: 60000, child }) }
  catch (error) { await service.stop(); throw new Error(`${error}\n${output}`) }
}, 90000)
afterAll(async () => {
  try { await service?.stop() }
  finally {
    try { await fixturePool?.close() }
    finally { postgres?.close(); rmSync(dir, { recursive: true, force: true }) }
  }
})
const read = async (url: string) => {
  const response = await fetch(service.baseUrl + url)
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toContain('no-store')
  return response.json()
}

it('lists each formal event source once across PDF Word and Excel without altering stored facts', async () => {
  const before = await snapshot()
  const url = '/api/roster/record-comparison/sources?kind=official_document&pageSize=200'
  const catalog = await read(url)
  expect(catalog.total).toBe(3)
  expect(catalog.rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: doc.id, label: '已登记公布文件', subtitle: '原文号', path: 'formal.pdf' }),
    expect.objectContaining({ id: -word.evidence.id, label: 'unregistered.docx', path: 'unregistered.docx', observedAt: null }),
    expect.objectContaining({ id: -excel.evidence.id, label: 'unregistered.xlsx', path: 'unregistered.xlsx', observedAt: null }),
  ]))
  expect(await read(url)).toEqual(catalog)
  expect(await snapshot()).toEqual(before)
})

it('selects unregistered sources and preserves event attachment identity when list numbers repeat', async () => {
  const compare = async (id: number) => read(`/api/roster/record-comparison?queryIds=${queryId}&exportBatchIds=&officialSourceDocumentIds=${id}`)
  const result = await compare(doc.id)
  expect(result.rows.filter((row: any) => row.evidence.some((item: any) => item.inSelectedSource)).map((row: any) => [row.event.id, row.evidence[0].attachment, row.evidence[0].listNo, row.evidence[0].page])).toEqual([
    [pdf.event.id, '附件一 / 名单一', 1, 3], [sameNumber.event.id, '附件二 / 名单二', 1, 8],
  ])
  const wordResult = await compare(-word.evidence.id)
  expect(wordResult.rows.find((row: any) => row.event.id === word.event.id)).toMatchObject({ event: { year: null, batchSeq: null }, evidence: [{ sourceFile: 'unregistered.docx', page: null, inSelectedSource: true }] })
  const excelResult = await compare(-excel.evidence.id)
  expect(excelResult.rows.find((row: any) => row.event.id === excel.event.id).evidence).toMatchObject([{ sourceFile: 'unregistered.xlsx', inSelectedSource: true }])
  const labels = await read(`/api/roster/record-comparison/sources?kind=official_document&ids=${-word.evidence.id}`)
  expect(labels).toMatchObject({ total: 1, rows: [{ id: -word.evidence.id, label: 'unregistered.docx' }] })
  const pages = await Promise.all([1, 2, 3].map(page => read(`/api/roster/record-comparison/sources?kind=official_document&pageSize=1&page=${page}`)))
  expect(new Set(pages.flatMap(page => page.rows.map((row: any) => row.path))).size).toBe(3)
  for (const invalid of ['0', '-9999999']) expect((await fetch(`${service.baseUrl}/api/roster/record-comparison?queryIds=${queryId}&exportBatchIds=&officialSourceDocumentIds=${invalid}`)).status).toBe(400)
  expect((await fetch(`${service.baseUrl}/api/roster/record-comparison/sources?kind=query&ids=-1`)).status).toBe(400)
  const rpc = await fetch(`${service.baseUrl}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_record_comparison', arguments: { queryIds: [queryId], exportBatchIds: [], officialSourceDocumentIds: [-word.evidence.id] } } }) })
  expect(rpc.status).toBe(200)
  const raw = await rpc.text()
  const payload = JSON.parse(raw.startsWith('event:') ? raw.split('\n').find(line => line.startsWith('data: '))!.slice(6) : raw)
  expect(JSON.parse(payload.result.content[0].text)).toEqual(wordResult)
})

it('reports missing files through HTTP HEAD instead of falling back to an HTML page', async () => {
  const missing = await fetch(`${service.baseUrl}/api/files/missing.pdf`, { method: 'HEAD' })
  expect(missing.status).toBe(404)
  expect(await missing.text()).toBe('')
  for (const path of ['known.pdf', 'nested/known.pdf']) {
    const found = await fetch(`${service.baseUrl}/api/files/${path}`, { method: 'HEAD' })
    expect(found.status).toBe(200)
    expect(found.headers.get('content-type')).toBe('application/pdf')
    expect(found.headers.get('content-length')).toBe('9')
    expect(await found.text()).toBe('')
  }
})
