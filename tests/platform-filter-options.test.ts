import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, toWebHandler } from 'h3'
import { initializeDb } from '../db/client'
import * as schema from '../db/schema'
import { readPlatformFilterOptions } from '../server/utils/platform-filter-options'
import { platformFilterOptionsQueryFromQuery } from '../lib/platform/filter-options'

const empty = { titles: [], declareKinds: [], years: [], statuses: [], batches: [], districts: [], validityDates: [] }
const cleanup: Array<() => void> = []
afterEach(() => { cleanup.splice(0).reverse().forEach(fn => fn()); vi.doUnmock('@db') })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'platform-filter-options-'))
  const db = initializeDb({ create: true, dbPath: join(dir, 'test.db') })
  cleanup.push(() => { db.$client.close(); rmSync(dir, { recursive: true, force: true }) })
  let sequence = 0
  function record(source: 'apply_list' | 'business_list' | 'recognized_list') {
    const record = db.insert(schema.platformBusinessRecord).values({ interface: source, platformKey: `synthetic-${++sequence}`, identityRuleVersion: 'test' }).returning().get()
    const version = db.insert(schema.platformBusinessRecordVersion).values({ recordId: record.id, hashAlgorithm: 'test', contentHash: `hash-${sequence}`, canonicalRawJson: '{"year":2099,"cszt":"raw-must-not-be-read"}' }).returning().get()
    return { recordId: record.id, versionId: version.id, ruleVersion: 'test' }
  }
  function observation(source: 'apply_list' | 'business_list' | 'recognized_list', values: Partial<Omit<typeof schema.platformRelation.$inferInsert, 'declareKind'>> & { declareKind?: string | null }, mode: 'missing' | 'conflict' | 'unverifiable' | 'resolved' = 'missing') {
    const query = db.insert(schema.platformQuery).values({ interface: source, queryKey: `query-${++sequence}`, rdjb: '3', queriedAt: '2026-11-01', status: 'success' }).returning().get()
    const { declareKind, ...relationValues } = values
    const relation = db.insert(schema.platformRelation).values({ queryId: query.id, sequenceNo: 1, ...relationValues }).returning().get()
    // SQLite legacy rows may contain dictionary values outside Drizzle's declared enum.
    if (declareKind !== undefined) db.$client.prepare('update platform_relation set declare_kind = ? where id = ?').run(declareKind, relation.id)
    const owner = mode === 'resolved' || mode === 'unverifiable' ? record(source) : null
    db.insert(schema.platformBusinessObservation).values({ relationId: relation.id, recordId: owner?.recordId ?? null, versionId: mode === 'resolved' ? owner!.versionId : null, identityState: mode === 'resolved' || mode === 'unverifiable' ? 'resolved' : mode === 'conflict' ? 'conflict' : 'missing_key', contentState: mode === 'resolved' ? 'verified' : 'unverifiable', keySource: 'none', projectionRuleVersion: 'test', inputFingerprint: `fp-${sequence}` }).run()
  }
  return { db, record, observation }
}

