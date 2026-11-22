import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { nativeAppAdapter } from '../../support/native-app'
import { enterprise } from '../../../db/postgresql/enterprise-tables'
import { submitSyntheticRecognizedCollection } from '../fixtures/recognized-source'
import { listPostgresCurrentQualified } from '../../../layers/sme-roster/lib/roster/current-qualified-query-postgres'
import type { CurrentQualifiedResult } from '../../../layers/sme-roster/lib/roster/current-qualified-page'
import { readExportWorkbook } from '../../support/read-workbook'
const dir = mkdtempSync(join(tmpdir(), 'native-recognized-qualification-'))
const app = nativeAppAdapter({ dir, token: 'recognized-facts-fixture' })
afterEach(async () => {
 try { await app.close() } finally { rmSync(dir, { recursive: true, force: true }) }
})

it('HTTP MCP and parsed XLSX consume a recognized period without a formal award', async () => {
 await app.prepare()
 const db = app.db
 const name = '四消费者企业'
 const uscc = '91310115MA1H7KUG93'
 const [owner] = await db.insert(enterprise).values({ name, nameNorm: name, usccNorm: uscc, city: '宁波市', district: '鄞州区' }).returning()
 await submitSyntheticRecognizedCollection(db, {
  rdjb: '1', queriedAt: '2026-05-01T00:00:00Z',
  rows: [{ enterpriseId: owner!.id, raw: {
   id: 'NATIVE-1', qymc: name, tyshxydm: uscc, rdjb: '1', rdtime: '2026-01-01',
   rddqrq: '2028-11-20', sfyx: '1', szsmc: '宁波市', whpcyear: '', whpc: '2023-2',
  } }],
 })
 await app.start()
 const filter={titleCode:'innovative_sme' as const,validYear:2028}
 const response=await fetch(app.url('/api/roster/current-enterprises?titleCode=innovative_sme&validYear=2028'))
 expect(response.status).toBe(200)
 const http=await response.json() as CurrentQualifiedResult
 const reply = await fetch(app.url('/mcp'), {
  method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_current_qualified_enterprises', arguments: filter } }),
 })
 expect(reply.status).toBe(200)
 const raw = await reply.text()
 const wire = JSON.parse(raw.startsWith('event:') ? raw.split('\n').find(line => line.startsWith('data: '))!.slice(6) : raw)
 const mcp = JSON.parse(wire.result.content[0].text) as CurrentQualifiedResult
 for(const result of[http,mcp,await listPostgresCurrentQualified(db,filter)]){
  expect(result.total).toBe(1)
  expect(result.rows[0]).toMatchObject({ enterpriseId: owner!.id, firstYear: null, matchedValidYears: [2028], matchedMaintenance: [] })
 }
 const submitted = await app.request('/api/roster/exports/current/innovative-sme', {
  method: 'POST', body: JSON.stringify({ clientRequestId: 'recognized-facts-export' }),
 })
 expect(submitted.status).toBe(202)
 const job = await app.terminal((await submitted.json()).jobId)
 expect(job.state, JSON.stringify(job)).toBe('done')
 expect(job.result.counts).toEqual({eligible:1,pending:0,excluded:0})
 const download = await app.download(job.result.artifact.downloadUrl)
 expect(download.response.status).toBe(200)
 const workbook=await readExportWorkbook(download.bytes)
 expect(workbook.getWorksheet('有效企业')!.getCell('B2').text).toBe(name)
 expect(workbook.getWorksheet('有效企业')!.getCell('E2').text).toBe('创新型中小企业')
}, 60000)
