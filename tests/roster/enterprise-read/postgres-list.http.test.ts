import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, createRouter, defineEventHandler, getQuery, setHeader, toWebHandler } from 'h3'
import ExcelJS from 'exceljs'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { closePostgresDirectoryDb } from '../../../db/postgresql/client'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'

let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
let request: ReturnType<typeof toWebHandler>
const dir = mkdtempSync(join(tmpdir(), 'pg-roster-list-'))
const seeds = `
  INSERT INTO enterprise (id,name,name_norm,uscc_norm,city) VALUES
    (9201,'正源企业','正源企业','91330110MA2GMDFH58','宁波市'),
    (9202,'平台企业','平台企业','91330211255994458Q','宁波市'),
    (9203,'备选企业','备选企业',NULL,NULL);
  INSERT INTO roster_legacy_member (enterprise_id) VALUES (9201),(9202);
  INSERT INTO enterprise_alias (id,enterprise_id,name,name_norm,source_kind,verification_status,created_at)
    VALUES (9201,9201,'原名称（宁波）','原名称宁波','manual','confirmed','2026-01-01');
  INSERT INTO record (id,enterprise_id,title_code,source,district) VALUES
    (9201,9201,'innovative_sme','jxj','海曙区'),(9202,9201,'specialized_sme','miit','江北区'),
    (9203,9202,'specialized_sme','miit','鄞州区'),(9204,9203,'little_giant','jxj',NULL);
  INSERT INTO record_event (id,record_id,event_type,year,batch_seq,decided_year) VALUES
    (9201,9201,'award',2022,1,2022),(9202,9201,'review',2022,1,2025),
    (9203,9202,'award',2024,1,2024),(9204,9203,'award',2025,1,2025),(9205,9204,'award',2025,1,2025);
  INSERT INTO record_evidence (id,record_event_id,source_file,page) VALUES
    (9201,9201,'announcement.pdf',3),(9202,9203,'source.xlsx',12);
  INSERT INTO platform_export_batch (id,title_code,year,collected_on,original_filename,sha256,created_at) VALUES
    (9201,'innovative_sme',2024,'2024-01-01','first.xlsx','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','2024-01-01'),
    (9202,'innovative_sme',2025,'2025-01-01','second.xlsx','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','2025-01-01');
  INSERT INTO platform_export_row (id,batch_id,source_row_no,uscc_raw,created_at) VALUES
    (9201,9201,2,'91330211255994458Q','2024-01-01');
`

beforeAll(async () => {
  postgres = await postgresRuntimeFixture({ dir })
  postgres.psql(['-c', 'SET search_path TO business, public; ' + seeds])
  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', postgres.url)
  vi.stubEnv('NUXT_DB_READONLY', '1')
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  vi.stubGlobal('getQuery', getQuery)
  vi.stubGlobal('setHeader', setHeader)
  const handler = (await import('../../../layers/sme-roster/server/api/roster/enterprises.get')).default
  const download = (await import('../../../layers/sme-roster/server/api/roster/export.get')).default
  const ledger = (await import('../../../layers/sme-roster/server/api/records.get')).default
  request = toWebHandler(createApp().use(createRouter()
    .get('/api/roster/enterprises', handler).get('/api/roster/export', download).get('/api/records', ledger)))
})

it('exports every matched enterprise as an XLSX row independent of list paging', async () => {
  const response = await request(new Request('http://localhost/api/roster/export?page=2&pageSize=1&sort=recognition'))
  expect(response.status).toBe(200)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(await response.arrayBuffer())
  const sheet = workbook.getWorksheet('企业总表')!
  expect(sheet.getColumn(1).values).toEqual(expect.arrayContaining(['平台企业', '正源企业']))
  expect(sheet.getColumn(1).values).not.toContain('备选企业')
  expect(sheet.getColumn(10).values?.join('\n')).toContain('announcement.pdf')
})
afterAll(async () => {
  await closePostgresDirectoryDb()
  postgres?.close()
  rmSync(dir, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

it('filters historical roster membership, event coordinates and first recognition before paging', async () => {
  const read = async (query: Record<string, string>) => {
    const response = await request(new Request('http://localhost/api/roster/enterprises?' + new URLSearchParams(query)))
    const result = await response.json()
    expect(response.status, JSON.stringify(result)).toBe(200)
    return result
  }
  const initial = await read({})
  expect(initial).toMatchObject({ counts: { total: 2, titlePairs: 3, recognitionPairs: 3 }, rows: [
    { enterpriseId: 9202, rosterState: 'removed_platform_only' },
    { enterpriseId: 9201, district: '海曙区', rosterState: 'current',
      firstRecognition: [{ titleCode: 'specialized_sme', year: 2024 }, { titleCode: 'innovative_sme', year: 2022 }] },
  ] })
  const filters: { query: Record<string, string>; ids: number[]; total: number }[] = [
    { query: { page: '2', pageSize: '1', sort: 'name' }, ids: [9201], total: 2 },
    { query: { rosterState: 'removed_platform_only' }, ids: [9202], total: 1 },
    { query: { q: '原名称宁波', district: '海曙区' }, ids: [9201], total: 1 },
    { query: { source: 'miit', eventType: 'review', year: '2022' }, ids: [], total: 0 },
    { query: { source: 'jxj', eventType: 'review', year: '2022' }, ids: [9201], total: 1 },
    { query: { title: 'specialized_sme', firstYear: '2022', firstStatus: 'confirmed' }, ids: [], total: 0 },
    { query: { title: 'innovative_sme', firstYear: '2022', firstStatus: 'confirmed' }, ids: [9201], total: 1 },
  ]
  for (const { query, ids, total } of filters) {
    const result = await read(query)
    expect(result.counts.total, JSON.stringify(query)).toBe(total)
    expect(result.rows.map((row: { enterpriseId: number }) => row.enterpriseId), JSON.stringify(query)).toEqual(ids)
  }
})

it('preserves ledger keyword matching and complete group history across paging', async () => {
  const read = async (query: Record<string, string>) => {
    const response = await request(new Request('http://localhost/api/records?' + new URLSearchParams(query)))
    const result = await response.json()
    expect(response.status, JSON.stringify(result)).toBe(200)
    return result
  }
  for (const keyword of ['%', '_']) expect((await read({ q: keyword })).total).toBe(4)
  expect(await read({ q: '\\' })).toMatchObject({ rows: [], total: 0 })
  const history = await read({ q: '原名称宁波', source: 'jxj', eventType: 'review', year: '2022', pageSize: '1' })
  expect(history).toMatchObject({ total: 1, rows: [{
    enterpriseId: 9201, titleCode: 'innovative_sme', events: [{ id: 9201, type: 'award' }, { id: 9202, type: 'review' }],
  }] })
  expect(await read({ q: '原名称宁波', source: 'jxj', eventType: 'review', year: '2022', pageSize: '1', page: '2' }))
    .toMatchObject({ total: 1, rows: [] })
})
