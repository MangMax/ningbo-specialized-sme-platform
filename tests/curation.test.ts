import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { schema, useDb } from '../db'
import { getCuratedComparison, parseCurationPatch, patchCuration } from '../lib/curation'

const dir = mkdtempSync(join(tmpdir(), 'spztx-curation-'))
const path = join(dir, 'nested', 'annotations.json')
const db = useDb({ dbPath: join(dir, 'test.db') })
vi.doMock('@db', () => ({ useDb: () => db }))
let query: Record<string, unknown> = {}
let body: unknown
let get: (event: unknown) => ReturnType<typeof getCuratedComparison> & { total: number }
const identity = { uscc: 'CODE', nameNorm: 'ignored', titleCode: 'specialized_sme', direction: 'missing_in_miit' }

beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
  vi.stubGlobal('getQuery', () => query)
  vi.stubGlobal('readBody', async () => body)
  vi.stubGlobal('useRuntimeConfig', () => ({ curatedPath: path }))
  vi.stubGlobal('createError', (opts: object) => Object.assign(new Error('Bad request'), opts))
  get = (await import('../server/api/comparison.get')).default as unknown as typeof get
  for (const [name, nameNorm, usccNorm, source, titleCode] of [
    ['甲公司', '甲公司', 'CODE', 'jxj', 'specialized_sme'],
    ['乙 公司(旧)', '乙公司旧', null, 'jxj', 'specialized_sme'],
    ['反向', '反向', 'REVERSE', 'miit', 'specialized_sme'],
    ['另一称号', '另一称号', 'OTHER', 'jxj', 'innovative_sme'],
  ] as const) {
    const enterpriseId = db.insert(schema.enterprise).values({ name, nameNorm, usccNorm }).returning({ id: schema.enterprise.id }).get().id
    db.insert(schema.record).values({ enterpriseId, source, titleCode }).run()
  }
})
beforeEach(() => { rmSync(path, { force: true }); query = {}; body = undefined })
afterAll(() => { vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }) })
// Seed historical annotations through the legacy helper; the public PATCH is retired (#102).
const seedLegacy = async (value: unknown) => patchCuration(path, parseCurationPatch(value))

describe('historical curation read compatibility and legacy JSON helper', () => {
  it('returns all rows uncurated when the file is absent without creating it', () => {
    const result = get({})
    expect(result.total).toBe(4)
    expect(result.rows.every(row => !row.curated && row.note === undefined)).toBe(true)
    expect(Object.values(result.curatedCounts).flatMap(x => Object.values(x))).toEqual([0, 0, 0, 0, 0, 0])
    expect(existsSync(path)).toBe(false)
  })
  it('persists note, decorates on fresh reads and restores the row on cancellation', async () => {
    await seedLegacy({ ...identity, curated: true, note: '已电话核实' })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      '["CODE","specialized_sme","missing_in_miit"]': { note: '已电话核实', at: expect.any(String) },
    })
    expect(get({}).rows.some(row => row.uscc === 'CODE')).toBe(false)
    query = { showCurated: 'true' }
    expect(get({}).rows.find(row => row.uscc === 'CODE')).toMatchObject({ curated: true, note: '已电话核实' })
    await seedLegacy({ ...identity, curated: false })
    query = {}
    expect(get({}).rows.find(row => row.uscc === 'CODE')).toMatchObject({ curated: false })
    expect(get({}).rows.find(row => row.uscc === 'CODE')?.note).toBeUndefined()
  })
  it('uses stored name_norm for missing USCC and isolates title and direction keys', async () => {
    await seedLegacy({ nameNorm: '乙公司旧', titleCode: 'specialized_sme', direction: 'missing_in_miit', curated: true, note: '无统代核实' })
    await seedLegacy({ ...identity, direction: 'extra_in_miit', curated: true })
    await seedLegacy({ ...identity, titleCode: 'innovative_sme', curated: true })
    query = { showCurated: 'true' }
    expect(get({}).rows.find(row => row.uscc === null)).toMatchObject({ curated: true, note: '无统代核实', nameNorm: '乙公司旧' })
    expect(get({}).rows.find(row => row.uscc === 'CODE')?.curated).toBe(false)
  })
  it('is idempotent for repeated legacy helper calls and preserves omitted notes', async () => {
    await seedLegacy({ ...identity, curated: true, note: '备注' })
    const first = readFileSync(path, 'utf8')
    await seedLegacy({ ...identity, curated: true, note: '备注' })
    await seedLegacy({ ...identity, curated: true })
    expect(readFileSync(path, 'utf8')).toBe(first)
    await seedLegacy({ ...identity, curated: true, note: '' })
    query = { showCurated: 'true' }
    expect(get({}).rows.find(row => row.uscc === 'CODE')?.note).toBe('')
    await seedLegacy({ ...identity, curated: false })
    await seedLegacy({ ...identity, curated: false })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({})
  })
  it('keeps global counts and curatedCounts independent of visibility, filters and pagination', async () => {
    await seedLegacy({ ...identity, curated: true })
    await seedLegacy({ uscc: 'OTHER', titleCode: 'innovative_sme', direction: 'missing_in_miit', curated: true })
    const hidden = get({})
    query = { showCurated: 'true', title: 'specialized_sme', direction: 'missing_in_miit', page: '2', pageSize: '1' }
    const visible = get({})
    expect(hidden.total).toBe(2)
    expect(visible.total).toBe(2)
    expect(visible.rows).toHaveLength(1)
    expect(visible.counts).toEqual(hidden.counts)
    expect(visible.counts.specialized_sme).toEqual({ missing_in_miit: 2, extra_in_miit: 1 })
    expect(visible.curatedCounts).toEqual(hidden.curatedCounts)
    expect(visible.curatedCounts).toEqual({
      little_giant: { missing_in_miit: 0, extra_in_miit: 0 },
      specialized_sme: { missing_in_miit: 1, extra_in_miit: 0 },
      innovative_sme: { missing_in_miit: 1, extra_in_miit: 0 },
    })
  })
  it.each([
    null, {}, { ...identity, curated: true, titleCode: 'unknown' },
    { ...identity, curated: true, direction: 'unknown' },
    { titleCode: 'specialized_sme', direction: 'missing_in_miit', curated: true },
    { ...identity, curated: 'true' }, { ...identity, curated: true, note: 3 },
    { ...identity, uscc: ' ', nameNorm: undefined, curated: true },
    { ...identity, uscc: 3, curated: true },
  ])('rejects invalid legacy body: %j', async invalid => {
    await expect(seedLegacy(invalid)).rejects.toThrow()
    expect(existsSync(path)).toBe(false)
  })
})
