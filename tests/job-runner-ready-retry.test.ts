import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import * as h3 from 'h3'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initializeDb } from '../db/client'
import { newJobId } from '../lib/job'
import { ensureJobRunnerReady } from '../server/utils/job-runner'
import { createJob, getJob } from '../server/utils/job-store'

let listJobsRoute: Awaited<typeof import('../server/api/jobs/index.get')>['default']
const ownedDirectories: string[] = []
const ownedServers: Server[] = []
const ownedConnections: Database.Database[] = []
const ownedDbs: Array<ReturnType<typeof initializeDb>> = []

beforeAll(async () => {
  for (const [name, value] of Object.entries(h3)) vi.stubGlobal(name, value)
  listJobsRoute = (await import('../server/api/jobs/index.get')).default
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

  it('公开任务读取首次故障后可恢复中断任务，后续读取不重复执行对账', async () => {
    const { dbPath } = fixturePath()
    vi.stubEnv('NUXT_DB_PATH', dbPath)
    vi.stubEnv('NUXT_DB_READONLY', '0')
    const db = initializeDb({ create: true,  dbPath })
    ownedDbs.push(db)
    db.$client.pragma('busy_timeout = 0')
    const id = newJobId()
    createJob(db, { id, kind: 'issue-313-http', params: {} })
    db.$client.exec(`
      create table issue313_updates (n integer not null);
      insert into issue313_updates values (0);
      create trigger issue313_job_update after update of state on job
      begin update issue313_updates set n = n + 1; end;
    `)
    const baseUrl = await startPublicJobsRoute()
    const holder = holdWriterLock(dbPath)

    const failed = await fetch(`${baseUrl}/api/jobs?kind=issue-313-http`)
    expect(failed.status).toBe(500)
    expect(getJob(db, id)?.state).toBe('queued')

    holder.exec('ROLLBACK')
    holder.close()
    const recovered = await fetch(`${baseUrl}/api/jobs?kind=issue-313-http`)
    expect(recovered.status).toBe(200)
    const recoveredBody = await recovered.json()
    expect(recoveredBody).toMatchObject({ total: 1, rows: [{ id, state: 'failed', error: expect.stringContaining('服务重启') }] })
    const finishedAt = recoveredBody.rows[0].finishedAt

    const repeated = await fetch(`${baseUrl}/api/jobs?kind=issue-313-http`)
    expect(repeated.status).toBe(200)
    expect((await repeated.json()).rows[0].finishedAt).toBe(finishedAt)
    expect(db.$client.prepare('select n from issue313_updates').get()).toEqual({ n: 1 })
    db.$client.close()
  })

  it('只读公开入口不会为恢复中断任务打开写能力', async () => {
    const { dbPath } = fixturePath()
    const writer = initializeDb({ create: true,  dbPath })
    ownedDbs.push(writer)
    const id = newJobId()
    createJob(writer, { id, kind: 'issue-313-readonly', params: {} })
    writer.$client.close()
    const before = createHash('sha256').update(readFileSync(dbPath)).digest('hex')

    vi.stubEnv('NUXT_DB_PATH', dbPath)
    vi.stubEnv('NUXT_DB_READONLY', '1')
    const baseUrl = await startPublicJobsRoute()
    const response = await fetch(`${baseUrl}/api/jobs?kind=issue-313-readonly`)
    expect(response.status).toBe(500)
    expect(createHash('sha256').update(readFileSync(dbPath)).digest('hex')).toBe(before)

    const observer = new Database(dbPath, { readonly: true, fileMustExist: true })
    ownedConnections.push(observer)
    expect(observer.prepare('select state from job where id = ?').get(id)).toEqual({ state: 'queued' })
    const readOnly = initializeDb({ create: true,  dbPath, readOnly: true })
    ownedDbs.push(readOnly)
    readOnly.$client.close()
  })
})
