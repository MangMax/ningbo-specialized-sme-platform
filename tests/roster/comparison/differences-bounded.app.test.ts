import { createServer } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import pg from 'pg'
import { createApp, defineEventHandler, getQuery, setHeader, toNodeListener } from 'h3'
import { stopJobs } from '../../../layers/core/server/utils/postgres-jobs'
import { useIsolatedPostgresCases } from '../../support/isolated-postgres-cases'
import { completeInProcessPostgresIntake } from '../imports/fixtures/in-process-intake-postgres'
import { runPostgresMixedImport } from '../../../layers/sme-roster/server/utils/roster-mixed-import-postgres'
import { savePostgresDecision102 } from '../../../layers/sme-roster/server/utils/decision-lifecycle/postgres-writes'
import type { RosterImportCommitResponse, RosterImportPayload, RosterImportRequest } from '../../../layers/sme-roster/lib/roster-import-client'
import type { PlatformLiveQueryResult } from '../../../layers/sme-roster/lib/platform/live-query'

vi.mock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (tool: unknown) => tool }))
const openDatabase = useIsolatedPostgresCases()
const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  try {
    // Complete background candidates while their isolated database still exists.
    await stopJobs()
  } finally {
    for (const close of cleanup.splice(0).reverse()) await close()
    vi.restoreAllMocks()
    vi.useRealTimers()
  }
})

async function fixture() {
  // Both writers stamp generated decision times from the same application clock.
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-21T12:00:00.000Z') })
  const db = openDatabase()
  let sequence = 0
  const write = async (payload: RosterImportPayload) => {
    const key = `synthetic-differences-${++sequence}`
    const request: RosterImportRequest = { idempotencyKey: key, sourceKind: 'announcement', sourceIdentity: key + '.pdf', payload }
    const output = await runPostgresMixedImport('commit', request)
    const receipt = await completeInProcessPostgresIntake(db, output, request) as RosterImportCommitResponse
    expect(receipt, JSON.stringify(receipt.items)).toMatchObject({ status: 'committed', summary: { failed: 0 } })
    return receipt
  }
  await write({ announcement: { sourceDocument: { source: 'jxj', title: 'Synthetic differences' }, records: Array.from({ length: 20 }, (_, i) => ({ enterprise: { name: `合成差异${String(i).padStart(2, '0')}`, ...(i === 0 ? { uscc: '91330211255994457P' } : {}) }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year: 2022, batchSeq: 1 }] })) } })
  await write({ differences: Array.from({ length: 20 }, (_, i) => (['missing_in_miit', 'extra_in_miit'] as const).map(direction => ({ enterpriseName: `合成差异${String(i).padStart(2, '0')}`, titleCode: 'specialized_sme', direction, status: 'needs_review' as const, measureCode: 'manual_review', recordedAt: '2026-10-18T00:00:00.000Z' }))).flat() })
  const save = async (command: Parameters<typeof savePostgresDecision102>[1]) => {
    const receipt = await savePostgresDecision102(db, command)
    return receipt
  }
  return { write, save }
}

// Count real PostgreSQL driver results crossing into the application.
function statementMeter() {
  const read = pg.Client.prototype.query
  const entries: { sql: string; rows: unknown[] }[] = []
  vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (this: pg.Client, ...args: unknown[]) {
    const pending = Reflect.apply(read, this, args)
    if (!(pending instanceof Promise)) return pending
    const statement = args[0] as string | pg.QueryConfig
    return pending.then((result: pg.QueryResult) => {
      entries.push({ sql: typeof statement === 'string' ? statement : statement.text, rows: result.rows })
      return result
    })
  } as typeof read)
  return {
    read: () => ({
      statements: entries.length,
      bytes: entries.reduce((sum, { rows }) => sum + Buffer.byteLength(JSON.stringify(rows)), 0),
      coverage: entries.filter(entry => entry.sql.startsWith('with "targets"')),
      legacyKeys: entries.filter(entry => /^select distinct "query_key" from .*"platform_collection"/.test(entry.sql)),
    }),
    reset: () => { entries.length = 0 },
  }
}

