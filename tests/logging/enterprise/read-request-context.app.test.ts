import { mkdtempSync, rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import pg from 'pg'
import { applicationLogs, closeApplicationLogging, initializeWorkerLogging } from '../../../layers/core/lib/logging'
import { createEnterpriseReadExecutor } from '../../../layers/sme-roster/server/utils/enterprise-read'
import { createEnterpriseReadProcess } from '../../../layers/sme-roster/server/utils/enterprise-read-process'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'

const bin = process.env.ROSTER_TEST_POSTGRES_BIN
const filter = { titleCode: 'little_giant' as const }

describe.skipIf(!bin)('PostgreSQL current qualification worker logging', () => {
  let root: string
  let runtime: Awaited<ReturnType<typeof postgresRuntimeFixture>>
  let postgres: pg.Pool

  beforeAll(async () => {
    root = mkdtempSync('/tmp/roster-read-logs-')
    runtime = await postgresRuntimeFixture({ dir: root, bin })
    for (const [key, value] of Object.entries(runtime.env)) vi.stubEnv(key, value)
    vi.stubEnv('NUXT_DB_READONLY', '1')
    postgres = new pg.Pool({ connectionString: runtime.url })
    initializeWorkerLogging()
  }, 15_000)

  afterAll(async () => {
    try {
      await closeApplicationLogging()
      await postgres?.end()
    } finally {
      vi.unstubAllEnvs()
      runtime?.close()
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
