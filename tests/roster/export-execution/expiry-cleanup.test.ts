import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { job } from '../../../db/postgresql/job-tables'
import { closePostgresDirectoryDb, usePostgresDirectoryDb } from '../../../db/postgresql/client'
import { newJobId } from '../../../layers/core/lib/job'
import { createPostgresJobRunner } from '../../../layers/core/server/utils/job-runner-postgres'
import { getJob } from '../../../layers/core/server/utils/job-store-postgres'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'

let dir: string
let exportsDir: string
let db: ReturnType<typeof usePostgresDirectoryDb>
let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>>
const expired = '2000-01-01T00:00:00Z'

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'roster-export-cleanup-'))
  postgres = await postgresRuntimeFixture({ dir })
  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', postgres.url)
  vi.stubEnv('NUXT_DB_READONLY', '0')
  exportsDir = join(dir, 'exports')
  vi.stubEnv('NUXT_ROSTER_EXPORT_DIR', exportsDir)
  db = usePostgresDirectoryDb()
}, 30_000)

beforeEach(async () => {
  await db.delete(job)
  mkdirSync(exportsDir)
})
afterEach(() => rmSync(exportsDir, { recursive: true, force: true }))
afterAll(async () => {
  await closePostgresDirectoryDb()
  postgres?.close()
  if (dir) rmSync(dir, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

async function seedExport({
  state = 'done', expiresAt = expired, kind = 'current-roster-export',
}: {
  state?: typeof job.$inferInsert.state
  expiresAt?: string
  kind?: string
} = {}) {
  const id = newJobId()
  const artifact = { id, expiresAt }
  await db.insert(job).values({
    id, kind, state, params: '{}', progress: '{"done":1,"total":1}',
    result: JSON.stringify({ artifact }), createdAt: expired,
  })
  return { id, artifact, xlsx: join(exportsDir, id + '.xlsx') }
}

async function sweep(clientRequestId: string) {
  const runner = createPostgresJobRunner(db, dir)
  try {
    const queued = await runner.submit({ kind: 'roster_export_cleanup', params: { clientRequestId } })
    await runner.wake()
    return (await getJob(db, queued.id))?.row
  } finally {
    await runner.stop()
  }
}

it('removes only expired completed roster workbooks and preserves export history', async () => {
  const old = await seedExport()
  const live = await seedExport({ expiresAt: '2999-01-01T00:00:00Z' })
  const running = await seedExport({ state: 'running' })
  const failed = await seedExport({ state: 'failed' })
  const malformed = await seedExport({ expiresAt: 'unknown' })
  const other = await seedExport({ kind: 'lead-lists-version-export' })
  const missing = await seedExport()
  const keep = [
    live.xlsx, running.xlsx, failed.xlsx, malformed.xlsx, other.xlsx,
    join(exportsDir, newJobId() + '.xlsx'),
    join(exportsDir, old.id + '.part'),
    join(exportsDir, other.id + '.csv'),
  ]
  for (const path of [old.xlsx, ...keep]) writeFileSync(path, 'fixture')

  expect(await sweep('hour-1')).toMatchObject({ state: 'done', result: { removed: 1, failed: 0 } })
  expect(existsSync(old.xlsx)).toBe(false)
  for (const path of keep) expect(existsSync(path), path).toBe(true)
  expect((await getJob(db, old.id))?.row).toMatchObject({ state: 'done', result: { artifact: old.artifact } })
  expect((await getJob(db, missing.id))?.row).toMatchObject({ state: 'done' })
  expect(await sweep('hour-2')).toMatchObject({ state: 'done', result: { removed: 0, failed: 0 } })
})

it('records partial deletion and fails when an expired workbook cannot be unlinked', async () => {
  const blocked = await seedExport()
  const removable = await seedExport()
  mkdirSync(blocked.xlsx)
  writeFileSync(removable.xlsx, 'fixture')

  expect(await sweep('hour-1')).toMatchObject({
    state: 'failed', result: { removed: 1, failed: 1 }, error: '部分过期名录导出文件未能清理',
  })
  expect(existsSync(blocked.xlsx)).toBe(true)
  expect(existsSync(removable.xlsx)).toBe(false)
})

it('distinguishes an unused export directory from a directory read failure', async () => {
  rmSync(exportsDir, { recursive: true })
  expect(await sweep('hour-1')).toMatchObject({ state: 'done', result: { removed: 0, failed: 0 } })

  writeFileSync(exportsDir, 'invalid export directory')
  expect(await sweep('hour-2')).toMatchObject({
    state: 'failed', result: { removed: 0, failed: 0 }, error: '无法读取名录导出目录',
  })
})
