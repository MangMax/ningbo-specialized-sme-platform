import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { expect, it, vi } from 'vitest'
import { reserveLoopbackPort, spawnCompiledApp, stopOwnedChild, waitForHttp } from '../../support/owned-process.mjs'
import { defaultLogCollection } from '../../../layers/core/lib/logging/policy'
import coreManifest from '../../../layers/core/lib/core/manifest'
import rosterManifest from '../../../layers/sme-roster/manifest'

const bin = process.env.TEST_POSTGRES_STARTUP_BIN

vi.mock('../../../server/install-application', () => ({ installApplicationServer() {} }))

async function openTaskEvents(base: string) {
  const controller = new AbortController()
  const response = await fetch(`${base}/api/task-center/events`, {
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)]),
  })
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('text/event-stream')
  expect(response.headers.get('cache-control')).toContain('no-store')
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  async function nextFrame(): Promise<string | null> {
    while (!buffer.includes('\n\n')) {
      const chunk = await reader.read()
      if (chunk.done) return null
      buffer += chunk.value
    }
    const end = buffer.indexOf('\n\n')
    const frame = buffer.slice(0, end)
    buffer = buffer.slice(end + 2)
    return frame
  }
  expect(await nextFrame()).toBe('retry: 3000')
  return { nextFrame, close: () => controller.abort() }
}

it.skipIf(!bin)('checks PostgreSQL-only runtime readiness, read-only tasks, committed SSE and two-schema restore', async () => {
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
          NUXT_MCP_TOKEN: apiToken,
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
      expect(child.exitCode).toBe(0)
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
      const credentials = await fetch(`${base}/api/settings/credentials`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ 'core.ocrToken': 'fixture-ocr-credential' }),
      })
      expect(credentials.status).toBe(200)
      expect(await credentials.json()).toMatchObject({
        'core.ocrToken': { configured: true, source: 'saved', masked: 'fix********ial' },
      })
    })

    const id = '01J00000000000000000000000'
    const batchId = '01J00000000000000000000001'
    const snapshotId = '01J00000000000000000000002'
    query(`INSERT INTO business.job (id, kind, params, state, result, created_at) VALUES
      ('${id}', 'render-pages', '{}', 'queued', NULL, '2026-11-20T00:00:00.000Z'),
      ('${batchId}', 'platform-query-batch', '{"items":[],"limits":{"maxRequests":10,"maxRows":100,"maxDurationMs":5000,"maxResultBytes":65536}}', 'done',
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
      expect(await get('/api/settings/credentials')).toMatchObject({
        'core.ocrToken': { configured: true, source: 'saved', masked: 'fix********ial' },
      })
      expect(await get('/api/logs/policy')).toMatchObject({ retentionDays: 30, maxBytes: 1048576 })
      expect(await get('/api/scheduled-tasks')).toMatchObject({
        enabled: false,
        items: expect.arrayContaining([expect.objectContaining({ id: 'roster_export_cleanup', nextRunAt: null })]),
      })
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
      const mcp = new Client({ name: 'pg-startup-fixture', version: '1' })
      await mcp.connect(new StreamableHTTPClientTransport(new URL('/mcp', base), { requestInit: { headers } }))
      try {
        const { tools } = await mcp.listTools()
        expect(tools.map(tool => tool.name).sort()).toEqual([
          ...coreManifest.mcpTools!, ...rosterManifest.mcpTools!,
        ].sort())
        const calls = [
          ['get_platform_batch', { batchId }, { batchId, state: 'done', attempt: 1 }],
          ['difference_snapshot', { action: 'read', jobId: snapshotId }, { id: snapshotId, state: 'done' }],
          ['get_runtime_log_policy', {}, { retentionDays: 30, maxBytes: 1048576 }],
        ] as const
        for (const [name, args, expected] of calls) {
          const result = await mcp.callTool({ name, arguments: args })
          expect(result.isError, JSON.stringify(result)).not.toBe(true)
          const content = result.content as { type: string; text: string }[]
          expect(JSON.parse(content[0]!.text)).toMatchObject(expected)
        }
      } finally {
        await mcp.close()
      }
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
    const listeners = () => query(`SELECT pid FROM pg_stat_activity
      WHERE application_name = 'task-center-events' ORDER BY pid`).split('\n').filter(Boolean)
    const ready = 'event: ready\ndata:'
    const changed = 'event: changed\ndata:'
    const update = `UPDATE business.job SET progress = '{"done":4,"total":8}' WHERE id = '${id}'`
    await withApp(true, async base => {
      const first = await openTaskEvents(base)
      const second = await openTaskEvents(base)
      try {
        expect(await first.nextFrame()).toBe(ready)
        expect(await second.nextFrame()).toBe(ready)
        expect(listeners()).toHaveLength(1)
        first.close()
        await withApp(true, async otherBase => {
          const other = await openTaskEvents(otherBase)
          try {
            expect(await other.nextFrame()).toBe(ready)
            expect(listeners()).toHaveLength(2)
            const next = second.nextFrame()
            const writer = new pg.Client({ host: dir, port: 5432, user: 'fixture', database: 'roster' })
            await writer.connect()
            try {
              await writer.query('BEGIN')
              await writer.query(update)
              expect(await Promise.race([next, delay(200, 'quiet')])).toBe('quiet')
              await writer.query('ROLLBACK')
              expect(await Promise.race([next, delay(200, 'quiet')])).toBe('quiet')
              await writer.query(`BEGIN; ${update}; COMMIT`)
            } finally {
              await writer.end()
            }
            expect(await next).toBe(changed)
            expect(await other.nextFrame()).toBe(changed)
            for (const endpoint of [base, otherBase]) {
              const response = await fetch(`${endpoint}/api/task-center/${id}`)
              expect(await response.json()).toMatchObject({ progress: { done: 4, total: 8 } })
            }

            expect(query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
              WHERE application_name = 'task-center-events'`)).toBe('t\nt')
            expect(await second.nextFrame()).toBeNull()
            expect(await other.nextFrame()).toBeNull()
          } finally {
            other.close()
          }
        })
      } finally {
        first.close()
        second.close()
      }

      query('DROP TRIGGER task_center_changed ON business.job')
      const unavailable = await openTaskEvents(base)
      try {
        expect(await unavailable.nextFrame()).toBeNull()
      } finally {
        unavailable.close()
      }

      for (let run = 0; run < 2; run++) {
        command('psql', ['-Xqw', '-f', 'upgrade/postgresql/install-job-runtime.sql'])
      }
      query(`UPDATE business.job SET progress = '{"done":5,"total":8}' WHERE id = '${id}'`)
      const reconnected = await openTaskEvents(base)
      expect(await reconnected.nextFrame()).toBe(ready)
      const snapshot = await fetch(`${base}/api/task-center/${id}`)
      expect(await snapshot.json()).toMatchObject({ progress: { done: 5, total: 8 } })
      expect(await reconnected.nextFrame()).toBe(': heartbeat')
      reconnected.close()
      await expect.poll(listeners).toEqual([])

      const openAtShutdown = await openTaskEvents(base)
      expect(await openAtShutdown.nextFrame()).toBe(ready)
    })
    await expect.poll(listeners).toEqual([])
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
