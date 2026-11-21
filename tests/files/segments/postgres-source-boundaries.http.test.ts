import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { createApp, createRouter, defineEventHandler, toNodeListener } from 'h3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { initializeDb } from '../../../db/client'
import { closePostgresDirectoryDb } from '../../../db/postgresql/client'
import { configurePostgresRuntime } from '../../../db/runtime-mode'
import { minimalPdf } from '../../support/minimal-pdf'

const bin = process.env.ROSTER_TEST_POSTGRES_BIN
const fileId = 9
const filename = 'notice.pdf'
const source = minimalPdf({ pages: 4 })
const sha256 = createHash('sha256').update(source).digest('hex')
const token = 'fixture-segments-api-secret'

describe.runIf(Boolean(bin))('PostgreSQL browser file segments', () => {
  let dir: string
  let started = false
  let server: ReturnType<typeof createServer>
  let base: string
  const run = (name: string, args: string[], env?: NodeJS.ProcessEnv) =>
    execFileSync(join(bin!, name), args, { env, stdio: 'pipe' })

  beforeAll(async () => {
    dir = mkdtempSync('/tmp/file-segments-pg-')
    writeFileSync(join(dir, filename), source)
    const snapshot = join(dir, 'source.sqlite')
    const sqlite = initializeDb({ create: true, dbPath: snapshot })
    try {
      sqlite.$client.prepare(`INSERT INTO stored_file (id,rel_path,filename,ext,bytes,sha256,created_at)
        VALUES (?,?,?,'pdf',?,?,'2025-01-01')`).run(fileId, filename, filename, source.length, sha256)
      sqlite.$client.exec(`
        INSERT INTO roster_file_classification(file_id,source,kind,parse_state) VALUES (9,'jxj','announcement','failed');
        INSERT INTO enterprise(id,name,name_norm) VALUES (1,'示例企业','示例企业');
        INSERT INTO record(id,enterprise_id,title_code,source) VALUES (1,1,'specialized_sme','jxj');
        INSERT INTO record_event(id,record_id,event_type,year,batch_seq) VALUES (1,1,'award',2022,1);
        INSERT INTO record_evidence(id,record_event_id,source_file,attachment,page) VALUES (1,1,'notice.pdf','附件1',1);
        INSERT INTO stored_file_part(file_id,title_code,event_kind,year,batch,attachment,row_count,origin)
          VALUES (9,'specialized_sme','award',2022,1,'附件1',1,'derived');

      `)
    } finally {
      sqlite.$client.close()
    }

    const env = { PATH: process.env.PATH, LANG: 'C', PGHOST: dir, PGPORT: '5432',
      PGUSER: 'segments_fixture', PGDATABASE: 'postgres', PGSQL_BIN: join(bin!, 'psql') }
    run('initdb', ['-A', 'trust', '-E', 'UTF8', '--locale=C', '-U', env.PGUSER, '-D', join(dir, 'pg')], env)
    run('pg_ctl', ['-w', '-D', join(dir, 'pg'), '-l', join(dir, 'pg.log'), '-o', "-c listen_addresses='' -k " + dir, 'start'], env)
    started = true
    execFileSync(process.execPath, ['upgrade/postgresql/stage-sqlite.mjs', snapshot, 'staged'], { env, stdio: 'pipe' })
    for (const name of ['enterprise-directory', 'enterprise-identity', 'jobs', 'file-and-lead-lists', 'roster']) {
      run('psql', ['-Xwq', '-v', 'staging=staged', '-f', 'upgrade/postgresql/materialize-' + name + '.sql'], env)
    }
    rmSync(snapshot)
    vi.stubEnv('NUXT_DB_PATH', join(dir, 'must-not-open.sqlite'))
    vi.stubEnv('NUXT_DB_MODE', 'postgresql')
    vi.stubEnv('NUXT_DB_READONLY', '0')
    vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', 'postgresql://segments_fixture@localhost/postgres?host=' + encodeURIComponent(dir))
    for (const key of ['NUXT_POSTGRES_DIRECTORY_WRITE', 'NUXT_POSTGRES_JOBS', 'NUXT_POSTGRES_FILE_LIBRARY',
      'NUXT_POSTGRES_LEAD_REGISTRATION', 'NUXT_POSTGRES_ROSTER_READ', 'NUXT_POSTGRES_LOG_URL']) vi.stubEnv(key, undefined)
    configurePostgresRuntime()
    vi.stubGlobal('defineEventHandler', defineEventHandler)
    vi.stubGlobal('useRuntimeConfig', () => ({ apiToken: token, filesDir: dir }))

    const router = createRouter()
      .get('/api/files/:id/segments', (await import('../../../layers/sme-roster/server/api/files/[id]/segments.get')).default)
      .post('/api/files/:id/segments/preflight', (await import('../../../layers/sme-roster/server/api/files/[id]/segments/preflight.post')).default)
      .post('/api/files/:id/segments/commit', (await import('../../../layers/sme-roster/server/api/files/[id]/segments/commit.post')).default)
    server = createServer(toNodeListener(createApp({ debug: false }).use(router)))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  }, 60_000)

  afterAll(async () => {
    try {
      if (server) await new Promise<void>(resolve => server.close(() => resolve()))
      await closePostgresDirectoryDb()
    } finally {
      vi.unstubAllGlobals()
      vi.unstubAllEnvs()
      if (started) run('pg_ctl', ['-w', '-D', join(dir, 'pg'), '-m', 'fast', 'stop'])
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  async function request(action = '', body?: unknown, origin = base) {
    const response = await fetch(`${base}/api/files/${fileId}/segments${action}`, body === undefined ? undefined : {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  }

  it('reads source facts, verifies PDF ranges, and persists same-origin segment changes with replay', async () => {
    const initial = await request()
    const coordinate = { titleCode: 'specialized_sme', eventKind: 'award', year: 2022, batch: 1, attachment: '附件1' }
    expect(initial).toMatchObject({ status: 200, body: { writeEnabled: true,
      state: { parseState: 'failed', parts: [{ ...coordinate, rowCount: 1, origin: 'derived' }], declarations: [] },
    } })
    expect(JSON.stringify(initial.body)).not.toContain(token)

    const expectedVersion = initial.body.state.version
    const preflight = { expectedVersion, verifyPhysicalPages: true }
    expect((await request('/preflight', preflight, 'https://other.example')).status).toBe(403)
    const plan = await request('/preflight', preflight)
    expect(plan).toMatchObject({ status: 200, body: { expectedVersion, parseState: 'failed',
      inputRef: { kind: 'file', pages: [], physicalSource: { pageCount: 4 } },
    } })
    const pageRanges = [{ start: 1, end: 2 }, { start: 4, end: 4 }]
    const part = { ...coordinate, rowCount: 3, pageRanges }
    const commit = { ...plan.body, parts: [part], idempotencyKey: 'declare', reason: '登记内容描述' }
    expect((await request('/commit', { ...commit, parseState: 'parsed' })).status).toBe(400)
    expect(await request()).toEqual(initial)

    const saved = await request('/commit', commit)
    expect(saved).toMatchObject({ status: 200, body: { replayed: false, state: { parseState: 'failed',
      parts: [{ ...coordinate, origin: 'agent', hasConflict: true, rowCount: 3 }],
      declarations: [{ part: { ...coordinate, rowCount: 3 }, pageRanges }],
    } } })
    const readback = await request()
    expect(readback).toEqual({ status: 200, body: { writeEnabled: true, state: saved.body.state } })
    expect(readback.body.state.version).not.toBe(expectedVersion)
    expect(await request('/commit', commit)).toEqual({ status: 200, body: { ...saved.body, replayed: true } })
    expect((await request('/preflight', preflight)).status).toBe(409)

    const withdrawalPlan = await request('/preflight', { expectedVersion: readback.body.state.version })
    expect(withdrawalPlan.status).toBe(200)
    const withdrawal = await request('/commit', { ...withdrawalPlan.body, parts: [], idempotencyKey: 'withdraw', reason: '撤回登记' })
    expect(withdrawal.status).toBe(200)
    expect((await request()).body.state).toMatchObject({ parseState: 'failed',
      parts: [{ ...coordinate, rowCount: 1, origin: 'derived' }], declarations: [],
    })
    expect(readFileSync(join(dir, filename))).toEqual(source)
  })
})