async function publicReads() {
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  vi.stubGlobal('getQuery', getQuery)
  vi.stubGlobal('setHeader', setHeader)
  const handler = (await import('../../../layers/sme-roster/server/api/roster/differences.get')).default
  const tool = (await import('../../../layers/sme-roster/server/mcp/tools/list_differences')).default as unknown as { handler: (input: Record<string, unknown>) => unknown }
  const app = createApp().use('/api/roster/differences', handler)
  const server = createServer(toNodeListener(app))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  const port = (server.address() as { port: number }).port
  return {
    rest: async (query = '') => { const res = await fetch(`http://127.0.0.1:${port}/api/roster/differences${query}`); expect(res.status).toBe(200); expect(res.headers.get('cache-control')).toBe('no-store'); return res.json() },
    mcp: (input: Record<string, unknown> = {}) => tool.handler(input) as any,
  }
}
it('bounds assessment work for REST and MCP pages while keeping the current explanation and independent coverage', async () => {
  await fixture()
  const api = await publicReads(), meter = statementMeter()
  const rest = await api.rest('?pageSize=20')
  expect(rest).toMatchObject({ total: 40, counts: { specialized_sme: { missing_in_miit: 20, extra_in_miit: 20 } } })
  expect(rest.rows).toHaveLength(20)
  expect(rest.rows.every((r: any) => r.status === 'needs_review' && r.queryCoverage.status === 'not_queried' && r.currentDecision.current.status === 'needs_review' && r.explanationValidity.status === 'unknown')).toBe(true)
  expect.soft(meter.read().statements).toBeGreaterThan(0)
  expect.soft(meter.read().statements).toBeLessThanOrEqual(120)
  meter.reset()
  const mcp = await api.mcp({ pageSize: 20 })
  expect(mcp.rows).toHaveLength(20)
  expect(mcp.counts).toEqual({ specialized_sme: { missing_in_miit: 20, extra_in_miit: 20 } })
  expect(mcp.rows.every((r: any) => r.status === 'needs_review' && r.queryCoverage.status === 'not_queried' && r.currentDecision.current.status === 'needs_review')).toBe(true)
  expect.soft(meter.read().statements).toBeGreaterThan(0)
  expect.soft(meter.read().statements).toBeLessThanOrEqual(120)
}, 30_000)

it('preserves REST filters counts deep pages evidence and the intentionally narrower MCP projection', async () => {
  const f = await fixture(), api = await publicReads()
  const successfulAt = '2026-10-18T00:00:00.000Z', failedAt = '2026-10-19T00:00:00.000Z'
  const scope = { interface: 'business_list' as const, queryKey: 'name:合成差异00', rdjb: '2' }
  await f.write({ platformQueries: [
    { ...scope, titleCode: 'specialized_sme', queriedAt: successfulAt, status: 'partial', rawResponse: 'SYNTHETIC_RAW',
      relations: [{ sequenceNo: 1, relationKey: 'm2-current', nameRaw: '合成旧名称', usccRaw: '91330211255994457P', verificationStatus: 'confirmed',
        rawFields: { id: 'm2-current', qymc: '合成旧名称', tyshxydm: '91330211255994457P', rdjb: '2' } }] },
    { ...scope, titleCode: 'specialized_sme', queriedAt: failedAt, status: 'failed', rawResponse: 'SYNTHETIC_FAILURE', failureReason: 'synthetic failure', relations: [] },
  ],
    aliases: [{ enterpriseName: '合成差异00', name: '合成旧名称', sourceKind: 'platform_business', verificationStatus: 'confirmed', sourceRelationRef: { ...scope, queriedAt: successfulAt, sequenceNo: 1 } }, { enterpriseName: '合成差异01', name: '合成旧名称', sourceKind: 'platform_apply', verificationStatus: 'pending' }],
    differences: [{ enterpriseName: '合成差异00', titleCode: 'specialized_sme', direction: 'missing_in_miit', status: 'confirmed_reason', reasonCode: 'pending_review', measureCode: 'follow_review', verificationStatus: 'confirmed', recordedAt: failedAt, evidenceQueryRef: { ...scope, queriedAt: failedAt } }, { enterpriseName: '合成差异01', titleCode: 'specialized_sme', direction: 'extra_in_miit', status: 'confirmed_no_diff', measureCode: 'none', verificationStatus: 'confirmed', recordedAt: '2026-10-19T00:00:00.000Z' }, { enterpriseName: '合成差异02', titleCode: 'little_giant', direction: 'missing_in_miit', status: 'needs_review', reasonCode: 'moved_in', measureCode: 'record_moved_in', movedIn: { city: '合成城市' }, recordedAt: '2026-10-19T00:00:00.000Z' }] })
  for (const [query, total, rows] of [
    ['', 41, 41], ['page=3&pageSize=7', 41, 7], ['page=200&pageSize=5', 41, 0],
    ['q=合成（旧）名称&title=specialized_sme,little_giant', 2, 2],
    ['status=confirmed_reason,confirmed_no_diff&direction=missing_in_miit,extra_in_miit', 2, 2],
    ['reason=pending_review,moved_in&pageSize=1', 2, 1], ['q=does-not-exist', 0, 0],
  ] as const) {
    const result = await api.rest('?' + query)
    expect(result.total, query).toBe(total)
    expect(result.rows, query).toHaveLength(rows)
  }
  const aliasRows = await api.rest('?q=' + encodeURIComponent('合成旧名称'))
  expect(aliasRows).toMatchObject({ total: 2, rows: [{ name: '合成差异00' }, { name: '合成差异00' }] })
  const pending = await api.rest('?reason=pending_review')
  expect(pending).toMatchObject({ total: 1, rows: [{ status: 'confirmed_reason', reasonCode: 'pending_review', measureCode: 'follow_review', queryCoverage: { status: 'failed' }, currentDecision: { current: { reasonCode: 'pending_review' } } }] })
  expect(pending.rows[0].evidence).toMatchObject({ status: 'failed', relationIds: [] })
  expect(pending.rows[0].explanationValidity.status).toBe('evidence_changed')
  expect((await api.rest('?reason=moved_in')).rows[0].movedIn).toEqual({ city: '合成城市', titleCode: null, year: null, batch: null, complete: false })
  expect((await api.mcp({ status: 'confirmed_no_diff' })).rows).toMatchObject([{ name: '合成差异01', status: 'confirmed_no_diff', reasonCode: null, measureCode: 'none' }])
  await f.write({ announcement: { sourceDocument: { source: 'jxj', title: 'Synthetic derived only' }, records: [{ enterprise: { name: '仅有正式记录' }, titleCode: 'innovative_sme', events: [{ eventType: 'nurture', year: 2021 }] }] } })
  expect(await api.rest('?title=innovative_sme')).toMatchObject({ total: 1, rows: [{ name: '仅有正式记录', status: 'not_queried', explanationId: null }] })
  expect(await api.mcp({ title: 'innovative_sme' })).toEqual({ rows: [], counts: {} })
}, 30_000)

