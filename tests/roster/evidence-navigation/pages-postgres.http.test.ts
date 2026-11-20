import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, createRouter, toWebHandler } from 'h3'
import pg from 'pg'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { closePostgresDirectoryDb } from '../../../db/postgresql/client'
import { minimalPdf } from '../../support/minimal-pdf'

const url = process.env.TEST_LEGACY_ROSTER_POSTGRES_URL
const token = 'page-fixture-token'
let folder: string
let request: ReturnType<typeof toWebHandler>

beforeAll(async () => {
  if (!url) return
  folder = mkdtempSync(join(tmpdir(), 'pg-legacy-pages-'))
  const pdf = minimalPdf({ pages: 2 })
  writeFileSync(join(folder, 'notice.pdf'), pdf)
  writeFileSync(join(folder, 'different.pdf'), pdf)

  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    await client.query(`
      SET search_path TO business,public;
      INSERT INTO enterprise(id,name,name_norm,district) VALUES
        (9301,'甲企业','甲企业','海曙区'),(9302,'乙企业','乙企业','海曙区');
      INSERT INTO record(id,enterprise_id,title_code,source,district) VALUES
        (9301,9301,'specialized_sme','jxj','江北区'),(9302,9302,'specialized_sme','jxj','海曙区');
      INSERT INTO record_event(id,record_id,event_type,year,batch_seq) VALUES
        (9301,9301,'award',2024,1),(9302,9302,'award',2024,1);
      INSERT INTO record_evidence(id,record_event_id,source_file,attachment,list_no) VALUES
        (9301,9301,'notice.pdf','名单一',6),(9302,9302,'notice.pdf','名单二',6),
        (9303,9302,'different.pdf','名单二',7);
      INSERT INTO stored_file(id,rel_path,filename,ext,bytes,sha256,created_at) VALUES
        (9301,'notice.pdf','notice.pdf','pdf',${pdf.length},'${createHash('sha256').update(pdf).digest('hex')}','2024-01-01'),
        (9303,'different.pdf','different.pdf','pdf',${pdf.length},repeat('0',64),'2024-01-01');
      INSERT INTO roster_file_classification(file_id,source,kind,title_code) VALUES
        (9301,'jxj','announcement','specialized_sme'),(9303,'jxj','announcement','specialized_sme');
    `)
  } finally { await client.end() }

  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', url)
  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_WRITE', '1')
  vi.stubEnv('NUXT_POSTGRES_ROSTER_READ', '1')
  vi.stubEnv('NUXT_DB_READONLY', '1')
  vi.stubGlobal('useRuntimeConfig', () => ({ apiToken: token, filesDir: folder }))
  vi.doMock('@db', () => ({ useDb: () => { throw new Error('Unexpected SQLite access in PostgreSQL mode') } }))
  const pages = (await import('../../../layers/sme-roster/server/api/roster/evidence/pages.post')).default
  const evidence = (await import('../../../layers/sme-roster/server/api/roster/evidence/[id].get')).default
  const audit = (await import('../../../layers/sme-roster/server/api/roster/evidence/[id]/audit.get')).default
  request = toWebHandler(createApp().use(createRouter()
    .post('/api/roster/evidence/pages', pages)
    .get('/api/roster/evidence/:id', evidence)
    .get('/api/roster/evidence/:id/audit', audit)))
})

afterAll(async () => {
  await closePostgresDirectoryDb()
  if (folder) rmSync(folder, { recursive: true, force: true })
  vi.doUnmock('@db')
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

async function get(path: string) {
  const result = await request(new Request('http://localhost/api/roster/evidence/' + path))
  expect(result.status).toBe(200)
  return result.json()
}

async function submit(body: unknown, authorized = true) {
  return request(new Request('http://localhost/api/roster/evidence/pages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(authorized ? { authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body),
  }))
}

it.skipIf(!url)('previews and partially applies verified pages with one official event revision and audit', async () => {
  const verified = { sourceFile: 'notice.pdf', listNo: 6, page: 2, enterpriseName: '甲企业', district: '海曙区', basis: 'Checked original page' }
  const entries = [
    verified,
    verified,
    { sourceFile: 'notice.pdf', listNo: 6, page: 1, enterpriseName: '其他企业' },
    { sourceFile: 'different.pdf', listNo: 7, page: 1, enterpriseId: 9302 },
    { sourceFile: 'notice.pdf', listNo: 6, page: 3, enterpriseId: 9302 },
  ]
  expect((await submit({ entries }, false)).status).toBe(401)
  const before = await get('9301')
  const preview = await submit({ entries, dryRun: true })
  const planned = await preview.json()
  expect(preview.status, JSON.stringify(planned)).toBe(200)
  expect(planned).toMatchObject({
    status: 'dry_run', summary: { requested: 5, assigned: 2, written: 0, unchanged: 1, pending: 3 },
    assignments: [
      { index: 0, evidenceId: 9301, page: 2, previous: null, basis: verified.basis },
      { index: 1, evidenceId: 9301, page: 2, previous: null, basis: verified.basis },
    ],
    pending: [
      { index: 2, reason: 'no_match', candidateIds: [9301, 9302], sameListNo: 2 },
      { index: 4, reason: 'page_invalid' },
      { index: 3, reason: 'ambiguous', candidateIds: [9303] },
    ],
  })
  expect(await get('9301')).toEqual(before)
  expect(await get('9301/audit')).toMatchObject({ total: 0, rows: [] })

  const commit = await submit({ entries })
  expect(commit.status).toBe(200)
  expect(await commit.json()).toEqual({
    ...planned, status: 'applied', summary: { ...planned.summary, written: 1 },
  })
  expect(await get('9301')).toMatchObject({
    coordinate: { sourceFile: 'notice.pdf', attachment: '名单一', listNo: 6, page: 2 }, event: { revision: 2 },
  })
  expect(await get('9302')).toMatchObject({ coordinate: { page: null }, event: { revision: 1 } })
  expect(await get('9303')).toMatchObject({ coordinate: { page: null } })
  const journal = await get('9301/audit')
  expect(journal).toMatchObject({ total: 1, rows: [{
    evidenceId: 9301, eventId: 9301, entryPoint: 'legacy_pages', batchKey: null,
    actor: { type: 'legacy', id: 'evidence-pages-adapter' }, basis: verified.basis,
    before: { coordinate: { page: null }, eventRevision: 1 },
    after: { coordinate: { page: 2 }, eventRevision: 2, file: { pageCount: 2 } },
  }] })
  const replay = await submit({ entries: [verified] })
  expect(replay.status).toBe(200)
  expect(await replay.json()).toMatchObject({ summary: { assigned: 1, written: 0, unchanged: 1, pending: 0 } })
  expect(await get('9301/audit')).toEqual(journal)
})
