import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import pg from 'pg'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import { closePostgresDirectoryDb } from '../../../db/postgresql/client'
import * as h3 from 'h3'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initializeDb } from '../../../db/client'
import { newJobId } from '../../../layers/core/lib/job'
import { ensureJobRunnerReady } from '../../../layers/core/server/utils/job-runner'
import { createJob, getJob } from '../../../layers/core/server/utils/job-store'

let listJobsRoute: Awaited<typeof import('../../../layers/core/server/api/jobs/index.get')>['default']
const ownedDirectories: string[] = []
const ownedServers: Server[] = []
const ownedConnections: Database.Database[] = []
const ownedDbs: Array<ReturnType<typeof initializeDb>> = []

beforeAll(async () => {
  for (const [name, value] of Object.entries(h3)) vi.stubGlobal(name, value)
  vi.stubGlobal('useRuntimeConfig', () => ({ apiToken: '' }))
  listJobsRoute = (await import('../../../layers/core/server/api/jobs/index.get')).default
})

afterEach(async () => {
  for (const server of ownedServers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  for (const connection of ownedConnections.splice(0)) {
    if (connection.open) connection.close()
  }
  for (const db of ownedDbs.splice(0)) {
    if (db.$client.open) db.$client.close()
  }
  vi.unstubAllEnvs()
  for (const directory of ownedDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

afterAll(() => vi.unstubAllGlobals())

function fixturePath(): { directory: string; dbPath: string } {
  const directory = mkdtempSync(join(tmpdir(), 'issue313-job-runner-ready-'))
  ownedDirectories.push(directory)
  return { directory, dbPath: join(directory, 'jobs.sqlite') }
}

async function startPublicJobsRoute(): Promise<string> {
  const router = h3.createRouter().get('/api/jobs', listJobsRoute)
  const server = createServer(h3.toNodeListener(h3.createApp({ debug: false }).use(router)))
  ownedServers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}

function holdWriterLock(dbPath: string): Database.Database {
  const holder = new Database(dbPath)
  ownedConnections.push(holder)
  holder.pragma('journal_mode = WAL')
  holder.exec('BEGIN IMMEDIATE')
  return holder
}

describe('ensureJobRunnerReady 对账就绪缓存', () => {
  it('保留首次 SQLITE_BUSY，释放锁后同一 db 可重试且成功后幂等', () => {
    const { dbPath } = fixturePath()
    const db = initializeDb({ create: true,  dbPath })
    ownedDbs.push(db)
    db.$client.pragma('busy_timeout = 0')
    const id = newJobId()
    createJob(db, { id, kind: 'issue-313-direct', params: {} })
    const holder = holdWriterLock(dbPath)

    let failure: unknown
    try {
      ensureJobRunnerReady(db)
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({ code: 'SQLITE_BUSY' })
    expect((failure as Error).message).toContain('database is locked')
    expect(getJob(db, id)?.state).toBe('queued')

    holder.exec('ROLLBACK')
    holder.close()
    expect(ensureJobRunnerReady(db)).toBe(1)
    expect(getJob(db, id)).toMatchObject({ state: 'failed', error: expect.stringContaining('服务重启') })
    expect(ensureJobRunnerReady(db)).toBe(0)
    db.$client.close()
  })
})

it.each(['0', '1'])('task history reads a locked queued job without recovering it (readonly=%s)', async readOnly => {
  const { directory } = fixturePath()
  const fixture = await postgresRuntimeFixture({ dir: directory })
  const admin = new pg.Client({ connectionString: fixture.url })
  try {
    await admin.connect()
    const id = newJobId()
    await admin.query("INSERT INTO business.job(id,kind,params,created_at) VALUES($1,'fixture','{}','2026-01-01Z')", [id])
    await admin.query('BEGIN')
    await admin.query('SELECT id FROM business.job WHERE id=$1 FOR UPDATE', [id])
    vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', fixture.url)
    vi.stubEnv('NUXT_DB_READONLY', readOnly)
    const baseUrl = await startPublicJobsRoute()
    for (let i = 0; i < 2; i++) {
      const response = await fetch(baseUrl + '/api/jobs?kind=fixture', { signal: AbortSignal.timeout(2000) })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ total: 1, rows: [{ id, state: 'queued', finishedAt: null }] })
    }
    await admin.query('ROLLBACK')
    expect((await admin.query('SELECT state, finished_at FROM business.job WHERE id=$1', [id])).rows)
      .toEqual([{ state: 'queued', finished_at: null }])
  } finally {
    await admin.end()
    await closePostgresDirectoryDb()
    fixture.close()
  }
}, 30_000)