it('keeps the latest title coverage and withdrawal fresh after application commits', async () => {
  const f = await fixture(), api = await publicReads()
  const first = (await api.rest('?q=合成差异00&direction=missing_in_miit')).rows[0]
  const scope = { enterpriseId: first.enterpriseId, titleCode: 'specialized_sme' as const, direction: 'missing_in_miit' as const }
  const latest = await f.save({ ...scope, action: 'replace', expectedCurrentId: first.explanationId, idempotencyKey: 'synthetic132-replace', actor: { type: 'agent', id: 'synthetic132' }, basis: 'synthetic independent decision', ruleVersion: '1', effectiveAt: '2026-10-20T00:00:00.000Z', decision: { status: 'confirmed_no_diff', measureCode: 'none', verificationStatus: 'confirmed' } })
  expect((await api.rest('?q=合成差异00&direction=missing_in_miit')).rows[0]).toMatchObject({ currentDecision: { versionId: latest.versionId, current: { status: 'confirmed_no_diff' } }, queryCoverage: { status: 'not_queried' } })
  const capture = await f.write({ platformQueries: Array.from({ length: 52 }, (_, i) => ({ interface: 'business_list', queryKey: 'name:合成差异00', rdjb: '2', titleCode: 'specialized_sme', queriedAt: new Date(Date.UTC(2026, 9, 20, 0, 0, i)).toISOString(), status: i === 51 ? 'failed' as const : 'no_record' as const, rawResponse: 'SYNTHETIC', relations: [] })) })
  const latestQueryId = Number(capture.items.filter(item => item.kind === 'platform_query').at(-1)!.ref.split(':')[1])
  const row = (await api.rest('?q=合成差异00&direction=missing_in_miit')).rows[0]
  expect(row).toMatchObject({ status: 'confirmed_no_diff', currentDecision: { current: { status: 'confirmed_no_diff' } }, queryCoverage: {
    status: 'failed', truncated: false, sources: [{ queryId: latestQueryId, queryStatus: 'failed', outcome: 'unknown' }],
  } })
  if (typeof latest.versionId !== 'number') throw new Error('Application decision receipt must include a numeric version')
  const withdrawn = await f.save({ ...scope, action: 'withdraw', expectedCurrentId: latest.versionId, idempotencyKey: 'synthetic132-withdraw', actor: { type: 'agent', id: 'synthetic132' }, basis: 'synthetic withdrawal', ruleVersion: '1', effectiveAt: '2026-10-20T00:00:00.000Z' })
  const rest = (await api.rest('?q=合成差异00&direction=missing_in_miit')).rows[0]
  const tool = (await api.mcp({ direction: 'missing_in_miit' })).rows.find((r: any) => r.enterpriseId === first.enterpriseId)
  for (const r of [rest, tool]) {
    expect(r).toMatchObject({ assessment: 'withdrawn', currentDecision: { versionId: withdrawn.versionId, current: null }, explanationValidity: { status: 'not_applicable' } })
    expect(r.queryCoverage).toEqual(row.queryCoverage)
  }
}, 30_000)

