import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { useDb } from '../db/client'
import * as candidates from '../lib/roster/current-candidates'
import { CurrentWorkbookLimitError, writeCurrentWorkbook } from '../lib/roster/current-workbook'

vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, tmpdir: vi.fn(actual.tmpdir) }
})

const systemTempDir = tmpdir()
const close: (() => void)[] = []
afterEach(() => { vi.restoreAllMocks(); vi.mocked(tmpdir).mockReturnValue(systemTempDir); for (const cleanup of close.splice(0)) cleanup() })
function universe(size: number) {
  const dir = mkdtempSync(join(process.env.CURRENT_CANDIDATE_READER_EVIDENCE_DIR ?? systemTempDir, 'enumeration-702-'))
  vi.mocked(tmpdir).mockReturnValue(dir)
  const db = useDb({ dbPath: join(dir, 'synthetic.db') })
  close.push(() => { db.$client.close(); if (!process.env.CURRENT_CANDIDATE_READER_EVIDENCE_DIR) rmSync(dir, { recursive: true, force: true }) })
  // Synthetic input at the candidate boundary: real SQLite iterator, no count or SQL-call oracle.
  vi.spyOn(candidates, 'currentCandidateReadSqlFor').mockReturnValue(`with recursive ids(id) as (select 1 where @title is not null and @rdjb is not null union all select id+1 from ids where id<${size}) select id from ids`)
  return { db: db.$client, file: join(dir, 'out.xlsx') }
}
function tempSpools() { return readdirSync(tmpdir()).filter(name => name.startsWith('current-export-full-text-')).sort() }

it('702 rejects an impossible five-sheet universe before assessment and releases its transaction', async () => {
  const { db, file } = universe(5 * 1048575 + 1)
  const before = tempSpools(), progress = vi.fn()
  await expect(writeCurrentWorkbook(db, 'little_giant', file, progress)).rejects.toBeInstanceOf(CurrentWorkbookLimitError)
  expect(progress).not.toHaveBeenCalled()
  expect(db.inTransaction).toBe(false)
  expect(tempSpools()).toEqual(before)
  expect(db.prepare('select 17 as witness').get()).toEqual({ witness: 17 })
}, 30000)

it('702 bounds candidate heap at the full valid workbook capacity and releases early cancellation', async () => {
  const { db, file } = universe(5 * 1048575)
  const before = tempSpools(), heapBefore = process.memoryUsage().heapUsed, arraysBefore = process.memoryUsage().arrayBuffers
  const cancelled = new Error('synthetic caller cancellation')
  const progress = vi.fn((done: number, total: number) => {
    expect(done).toBe(0)
    expect(total).toBe(5242875)
    // A full number/object array exceeds this margin; typed scalar chunks do not.
    expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(32 * 1024 * 1024)
    expect(process.memoryUsage().arrayBuffers - arraysBefore).toBeLessThan(41 * 1024 * 1024)
    throw cancelled
  })
  await expect(writeCurrentWorkbook(db, 'little_giant', file, progress)).rejects.toBe(cancelled)
  expect(progress).toHaveBeenCalledOnce()
  expect(db.inTransaction).toBe(false)
  expect(tempSpools()).toEqual(before)
  expect(existsSync(file)).toBe(true) // The caller owns publication/removal of the partial destination.
}, 30000)

it('702 closes a failing candidate iterator and rolls back before a subsequent workbook', async () => {
  const { db, file } = universe(300)
  db.function('synthetic_failure_702', (value: number) => {
    if (value === 201) throw new Error('synthetic enumeration read failure')
    return value
  })
  vi.mocked(candidates.currentCandidateReadSqlFor).mockReturnValue('with recursive ids(id) as (select 1 where @title is not null and @rdjb is not null union all select id+1 from ids where id<300) select synthetic_failure_702(id) as id from ids')
  const before = tempSpools()
  await expect(writeCurrentWorkbook(db, 'little_giant', file, () => {})).rejects.toThrow('synthetic enumeration read failure')
  expect(db.inTransaction).toBe(false)
  expect(tempSpools()).toEqual(before)
  vi.restoreAllMocks()
  const next = await writeCurrentWorkbook(db, 'little_giant', file, () => {})
  expect(next.total).toBe(0)
  expect(next.statusCounts).toEqual({ effective: 0, expired: 0, terminated: 0, moved_out: 0, unrecognized: 0 })
})
