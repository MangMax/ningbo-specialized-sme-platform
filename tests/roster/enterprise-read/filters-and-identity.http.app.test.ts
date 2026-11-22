import { listPostgresRosterEnterprises } from '../../../layers/sme-roster/lib/roster/enterprise-list-postgres'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import { closePostgresDirectoryDb, usePostgresDirectoryDb } from '../../../db/postgresql/client'
import { enterprise as enterpriseTable, enterpriseAlias } from '../../../db/postgresql/enterprise-tables'
import { record as recordTable, recordEvent, recordEvidence } from '../../../db/postgresql/ledger-tables'
import { rosterLegacyMember } from '../../../db/postgresql/roster-selection-tables'
import { title } from '../../../db/postgresql/title-table'
import { eq, inArray } from 'drizzle-orm'
import { seedPostgresPlatformQuery } from '../../platform/fixtures/postgres-query'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, createRouter, toNodeListener, getQuery, getRouterParam, defineEventHandler, createError, setHeader } from 'h3'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'

const dir = mkdtempSync(join(tmpdir(), 'enterprise-read-http-'))
let owner: number, unrelated: number, recognized: number, failed: number
const originalRows: Record<string, string>[] = [{ original: '原行1', qymc: '原名1', tyshxydm: '91330211255994457P' }, { original: '原行2', qymc: '原名2' }]
async function seed() {
  owner = (await pgDb.insert(enterpriseTable).values({ name: '合成双称号企业', nameNorm: '合成双称号企业', usccNorm: '91330211255994457P', district: '海曙区' }).returning())[0]!.id
  unrelated = (await pgDb.insert(enterpriseTable).values({ name: '无关企业', nameNorm: '无关企业' }).returning())[0]!.id
  await pgDb.insert(rosterLegacyMember).values([{ enterpriseId: owner }, { enterpriseId: unrelated }])
  for (const [titleCode, year] of [['specialized_sme', 2022], ['little_giant', 2024]] as const) {
    const recordId = (await pgDb.insert(recordTable).values({ enterpriseId: owner, titleCode, source: 'jxj' }).returning())[0]!.id
    const eventId = (await pgDb.insert(recordEvent).values({ recordId, eventType: 'award', year, decidedYear: year, batchSeq: 1 }).returning())[0]!.id
    await pgDb.insert(recordEvidence).values({ recordEventId: eventId, sourceFile: 'synthetic.pdf', page: 3 })
    // Each synthetic source explicitly confirms batch 1 of its own originating
    // award; the 2025 publication is the conclusion year, not a new origin.
    const reviewId = (await pgDb.insert(recordEvent).values({ recordId, eventType: 'review', year, decidedYear: 2025, batchSeq: 1, reviewOutcome: 'passed' }).returning())[0]!.id
    await pgDb.insert(recordEvidence).values({ recordEventId: reviewId, sourceFile: `synthetic-review-${titleCode}.pdf`, page: 1 })
  }
  for (const [name, verificationStatus] of [['已确认旧名', 'confirmed'], ['待核旧名', 'pending']] as const) await pgDb.insert(enterpriseAlias).values({ enterpriseId: owner, name, nameNorm: name, sourceKind: 'manual', sourceRefId: 0, verificationStatus, createdAt: '2026-10-19' })
  recognized = (await seedPostgresPlatformQuery(pgDb, { interface: 'recognized_list', queryKey: '91330211255994457P', rdjb: '2', titleCode: 'specialized_sme', queriedAt: '2026-10-19T00:00:00Z', status: 'partial', rawResponse: 'Explicit synthetic original directory page',
    collectionEvidence: { source: 'queryBusList', status: 'partial', effectiveConditions: { uscc: '91330211255994457P', combination: 'and' }, titleScope: { mode: 'selected', rdjb: ['2'] }, queriedAt: '2026-10-19T00:00:00Z', completedAt: '2026-10-19T00:00:01Z', rows: originalRows, pages: [{ source: 'queryBusList', rdjb: '2', page: 4, status: 'success', fetchedCount: 2, declaredTotal: null, error: null }], fetchedCount: 2, declaredTotal: null, completeness: 'partial', fullRange: false, unfinished: [{ source: 'queryBusList', rdjb: '2', page: 5 }], error: null, limits: { pageSize: 50, maxRequests: 100, maxRows: 5000, maxDurationMs: 60000 } },
    relations: originalRows.map((rawFields, index) => ({ sequenceNo: index + 1, enterpriseId: index === 0 ? owner : null, nameRaw: rawFields.qymc, usccRaw: 'tyshxydm' in rawFields ? rawFields.tyshxydm : null, rawFields })) })).queryId
  failed = (await seedPostgresPlatformQuery(pgDb, { interface: 'apply_list', queryKey: 'name:合成双称号企业', queriedAt: '2026-10-18', status: 'failed', failureReason: 'synthetic failure', rawResponse: 'Explicit synthetic failed capture' })).queryId
  await seedPostgresPlatformQuery(pgDb, { interface: 'business_list', queryKey: 'unrelated', queriedAt: '2026-10-19', status: 'success', rawResponse: '原文'.repeat(1_000_000), relations: [{ sequenceNo: 1, enterpriseId: unrelated, rawFields: { original: 'unrelated source row' } }] })
}
let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
let pgDb: ReturnType<typeof usePostgresDirectoryDb>
let server: ReturnType<typeof createServer>, base: string
beforeAll(async () => {
  postgres = await postgresRuntimeFixture({ dir })
  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', postgres.url)
  vi.stubEnv('NUXT_DB_READONLY', '0')
  pgDb = usePostgresDirectoryDb()
  await seed()
  for (const [name, value] of Object.entries({ defineEventHandler, getQuery, getRouterParam, createError, setHeader })) vi.stubGlobal(name, value)
  const list = (await import('../../../layers/sme-roster/server/api/roster/enterprises.get')).default
  const detail = (await import('../../../layers/sme-roster/server/api/roster/enterprises/[id].get')).default
  server = createServer(toNodeListener(createApp({ debug: false }).use(createRouter().get('/api/roster/enterprises', list).get('/api/roster/enterprises/:id', detail))))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
}, 60_000)
afterAll(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); await closePostgresDirectoryDb(); postgres?.close(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }) })
it('HTTP list keeps filters, same-title recognition, counts, stable deep pages and confirmed alias search without decoding unrelated archives', async () => {
  const response = await fetch(`${base}/api/roster/enterprises?q=已确认旧名&pageSize=1`)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ counts: { total: 1, titlePairs: 2, recognitionPairs: 2, differences: 2 }, rows: [{ enterpriseId: owner, titles: ['little_giant', 'specialized_sme'], aliasNames: ['已确认旧名'], nextReviewYear: 2028, anchorNeedsReview: false, firstRecognition: [{ titleCode: 'little_giant', year: 2024 }, { titleCode: 'specialized_sme', year: 2022 }] }] })
  for (const query of ['q=待核旧名', 'title=little_giant&firstYear=2022', 'source=jxj&eventType=award&year=2025']) expect(await (await fetch(`${base}/api/roster/enterprises?${query}`)).json()).toMatchObject({ counts: { total: 0 }, rows: [] })
  expect(await (await fetch(`${base}/api/roster/enterprises?q=合成&sort=name&page=2&pageSize=1`)).json()).toMatchObject({ counts: { total: 1 }, page: 2, rows: [] })
})
it.each([
  { id: 'legacy-origin-and-batch', legacy: true, patch: {} },
  { id: 'missing-review-origin', legacy: false, patch: { year: null } },
  { id: 'missing-review-batch', legacy: false, patch: { batchSeq: null } },
  { id: 'missing-review-conclusion-year', legacy: false, patch: { decidedYear: null } },
  { id: 'missing-review-outcome', legacy: false, patch: { reviewOutcome: null } },
])('HTTP list retains both titles and their histories with no definite due for $id', async ({ id, legacy, patch }) => {
  const name = `issue337-${id}`
  const enterprise = (await pgDb.insert(enterpriseTable).values({ name, nameNorm: name }).returning())[0]!
  await pgDb.insert(rosterLegacyMember).values({ enterpriseId: enterprise.id })
  const events = []
  const evidence = []
  try {
    for (const [titleCode, year] of [['specialized_sme', 2022], ['little_giant', 2024]] as const) {
      const record = (await pgDb.insert(recordTable).values({ enterpriseId: enterprise.id, titleCode, source: 'jxj', nameRaw: name }).returning())[0]!
      const award = (await pgDb.insert(recordEvent).values({ recordId: record.id, eventType: 'award', year, decidedYear: year, batchSeq: legacy ? null : 1 }).returning())[0]!
      const review = (await pgDb.insert(recordEvent).values({ recordId: record.id, eventType: 'review', year: legacy ? 2025 : year, decidedYear: 2025, batchSeq: legacy ? null : 1, reviewOutcome: 'passed', ...patch }).returning())[0]!
      events.push(award, review)
      for (const event of legacy ? [award] : [award, review]) evidence.push((await pgDb.insert(recordEvidence).values({ recordEventId: event.id, sourceFile: `issue337/${id}-${titleCode}.pdf`, page: 1 }).returning())[0]!)
    }
    const response = await fetch(`${base}/api/roster/enterprises?q=${name}&pageSize=1`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ counts: { total: 1, titlePairs: 2, recognitionPairs: 2, differences: 2 }, rows: [{ enterpriseId: enterprise.id, titles: ['little_giant', 'specialized_sme'], nextReviewYear: null, anchorNeedsReview: true, firstRecognition: [{ titleCode: 'little_giant', year: 2024 }, { titleCode: 'specialized_sme', year: 2022 }] }] })
    const detailResponse = await fetch(`${base}/api/roster/enterprises/${enterprise.id}`)
    expect(detailResponse.status).toBe(200)
    const detail = await detailResponse.json()
    expect(detail.events).toEqual(events.map(({ id, recordId, eventType, year, batchSeq, decidedYear, reviewOutcome }) => ({ id, recordId, eventType, year, batchSeq, decidedYear, reviewOutcome })))
    expect(detail.evidence).toEqual(evidence.map(({ id, recordEventId, sourceFile, attachment, listNo, page }) => ({ id, eventId: recordEventId, sourceFile, attachment, listNo, page })))
    expect(detail.records).toHaveLength(2)
    for (const record of detail.records) expect(record.lifecycle).toMatchObject({ state: 'none', needsReview: true, dueYear: null })
  } finally {
    await pgDb.delete(recordTable).where(eq(recordTable.enterpriseId, enterprise.id))
    await pgDb.delete(enterpriseTable).where(eq(enterpriseTable.id, enterprise.id))
  }
})
it('HTTP filtered list scopes title counts to matched enterprises despite unrelated evidence pointers', async () => {
  const record = (await pgDb.insert(recordTable).values({ enterpriseId: unrelated, titleCode: 'innovative_sme', source: 'jxj' }).returning())[0]!
  const event = (await pgDb.insert(recordEvent).values({ recordId: record.id, eventType: 'award', year: 2020 }).returning())[0]!
  await pgDb.insert(recordEvidence).values({ recordEventId: event.id, sourceFile: `unrelated-pointer-${'x'.repeat(4096)}.pdf` })

  try {
    const response = await fetch(`${base}/api/roster/enterprises?q=已确认旧名&pageSize=1`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ counts: { total: 1, titlePairs: 2, recognitionPairs: 2, differences: 2 }, rows: [{ enterpriseId: owner, nextReviewYear: 2028 }] })
  } finally { await pgDb.delete(recordTable).where(eq(recordTable.id, record.id)) }
})
it('HTTP detail keeps Unicode identity normalization', async () => {
  const [identity] = await pgDb.insert(enterpriseTable).values({ name: '控制符测试企业', nameNorm: '控制符测试企业', usccNorm: 'XSS' }).returning()
  const query = { id: (await seedPostgresPlatformQuery(pgDb, { interface: 'apply_list', queryKey: 'xß', queriedAt: '2026-10-19', status: 'failed', rawResponse: 'Explicit synthetic identity lookup' })).queryId }
  try {
    const response = await fetch(`${base}/api/roster/enterprises/${identity!.id}`)
    expect(response.status).toBe(200)
    expect((await response.json()).platform.queries.map((q: any) => q.id)).toEqual([query.id])
  } finally {
    await pgDb.delete(enterpriseTable).where(eq(enterpriseTable.id, identity!.id))
  }
})
it('Enterprise search keeps malformed UTF-16 distinct from stored replacement characters', async () => {
  const identity = (await pgDb.insert(enterpriseTable).values({ name: '替换\uFFFD企业', nameNorm: '替换\uFFFD企业', district: '替换\uFFFD属地' }).returning())[0]!
  await pgDb.insert(rosterLegacyMember).values({ enterpriseId: identity.id })
  try {
    expect((await listPostgresRosterEnterprises(pgDb, { q: '\uD800' })).rows).toEqual([])
    expect((await listPostgresRosterEnterprises(pgDb, { district: '替换\uD800属地' })).rows).toEqual([])
    expect((await listPostgresRosterEnterprises(pgDb, { q: '\uFFFD' })).rows.map(row => row.enterpriseId)).toEqual([identity.id])
  } finally { await pgDb.delete(enterpriseTable).where(eq(enterpriseTable.id, identity.id)) }
})
it('Enterprise search matches either UTF-16 half in supplementary names, confirmed aliases and USCC without replacement false positives', async () => {
  const inputs = [
    { name: '正名𠀀企业', nameNorm: '正名𠀀企业' },
    { name: '别名匹配企业', nameNorm: '别名匹配企业' },
    { name: '统代匹配企业', nameNorm: '统代匹配企业', usccNorm: 'SYN𠀀84' },
    { name: '待核别名企业', nameNorm: '待核别名企业' },
    { name: '替换\uFFFD对照', nameNorm: '替换\uFFFD对照' },
  ]
  const identities = (await pgDb.insert(enterpriseTable).values(inputs).returning({ id: enterpriseTable.id })).map(row => row.id)
  await pgDb.insert(rosterLegacyMember).values(identities.map(enterpriseId => ({ enterpriseId })))
  for (const [index, verificationStatus] of [[1, 'confirmed'], [3, 'pending']] as const) await pgDb.insert(enterpriseAlias).values({ enterpriseId: identities[index]!, name: '旧名𠀀', nameNorm: '旧名𠀀', sourceKind: 'manual', sourceRefId: 0, verificationStatus, createdAt: '2026-10-19' })
  try {
    for (const q of ['𠀀', '\uD840', '\uDC00']) {
      const result = await listPostgresRosterEnterprises(pgDb, { q })
      expect(result.counts.total).toBe(3)
      expect(result.rows.map(row => row.enterpriseId).sort((a, b) => a - b)).toEqual(identities.slice(0, 3))
    }
    expect((await listPostgresRosterEnterprises(pgDb, { q: '\uD841' })).rows).toEqual([])
    expect((await listPostgresRosterEnterprises(pgDb, { q: '\uDC01' })).rows).toEqual([])
    expect((await listPostgresRosterEnterprises(pgDb, { q: '\uFFFD' })).rows.map(row => row.enterpriseId)).toEqual([identities[4]])
  } finally {
    await pgDb.delete(enterpriseTable).where(inArray(enterpriseTable.id, identities))
  }
})
it('HTTP SQL selection preserves first-award ties, pending years, same-event filters and terminated lifecycle', async () => {
  const identities = (await pgDb.insert(enterpriseTable).values(['A','B','C'].map(label => ({
    name: `汇总边界${label}`, nameNorm: `汇总边界${label}`, usccNorm: `BOUND84${label}`,
  }))).returning({ id: enterpriseTable.id })).map(row => row.id)
  await pgDb.insert(rosterLegacyMember).values(identities.map(enterpriseId => ({ enterpriseId })))
  const [a, b, c] = identities as [number, number, number]
  const record = async (enterpriseId: number, titleCode: string, source: 'jxj' | 'miit' = 'jxj') => (await pgDb.insert(recordTable).values({ enterpriseId, titleCode, source }).returning())[0]!.id
  const award = async (recordId: number, year: number | null, evidence: boolean, decidedYear = year) => {
    const id = (await pgDb.insert(recordEvent).values({ recordId, eventType: 'award', year, decidedYear }).returning())[0]!.id
    if (evidence) await pgDb.insert(recordEvidence).values({ recordEventId: id, sourceFile: 'boundary.pdf', page: 1 })
    return id
  }
  const early = await award(await record(a, 'specialized_sme'), 2020, false, 2021)
  const aPlatform = await record(a, 'specialized_sme', 'miit')
  await award(aPlatform, 2021, true)
  await award(await record(a, 'innovative_sme'), 2019, true)
  await pgDb.insert(recordEvent).values({ recordId: aPlatform, eventType: 'review', year: 2024, decidedYear: 2024, reviewOutcome: 'passed' })
  await award(await record(b, 'little_giant'), null, true)
  const cRecord = await record(c, 'specialized_sme')
  await award(cRecord, 2020, true, 2022)
  await pgDb.insert(recordEvent).values({ recordId: cRecord, eventType: 'review', year: 2025, decidedYear: 2025, reviewOutcome: 'failed' })
  const list = async (query: string) => (await fetch(`${base}/api/roster/enterprises?q=汇总边界&${query}`)).json()
  try {
    const result = await list('pageSize=10')
    expect(result.rows.map((row: any) => row.enterpriseId)).toEqual([c, a, b])
    expect(result.counts).toMatchObject({ total: 3, titlePairs: 4, recognitionPairs: 4, differences: 3 })
    expect(result.rows[0]).toMatchObject({ nextReviewYear: null, firstRecognition: [{ year: 2022, status: 'confirmed' }] })
    expect(result.rows[1].firstRecognition.find((entry: any) => entry.titleCode === 'specialized_sme')).toMatchObject({ year: 2021, firstEventId: early, status: 'pending', pendingReason: 'no_evidence' })
    expect(await list('title=specialized_sme&firstYear=2021&firstStatus=pending')).toMatchObject({ counts: { total: 1, titlePairs: 2, recognitionPairs: 1 }, rows: [{ enterpriseId: a }] })
    expect(await list('title=little_giant&firstStatus=pending')).toMatchObject({ rows: [{ enterpriseId: b, firstRecognition: [{ year: null, pendingReason: 'no_dated_award' }] }] })
    expect(await list('source=jxj&eventType=review&year=2024')).toMatchObject({ counts: { total: 0 }, rows: [] })
    expect(await list('source=miit&eventType=review&year=2024')).toMatchObject({ counts: { total: 1 }, rows: [{ enterpriseId: a }] })
  } finally {
    await pgDb.delete(recordTable).where(inArray(recordTable.enterpriseId, identities))
    await pgDb.delete(enterpriseTable).where(inArray(enterpriseTable.id, identities))
  }
})
it('HTTP detail scopes identity and record evidence but preserves recognized unmatched rows, failures, original JSON and source positions', async () => {
  // Unrelated identity JSON also cannot be loaded by the detail path.
  await pgDb.update(enterpriseTable).set({ qualityFlags: '{invalid unrelated identity' }).where(eq(enterpriseTable.id, unrelated))
  try {
    const response = await fetch(`${base}/api/roster/enterprises/${owner}`)
    expect(response.status).toBe(200)
    const detail = await response.json()
    expect(detail.records).toHaveLength(2)
    expect(detail.events).toHaveLength(4)
    expect(detail.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ sourceFile: 'synthetic.pdf', page: 3 })]))
    expect(detail.aliases).toHaveLength(2)
    expect(detail.platform.queries.map((q: any) => [q.id, q.status, q.relationCount])).toEqual([[failed, 'failed', 0], [recognized, 'partial', 2]])
    expect(detail.platform.relations.map((r: any) => [r.sequenceNo, r.enterpriseId, r.rawFields, r.sourcePage])).toEqual([[1, owner, originalRows[0], 4], [2, null, originalRows[1], 4]])
  } finally { await pgDb.update(enterpriseTable).set({ qualityFlags: null }).where(eq(enterpriseTable.id, unrelated)) }
  expect((await fetch(`${base}/api/roster/enterprises/999999`)).status).toBe(404)
  expect((await fetch(`${base}/api/roster/enterprises/invalid`)).status).toBe(400)
})
it('keeps unknown reference titles through the generic aggregate instead of dropping them from compact counts', async () => {
  await pgDb.insert(title).values({ code: 'synthetic_extra', nameZh: '合成额外称号', level: 'municipal', rank: 99 })
  const enterprise = (await pgDb.insert(enterpriseTable).values({ name: '额外称号企业', nameNorm: '额外称号企业' }).returning())[0]!
  await pgDb.insert(rosterLegacyMember).values({ enterpriseId: enterprise.id })
  const record = (await pgDb.insert(recordTable).values({ enterpriseId: enterprise.id, titleCode: 'synthetic_extra', source: 'jxj' }).returning())[0]!
  await pgDb.insert(recordEvent).values({ recordId: record.id, eventType: 'award', year: 2024 })
  try {
    const response = await fetch(`${base}/api/roster/enterprises?q=额外称号企业`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ counts: { total: 1, titlePairs: 1, recognitionPairs: 1, differences: 0, titles: { synthetic_extra: 1 } }, rows: [{ titles: ['synthetic_extra'] }] })
  } finally {
    await pgDb.delete(recordEvent).where(eq(recordEvent.recordId, record.id))
    await pgDb.delete(recordTable).where(eq(recordTable.id, record.id))
    await pgDb.delete(enterpriseTable).where(eq(enterpriseTable.id, enterprise.id))
    await pgDb.delete(title).where(eq(title.code, 'synthetic_extra'))
  }
})