it('does not materialize unrelated raw archives when added synthetic payload sizes grow', async () => {
  const f = await fixture(), api = await publicReads()
  const expectedRest = await api.rest('?pageSize=20'), expectedMcp = await api.mcp({ pageSize: 20 })
  const meter = statementMeter()
  for (const factor of [1, 2, 5]) {
    await f.write({ platformQueries: [{ interface: 'business_list', queryKey: `archive:unrelated-${factor}`, rdjb: '3', titleCode: 'little_giant', queriedAt: '2026-10-20T00:00:00.000Z', status: 'failed', rawResponse: 'SYNTHETIC_UNRELATED'.repeat(factor * 8192), relations: [{ sequenceNo: 1, rawFields: { body: 'SYNTHETIC_RELATION'.repeat(factor * 8192) } }] }] })
    meter.reset()
    expect(await api.rest('?pageSize=20')).toEqual(expectedRest)
    expect(meter.read().bytes).toBeGreaterThan(0)
    expect(meter.read().bytes).toBeLessThan(128 * 1024)
    expect(meter.read().statements).toBeLessThanOrEqual(120)
    meter.reset()
    expect(await api.mcp({ pageSize: 20 })).toEqual(expectedMcp)
    expect(meter.read().bytes).toBeGreaterThan(0)
    expect(meter.read().bytes).toBeLessThan(128 * 1024)
    expect(meter.read().statements).toBeLessThanOrEqual(120)
  }
}, 30_000)

