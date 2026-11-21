import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { nativeAppAdapter } from '../../support/native-app'
import { reserveLoopbackPort } from '../../support/owned-process.mjs'

const bin = process.env.ROSTER_TEST_POSTGRES_BIN

describe.skipIf(!bin)('PostgreSQL first recognition and ledger years', () => {
  let dir: string
  let data: string
  let started = false
  let app: ReturnType<typeof nativeAppAdapter>
  const command = (name: string, args: string[], input?: string) =>
    execFileSync(join(bin!, name), args, { input, stdio: ['pipe', 'pipe', 'pipe'] })

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'roster-recognitions-pg-'))
    data = join(dir, 'pg')
    const port = await reserveLoopbackPort()
    const url = `postgresql://roster_fixture@127.0.0.1:${port}/postgres`
    command('initdb', ['-D', data, '-U', 'roster_fixture', '-A', 'trust', '--no-locale', '-E', 'UTF8'])
    command('pg_ctl', ['-D', data, '-l', join(dir, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -k ${dir}`, '-w', 'start'])
    started = true
    command('psql', ['-X', '-w', '-v', 'ON_ERROR_STOP=1', url], `
      CREATE SCHEMA business;
      SET search_path TO business;
      CREATE TABLE enterprise (id bigint PRIMARY KEY, name text, uscc_norm text, district text);
      CREATE TABLE record (id bigint PRIMARY KEY, enterprise_id bigint, title_code text, source text, district text);
      CREATE TABLE record_event (id bigint PRIMARY KEY, record_id bigint, event_type text, year bigint, decided_year bigint, review_outcome text);
      CREATE TABLE record_evidence (id bigint PRIMARY KEY, record_event_id bigint, source_file text, attachment text, list_no bigint, page bigint);
      INSERT INTO enterprise VALUES (7,'宁波甲',NULL,''), (8,'宁波乙',NULL,NULL);
      INSERT INTO record VALUES (1,7,'specialized_sme','jxj','海曙区'), (2,7,'little_giant','miit',NULL),
        (3,8,'specialized_sme','jxj',NULL), (4,8,'innovative_sme','jxj',NULL);
      INSERT INTO record_event VALUES
        (10,1,'award',2019,2020,NULL), (11,1,'award',2020,2020,NULL), (12,1,'review',2020,2023,'failed'),
        (13,1,'award',2024,2024,NULL), (14,2,'award',2022,NULL,NULL),
        (15,3,'award',NULL,NULL,NULL), (16,4,'nurture',2021,NULL,NULL);
      INSERT INTO record_evidence VALUES (21,10,'公告.pdf','附件一',6,3), (22,10,'名单.xlsx',NULL,7,2),
        (23,11,'同年后录.pdf',NULL,8,4);
    `)
    app = nativeAppAdapter({
      dir, token: 'isolated-recognition-test',
      launch: ({ cwd, port }) => ({
        args: [join(cwd, '.output/server/index.mjs')],
        env: {
          NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port),
          NUXT_DB_READONLY: '1', NUXT_POSTGRES_DIRECTORY_URL: url, NUXT_POSTGRES_ROSTER_READ: '1',
        },
      }),
    })
    await app.start()
  }, 60_000)

  afterAll(async () => {
    try {
      await app?.close()
    } finally {
      if (started) command('pg_ctl', ['-D', data, '-w', '-m', 'fast', 'stop'])
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  async function read(path: string) {
    const response = await app.request('/api/roster/' + path)
    expect(response.status, await response.clone().text()).toBe(200)
    return response.json()
  }

  it('returns the earliest award evidence, pending reasons, and counts before pagination', async () => {
    const body = await read('recognitions?page=1&pageSize=1&title=specialized_sme&year=2020&status=confirmed')
    expect(body).toEqual({
      rows: [{
        enterpriseId: 7, name: '宁波甲', uscc: null, district: '海曙区', titleCode: 'specialized_sme', firstYear: 2020,
        firstEventId: 10, source: 'jxj', status: 'confirmed', pendingReason: null, undatedAwardIds: [],
        evidence: [
          { sourceFile: '公告.pdf', attachment: '附件一', listNo: 6, page: 3 },
          { sourceFile: '名单.xlsx', attachment: null, listNo: 7, page: null },
        ],
      }],
      counts: { titlePairs: 1, enterprises: 1, titles: { little_giant: 0, specialized_sme: 1, innovative_sme: 0 } },
      page: 1, pageSize: 1,
    })
    const pending = await read('recognitions?status=pending')
    expect(pending.rows.map((row: { enterpriseId: number; pendingReason: string }) => [row.enterpriseId, row.pendingReason]))
      .toEqual([[7, 'no_evidence'], [8, 'no_dated_award']])
    expect((await read('recognitions?page=2&pageSize=1')).counts).toEqual({
      titlePairs: 3, enterprises: 2, titles: { little_giant: 1, specialized_sme: 2, innovative_sme: 0 },
    })
  })

  it('returns distinct ledger event years and earliest recognition years from PostgreSQL', async () => {
    expect(await read('ledger-years')).toEqual({ eventYears: [2019, 2020, 2021, 2022, 2024], firstRecognitionYears: [2020, 2022] })
  })
})
