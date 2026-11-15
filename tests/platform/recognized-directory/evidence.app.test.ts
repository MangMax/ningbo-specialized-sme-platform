import { executeNativeImport } from '../../roster/imports/fixtures/import-server'
import { importExecutor } from '../../../server/utils/import-execution'
import * as readerLocation from '../../../server/utils/enterprise-read-worker-location'
import { createEnterpriseReadProcess } from '../../../server/utils/enterprise-read-process'
import { enterpriseReads } from '../../../server/utils/enterprise-read'
import { initializeDb } from '../../../db/client'
import { assertEnterpriseDetailSnapshotEqual } from '../../roster/assertions/enterprise-detail-snapshot'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { schema } from '../../../db'
import { createRosterImportClient } from '../../../lib/roster-import-client'
import type { PlatformLiveQueryResult } from '../../../lib/platform/live-query'
import { runPlatformLiveQuery } from '../../../server/utils/platform-live-query'
import { startEvidenceServer } from '../fixtures/evidence-server'
import { getRosterEnterpriseDetail } from '../../../lib/roster/enterprise-roster'

const dir = mkdtempSync(join(tmpdir(), 'recognized-evidence-'))
const db = initializeDb({ create: true, dbPath: join(dir, 'test.sqlite') })
const USCC = '913300000000000004'
const time = '2025-02-03T01:02:03.000Z'
const token = 'synthetic-recognized-import-token'
let api: Awaited<ReturnType<typeof startEvidenceServer>>
let client: ReturnType<typeof createRosterImportClient>
beforeAll(async () => {
  vi.spyOn(importExecutor, 'execute').mockImplementation(executeNativeImport)
  // Exercise the packaged real reader; source transpilation is not part of this business contract.
  vi.spyOn(readerLocation, 'createEnterpriseWorker').mockImplementation(() => createEnterpriseReadProcess(new URL('../../../.output/server/enterprise-read-worker.mjs', import.meta.url)))
  await enterpriseReads.start()
  vi.stubEnv('NUXT_DB_PATH', join(dir, 'test.sqlite'))
  vi.stubGlobal('setHeader', () => {})
  vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
  vi.stubGlobal('getQuery', (event: any) => event.query)
  vi.stubGlobal('createError', (opts: any) => Object.assign(new Error(opts.statusMessage), opts))
  vi.stubGlobal('useRuntimeConfig', () => ({ filesDir: dir, curatedPath: join(dir, 'absent-curated.json'), reconcilePath: join(dir, 'absent-reconcile.json') }))
  const queriesRoute = (await import('../../../server/api/platform/queries.get')).default
  const comparisonRoute = (await import('../../../server/api/comparison.get')).default
  const { handleComparisonScopeProofRequest } = await import('../../../server/utils/comparison-scope-proof-api')
  const { parseUploadDeclaration, registerStoredFile } = await import('../../../server/utils/stored-files-upload')
  const { parseRecordComparisonQuery } = await import('../../../lib/roster/record-comparison')
  const { getRecordComparison } = await import('../../../server/utils/record-comparison')
  const { resolveVerifiedComparisonEvidence } = await import('../../../server/utils/comparison-scope-proof')
  api = await startEvidenceServer({ db, apiToken: token, routes: {
    '/api/files/register': async req => { const registered = await registerStoredFile(db, dir, parseUploadDeclaration(req.body)); return { status: registered.created ? 201 : 200, body: registered.row } },
    '/api/roster/comparison-scope-proofs/preflight': req => handleComparisonScopeProofRequest({ action: 'preflight', method: req.method, body: req.body, headers: req.headers }, { db, apiToken: token }),
    '/api/roster/comparison-scope-proofs/commit': req => handleComparisonScopeProofRequest({ action: 'commit', method: req.method, body: req.body, headers: req.headers }, { db, apiToken: token }),
    '/api/platform/query': async req => ({ status: 200, body: await runPlatformLiveQuery(req.body, {
      cookie: 'session=synthetic-recognized-session', transport: { fetchImpl: async (_url, init) => {
        const form = new URLSearchParams(init.body)
        const page = Number(form.get('pageNum')); const rdjb = form.get('rdjb')
        const count = rdjb === '1' ? 2 : 1
        return { ok: true, status: 200, text: async () => JSON.stringify({ zrarData: { grid: { businessGrid: { page, pageSize: 1, maxCount: count, maxPage: count, pageSet: [{ id: 'shared-live-id', tyshxydm: USCC, qymc: '合成实时企业', whpcyear: '2024', whpc: '2', rddqrq: '2027', szq: '原始属地' }] } } } }) }
      } },
    }) }),
  }, getRoutes: {
    '/api/comparison': url => comparisonRoute({ query: Object.fromEntries(url.searchParams) } as never),
    '/api/platform/queries': url => queriesRoute({ query: Object.fromEntries(url.searchParams) } as never),
    '/api/roster/record-comparison': url => { const input = parseRecordComparisonQuery(Object.fromEntries(url.searchParams)); return getRecordComparison(db, input, resolveVerifiedComparisonEvidence(db, input.proofIds ?? [], input)) },
  } })
  client = createRosterImportClient({ baseUrl: api.baseUrl, token })
})
afterAll(async () => { await api?.close(); await enterpriseReads.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); db.$client.close(); rmSync(dir, { recursive: true, force: true }) })
function archive(): PlatformLiveQueryResult {
  return {
    source: 'queryBusList', status: 'success',
    effectiveConditions: { uscc: USCC, combination: 'and', whpcyear: '2024', whpc: '2' },
    titleScope: { mode: 'selected', rdjb: ['1', '2', '3'] }, queriedAt: time, completedAt: '2025-02-03T01:03:00.000Z',
    rows: [1, 2, 3, 4].map(n => ({ id: `same-${n % 2}`, qymc: '合成企业', tyshxydm: USCC, whpcyear: '2024', whpc: '2', rddqrq: '2027', szq: '原始属地' })),
    pages: [['1', 1, 1], ['1', 2, 1], ['2', 1, 1], ['3', 1, 1]].map(([rdjb, page, fetchedCount]) => ({ source: 'queryBusList', rdjb: String(rdjb), page: Number(page), fetchedCount: Number(fetchedCount), status: 'success', declaredTotal: null, maxPage: String(rdjb) === '1' ? 2 : 1, error: null })),
    fetchedCount: 4, declaredTotal: null, completeness: 'complete', fullRange: true, unfinished: [], error: null,
    limits: { pageSize: 1, maxRequests: 100, maxRows: 5000, maxDurationMs: 60000 },
  }
}
function titleWideArchive(): PlatformLiveQueryResult {
  const evidence = archive()
  evidence.effectiveConditions = { combination: 'and' }
  evidence.titleScope = { mode: 'selected', rdjb: ['2'] }
  evidence.pages = [{ source: 'queryBusList', rdjb: '2', page: 1, status: 'success', fetchedCount: 1, declaredTotal: 1, maxPage: 1, error: null }]
  evidence.rows = evidence.rows.slice(0, 1)
  evidence.fetchedCount = 1
  evidence.declaredTotal = 1
  evidence.queriedAt = '2026-10-18T02:24:00.000Z'
  evidence.completedAt = '2026-10-18T02:25:00.000Z'
  return evidence
}
function request(result = archive(), key = 'archive-complete') {
  return {
    idempotencyKey: key, sourceKind: 'alias_evidence' as const, sourceIdentity: 'synthetic-archive',
    payload: { platformQueries: [{ interface: 'recognized_list', queryKey: USCC, rdjb: result.titleScope.rdjb.join(','), titleCode: result.titleScope.rdjb.length === 1 ? { '1': 'innovative_sme', '2': 'specialized_sme', '3': 'little_giant' }[result.titleScope.rdjb[0]!] : null, queriedAt: result.queriedAt, status: result.status, collectionEvidence: result,
      relations: result.rows.map((rawFields, i) => ({ sequenceNo: i + 1, relationKey: rawFields.id, usccRaw: rawFields.tyshxydm, nameRaw: rawFields.qymc, rawFields })),
    }] },
  }
}
it('authenticated archive import preserves three-title pages, every same-code row, source identity and original time through public history', async () => {
  const req = request()
  const unauthorized = await fetch(`${api.baseUrl}/api/roster/import/commit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) })
  expect(unauthorized.status).toBe(401)
  const preflight = await client.preflight(req as never)
  expect(preflight.preflight.conflicts).toEqual([])
  expect((await fetch(`${api.baseUrl}/api/platform/queries`)).ok).toBe(true)
  expect((await (await fetch(`${api.baseUrl}/api/platform/queries`)).json()).total).toBe(0)
  const saved = await client.commit(req as never)
  expect(saved.status).toBe('committed')
  const read = await (await fetch(`${api.baseUrl}/api/platform/queries?interface=recognized_list&queryKey=${USCC}`)).json()
  expect(read.total).toBe(1)
  expect(read.rows[0].query).toMatchObject({ interface: 'recognized_list', queriedAt: time, relationCount: 4, collectionEvidence: archive() })
  expect(read.rows[0].relations.map((r: any) => [r.sequenceNo, r.sourceRdjb, r.sourcePage])).toEqual([[1, '1', 1], [2, '1', 2], [3, '2', 1], [4, '3', 1]])
  expect(read.rows[0].relations.map((r: any) => r.rawFields)).toEqual(archive().rows)
  const detail = saved.items.find((i: any) => i.kind === 'platform_query')!.detail!
  expect(detail.relations).toEqual(read.rows[0].relations.map((r: any) => r.id))
})

it('rejects missing provenance, false complete/zero claims, wrong source, row mapping and original time without any business writes', async () => {
  const invalid: Array<(r: any) => void> = [
    r => { delete r.payload.platformQueries[0].collectionEvidence },
    r => { r.payload.platformQueries[0].collectionEvidence.source = 'businessList' },
    r => { r.payload.platformQueries[0].collectionEvidence.completedAt = '' },
    r => { r.payload.platformQueries[0].interface = 'business_list' },
    r => { r.payload.platformQueries[0].relations[0].year = 2024 },
    r => { r.payload.platformQueries[0].collectionEvidence.unfinished = [{ source: 'queryBusList', rdjb: '3', page: 2 }] },
    r => { r.payload.platformQueries[0].collectionEvidence.pages.pop() },
    r => { for (const p of r.payload.platformQueries[0].collectionEvidence.pages) delete p.maxPage },
    r => { r.payload.platformQueries[0].relations[0].rawFields = { qymc: '伪造' } },
    r => { r.payload.platformQueries[0].status = 'no_record' },
    r => { r.payload.platformQueries[0].queriedAt = '2026-01-01T00:00:00Z' },
  ]
  for (const [i, mutate] of invalid.entries()) {
    const evidence = archive(); evidence.queriedAt = `2023-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`; evidence.completedAt = `2023-01-${String(i + 1).padStart(2, '0')}T00:01:00Z`
    const req = request(evidence, `invalid-${i}`); mutate(req)
    const result = await client.preflight(req as never)
    expect(result.preflight.conflicts.length, `case ${i}`).toBeGreaterThan(0)
    const committed = await client.commit(req as never)
    expect(committed.status).toBe('failed')
  }
  const read = await (await fetch(`${api.baseUrl}/api/platform/queries?interface=recognized_list`)).json()
  expect(read.total).toBe(1)
})

it('archives complete zero, partial, login failure and not queried separately, with title filtering and historical pagination', async () => {
  const { recognizedResultToImport } = await import('../../../lib/platform/recognized-evidence')
  const zero = archive()
  zero.queriedAt = '2024-01-01T00:00:00Z'; zero.completedAt = '2024-01-01T00:01:00Z'
  zero.status = 'no_record'; zero.rows = []; zero.fetchedCount = 0; zero.declaredTotal = 0
  zero.pages = ['1', '2', '3'].map(rdjb => ({ source: 'queryBusList', rdjb, page: 1, status: 'success', fetchedCount: 0, declaredTotal: 0, error: null }))
  const partial = archive()
  partial.queriedAt = '2024-02-01T00:00:00Z'; partial.completedAt = '2024-02-01T00:01:00Z'
  partial.status = 'partial'; partial.completeness = 'partial'; partial.rows = partial.rows.slice(0, 1); partial.pages = partial.pages.slice(0, 1); partial.fetchedCount = 1
  partial.unfinished = [{ source: 'queryBusList', rdjb: '1', page: 2 }, { source: 'queryBusList', rdjb: '2', page: 1 }, { source: 'queryBusList', rdjb: '3', page: 1 }]
  const failed = structuredClone(partial)
  failed.queriedAt = '2024-03-01T00:00:00Z'; failed.completedAt = '2024-03-01T00:01:00Z'
  failed.status = 'auth_failed'; failed.rows = []; failed.fetchedCount = 0
  failed.error = { code: 'auth_failed', message: '合成登录页失效' }
  failed.pages = [{ source: 'queryBusList', rdjb: '1', page: 1, status: 'auth_failed', fetchedCount: 0, declaredTotal: null, error: failed.error }]
  failed.unfinished[0]!.page = 1
  const notQueried = structuredClone(failed)
  notQueried.queriedAt = '2024-04-01T00:00:00Z'; notQueried.completedAt = '2024-04-01T00:01:00Z'
  notQueried.status = 'not_queried'; notQueried.completeness = 'not_queried'; notQueried.pages = []; notQueried.error = null
  for (const [index, evidence] of [zero, partial, failed, notQueried].entries()) {
    const req = { ...request(evidence, `state-${index}`), payload: { platformQueries: [recognizedResultToImport(evidence)] } }
    expect((await client.preflight(req)).preflight.conflicts).toEqual([])
    expect((await client.commit(req)).status).toBe('committed')
  }
  const read = await (await fetch(`${api.baseUrl}/api/platform/queries?interface=recognized_list&titleCode=little_giant&uscc=${USCC}&pageSize=2`)).json()
  expect(read.total).toBe(5)
  expect(read.rows).toHaveLength(2)
  expect(read.counts).toEqual({ success: 1, no_record: 1, partial: 1, failed: 1, not_queried: 1 })
  const zeroRead = await (await fetch(`${api.baseUrl}/api/platform/queries?interface=recognized_list&status=no_record`)).json()
  expect(zeroRead.rows[0].query.collectionEvidence).toEqual(zero)
  expect(zeroRead.rows[0].relations).toEqual([])
  const bad = request(structuredClone(partial), 'partial-as-zero')
  bad.payload.platformQueries[0]!.status = 'no_record'
  expect((await client.preflight(bad as never)).preflight.conflicts.length).toBeGreaterThan(0)
})

it('same natural identity replays idempotently, conflicting archive cannot mutate history, and a transaction failure rolls back all query rows', async () => {
  const req = request()
  const original = await client.commit(req as never)
  expect(await client.commit(req as never)).toEqual(original)
  const otherKey = request(archive(), 'same-archive-new-key')
  expect((await client.commit(otherKey as never)).status).toBe('committed')
  const before = await (await fetch(`${api.baseUrl}/api/platform/queries?interface=recognized_list`)).json()
  const conflicting = request(archive(), 'changed-archive')
  conflicting.payload.platformQueries[0]!.collectionEvidence.effectiveConditions.whpc = '3'
  expect((await client.preflight(conflicting as never)).preflight.conflicts.length).toBeGreaterThan(0)
  expect((await client.commit(conflicting as never)).status).toBe('failed')
  const failed = archive(); failed.queriedAt = '2025-06-01T00:00:00Z'; failed.completedAt = '2025-06-01T00:01:00Z'
  // Synthetic storage failure at the write boundary; outcome is checked through public reads.
  db.$client.exec("CREATE TRIGGER synthetic_import_failure BEFORE INSERT ON platform_business_observation BEGIN SELECT RAISE(ABORT, 'synthetic transaction failure'); END")
  try { expect((await client.commit(request(failed, 'rollback') as never)).status).toBe('failed') }
  finally { db.$client.exec('DROP TRIGGER synthetic_import_failure') }
  const after = await (await fetch(`${api.baseUrl}/api/platform/queries?interface=recognized_list`)).json()
  expect(after).toEqual(before)
})

it('MCP history and enterprise detail match REST, preserve cross-source identical IDs, and evidence never changes enterprise records or decisions implicitly', async () => {
  const { recognizedResultToImport } = await import('../../../lib/platform/recognized-evidence')
  const seed = await client.commit({ idempotencyKey: 'seed-enterprise', sourceKind: 'announcement', sourceIdentity: 'synthetic-seed', payload: { announcement: {
    sourceDocument: { source: 'jxj', title: '合成种子' }, records: [{ enterprise: { name: '合成主档', uscc: USCC }, titleCode: 'innovative_sme', events: [{ eventType: 'award', year: 2023 }] }],
  } } })
  expect(seed.status, JSON.stringify(seed)).toBe('committed')
  const enterpriseId = seed.items.find(i => i.kind === 'record_event')!.detail!.enterpriseId as number
  const before = getRosterEnterpriseDetail(db, enterpriseId)!
  const evidence = archive(); evidence.queriedAt = '2025-07-01T00:00:00Z'; evidence.completedAt = '2025-07-01T00:01:00Z'
  const req = { ...request(evidence, 'mcp-archive'), payload: { platformQueries: [recognizedResultToImport(evidence)] } }
  vi.doMock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (definition: unknown) => definition }))
  const save = (await import('../../../server/mcp/tools/save_roster_batch')).default as any
  const preflight = (await import('../../../server/mcp/tools/preflight_roster_batch')).default as any
  expect(save.enabled({ context: { mcpAuth: { writeAuthorized: false } } })).toBe(false)
  expect(save.enabled({ context: { mcpAuth: { writeAuthorized: true } } })).toBe(true)
  expect((await preflight.handler(req)).preflight.conflicts).toEqual([])
  const committed = await save.handler(req)
  expect(committed.status).toBe('committed')
  const history = (await import('../../../server/mcp/tools/list_platform_queries')).default as any
  const input = { interface: 'recognized_list', uscc: USCC, titleCode: 'little_giant', page: 1, pageSize: 10 }
  const rest = await (await fetch(`${api.baseUrl}/api/platform/queries?${new URLSearchParams(Object.entries(input).map(([k,v]) => [k,String(v)]))}`)).json()
  expect(await history.handler(input)).toEqual(rest)
  const detailTool = (await import('../../../server/mcp/tools/get_enterprise_detail')).default as any
  const after = JSON.parse(await detailTool.handler({ enterpriseId }))
  expect(after.platform.queries.find((q: any) => q.queriedAt === evidence.queriedAt).collectionEvidence).toEqual(evidence)
  const allHistory = await (await fetch(`${api.baseUrl}/api/platform/queries?queryKey=${USCC}&pageSize=100`)).json()
  expect(after.platform.relations.map((r: any) => r.id).sort((a: number, b: number) => a-b)).toEqual(allHistory.rows.flatMap((q: any) => q.relations.map((r: any) => r.id)).sort((a: number, b: number) => a-b))
  expect(after.platform.relations[0]).toMatchObject({ sourceRdjb: '1', sourcePage: 1, rawFields: evidence.rows[0] })
  for (const key of ['enterprise', 'aliases', 'records', 'events', 'evidence'] as const) expect(after[key]).toEqual(before[key])
  // Coverage is additive read state; archival evidence must not change business decisions.
  const business = (rows: any[]) => rows.map(({ queryCoverage, currentDecision, explanationValidity, assessment, ...decision }) => decision)
  expect(business(after.differences)).toEqual(business(before.differences))
  expect(after.differences.map((d: any) => d.currentDecision)).toEqual(before.differences.map((d: any) => d.currentDecision))
  const changed = after.differences.find((d: any) => d.titleCode === 'innovative_sme')
  expect(changed.queryCoverage).toMatchObject({ status: 'partial', truncated: false, sources: expect.arrayContaining([expect.objectContaining({ interface: 'recognized_list', queriedAt: evidence.queriedAt, status: 'complete', titleCode: 'innovative_sme', outcome: 'records' })]) })
  expect(changed.assessment).toBe('unknown')
  expect(changed.explanationValidity).toEqual({ status: 'not_applicable', reasons: [], explanationId: null, evidenceQueryIds: [] })
  expect(before.differences.find((d: any) => d.titleCode === 'innovative_sme')!.queryCoverage.sources.some((s: any) => s.queriedAt === evidence.queriedAt)).toBe(false)
  const comparison = await (await fetch(`${api.baseUrl}/api/comparison?title=innovative_sme&direction=missing_in_miit`)).json()
  const comparisonQuery = comparison.rows.find((r: any) => r.enterpriseId === enterpriseId).platform.queries.find((q: any) => q.queriedAt === evidence.queriedAt)
  expect(comparisonQuery.collectionEvidence).toEqual(evidence)
  expect(comparisonQuery.relations[0]).toMatchObject({ rawFields: evidence.rows[0], sourceRdjb: '1', sourcePage: 1 })
  const legacy = { ...request(evidence, 'legacy-same-id'), payload: { platformQueries: [{ interface: 'business_list' as const, queryKey: USCC, rdjb: '1', queriedAt: evidence.queriedAt, status: 'success' as const, rawResponse: JSON.stringify(evidence.rows), relations: [{ sequenceNo: 1, relationKey: evidence.rows[0]!.id, usccRaw: USCC, nameRaw: '合成企业' }] }] } }
  const legacySaved = await client.commit(legacy)
  expect(legacySaved.status, JSON.stringify(legacySaved)).toBe('committed')
  const read = await (await fetch(`${api.baseUrl}/api/platform/queries?enterpriseId=${enterpriseId}`)).json()
  expect(read.rows.flatMap((q: any) => q.relations).filter((r: any) => r.relationKey === 'same-1')).toHaveLength(3)
  expect(new Set(read.rows.map((q: any) => q.query.interface))).toEqual(new Set(['business_list', 'recognized_list']))
})

it('explicit same-batch difference references resolve real query and row IDs while wrong source, title and subject references are rejected', async () => {
  const { recognizedResultToImport } = await import('../../../lib/platform/recognized-evidence')
  const evidence = archive(); evidence.queriedAt = '2025-08-01T00:00:00Z'; evidence.completedAt = '2025-08-01T00:01:00Z'
  const query = recognizedResultToImport(evidence)
  const ref = { interface: 'recognized_list' as const, queryKey: USCC, rdjb: '1,2,3', queriedAt: evidence.queriedAt }
  const diff = { uscc: USCC, titleCode: 'little_giant', direction: 'missing_in_miit' as const, status: 'needs_review' as const, recordedAt: '2025-08-02T00:00:00Z', evidenceQueryRef: ref, evidenceRelationRef: { ...ref, sequenceNo: 4, relationKey: 'same-0' } }
  const req = { ...request(evidence, 'explicit-difference'), payload: { platformQueries: [query], differences: [diff] } }
  expect((await client.preflight(req)).preflight.conflicts).toEqual([])
  const commit = await client.commit(req)
  expect(commit.status).toBe('committed')
  const read = await (await fetch(`${api.baseUrl}/api/platform/queries?interface=recognized_list&queryKey=${USCC}&pageSize=50`)).json()
  const row = read.rows.find((r: any) => r.query.queriedAt === evidence.queriedAt)
  const decision = commit.items.find(i => i.kind === 'difference')!.detail!
  expect(decision).toMatchObject({ evidenceQueryId: row.query.id, evidenceRelationId: row.relations[3].id })
  const wrongTitle = structuredClone(req); wrongTitle.idempotencyKey = 'wrong-title'; wrongTitle.payload.differences[0]!.evidenceRelationRef.sequenceNo = 1; wrongTitle.payload.differences[0]!.evidenceRelationRef.relationKey = 'same-1'
  expect((await client.preflight(wrongTitle)).preflight.conflicts.length).toBeGreaterThan(0)
  const wrongSource = structuredClone(req); wrongSource.idempotencyKey = 'wrong-source'; (wrongSource.payload.differences[0]!.evidenceQueryRef as any) = { interface: 'business_list', queryKey: USCC, rdjb: '1', queriedAt: '2025-07-01T00:00:00Z' }
  expect((await client.preflight(wrongSource)).preflight.conflicts.length).toBeGreaterThan(0)
  const wrongSubject = structuredClone(req); wrongSubject.idempotencyKey = 'wrong-subject'; wrongSubject.payload.platformQueries[0]!.relations![0]!.enterpriseId = 999999
  expect((await client.preflight(wrongSubject)).preflight.conflicts.length).toBeGreaterThan(0)
  const ambiguous = structuredClone(req); ambiguous.idempotencyKey = 'ambiguous'; delete (ambiguous.payload.differences[0]!.evidenceQueryRef as any).queriedAt
  expect((await client.preflight(ambiguous)).preflight.conflicts.length).toBeGreaterThan(0)
})

it('synthetic paginated public live result transfers explicitly to SQLite without a second upstream query', async () => {
  const liveResponse = await fetch(`${api.baseUrl}/api/platform/query`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'queryBusList', uscc: USCC, pageSize: 1 }) })
  const result = await liveResponse.json() as PlatformLiveQueryResult
  expect(result).toMatchObject({ status: 'success', completeness: 'complete', fetchedCount: 4, declaredTotal: 4 })
  expect(result.pages.map(p => [p.rdjb, p.page, p.maxPage])).toEqual([['1', 1, 2], ['1', 2, 2], ['2', 1, 1], ['3', 1, 1]])
  const { recognizedResultToImport } = await import('../../../lib/platform/recognized-evidence')
  const req = { ...request(result, 'live-transfer'), payload: { platformQueries: [recognizedResultToImport(result)] } }
  expect((await client.preflight(req)).preflight.conflicts).toEqual([])
  expect((await client.commit(req)).status).toBe('committed')
  const read = await (await fetch(`${api.baseUrl}/api/platform/queries?interface=recognized_list&pageSize=1`)).json()
  expect(read.rows[0].query.collectionEvidence).toEqual(result)
  expect(read.rows[0].relations).toHaveLength(4)
  expect(new Set(read.rows[0].relations.map((r: any) => r.relationKey))).toEqual(new Set(['shared-live-id']))
})

it('single-title name candidates remain unmatched and a completed continuation stays partial rather than whole-range no-record', async () => {
  const { recognizedResultToImport } = await import('../../../lib/platform/recognized-evidence')
  const candidate = archive()
  candidate.queriedAt = '2025-09-01T00:00:00Z'; candidate.completedAt = '2025-09-01T00:01:00Z'
  candidate.titleScope.rdjb = ['2']; candidate.effectiveConditions = { name: '合成主档', combination: 'and' }
  candidate.rows = [{ id: 'name-candidate', qymc: '合成主档', whpcyear: '2024' }]; candidate.fetchedCount = 1; candidate.declaredTotal = 1
  candidate.pages = [{ source: 'queryBusList', rdjb: '2', page: 1, status: 'success', fetchedCount: 1, declaredTotal: 1, maxPage: 1, error: null }]
  const req = { ...request(candidate, 'single-name-candidate'), payload: { platformQueries: [recognizedResultToImport(candidate)] } }
  expect((await client.preflight(req)).preflight.conflicts).toEqual([])
  expect((await client.commit(req)).status).toBe('committed')
  const read = await (await fetch(`${api.baseUrl}/api/platform/queries?interface=recognized_list&titleCode=specialized_sme&queryKey=${encodeURIComponent('name:合成主档')}`)).json()
  expect(read.total).toBe(1)
  expect(read.rows[0].query).toMatchObject({ titleCode: 'specialized_sme', rdjb: '2' })
  expect(read.rows[0].relations[0]).toMatchObject({ enterpriseId: null, matchBasis: 'none', verificationStatus: 'pending' })
  expect((await (await fetch(`${api.baseUrl}/api/platform/queries?queryKey=${encodeURIComponent('name:合成主档')}&titleCode=little_giant`)).json()).total).toBe(0)
  const continuation = archive()
  continuation.queriedAt = '2025-09-02T00:00:00Z'; continuation.completedAt = '2025-09-02T00:01:00Z'
  continuation.titleScope.rdjb = ['1']; continuation.rows = [continuation.rows[0]!]; continuation.fetchedCount = 1; continuation.declaredTotal = 2; continuation.fullRange = false
  continuation.pages = [{ source: 'queryBusList', rdjb: '1', page: 2, maxPage: 2, status: 'success', fetchedCount: 1, declaredTotal: 2, error: null }]
  const next = { ...request(continuation, 'continuation'), payload: { platformQueries: [recognizedResultToImport(continuation)] } }
  expect(next.payload.platformQueries[0]!.status).toBe('partial')
  expect((await client.commit(next)).status).toBe('committed')
  const history = await (await fetch(`${api.baseUrl}/api/platform/queries?interface=recognized_list&status=partial`)).json()
  expect(history.rows.find((r: any) => r.query.queriedAt === continuation.queriedAt).query.collectionEvidence).toEqual(continuation)
})

it.each(['query-ref', 'row-ref', 'query-id', 'row-id'] as const)('rejects contradictory supplied USCC through REST and MCP for recognized %s without losing valid name fallback', async (kind) => {
  const seed = await client.commit({ idempotencyKey: `subject-seed-${kind}`, sourceKind: 'announcement', sourceIdentity: 'synthetic-subject-seed', payload: { announcement: {
    sourceDocument: { source: 'jxj', title: '主体冲突合成种子' }, records: [{ enterprise: { name: '合成主档', uscc: USCC }, titleCode: 'innovative_sme', events: [{ eventType: 'award', year: 2023 }] }],
  } } })
  expect(seed.status).toBe('committed')
  const { recognizedResultToImport } = await import('../../../lib/platform/recognized-evidence')
  const evidence = archive()
  evidence.queriedAt = `2025-10-0${['query-ref', 'row-ref', 'query-id', 'row-id'].indexOf(kind) + 1}T00:00:00Z`
  evidence.completedAt = evidence.queriedAt.replace('00:00:00', '00:01:00')
  const query = recognizedResultToImport(evidence)
  const ref = { interface: 'recognized_list' as const, queryKey: USCC, rdjb: '1,2,3', queriedAt: evidence.queriedAt }
  let refs: Record<string, unknown> = kind === 'query-ref' ? { evidenceQueryRef: ref } : { evidenceRelationRef: { ...ref, sequenceNo: 4 } }
  if (kind.endsWith('-id')) {
    expect((await client.commit({ ...request(evidence, `subject-archive-${kind}`), payload: { platformQueries: [query] } })).status).toBe('committed')
    const history = await (await fetch(`${api.baseUrl}/api/platform/queries?queryKey=${USCC}&pageSize=100`)).json()
    const stored = history.rows.find((row: any) => row.query.queriedAt === evidence.queriedAt)
    refs = kind === 'query-id' ? { evidenceQueryId: stored.query.id } : { evidenceRelationId: stored.relations[3].id }
  }
  const req = { ...request(evidence, `contradictory-subject-${kind}`), payload: { platformQueries: kind.endsWith('-id') ? [] : [query], differences: [{
    enterpriseName: '合成主档', uscc: '91330200000000001H', titleCode: 'little_giant', direction: 'missing_in_miit' as const,
    status: 'needs_review' as const, recordedAt: evidence.completedAt, ...refs,
  }] } }
  const preflight = (await import('../../../server/mcp/tools/preflight_roster_batch')).default as any
  const save = (await import('../../../server/mcp/tools/save_roster_batch')).default as any
  const beforeFailure = await (await fetch(`${api.baseUrl}/api/platform/queries?queryKey=${USCC}&pageSize=100`)).json()
  const restPreflight = await client.preflight(req as never)
  expect(restPreflight.preflight.conflicts).toContainEqual(expect.objectContaining({ error: expect.objectContaining({ code: 'evidence_subject_mismatch' }) }))
  expect(await preflight.handler(req)).toEqual(restPreflight)
  expect((await client.commit(req as never)).status).toBe('failed')
  expect((await save.handler(req)).status).toBe('failed')
  expect(await (await fetch(`${api.baseUrl}/api/platform/queries?queryKey=${USCC}&pageSize=100`)).json()).toEqual(beforeFailure)
  // A missing code is different from a contradictory one: the existing exact-name master may still resolve valid evidence.
  delete (req.payload.differences[0] as any).uscc
  req.idempotencyKey = `valid-name-fallback-${kind}`
  expect((await client.preflight(req as never)).preflight.conflicts).toEqual([])
  expect((await client.commit(req as never)).status).toBe('committed')
})

it.each(['uscc', 'name'] as const)('archive-before-master %s query preserves every recognized source row in REST/MCP detail and comparison without confirming identity or exposing unrelated queries', async (subject) => {
  const { recognizedResultToImport } = await import('../../../lib/platform/recognized-evidence')
  const code = subject === 'uscc' ? '91330200000000001H' : '91330211255994457P'
  const name = subject === 'uscc' ? '合成代码归档先于主档企业' : '合成名称归档先于主档企业'
  const queryKey = subject === 'uscc' ? code : `name:${name}`
  const evidence = archive()
  evidence.effectiveConditions = subject === 'uscc' ? {uscc: code, combination: 'and'} : {name, combination: 'and'}
  evidence.rows = evidence.rows.map(row => ({ ...row, tyshxydm: subject === 'uscc' ? code : '', qymc: name }))
  const imported = await client.commit({ ...request(evidence, `before-master-archive-${subject}`), payload: { platformQueries: [recognizedResultToImport(evidence)] } })
  expect(imported.status).toBe('committed')
  const readHistory = async () => (await (await fetch(`${api.baseUrl}/api/platform/queries?interface=recognized_list&queryKey=${encodeURIComponent(queryKey)}`)).json()).rows[0]
  const archived = await readHistory()
  expect(archived.relations).toHaveLength(4)
  for (const row of archived.relations) expect(row).toMatchObject({ enterpriseId: null, matchBasis: 'none', verificationStatus: 'pending' })
  const seed = await client.commit({ idempotencyKey: `after-archive-master-${subject}`, sourceKind: 'announcement', sourceIdentity: 'synthetic-after-archive', payload: { announcement: {
    sourceDocument: { source: 'jxj', title: '归档后创建主档' }, records: [{ enterprise: { name, uscc: code }, titleCode: 'innovative_sme', events: [{ eventType: 'award', year: 2023 }] }],
  } } })
  expect(seed.status).toBe('committed')
  const enterpriseId = seed.items.find(i => i.kind === 'record_event')!.detail!.enterpriseId as number
  vi.stubGlobal('getRouterParam', (event: any) => event.id)
  const detailRoute = (await import('../../../server/api/roster/enterprises/[id].get')).default
  const restApi = await startEvidenceServer({ db, apiToken: token, getRoutes: { [`/api/roster/enterprises/${enterpriseId}`]: async () => JSON.parse((await detailRoute({ id: enterpriseId } as never)).toString('utf8')) } })
  try {
    const detail = await (await fetch(`${restApi.baseUrl}/api/roster/enterprises/${enterpriseId}`)).json()
    const detailTool = (await import('../../../server/mcp/tools/get_enterprise_detail')).default as any
    assertEnterpriseDetailSnapshotEqual(JSON.parse(await detailTool.handler({ enterpriseId })), detail)
    expect(detail.platform.queries.map((q: any) => q.id)).toEqual([archived.query.id])
    expect(detail.platform.queries[0]).toMatchObject({ relationCount: 4, collectionEvidence: evidence })
    expect(detail.platform.relations.map((r: any) => r.id)).toEqual(archived.relations.map((r: any) => r.id))
    for (const row of detail.platform.relations) expect(row).toMatchObject({ enterpriseId: null, matchBasis: 'none', verificationStatus: 'pending' })
    expect(detail.platform.relations.map((r: any) => [r.rawFields, r.sourceRdjb, r.sourcePage])).toEqual(archived.relations.map((r: any) => [r.rawFields, r.sourceRdjb, r.sourcePage]))
    const comparison = await (await fetch(`${api.baseUrl}/api/comparison?title=innovative_sme&direction=missing_in_miit`)).json()
    const platform = comparison.rows.find((r: any) => r.enterpriseId === enterpriseId).platform
    expect(platform.relationCount).toBe(4)
    expect(platform.queries.map((q: any) => q.id)).toEqual([archived.query.id])
    expect(platform.queries[0].relationCount).toBe(4)
    expect(platform.queries[0].relations.map((r: any) => r.id)).toEqual(archived.relations.map((r: any) => r.id))
    for (const row of platform.queries[0].relations) expect(row).toMatchObject({ enterpriseId: null, matchBasis: 'none', verificationStatus: 'pending' })
    expect(await readHistory()).toEqual(archived)
    expect(detail.differences).toEqual([expect.objectContaining({ explanationId: null, status: 'not_queried', reasonCode: null })])
  } finally { await restApi.close() }
})

it('imports a complete title-wide recognized archive through public preflight and commit', async () => {
  const evidence = titleWideArchive()
  const req = request(evidence, 'title-wide-complete')
  req.payload.platformQueries[0]!.queryKey = 'synthetic-title-wide-archive'
  const preflight = await client.preflight(req as never)
  expect(preflight.preflight.conflicts).toEqual([])
  expect((await client.commit(req as never)).status).toBe('committed')
  const read = await (await fetch(`${api.baseUrl}/api/platform/queries?interface=recognized_list&queryKey=synthetic-title-wide-archive`)).json()
  expect(read.total).toBe(1)
  expect(read.rows[0].query.collectionEvidence).toEqual(evidence)
  expect(read.rows[0].relations[0]).toMatchObject({ sequenceNo: 1, sourceRdjb: '2', sourcePage: 1, rawFields: evidence.rows[0] })
})
it('preserves title-wide zero and partial archives through public import', async () => {
  const { recognizedResultToImport } = await import('../../../lib/platform/recognized-evidence')
  const zero = titleWideArchive()
  zero.queriedAt = '2026-10-18T03:00:00.000Z'; zero.completedAt = '2026-10-18T03:01:00.000Z'
  zero.status = 'no_record'; zero.rows = []; zero.fetchedCount = 0; zero.declaredTotal = 0
  zero.pages = [{ source: 'queryBusList', rdjb: '2', page: 1, status: 'success', fetchedCount: 0, declaredTotal: 0, maxPage: 1, error: null }]
  const partial = titleWideArchive()
  partial.queriedAt = '2026-10-18T04:00:00.000Z'; partial.completedAt = '2026-10-18T04:01:00.000Z'
  partial.effectiveConditions = { combination: 'and', whpcyear: '2024', whpc: '2', sqsj: '2024/02/01 - 2024/02/29', orderField: 'qymc', orderDirection: 'asc' }
  partial.status = 'partial'; partial.completeness = 'partial'; partial.declaredTotal = 2
  partial.pages = [{ source: 'queryBusList', rdjb: '2', page: 1, status: 'success', fetchedCount: 1, declaredTotal: 2, maxPage: 2, error: null }]
  partial.unfinished = [{ source: 'queryBusList', rdjb: '2', page: 2 }]
  for (const [index, evidence] of [zero, partial].entries()) {
    const item = recognizedResultToImport(evidence)
    expect(item.queryKey).toMatch(/^scope:queryBusList:2:/)
    expect(item.queryKey).not.toContain('undefined')
    const req = { ...request(evidence, `title-wide-state-${index}`), payload: { platformQueries: [item] } }
    expect((await client.preflight(req)).preflight.conflicts).toEqual([])
    expect((await client.commit(req)).status).toBe('committed')
    const read = await (await fetch(`${api.baseUrl}/api/platform/queries?interface=recognized_list&queryKey=${encodeURIComponent(item.queryKey)}`)).json()
    expect(read.rows.find((row: any) => row.query.queriedAt === evidence.queriedAt).query.collectionEvidence).toEqual(evidence)
  }
})
it('rejects malformed title-wide conditions, title scope and page proof through public preflight and commit', async () => {
  const invalid: Array<(evidence: PlatformLiveQueryResult) => void> = [
    evidence => { (evidence.effectiveConditions as any).unexpectedFilter = '1' },
    evidence => { evidence.effectiveConditions.sqsj = '2026/02/30 - 2026/03/01' },
    evidence => { evidence.effectiveConditions.whpc = '2' },
    evidence => { evidence.effectiveConditions.orderField = 'qymc' },
    evidence => { evidence.titleScope.rdjb = ['2', '2'] },
    evidence => { evidence.pages[0]!.page = 2 },
    evidence => { evidence.pages[0]!.fetchedCount = 2 },
  ]
  for (const [index, mutate] of invalid.entries()) {
    const evidence = titleWideArchive()
    evidence.queriedAt = `2026-10-19T${String(index).padStart(2, '0')}:00:00.000Z`
    evidence.completedAt = `2026-10-19T${String(index).padStart(2, '0')}:01:00.000Z`
    mutate(evidence)
    const req = request(evidence, `title-wide-invalid-${index}`)
    req.payload.platformQueries[0]!.queryKey = `synthetic-title-wide-invalid-${index}`
    const plan = await client.preflight(req as never)
    expect(plan.preflight.conflicts.length, `case ${index}`).toBeGreaterThan(0)
    expect((await client.commit(req as never)).status, `case ${index}`).toBe('failed')
  }
})
it('a publicly saved title-wide archive can register current equivalence and qualify public comparison', async () => {
  const evidence = titleWideArchive()
  evidence.queriedAt = '2026-10-18T05:00:00.000Z'; evidence.completedAt = '2026-10-18T05:01:00.000Z'
  const item = (await import('../../../lib/platform/recognized-evidence')).recognizedResultToImport(evidence)
  expect((await client.commit({ idempotencyKey: 'proof-title-wide-query', sourceKind: 'alias_evidence', sourceIdentity: 'synthetic/proof/query', payload: { platformQueries: [item] } })).status).toBe('committed')
  const queryRead = await (await fetch(`${api.baseUrl}/api/platform/queries?interface=recognized_list&queryKey=${encodeURIComponent(item.queryKey)}`)).json()
  const queryId = queryRead.rows.find((row: any) => row.query.queriedAt === evidence.queriedAt).query.id as number

  const official = await client.commit({ idempotencyKey: 'proof-title-wide-official', sourceKind: 'announcement', sourceIdentity: 'synthetic/proof/official', payload: { announcement: {
    sourceDocument: { source: 'jxj', title: '合成公布文件' }, records: [{ enterprise: { name: '合成企业', uscc: USCC }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year: 2024 }] }],
  } } })
  expect(official.status).toBe('committed')
  const documentId = db.select().from(schema.sourceDocument).all().find(row => row.path === 'synthetic/proof/official')!.id
  const exported = await client.commit({ idempotencyKey: 'proof-title-wide-export', sourceKind: 'platform_export', sourceIdentity: 'synthetic/proof/export', payload: { exportSnapshot: {
    titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-18', originalFilename: 'synthetic-proof-export.xlsx', sha256: 'b'.repeat(64),
    rows: [{ sourceRowNo: 3, usccRaw: USCC, nameRaw: '合成企业' }],
  } } })
  expect(exported.status).toBe('committed')
  const exportBatchId = db.select().from(schema.platformExportBatch).all().find(row => row.originalFilename === 'synthetic-proof-export.xlsx')!.id

  mkdirSync(join(dir, 'miit', 'export'), { recursive: true })
  writeFileSync(join(dir, 'miit', 'export', 'synthetic-proof-freeze.txt'), 'synthetic archived freeze')
  const registered = await fetch(`${api.baseUrl}/api/files/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ relPath: 'miit/export/synthetic-proof-freeze.txt', source: 'miit', kind: 'export' }) })
  expect(registered.status).toBe(201)
  const freeze = await registered.json()
  const proofRequest = { idempotencyKey: 'proof-title-wide-equivalence', sourceIdentity: 'synthetic/proof/equivalence', actor: { type: 'agent', id: 'synthetic-agent' }, basis: 'Synthetic archived query and export share an attested account, region and collection window', ruleId: 'manual-review', ruleVersion: '1', operations: [{ action: 'create', kind: 'current_source_equivalence', status: 'confirmed', evidence: {
    queryId, exportBatchId, titleCode: 'specialized_sme', queryReference: 'platform_query.collectionEvidence', exportReference: 'platform_export_batch.sha256',
    scope: { queryAccount: 'synthetic-account', exportAccount: 'synthetic-account', queryRegion: 'synthetic-region', exportRegion: 'synthetic-region', queryFilters: { combination: 'and' }, exportFilters: { combination: 'and' }, windowStart: '2026-10-18T00:00:00.000Z', windowEnd: '2026-10-18T23:59:59.000Z', platformVersion: 'synthetic-v1', freezeReference: freeze.relPath, freezeFileId: freeze.id, freezeSha256: freeze.sha256 },
  } }] }
  const proofPost = (action: string, body: unknown) => fetch(`${api.baseUrl}/api/roster/comparison-scope-proofs/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
  const preflight = await proofPost('preflight', proofRequest)
  expect(preflight.status).toBe(200)
  const plan = await preflight.json()
  expect(plan.planHash).toMatch(/^[a-f0-9]{64}$/)
  const committed = await proofPost('commit', { request: proofRequest, planHash: plan.planHash })
  expect(committed.status).toBe(200)
  const proofId = (await committed.json()).proofIds[0] as number
  const sources = `queryIds=${queryId}&exportBatchIds=${exportBatchId}&officialSourceDocumentIds=${documentId}`
  const before = await (await fetch(`${api.baseUrl}/api/roster/record-comparison?${sources}`)).json()
  expect(before.currentSourceConsistency.recognizedObservations[0].qualification).toBe('not_comparable')
  const qualified = await (await fetch(`${api.baseUrl}/api/roster/record-comparison?${sources}&proofIds=${proofId}`)).json()
  expect(qualified.currentSourceConsistency.recognizedObservations[0].qualification).toBe('matched')
})