it('preserves exact identity title partitions source conditions and no record outcomes on both public readers', async () => {
  const f = await fixture(), api = await publicReads()
  const uscc = '91330211255994457P'
  const evidence = (source: 'queryBusList', rdjb: string, conditions: PlatformLiveQueryResult['effectiveConditions'] = { uscc, combination: 'and' }): PlatformLiveQueryResult => ({
    source, status: 'no_record' as const, effectiveConditions: conditions,
    titleScope: { mode: 'selected' as const, rdjb: [rdjb] },
    queriedAt: '2026-10-20T00:00:00.000Z', completedAt: '2026-10-20T00:00:01.000Z', rows: [],
    pages: [{ source, rdjb, page: 1, status: 'success' as const, fetchedCount: 0, declaredTotal: 0, error: null }],
    fetchedCount: 0, declaredTotal: 0, completeness: 'complete' as const, fullRange: true, unfinished: [], error: null,
    limits: { pageSize: 50, maxRequests: 100, maxRows: 5000, maxDurationMs: 60000 },
  })
  await f.write({ platformQueries: [
    { interface: 'recognized_list', queryKey: uscc, titleCode: 'specialized_sme', rdjb: '2', queriedAt: '2026-10-20T00:00:00.000Z', status: 'no_record', collectionEvidence: evidence('queryBusList', '2') },
    { interface: 'business_list', queryKey: uscc.toLowerCase(), titleCode: 'specialized_sme', rdjb: '2', queriedAt: '2026-10-19T00:00:00.000Z', status: 'no_record', rawResponse: 'SYNTHETIC_EMPTY_RESPONSE' },
    { interface: 'business_list', queryKey: uscc, titleCode: 'innovative_sme', rdjb: '1', queriedAt: '2026-10-20T00:00:01.000Z', status: 'no_record', rawResponse: 'SYNTHETIC_EMPTY_RESPONSE' },
    { interface: 'apply_list', queryKey: uscc, rdjb: '', queriedAt: '2026-10-20T00:00:02.000Z', status: 'no_record', rawResponse: 'SYNTHETIC_EMPTY_RESPONSE' },
    { interface: 'recognized_list', queryKey: uscc, titleCode: 'specialized_sme', rdjb: '2', queriedAt: '2026-10-20T00:00:03.000Z', status: 'no_record', collectionEvidence: { ...evidence('queryBusList', '2', { uscc, rddqrq: '2025', combination: 'and' }), queriedAt: '2026-10-20T00:00:03.000Z', completedAt: '2026-10-20T00:00:04.000Z' } },
  ] })
  const rest = await api.rest('?q=91330211255994457p')
  expect(rest.total).toBe(2)
  for (const row of rest.rows) {
    expect(row).toMatchObject({ status: 'needs_review', queryCoverage: { status: 'complete', truncated: false }, assessment: 'decided' })
    expect(row.queryCoverage.sources).toHaveLength(4)
    expect(row.queryCoverage.sources.map((s: any) => [s.interface, s.titleCode, s.outcome])).toEqual([
      ['recognized_list', 'specialized_sme', 'no_record'], ['apply_list', null, 'unknown'], ['recognized_list', 'specialized_sme', 'no_record'], ['business_list', 'specialized_sme', 'unknown'],
    ])
    expect(row.queryCoverage.sources[0].conditions.rddqrq).toBe('2025')
  }
  const mcp = await api.mcp({ title: 'specialized_sme' })
  for (const row of rest.rows) {
    const matching = mcp.rows.find((r: any) => r.enterpriseId === row.enterpriseId && r.direction === row.direction)
    expect(matching.queryCoverage).toEqual(row.queryCoverage)
    expect(matching.currentDecision).toEqual(row.currentDecision)
    expect(matching.explanationValidity).toEqual(row.explanationValidity)
  }
  // A later source on the other side changes only current comparison membership;
  // historical explanations and their independent decision/coverage stay visible.
  await f.write({ announcement: { sourceDocument: { source: 'miit', title: 'Synthetic aligned snapshot' }, records: [{ enterprise: { name: '合成差异00', uscc }, titleCode: 'specialized_sme', events: [{ eventType: 'maintain', year: 2025 }] }] } })
  const aligned = await api.rest('?q=' + uscc)
  expect(aligned.total).toBe(2)
  expect(aligned.rows.every((r: any) => r.inCurrentDifference === false && r.status === 'needs_review')).toBe(true)
  expect(aligned.rows.map((r: any) => r.explanationId)).toEqual(rest.rows.map((r: any) => r.explanationId))
}, 30_000)

