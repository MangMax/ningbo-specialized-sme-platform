import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { reserveLoopbackPort, spawnCompiledApp, stopOwnedChild, waitForHttp } from '../../support/owned-process.mjs'
import { defaultLogCollection } from '../../../layers/core/lib/logging/policy'

const bin = process.env.TEST_POSTGRES_STARTUP_BIN

// Only the compiled child needs server registration. Skip the in-process test
// setup's second copy of the server module graph.
vi.mock('../../../server/install-application', () => ({ installApplicationServer() {} }))

it.skipIf(!bin)('checks PostgreSQL-only runtime readiness, read-only tasks and two-schema restore', async () => {
  const dir = mkdtempSync('/tmp/pg-startup-')
  const data = join(dir, 'cluster')
  const dbPath = join(dir, 'legacy', 'roster.db')
  const logsPath = join(dir, 'legacy-logs')
  const pgEnv = {
    PATH: process.env.PATH, LC_ALL: 'C', PGHOST: dir, PGPORT: '5432',
    PGUSER: 'fixture', PGDATABASE: 'roster', PGSQL_BIN: bin!,
  }
  const command = (name: string, args: string[]) => execFileSync(join(bin!, name), args, { env: pgEnv, encoding: 'utf8' })
  const query = (sql: string) => command('psql', ['-X', '-w', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql]).trim()
  let started = false
  try {
    command('initdb', ['-D', data, '-A', 'trust', '-U', 'fixture', '--locale=C', '-E', 'UTF8'])
    const logPath = join(dir, 'server.log')
    try {
      command('pg_ctl', ['-D', data, '-l', logPath, '-o', `-h '' -k '${dir}'`, '-w', 'start'])
    } catch (cause) {
      throw new Error(existsSync(logPath) ? readFileSync(logPath, 'utf8') : 'PostgreSQL did not start', { cause })
    }
    started = true
    command('createdb', ['--maintenance-db=postgres', '--template=template0', '--locale-provider=builtin', '--builtin-locale=C.UTF-8', 'roster'])

    query(`
      CREATE EXTENSION pg_trgm;
      CREATE SCHEMA business;
      CREATE TABLE business.title (code text PRIMARY KEY, name_zh text, level text, rank bigint);
      INSERT INTO business.title VALUES ('innovative_sme', '创新型中小企业', 'municipal', 30);
      CREATE TABLE business.record (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, evidence bytea);
      INSERT INTO business.record (evidence) VALUES (decode('00ff0a', 'hex'));
      SELECT setval('business.record_id_seq', 33);
      CREATE TABLE business.record_link (revision bigint NOT NULL, event bigint NOT NULL, UNIQUE (revision, event));
      INSERT INTO business.record_link VALUES (1, 2), (1, 1);
      CREATE TABLE business.service_credential (key text PRIMARY KEY, value text, updated_at text);

      CREATE SCHEMA staged;
      CREATE TABLE staged.job (id text, kind text, params text, state text, progress text,
        result text, error text, created_at text, started_at text, finished_at text);
      CREATE TABLE staged.log_policy (id bigint, "retentionDays" bigint, "maxBytes" bigint, pruned bigint, cleared bigint);
      INSERT INTO staged.log_policy VALUES (1, 30, 1048576, 0, 0);
      CREATE TABLE staged.log_collection (id bigint, collection text, revision bigint);
      INSERT INTO staged.log_collection VALUES (1, '${JSON.stringify(defaultLogCollection())}', 0);
      CREATE TABLE staged.log_events (seq bigint, id text, timestamp text, level text, source text,
        operation text, outcome text, "requestId" text, "traceId" text, "taskId" text, "fileId" bigint,
        "batchId" text, "resourceId" text, summary text, detail text);
      CREATE TABLE staged.sqlite_sequence (name text, seq bigint);
      INSERT INTO staged.sqlite_sequence VALUES ('log_events', 101);
    `)
    for (const file of ['materialize-jobs.sql', 'materialize-runtime-logs.sql']) {
      command('psql', ['-X', '-w', '-v', 'ON_ERROR_STOP=1', '-v', 'staging=staged', '-f', join('upgrade/postgresql', file)])
    }
    query(`
      CREATE ROLE fixture_logs LOGIN;
      GRANT USAGE ON SCHEMA runtime_logs TO fixture_logs;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA runtime_logs TO fixture_logs;
      GRANT SELECT, USAGE ON ALL SEQUENCES IN SCHEMA runtime_logs TO fixture_logs;
    `)

    const logsUrl = `postgresql://fixture_logs@localhost/roster?host=${encodeURIComponent(dir)}`
    const apiToken = 'startup-fixture-token'
    async function withApp(readOnly: boolean, checks: (base: string) => Promise<void>) {
      const port = await reserveLoopbackPort()
      const child = spawnCompiledApp(port, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          NUXT_DB_MODE: 'postgresql',
          NUXT_DB_PATH: dbPath,
          NUXT_DB_READONLY: readOnly ? '1' : '0',
          NUXT_POSTGRES_DIRECTORY_URL: `postgresql://fixture@localhost/roster?host=${encodeURIComponent(dir)}`,
          NUXT_POSTGRES_LOG_URL: readOnly ? logsUrl : undefined,
          NUXT_LOG_DIR: logsPath,
          NUXT_FILES_DIR: join(dir, 'files'),
          NUXT_INCOMING_DIR: join(dir, 'incoming'),
          NUXT_API_TOKEN: apiToken,
        },
      })
      let output = ''
      for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-3000) })
      const base = `http://127.0.0.1:${port}`
      try {
        await waitForHttp(`${base}/api/health`, { child, timeoutMs: 8_000 })
        await checks(base)
      } catch (cause) {
        throw new Error(output || 'Compiled app produced no startup output', { cause })
      } finally {
        await stopOwnedChild(child)
      }
    }

    await withApp(false, async base => {
      const healthUrl = `${base}/api/health`
      expect(await (await fetch(healthUrl)).json()).toEqual({
        titles: [{ code: 'innovative_sme', nameZh: '创新型中小企业', level: 'municipal', rank: 30 }],
        recordCount: 1,
      })
      query('ALTER TABLE runtime_logs.log_policy RENAME TO offline_policy')
      const unavailable = await fetch(healthUrl, { headers: { accept: 'application/json' } })
      expect(unavailable.status).toBe(503)
      expect(await unavailable.json()).toMatchObject({ data: { code: 'postgresql_runtime_unavailable' } })
      query('ALTER TABLE runtime_logs.offline_policy RENAME TO log_policy')
      expect((await fetch(healthUrl)).status).toBe(200)
      query('ALTER TABLE business.job RENAME COLUMN cancel_requested TO offline_cancel')
      const noJobSchema = await fetch(healthUrl, { headers: { accept: 'application/json' } })
      expect(noJobSchema.status).toBe(503)
      expect(await noJobSchema.json()).toMatchObject({ data: { code: 'postgresql_runtime_unavailable' } })
      query('ALTER TABLE business.job RENAME COLUMN offline_cancel TO cancel_requested')
      expect((await fetch(healthUrl)).status).toBe(200)
      const { kinds } = await (await fetch(`${base}/api/jobs/kinds`)).json()
      expect(kinds).toEqual(expect.arrayContaining([
        'render-pages', 'ocr', 'difference-snapshot', 'platform-query-batch', 'reconcile',
        'event-archive-candidates', 'event-annual-correspondence', 'current-roster-export', 'lead-lists-version-export',
      ].map(kind => expect.objectContaining({ kind, status: 'ready' }))))
    })

    const id = '01J00000000000000000000000'
    const batchId = '01J00000000000000000000001'
    const snapshotId = '01J00000000000000000000002'
    query(`INSERT INTO business.job (id, kind, params, state, result, created_at) VALUES
      ('${id}', 'render-pages', '{}', 'queued', NULL, '2026-11-20T00:00:00.000Z'),
      ('${batchId}', 'platform-query-batch', '{"items":[],"limits":{}}', 'done',
        '{"attempt":1,"items":[],"completeness":"complete"}', '2026-11-20T00:00:00.000Z'),
      ('${snapshotId}', 'difference-snapshot', '{}', 'done', '{"completeness":"complete"}', '2026-11-20T00:00:00.000Z')`)
    await withApp(true, async base => {
      const headers = { authorization: `Bearer ${apiToken}` }
      const get = async (path: string) => {
        const response = await fetch(base + path, { headers })
        expect(response.status, path).toBe(200)
        return response.json()
      }
      expect(await get('/api/jobs?view=summary')).toMatchObject({ total: 3 })
      expect(await get('/api/jobs?kind=render-pages')).toMatchObject({ total: 1, rows: [{ id, params: {} }] })
      expect(await get(`/api/jobs/${id}`)).toMatchObject({ id, state: 'queued' })
      expect(await get('/api/task-center')).toMatchObject({
        total: 3, exportReady: false, authorized: false,
        rows: expect.arrayContaining([expect.objectContaining({
          id, capabilities: expect.objectContaining({ cancel: false, retry: false, retryItemIds: [] }),
        })]),
      })
      expect(await get(`/api/task-center/${id}`)).toMatchObject({ id, state: 'queued', capabilities: { cancel: false } })
      expect(await get(`/api/platform/batches/${batchId}`)).toMatchObject({ batchId, state: 'done', attempt: 1 })
      expect(await get(`/api/roster/difference-snapshots/${snapshotId}`)).toMatchObject({
        id: snapshotId, state: 'done', result: { completeness: 'complete' },
      })
      expect((await get('/api/jobs/kinds')).kinds).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'render-pages', status: 'todo', note: '当前任务中心只读' }),
      ]))
      expect((await get('/api/roster/exports/current/capabilities')).exports).toEqual(expect.arrayContaining([
        expect.objectContaining({ ready: false }),
      ]))
      expect((await fetch(`${base}/api/jobs/${id}`, { method: 'DELETE', headers })).status).toBe(403)
      expect((await fetch(`${base}/api/task-center/${id}/cancel`, { method: 'POST', headers })).status).toBe(403)
      expect((await fetch(`${base}/api/jobs`, {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'render-pages', params: { files: ['fixture.pdf'] } }),
      })).status).toBe(403)
    })
    expect(query(`SELECT state FROM business.job WHERE id = '${id}'`)).toBe('queued')
    expect(existsSync(join(dbPath, '..'))).toBe(false)
    expect(existsSync(logsPath)).toBe(false)

    for (let run = 0; run < 2; run++) {
      const report = execFileSync('bash', ['upgrade/postgresql/rehearse-restore.sh'], {
        env: { ...pgEnv, TMPDIR: dir }, encoding: 'utf8',
      })
      expect(report).toContain('Matched table hashes and sequence states for 10 relations')
      expect(query("SELECT count(*) FROM pg_database WHERE datname LIKE 'restore_%'")).toBe('0')
      expect(query('SELECT last_value FROM business.record_id_seq')).toBe('33')
    }
  } finally {
    if (started) command('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'])
    rmSync(dir, { recursive: true, force: true })
  }
}, 90000)
