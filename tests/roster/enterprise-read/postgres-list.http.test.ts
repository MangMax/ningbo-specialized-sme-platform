import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, createRouter, defineEventHandler, getQuery, setHeader, toWebHandler } from 'h3'
import ExcelJS from 'exceljs'
import pg from 'pg'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { initializeDb } from '../../../db/client'
import { closePostgresDirectoryDb } from '../../../db/postgresql/client'
import { listRosterEnterprises } from '../../../layers/sme-roster/lib/roster/enterprise-roster'
import { listRecords } from '../../../layers/sme-roster/lib/query'
import { parseRecordQuery, parseRosterEnterpriseQuery } from '../../../layers/sme-roster/server/utils/roster-read-query'

const url = process.env.TEST_PROFILE_POSTGRES_URL
let request: ReturnType<typeof toWebHandler>
let sqlite: ReturnType<typeof initializeDb>
let folder: string
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
  if (!url) return
  folder = mkdtempSync(join(tmpdir(), 'pg-roster-list-'))
  sqlite = initializeDb({ create: true, dbPath: join(folder, 'fixture.sqlite') })
  sqlite.$client.exec(seeds)
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try { await client.query('SET search_path TO business,public; ' + seeds) }
  finally { await client.end() }
  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', url)
  vi.stubEnv('NUXT_DB_READONLY', '1')
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  vi.stubGlobal('getQuery', getQuery)
  vi.stubGlobal('setHeader', setHeader)
  vi.doMock('@db', () => ({ useDb: () => { throw new Error('Unexpected SQLite access in PostgreSQL mode') } }))
  const handler = (await import('../../../layers/sme-roster/server/api/roster/enterprises.get')).default
  const download = (await import('../../../layers/sme-roster/server/api/roster/export.get')).default
  const ledger = (await import('../../../layers/sme-roster/server/api/records.get')).default
  request = toWebHandler(createApp().use(createRouter()
    .get('/api/roster/enterprises', handler).get('/api/roster/export', download).get('/api/records', ledger)))
})

it.skipIf(!url)('exports every matched enterprise as an XLSX row independent of list paging', async () => {
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
  sqlite?.$client.close()
  if (folder) rmSync(folder, { recursive: true, force: true })
  vi.doUnmock('@db')
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

it.skipIf(!url)('matches the SQLite historical roster for membership, source intersections, counts and paged evidence', async () => {
  const paired = async (query: Record<string, string>) => {
    const response = await request(new Request('http://localhost/api/roster/enterprises?' + new URLSearchParams(query)))
    const result = await response.json()
    expect(response.status, JSON.stringify(result)).toBe(200)
    expect(result).toEqual(listRosterEnterprises(sqlite, parseRosterEnterpriseQuery(query)))
    return result
  }
  const initial = await paired({})
  expect(initial).toMatchObject({ counts: { total: 2, titlePairs: 3, recognitionPairs: 3 }, rows: [
    { enterpriseId: 9202, rosterState: 'removed_platform_only' },
    { enterpriseId: 9201, district: '海曙区', rosterState: 'current',
      firstRecognition: [{ titleCode: 'specialized_sme', year: 2024 }, { titleCode: 'innovative_sme', year: 2022 }] },
  ] })
  const filters: Record<string, string>[] = [
    { page: '2', pageSize: '1', sort: 'recognition' },
    { rosterState: 'removed_platform_only' },
    { q: '原名称宁波', district: '海曙区' },
    { source: 'miit', eventType: 'review', year: '2022' },
    { source: 'jxj', eventType: 'review', year: '2022' },
    { title: 'specialized_sme', firstYear: '2022', firstStatus: 'confirmed' },
    { title: 'innovative_sme', firstYear: '2022', firstStatus: 'confirmed' },
    { diffStatus: 'not_queried', sort: 'name' },
  ]
  for (const query of filters) await paired(query)
})

it.skipIf(!url)('preserves complete ledger history in the matching groups and applies derived filters before pagination', async () => {
  const pairs: Record<string, string>[] = [
    {}, { page: '2', pageSize: '1' }, { page: '90', pageSize: '1' },
    { q: '原名称宁波', source: 'jxj', eventType: 'review', year: '2022' },
    { q: 'ma2gmdfh', firstYear: '2024', firstStatus: 'confirmed' },
    { q: '%' }, { q: '_' }, { q: '\\' },
    { firstStatus: 'pending', pageSize: '1' }, { flags: 'uscc_missing' },
    { dueYear: '2028' }, { dueYear: '2028', pageSize: '1', page: '2' },
  ]
  for (const query of pairs) {
    const response = await request(new Request('http://localhost/api/records?' + new URLSearchParams(query)))
    const result = await response.json()
    expect(response.status, JSON.stringify(result)).toBe(200)
    expect(result).toEqual(listRecords(sqlite, parseRecordQuery(query)))
  }
})
