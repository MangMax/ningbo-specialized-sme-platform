import { initializeDb } from '../../../db/client'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { schema, useDb } from '../../../db'
import { getCuratedComparison } from '../../../layers/sme-roster/lib/curation'

const dir = mkdtempSync(join(tmpdir(), 'spztx-curation-'))
const path = join(dir, 'nested', 'annotations.json')
const db = initializeDb({ create: true, dbPath: join(dir, 'test.db') })
vi.doMock('@db', () => ({ useDb: () => db }))
let query: Record<string, unknown> = {}
let body: unknown
let get: (event: unknown) => ReturnType<typeof getCuratedComparison> & { total: number }
let patch: (event: unknown) => Promise<{ curated: boolean }>
const identity = { uscc: 'CODE', nameNorm: 'ignored', titleCode: 'specialized_sme', direction: 'missing_in_miit' }

beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
  vi.stubGlobal('setHeader', () => {})
  vi.stubGlobal('setResponseStatus', () => {})
  vi.stubGlobal('getQuery', () => query)
  vi.stubGlobal('readBody', async () => body)
  vi.stubGlobal('useRuntimeConfig', () => ({ curatedPath: path }))
  vi.stubGlobal('createError', (opts: object) => Object.assign(new Error('Bad request'), opts))
  get = (await import('../../../layers/sme-roster/server/api/comparison.get')).default as unknown as typeof get
  patch = (await import('../../../layers/sme-roster/server/api/comparison/curated.patch')).default as unknown as typeof patch
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
const send = (value: unknown) => { body = value; return patch({}) }

describe('comparison curation routes and local JSON', () => {
  it('returns all rows uncurated when the file is absent without creating it', () => {
    const result = get({})
    expect(result.total).toBe(4)
    expect(result.rows.every(row => !row.curated && row.note === undefined)).toBe(true)
    expect(Object.values(result.curatedCounts).flatMap(x => Object.values(x))).toEqual([0, 0, 0, 0, 0, 0])
    expect(existsSync(path)).toBe(false)
  })
  it('persists note, decorates on fresh reads and restores the row on cancellation', async () => {
    await send({ ...identity, curated: true, note: '已电话核实' })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      '["CODE","specialized_sme","missing_in_miit"]': { note: '已电话核实', at: expect.any(String) },
    })
    expect(get({}).rows.some(row => row.uscc === 'CODE')).toBe(false)
    query = { showCurated: 'true' }
    expect(get({}).rows.find(row => row.uscc === 'CODE')).toMatchObject({ curated: true, note: '已电话核实' })
    await send({ ...identity, curated: false })
    query = {}
    expect(get({}).rows.find(row => row.uscc === 'CODE')).toMatchObject({ curated: false })
    expect(get({}).rows.find(row => row.uscc === 'CODE')?.note).toBeUndefined()
  })
  it('uses stored name_norm for missing USCC and isolates title and direction keys', async () => {
    await send({ nameNorm: '乙公司旧', titleCode: 'specialized_sme', direction: 'missing_in_miit', curated: true, note: '无统代核实' })
    await send({ ...identity, direction: 'extra_in_miit', curated: true })
    await send({ ...identity, titleCode: 'innovative_sme', curated: true })
    query = { showCurated: 'true' }
    expect(get({}).rows.find(row => row.uscc === null)).toMatchObject({ curated: true, note: '无统代核实', nameNorm: '乙公司旧' })
    expect(get({}).rows.find(row => row.uscc === 'CODE')?.curated).toBe(false)
  })
  it('is idempotent for repeated PATCH and preserves omitted notes', async () => {
    await send({ ...identity, curated: true, note: '备注' })
    const first = readFileSync(path, 'utf8')
    await send({ ...identity, curated: true, note: '备注' })
    await send({ ...identity, curated: true })
    expect(readFileSync(path, 'utf8')).toBe(first)
    await send({ ...identity, curated: true, note: '' })
    query = { showCurated: 'true' }
    expect(get({}).rows.find(row => row.uscc === 'CODE')?.note).toBe('')
    await send({ ...identity, curated: false })
    await send({ ...identity, curated: false })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({})
  })
  it('keeps global counts and curatedCounts independent of visibility, filters and pagination', async () => {
    await send({ ...identity, curated: true })
    await send({ uscc: 'OTHER', titleCode: 'innovative_sme', direction: 'missing_in_miit', curated: true })
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
  ])('rejects invalid PATCH body with 400: %j', async invalid => {
    await expect(send(invalid)).rejects.toMatchObject({ statusCode: 400 })
    expect(existsSync(path)).toBe(false)
  })
})