it('records use source-specific distinct columns and preserve unknown values with stable ordering', () => {
  const { db, record } = fixture()
  for (const values of [{ declareKind: 'update', declarationYear: 2024, status: 'z-unknown' }, { declareKind: 'apply', declarationYear: 2026, status: 'a-status' }, { declareKind: 'update', declarationYear: 2024, status: 'z-unknown' }, { declareKind: '', status: '  ' }, { appliedAt: '2038-01-01' }]) db.insert(schema.platformApplyProjection).values({ ...record('apply_list'), ...values }).run()
  for (const values of [{ declareKind: 'outside-dictionary', businessYear: 2023, status: '9', batch: 'batch-Z' }, { declareKind: 'review', businessYear: 2025, status: '0', batch: 'batch-A' }, { declareKind: null, businessYear: null, status: null, batch: null, appliedAt: '2040-02-02', awardBatchLabel: '2041' }]) db.insert(schema.platformBusinessProjection).values({ ...record('business_list'), ...values }).run()
  for (const values of [{ validityDateRaw: 'not-a-date', maintenanceYear: 2029, maintenanceBatch: 'batch-R', district: '3302' }, { validityDateRaw: '2028/12/31', maintenanceBatch: 'batch-Q', district: '3301' }, { validityDateRaw: '', maintenanceBatch: '  ', district: null }]) db.insert(schema.platformRecognizedProjection).values({ ...record('recognized_list'), ...values }).run()
  // A projection physically attached to another interface must not supply candidates.
  db.insert(schema.platformApplyProjection).values({ ...record('business_list'), declareKind: 'wrong-interface', declarationYear: 2098, titleRaw: 'wrong-interface-title' }).run()
  expect(readPlatformFilterOptions({ source: 'declarations' }, db)).toEqual({ ...empty, declareKinds: ['apply', 'update'], years: [2026, 2024], statuses: ['a-status', 'z-unknown'] })
  expect(readPlatformFilterOptions({ source: 'business-processes' }, db)).toEqual({ ...empty, declareKinds: ['outside-dictionary', 'review'], years: [2025, 2023], statuses: ['0', '9'], batches: ['batch-A', 'batch-Z'] })
  expect(readPlatformFilterOptions({ source: 'recognized-directory' }, db)).toEqual({ ...empty, validityDates: ['2028/12/31', 'not-a-date'], batches: ['batch-Q', 'batch-R'], districts: ['3301', '3302'] })
})

it('isolated uses only matching observation relations and never record projections or query title scopes', () => {
  const { db, record, observation } = fixture()
  db.insert(schema.platformApplyProjection).values({ ...record('apply_list'), declareKind: 'projection-only', declarationYear: 2090, status: 'projection-status' }).run()
  observation('apply_list', { declareKind: 'legacy-unknown', year: 2021, status: 'isolated-A' }, 'missing')
  observation('apply_list', { declareKind: 'apply', year: 2024, status: 'isolated-B' }, 'conflict')
  observation('apply_list', { declareKind: 'review', year: 2022, status: 'isolated-C' }, 'unverifiable')
  observation('apply_list', { declareKind: 'excluded', year: 2099, status: 'excluded' }, 'resolved')
  observation('apply_list', { appliedAt: '2040-01-01', batch: '2041' })
  observation('business_list', { declareKind: 'business-isolated', year: 2020, status: 'business-status', batch: 'business-batch' })
  observation('business_list', { year: 2023, status: '0', batch: 'unknown-batch' }, 'conflict')
  observation('recognized_list', { declareKind: 'never-directory-kind', year: 2088, status: 'never-directory-status', batch: 'never-directory-batch' })
  expect(readPlatformFilterOptions({ source: 'declarations', view: 'records' }, db)).toEqual({ ...empty, declareKinds: ['projection-only'], years: [2090], statuses: ['projection-status'] })
  expect(readPlatformFilterOptions({ source: 'declarations', view: 'isolated' }, db)).toEqual({ ...empty, declareKinds: ['apply', 'legacy-unknown', 'review'], years: [2024, 2022, 2021], statuses: ['isolated-A', 'isolated-B', 'isolated-C'] })
  expect(readPlatformFilterOptions({ source: 'business-processes', view: 'isolated' }, db)).toEqual({ ...empty, declareKinds: ['business-isolated'], years: [2023, 2020], statuses: ['0', 'business-status'], batches: ['business-batch', 'unknown-batch'] })
  expect(readPlatformFilterOptions({ source: 'recognized-directory', view: 'isolated' }, db)).toEqual(empty)
})

it('year candidates exclude zero negative fractional and unsafe integers in records and isolated views', () => {
  const { db, record, observation } = fixture()
  for (const year of [0, -1, 2024.5, Number.MAX_SAFE_INTEGER + 1, 2024, 2026]) {
    db.insert(schema.platformApplyProjection).values({ ...record('apply_list'), declarationYear: year }).run()
    db.insert(schema.platformBusinessProjection).values({ ...record('business_list'), businessYear: year }).run()
    observation('apply_list', { year })
    observation('business_list', { year })
  }
  for (const source of ['declarations', 'business-processes']) {
    for (const view of ['records', 'isolated']) {
      expect(readPlatformFilterOptions({ source, view }, db)).toEqual({ ...empty, years: [2026, 2024] })
    }
  }
})