it('bounds driver key materialization and truncates only distinct current coverage scopes', async () => {
  const f = await fixture(), api = await publicReads(), meter = statementMeter()
  const legacy = [' 91330211\u200b255994457p ', '91330211\t255994457p']
  const excluded = ['９１３３０２１１２５５９９４４５７ｐ', '91330211255994457p\0', 'archive:91330211255994457p\u200b']
  const names = ['name:合成差异00', 'name:合成差异01']
  const at = '2026-10-20T00:00:00.000Z', later = '2026-10-20T00:00:01.000Z'
  const attempt = (queryKey: string, status: 'no_record' | 'not_queried' | 'partial' | 'failed' = 'no_record', queriedAt = at) => ({
    interface: 'business_list' as const, queryKey, rdjb: '2', titleCode: 'specialized_sme', queriedAt, status, rawResponse: 'SYNTHETIC_ATTEMPT_RESPONSE',
  })
  // Natural archive identities differ by interface/rdjb/time. Literal queryKey
  // strings are preserved by the application import API; no SQL fixture writes.
  const rawHistory = [
    ...Array.from({ length: 12 }, (_, i) => attempt(legacy[i % 2]!, 'partial', new Date(Date.parse(at) - i).toISOString())),
    ...excluded.flatMap(key => Array.from({ length: 8 }, (_, i) => attempt(key, 'failed', new Date(Date.parse(later) + i).toISOString()))),
    attempt(names[0]!, 'not_queried', later), attempt(names[1]!, 'failed', later),
    { ...attempt(excluded[2]!, 'partial', later), interface: 'apply_list', relations: [{ sequenceNo: 1, usccRaw: '91330211255994457P', nameRaw: '合成差异00' }] },
    attempt('archive:ascii-unrelated', 'failed', later),
  ] satisfies NonNullable<RosterImportPayload['platformQueries']>
  const initial = await f.write({
    platformQueries: rawHistory.map(row => ({ ...row, queryKey: row.queryKey.replace('\0', '!') })),
  })
  const queryIds = (receipt: typeof initial) => receipt.items.filter(item => item.kind === 'platform_query').map(item => Number(item.ref.split(':')[1]))
  const initialIds = queryIds(initial)
  const relatedId = initialIds[38]!, nameId = initialIds[36]!, otherNameId = initialIds[37]!
  const checkDriver = (truncated: boolean, otherTitleSources: number) => {
    const { coverage, legacyKeys } = meter.read()
    expect(coverage).toHaveLength(1)
    // The same batch covers all titles for REST qualification. MCP only needs
    // the selected title. Each target retains at most one truncation sentinel.
    expect(coverage[0]?.rows).toHaveLength((truncated ? 52 : 5) + otherTitleSources)
    expect(legacyKeys).toHaveLength(1)
    const keys = legacyKeys[0]!.rows.flat() as string[]
    expect(keys.sort()).toEqual([...legacy, excluded[0], excluded[2], ...names].sort())
  }
  const check = async (truncated: boolean, tiedIds: number[] = []) => {
    meter.reset()
    const rest = await api.rest('?pageSize=50')
    checkDriver(truncated, 2)
    expect(rest).toMatchObject({ total: 40, counts: { specialized_sme: { missing_in_miit: 20, extra_in_miit: 20 } } })
    const rows = rest.rows.filter((row: any) => row.name === '合成差异00')
    expect(rows.map((row: any) => row.direction).sort()).toEqual(['extra_in_miit', 'missing_in_miit'])
    for (const row of rows) {
      // The latest business query is name-only/not_queried; older partial or
      // failed retries with the same conditions cannot replace its semantics.
      expect(row).toMatchObject({ status: 'needs_review', currentDecision: { current: { status: 'needs_review' } }, queryCoverage: { status: 'unknown', truncated } })
      const sources = row.queryCoverage.sources
      expect(sources).toHaveLength(truncated ? 50 : 4)
      expect(sources.slice(0, 2)).toMatchObject([
        { queryId: relatedId, interface: 'apply_list', subjectMatch: 'matched_relation', status: 'partial', outcome: 'unknown' },
        { queryId: nameId, subjectMatch: 'name_only', queryStatus: 'not_queried', status: 'not_queried', outcome: 'unknown' },
      ])
      expect(sources.slice(2).map((s: any) => s.queryId)).toEqual(truncated ? tiedIds.slice().reverse() : initialIds.slice(0, 2))
      expect(sources.slice(2).every((s: any) => s.subjectMatch === 'exact_uscc' && s.outcome === 'unknown')).toBe(true)
      if (truncated) expect(sources.slice(2, 6).map((s: any) => s.queryStatus)).toEqual(['failed', 'partial', 'not_queried', 'no_record'])
    }
    expect(rest.rows.filter((row: any) => row.name === '合成差异01').every((row: any) => row.queryCoverage.sources.length === 1 && row.queryCoverage.sources[0].queryId === otherNameId && row.queryCoverage.sources[0].subjectMatch === 'name_only' && row.queryCoverage.status === 'failed')).toBe(true)
    expect(rest.rows.filter((row: any) => row.name === '合成差异02').every((row: any) => row.queryCoverage.status === 'not_queried')).toBe(true)
    meter.reset()
    const mcp = await api.mcp({ pageSize: 50 })
    checkDriver(truncated, 0)
    expect(mcp.rows).toHaveLength(40)
    expect(mcp.counts).toEqual({ specialized_sme: { missing_in_miit: 20, extra_in_miit: 20 } })
    for (const row of rest.rows) {
      const matching = mcp.rows.find((r: any) => r.enterpriseId === row.enterpriseId && r.direction === row.direction)
      expect(matching.queryCoverage).toEqual(row.queryCoverage)
    }
  }
  await check(false)
  const statuses = ['no_record', 'not_queried', 'partial', 'failed'] as const
  const repeated = await f.write({ platformQueries: Array.from({ length: 48 }, (_, i) => ({
    ...attempt(legacy[i % 2]!, statuses[i % 4]), rdjb: `2,synthetic-${i}`,
    // All 48 timestamps tie: newest IDs must win, including across both keys.
    // The latest partial query also matches by relation and must appear once.
    ...(i === 46 ? { relations: [{ sequenceNo: 1, usccRaw: '91330211255994457P' }] } : {}),
  })) })
  await check(true, queryIds(repeated))
}, 30_000)
