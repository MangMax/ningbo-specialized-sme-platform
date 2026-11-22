import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import pg from 'pg'
import { applicationLogs, closeApplicationLogging, initializeWorkerLogging } from '../../../layers/core/lib/logging'
import { defaultLogCollection } from '../../../layers/core/lib/logging/policy'
import { createEnterpriseReadExecutor } from '../../../layers/sme-roster/server/utils/enterprise-read'
import { createEnterpriseReadProcess } from '../../../layers/sme-roster/server/utils/enterprise-read-process'
import { reserveLoopbackPort } from '../../support/owned-process.mjs'

const bin = process.env.ROSTER_TEST_POSTGRES_BIN
const filter = { titleCode: 'little_giant' as const }

describe.skipIf(!bin)('PostgreSQL current qualification worker logging', () => {
  let root: string
  let cluster: string
  let started = false
  let postgres: pg.Pool
  const command = (name: string, args: string[], input?: string) =>
    execFileSync(join(bin!, name), args, { input, stdio: ['pipe', 'pipe', 'pipe'] })

  beforeAll(async () => {
    root = mkdtempSync('/tmp/roster-read-logs-')
    cluster = join(root, 'cluster')
    const port = await reserveLoopbackPort()
    const url = `postgresql://fixture@127.0.0.1:${port}/postgres`
    command('initdb', ['-D', cluster, '-A', 'trust', '-U', 'fixture', '--locale=C', '-E', 'UTF8'])
    command('pg_ctl', ['-D', cluster, '-l', join(root, 'server.log'), '-o', `-h 127.0.0.1 -p ${port} -k ${root}`, '-w', 'start'])
    started = true
    command('psql', ['-X', '-w', '-v', 'ON_ERROR_STOP=1', url], `
      CREATE SCHEMA business;
      SET search_path TO business;
      CREATE TABLE record (enterprise_id bigint, title_code text);
      CREATE TABLE difference_reason (enterprise_id bigint, title_code text);
      CREATE TABLE record_correspondence (enterprise_id bigint, title_code text);
      CREATE TABLE platform_recognized_projection (version_id bigint, observation_id bigint, title_raw text);
      CREATE TABLE platform_business_projection (LIKE platform_recognized_projection);
      CREATE TABLE platform_apply_projection (LIKE platform_recognized_projection);
      CREATE TABLE platform_business_observation (id bigint, version_id bigint);
      CREATE TABLE platform_observation_assignment (observation_id bigint, enterprise_id bigint, uscc_raw text, revision bigint);
      CREATE SCHEMA staged;
      CREATE TABLE staged.log_policy (id bigint, "retentionDays" bigint, "maxBytes" bigint, pruned bigint, cleared bigint);
      INSERT INTO staged.log_policy VALUES (1, 30, 1048576, 0, 0);
      CREATE TABLE staged.log_collection (id bigint, collection text, revision bigint);
      INSERT INTO staged.log_collection VALUES (1, '${JSON.stringify(defaultLogCollection())}', 0);
      CREATE TABLE staged.log_events (seq bigint, id text, timestamp text, level text, source text, operation text, outcome text,
        "requestId" text, "traceId" text, "taskId" text, "fileId" bigint, "batchId" text, "resourceId" text, summary text, detail text);
      CREATE TABLE staged.sqlite_sequence (name text, seq bigint);
    `)
    command('psql', ['-X', '-w', '-v', 'staging=staged', url, '-f', 'upgrade/pg/sqlite-import/materialize-runtime-logs.sql'])
    vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', url)
    vi.stubEnv('NUXT_POSTGRES_LOG_URL', url)
    vi.stubEnv('NUXT_DB_READONLY', '1')
    postgres = new pg.Pool({ connectionString: url })
    initializeWorkerLogging()
  }, 15_000)

  afterAll(async () => {
    try {
      await closeApplicationLogging()
      await postgres?.end()
    } finally {
      vi.unstubAllEnvs()
      if (started) command('pg_ctl', ['-D', cluster, '-w', '-m', 'fast', 'stop'])
      if (root) rmSync(root, { recursive: true, force: true })
    }
  })

  async function logs(requestId: string) {
    await applicationLogs().flush()
    return (await applicationLogs().list({ requestId, limit: 100 })).rows
  }

  it('persists worker execution context and preserves success and PostgreSQL failure results', async () => {
    const reads = createEnterpriseReadExecutor()
    try {
      const read = await reads.currentQualifiedJson({ ...filter, q: 'PRIVATE184_SEARCH' }, undefined, { requestId: 'read184', traceId: 'trace184' })
      expect(JSON.parse(read.body.toString())).toMatchObject({
        titleCode: 'little_giant', total: 0, rows: [], publishedPending: { requested: true, total: 0 },
      })
      await expect.poll(async () => (await logs('read184')).filter(row => row.operation === 'enterprise_read.execute').map(row => row.outcome).sort())
        .toEqual(['started', 'success'])
      const rows = await logs('read184')
      expect(rows.filter(row => row.operation === 'enterprise_read.finished')).toMatchObject([{ outcome: 'success', traceId: 'trace184' }])
      await postgres.query('ALTER TABLE business.record RENAME TO fixture_hidden_record')
      try {
        await expect(reads.currentQualifiedJson(filter, undefined, { requestId: 'failed184' })).rejects.toMatchObject({ statusCode: 503 })
      } finally {
        await postgres.query('ALTER TABLE business.fixture_hidden_record RENAME TO record')
      }
      expect((await logs('failed184')).filter(row => row.operation === 'enterprise_read.finished')).toMatchObject([{ outcome: 'failure' }])
      const details = await Promise.all(rows.map(row => applicationLogs().detail(row.id)))
      expect(JSON.stringify(details)).not.toMatch(/PRIVATE184|dbPath|filter|heap|params/)
    } finally { await reads.close() }
  }, 15_000)

  function scripted(source: string) {
    return createEnterpriseReadExecutor({ createWorker: () => createEnterpriseReadProcess(new URL('file:///unused184'), source) })
  }

  it.each([
    ['exit184', "process.send({type:'ready'});process.on('message',()=>process.exit(7))"],
    ['ipc184', "process.send({type:'ready'});process.on('message',m=>process.send({id:m.id,type:'invalid'}))"],
  ])('records process faults as unknown after one failed read', async (id, source) => {
    const reads = scripted(source)
    try { await expect(reads.currentQualifiedJson(filter, undefined, { requestId: id })).rejects.toMatchObject({ statusCode: 503 }) }
    finally { await reads.close() }
    const rows = await logs(id)
    expect(rows.filter(row => row.operation === 'enterprise_read.finished')).toMatchObject([{ outcome: 'unknown' }])
    expect(rows.filter(row => row.operation === 'enterprise_read.process.exit')).toHaveLength(1)
  })

  it('records startup failure separately from an early exit', async () => {
    const failed = createEnterpriseReadExecutor({ createWorker: () => { throw new Error('PRIVATE184_START') } })
    try {
      await expect(failed.currentQualifiedJson(filter, undefined, { requestId: 'spawn184' })).rejects.toMatchObject({ code: 'worker_start_failed' })
    } finally { await failed.close() }
    expect((await logs('spawn184')).filter(row => row.operation === 'enterprise_read.process.start').map(row => row.outcome))
      .toEqual(['failure', 'started'])
    const exited = scripted('process.exit(3)')
    try {
      await expect(exited.currentQualifiedJson(filter, undefined, { requestId: 'earlyexit184' })).rejects.toMatchObject({ code: 'worker_exited' })
    } finally { await exited.close() }
    expect((await logs('earlyexit184')).find(row => row.operation === 'enterprise_read.finished')?.outcome).toBe('unknown')
  })

  it('records one startup timeout and retires the child', async () => {
    const reads = scripted('setInterval(()=>{},1000)')
    try {
      await expect(reads.currentQualifiedJson(filter, undefined, { requestId: 'timeout184' })).rejects.toMatchObject({ code: 'worker_start_timeout' })
    } finally { await reads.close() }
    const rows = await logs('timeout184')
    expect(rows.filter(row => row.operation === 'enterprise_read.finished')).toMatchObject([{ outcome: 'timeout' }])
    expect(rows.filter(row => row.operation === 'enterprise_read.process.start').map(row => row.outcome)).toEqual(['timeout', 'started'])
  }, 10_000)
})