it('candidates include values beyond the 200 row page limit without writing to SQLite', () => {
  const { db, record } = fixture()
  for (let i = 0; i < 205; i++) db.insert(schema.platformBusinessProjection).values({ ...record('business_list'), titleRaw: i === 204 ? 'outside-page-title' : '1', businessYear: i === 204 ? 2027 : 2024, status: i === 204 ? 'outside-page' : 'common', batch: i === 204 ? 'last-batch' : null }).run()
  const before = db.$client.serialize()
  expect(readPlatformFilterOptions({ source: 'business-processes' }, db)).toEqual({ ...empty, titles: ['1', 'outside-page-title'], years: [2027, 2024], statuses: ['common', 'outside-page'], batches: ['last-batch'] })
  expect(db.$client.serialize()).toEqual(before)
})

it('sources with no row title return seven empty arrays without guessed values', () => {
  const { db, record, observation } = fixture()
  db.insert(schema.platformApplyProjection).values({ ...record('apply_list'), appliedAt: '2040-01-01' }).run()
  db.insert(schema.platformBusinessProjection).values({ ...record('business_list'), appliedAt: '2041-01-01', awardBatchLabel: '2042' }).run()
  db.insert(schema.platformRecognizedProjection).values({ ...record('recognized_list'), maintenanceYear: 2043 }).run()
  observation('apply_list', { appliedAt: '2044-01-01', batch: '2045' })
  observation('business_list', { appliedAt: '2046-01-01', awardBatchLabel: '2047' })
  for (const source of ['declarations', 'business-processes', 'recognized-directory']) for (const view of ['records', 'isolated']) expect(readPlatformFilterOptions({ source, view }, db)).toEqual(empty)
})

it('strict query validation rejects missing unknown repeated empty and non-string parameters', () => {
  for (const input of [{}, { source: '' }, { source: 'apply_list' }, { source: ['declarations'] }, { source: 'declarations', view: '' }, { source: 'declarations', view: 'other' }, { source: 'declarations', view: ['records'] }, { source: 'declarations', year: '2024' }, { source: 'declarations', sourceExtra: true }, null]) expect(() => platformFilterOptionsQueryFromQuery(input)).toThrow(expect.objectContaining({ statusCode: 400 }))
  expect(platformFilterOptionsQueryFromQuery({ source: 'declarations' })).toEqual({ source: 'declarations', view: 'records' })
})

it('h3 route reads publicly with no-store and returns direct DTO while invalid queries return 400', async () => {
  const { db, record } = fixture()
  db.insert(schema.platformBusinessProjection).values({ ...record('business_list'), businessYear: 2025, status: 'public-status' }).run()
  const useDb = vi.fn(() => db)
  vi.doMock('@db', () => ({ useDb }))
  const handler = (await import('../server/api/platform/filter-options.get')).default
  const request = toWebHandler(createApp().use('/api/platform/filter-options', handler))
  const response = await request(new Request('http://localhost/api/platform/filter-options?source=business-processes'))
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toEqual({ ...empty, years: [2025], statuses: ['public-status'] })
  expect(useDb).toHaveBeenCalledTimes(1)
  for (const query of ['', 'source=bad', 'source=business-processes&view=', 'source=business-processes&view=records&view=isolated', 'source=business-processes&source=declarations', 'source=business-processes&page=2']) {
    const bad = await request(new Request(`http://localhost/api/platform/filter-options?${query}`))
    expect(bad.status).toBe(400)
    expect(bad.headers.get('cache-control')).toBe('no-store')
  }
  expect(useDb).toHaveBeenCalledTimes(1)
})
