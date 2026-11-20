import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { initializeDb, schema } from '../../../db/client'
import { newJobId } from '../../../layers/core/lib/job'
import { submitJob, whenIdle } from '../../../layers/core/server/utils/job-runner'
import { getJob } from '../../../layers/core/server/utils/job-store'

let dir: string
let exportsDir: string
let db: ReturnType<typeof initializeDb>
const expired = '2000-01-01T00:00:00Z'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'roster-export-cleanup-'))
  const dbPath = join(dir, 'roster.db')
  db = initializeDb({ dbPath, create: true })
  exportsDir = dbPath + '.exports'
  mkdirSync(exportsDir)
})

afterEach(async () => {
  await whenIdle()
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})

function seedExport({
  state = 'done', expiresAt = expired, kind = 'current-roster-export',
}: {
  state?: typeof schema.job.$inferInsert.state
  expiresAt?: string
  kind?: string
} = {}) {
  const id = newJobId()
  const artifact = { id, expiresAt }
  db.insert(schema.job).values({
    id, kind, state, params: {}, progress: { done: 1, total: 1 },
    result: { artifact }, createdAt: expired,
  }).run()
  return { id, artifact, xlsx: join(exportsDir, id + '.xlsx') }
}

async function sweep(clientRequestId: string) {
  const queued = submitJob(db, {
    kind: 'roster_export_cleanup', params: { clientRequestId }, filesDir: dir,
  })
  await whenIdle()
  return getJob(db, queued.id)
}

it('removes only expired completed roster workbooks and preserves export history', async () => {
  const old = seedExport()
  const live = seedExport({ expiresAt: '2999-01-01T00:00:00Z' })
  const running = seedExport({ state: 'running' })
  const failed = seedExport({ state: 'failed' })
  const malformed = seedExport({ expiresAt: 'unknown' })
  const other = seedExport({ kind: 'lead-lists-version-export' })
  const missing = seedExport()
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
  expect(getJob(db, old.id)).toMatchObject({ state: 'done', result: { artifact: old.artifact } })
  expect(getJob(db, missing.id)).toMatchObject({ state: 'done' })
  expect(await sweep('hour-2')).toMatchObject({ state: 'done', result: { removed: 0, failed: 0 } })
})

it('records partial deletion and fails when an expired workbook cannot be unlinked', async () => {
  const blocked = seedExport()
  const removable = seedExport()
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
