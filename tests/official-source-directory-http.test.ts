import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterAll, beforeAll, expect, it } from 'vitest'
import { useDb, schema } from '../db/client'
import { spawnOwnedChild as spawn, reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../scripts/lib/isolated-local-services.mjs'

const dir = mkdtempSync(join(tmpdir(), 'official-source-directory-'))
mkdirSync(join(dir, 'files', 'nested'), { recursive: true })
writeFileSync(join(dir, 'files', 'known.pdf'), '%PDF-1.4\n')
writeFileSync(join(dir, 'files', 'nested', 'known.pdf'), '%PDF-1.4\n')
const path = join(dir, 'fixture.db')
const db = useDb({ dbPath: path })
const enterprise = db.insert(schema.enterprise).values({ name: '目录合成企业', nameNorm: '目录合成企业' }).returning().get()
const record = db.insert(schema.record).values({ enterpriseId: enterprise.id, source: 'jxj', titleCode: 'specialized_sme' }).returning().get()
const doc = db.insert(schema.sourceDocument).values({ source: 'jxj', title: '已登记公布文件', path: 'formal.pdf', docNumber: '原文号' }).returning().get()
db.insert(schema.sourceDocument).values({ source: 'jxj', title: '培育通知', path: 'notice.pdf' }).run()
db.insert(schema.sourceDocument).values({ source: 'jxj', title: '重复登记', path: 'formal.pdf' }).run()
const add = (sourceFile: string, eventType: 'award' | 'review' | 'nurture' | 'maintain', attachment: string, page: number | null) => {
  const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType, year: null }).returning().get()
  const evidence = db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile, attachment, listNo: 1, page }).returning().get()
  return { event, evidence }
}
const pdf = add('formal.pdf', 'award', '附件一 / 名单一', 3)
const sameNumber = add('formal.pdf', 'review', '附件二 / 名单二', 8)
const word = add('unregistered.docx', 'award', '附件一', null)
const excel = add('unregistered.xlsx', 'review', '复核名单', null)
add('notice.pdf', 'nurture', '入库培育', null)
add('maintenance.pdf', 'maintain', '维护', null)
const query = db.insert(schema.platformQuery).values({ interface: 'business_list', queryKey: 'synthetic', queriedAt: '2026-10-23T00:00:00Z', status: 'success' }).returning().get()
const snapshot = () => db.$client.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name").all().map((row: any) => [row.name, db.$client.prepare(`select * from \"${row.name}\" order by rowid`).all()])
let service: { baseUrl: string; stop: () => Promise<void> }
beforeAll(async () => {
  const port = await reserveLoopbackPort()
  const child = spawn(process.execPath, [resolve('node_modules/nuxt/bin/nuxt.mjs'), 'dev', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NUXT_BUILD_DIR: join(dir, 'build'), NUXT_DB_PATH: path, NUXT_DB_READONLY: '1', NUXT_FILES_DIR: join(dir, 'files'), NUXT_INCOMING_DIR: join(dir, 'incoming') },
  })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-6000) })
  service = { baseUrl: `http://127.0.0.1:${port}`, stop: () => stopOwnedChild(child) }
  try { await waitForHttp(`${service.baseUrl}/api/roster/record-comparison/sources?kind=official_document`, { timeoutMs: 60000, child }) }
  catch (error) { await service.stop(); throw new Error(`${error}\n${output}`) }
}, 90000)
afterAll(async () => { await service?.stop(); db.$client.close(); rmSync(dir, { recursive: true, force: true }) })
const read = async (url: string) => {
  const response = await fetch(service.baseUrl + url)
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toContain('no-store')
  return response.json()
}

it('lists each formal event source once across PDF Word and Excel without altering stored facts', async () => {
  const before = snapshot()
  const url = '/api/roster/record-comparison/sources?kind=official_document&pageSize=200'
  const catalog = await read(url)
  expect(catalog.total).toBe(3)
  expect(catalog.rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: doc.id, label: '已登记公布文件', subtitle: '原文号', path: 'formal.pdf' }),
    expect.objectContaining({ id: -word.evidence.id, label: 'unregistered.docx', path: 'unregistered.docx', observedAt: null }),
    expect.objectContaining({ id: -excel.evidence.id, label: 'unregistered.xlsx', path: 'unregistered.xlsx', observedAt: null }),
  ]))
  expect(await read(url)).toEqual(catalog)
  expect(snapshot()).toEqual(before)
})

it('selects unregistered sources and preserves event attachment identity when list numbers repeat', async () => {
  const compare = async (id: number) => read(`/api/roster/record-comparison?queryIds=${query.id}&exportBatchIds=&officialSourceDocumentIds=${id}`)
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
  for (const invalid of ['0', '-9999999']) expect((await fetch(`${service.baseUrl}/api/roster/record-comparison?queryIds=${query.id}&exportBatchIds=&officialSourceDocumentIds=${invalid}`)).status).toBe(400)
  expect((await fetch(`${service.baseUrl}/api/roster/record-comparison/sources?kind=query&ids=-1`)).status).toBe(400)
  const rpc = await fetch(`${service.baseUrl}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_record_comparison', arguments: { queryIds: [query.id], exportBatchIds: [], officialSourceDocumentIds: [-word.evidence.id] } } }) })
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
