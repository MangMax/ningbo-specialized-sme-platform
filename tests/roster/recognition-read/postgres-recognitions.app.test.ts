import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { nativeAppAdapter } from '../../support/native-app'

describe('PostgreSQL first recognition and ledger years', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roster-recognitions-pg-'))
  const app = nativeAppAdapter({ dir, token: 'native-first-recognitions' })
  let postgres: pg.Pool

  beforeAll(async () => {
    await app.prepare()
    app.psql(['-c', `
      SET search_path TO business, public;
      INSERT INTO enterprise (id,name,name_norm,district) VALUES (7,'宁波甲','宁波甲',''), (8,'宁波乙','宁波乙',NULL);
      INSERT INTO record (id,enterprise_id,title_code,source,district)
      VALUES (1,7,'specialized_sme','jxj','海曙区'), (2,7,'little_giant','miit',NULL),
        (3,8,'specialized_sme','jxj',NULL), (4,8,'innovative_sme','jxj',NULL);
      INSERT INTO record_event (id,record_id,event_type,year,decided_year,review_outcome) VALUES
        (10,1,'award',2019,2020,NULL), (11,1,'award',2020,2020,NULL), (12,1,'review',2020,2023,'failed'),
        (13,1,'award',2024,2024,NULL), (14,2,'award',2022,NULL,NULL),
        (15,3,'award',NULL,NULL,NULL), (16,4,'nurture',2021,NULL,NULL);
      INSERT INTO record_evidence (id,record_event_id,source_file,attachment,list_no,page) VALUES
        (21,10,'公告.pdf','附件一',6,3), (22,10,'名单.xlsx',NULL,7,2), (23,11,'同年后录.pdf',NULL,8,4);
    `])
    await app.start()
    postgres = new pg.Pool({ connectionString: app.postgresUrl })
  }, 60_000)

  afterAll(async () => {
    try { await postgres?.end() }
    finally {
      try { await app.close() }
      finally { rmSync(dir, { recursive: true, force: true }) }
    }
  })

  async function read(path: string) {
    const response = await fetch(app.url('/api/roster/' + path), { signal: AbortSignal.timeout(5000) })
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

  it('serves unrelated requests while PostgreSQL waits to read recognition evidence', async () => {
    const path = 'recognitions?pageSize=1&title=specialized_sme&status=confirmed'
    const expected = await read(path)
    expect(expected.rows).toHaveLength(1)

    const lock = await postgres.connect()
    let completion: Promise<unknown> | undefined
    try {
      const { rows: [holder] } = await lock.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      await lock.query('BEGIN')
      await lock.query('LOCK TABLE business.record_evidence IN ACCESS EXCLUSIVE MODE')
      completion = read(path)
      void completion.catch(() => {})
      await expect.poll(async () => {
        const { rows } = await postgres.query<{ waiting: boolean }>(`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock'
              AND $1 = ANY(pg_blocking_pids(pid))
          ) AS waiting
        `, [holder!.pid])
        return rows[0]?.waiting
      }).toBe(true)
      const other = await fetch(app.url('/api/jobs/kinds'), { signal: AbortSignal.timeout(1000) })
      expect(other.status).toBe(200)
    } finally {
      try { await lock.query('ROLLBACK') } finally { lock.release() }
    }
    expect(await completion).toEqual(expected)
  })
})
