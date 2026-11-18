import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, defineEventHandler, getQuery, setHeader, toNodeListener } from 'h3'
import { initializeDb } from '../../../db/client'
import { commitRosterImport } from '../../../server/utils/roster-import'
import { whenIdle } from '../../../layers/core/server/utils/job-runner'
import type { RosterImportPayload } from '../../../lib/roster-import-client'
import type { PlatformLiveQueryResult } from '../../../lib/platform/live-query'

const active = vi.hoisted(() => ({ db: null as ReturnType<typeof initializeDb> | null }))
vi.mock('@db', () => ({ useDb: () => active.db }))
vi.mock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (tool: unknown) => tool }))
const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  // Archive imports enqueue real candidate tasks using this fixture's DB.
  // Let their persisted checkpoints finish before closing the connection.
  await whenIdle()
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.unstubAllGlobals()
})
function fixture(observe?: (db: ReturnType<typeof initializeDb>) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'differences-132-'))
  const db = initializeDb({ create: true,  dbPath: join(dir, 'synthetic.db') })
  active.db = db
  cleanup.push(() => { db.$client.close(); rmSync(dir, { recursive: true, force: true }) })
  observe?.(db)
  let sequence = 0
  const write = (payload: RosterImportPayload) => {
    const key = `synthetic-132-${++sequence}`
    const receipt = commitRosterImport(db, { idempotencyKey: key, sourceKind: 'announcement', sourceIdentity: key + '.pdf', payload })
    expect(receipt, JSON.stringify(receipt.items)).toMatchObject({ status: 'committed', summary: { failed: 0 } })
    return receipt
  }
  write({ announcement: { sourceDocument: { source: 'jxj', title: 'Synthetic 132' }, records: Array.from({ length: 20 }, (_, i) => ({ enterprise: { name: `合成差异${String(i).padStart(2, '0')}`, ...(i === 0 ? { uscc: '91330211255994457P' } : {}) }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year: 2022, batchSeq: 1 }] })) } })
  write({ differences: Array.from({ length: 20 }, (_, i) => (['missing_in_miit', 'extra_in_miit'] as const).map(direction => ({ enterpriseName: `合成差异${String(i).padStart(2, '0')}`, titleCode: 'specialized_sme', direction, status: 'needs_review' as const, measureCode: 'manual_review', recordedAt: '2026-10-18T00:00:00.000Z' }))).flat() })
  return { db, write }
}
// Wrap the registered production UDF, preserving its implementation and arity.
// Count only executions of the page-local coverage SELECT, not other readers.
function coverageFunctionMeter(db: ReturnType<typeof initializeDb>) {
  const register = db.$client.function.bind(db.$client)
  const prepare = db.$client.prepare.bind(db.$client)
  let selectingCoverage = false, selects = 0
  const calls = new Map<string, number>()
  db.$client.function = ((name: string, options: object, fn: (value: unknown) => unknown) => register(name, options,
    name === 'roster84_uscc' ? function (value: unknown) {
      if (selectingCoverage) calls.set(String(value), (calls.get(String(value)) ?? 0) + 1)
      return fn(value)
    } : fn)) as typeof db.$client.function
  db.$client.prepare = ((...args: Parameters<typeof prepare>) => {
    const stmt = prepare(...args)
    if (/with \"coverage_targets\" as/i.test(stmt.source)) {
      const all = stmt.all.bind(stmt)
      Object.defineProperty(stmt, 'all', { value: (...params: unknown[]) => {
        selects++; selectingCoverage = true
        try { return all(...params) } finally { selectingCoverage = false }
      } })
    }
    return stmt
  }) as typeof db.$client.prepare
  return { read: () => ({ selects, calls: Object.fromEntries(calls) }), reset: () => { selects = 0; calls.clear() } }
}
// Observe the SQLite boundary, not internal collaborators. The ceiling is a
// resource regression guard for a 20-row public page, never a latency/SLO claim.
function statementMeter(db: ReturnType<typeof initializeDb>) {
  const prepare = db.$client.prepare.bind(db.$client)
  let statements = 0, bytes = 0
  db.$client.prepare = ((...args: Parameters<typeof prepare>) => {
    const stmt = prepare(...args)
    for (const method of ['get', 'all'] as const) {
      const run = stmt[method].bind(stmt)
      Object.defineProperty(stmt, method, { value: (...params: unknown[]) => {
        const result = run(...params)
        statements++; bytes += Buffer.byteLength(JSON.stringify(result) ?? '')
        return result
      } })
    }
    return stmt
  }) as typeof db.$client.prepare
  return { read: () => ({ statements, bytes }), reset: () => { statements = 0; bytes = 0 } }
}
async function publicReads() {
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  vi.stubGlobal('getQuery', getQuery)
  vi.stubGlobal('setHeader', setHeader)
  const handler = (await import('../../../server/api/roster/differences.get')).default
  const tool = (await import('../../../server/mcp/tools/list_differences')).default as unknown as { handler: (input: Record<string, unknown>) => unknown }
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
  const f = fixture(), api = await publicReads(), meter = statementMeter(f.db)
  const rest = await api.rest('?pageSize=20')
  expect(rest).toMatchObject({ total: 40, counts: { specialized_sme: { missing_in_miit: 20, extra_in_miit: 20 } } })
  expect(rest.rows).toHaveLength(20)
  expect(rest.rows.every((r: any) => r.status === 'needs_review' && r.queryCoverage.status === 'not_queried' && r.currentDecision.current.status === 'needs_review' && r.explanationValidity.status === 'unknown')).toBe(true)
  expect.soft(meter.read().statements).toBeLessThanOrEqual(120)
  meter.reset()
  const mcp = await api.mcp({ pageSize: 20 })
  expect(mcp.rows).toHaveLength(20)
  expect(mcp.counts).toEqual({ specialized_sme: { missing_in_miit: 20, extra_in_miit: 20 } })
  expect(mcp.rows.every((r: any) => r.status === 'needs_review' && r.queryCoverage.status === 'not_queried' && r.currentDecision.current.status === 'needs_review')).toBe(true)
  expect.soft(meter.read().statements).toBeLessThanOrEqual(120)
})

it('preserves REST filters counts deep pages evidence and the intentionally narrower MCP projection', async () => {
  const f = fixture(), api = await publicReads()
  const { listRosterDifferences: reference } = await import('../../../layers/sme-roster/lib/roster/enterprise-roster')
  f.write({ platformQueries: [{ interface: 'business_list', queryKey: 'name:合成差异00', rdjb: '2', titleCode: 'specialized_sme', queriedAt: '2026-10-19T00:00:00.000Z', status: 'failed', rawResponse: 'SYNTHETIC_RAW', failureReason: 'synthetic failure', relations: [{ sequenceNo: 1, nameRaw: '合成旧名称', usccRaw: '91330211255994457P', verificationStatus: 'confirmed' }, { sequenceNo: 2, nameRaw: 'unmatched synthetic' }] }],
    aliases: [{ enterpriseName: '合成差异00', name: '合成旧名称', sourceKind: 'platform_business', verificationStatus: 'confirmed', sourceRelationRef: { interface: 'business_list', queryKey: 'name:合成差异00', rdjb: '2', sequenceNo: 1 } }, { enterpriseName: '合成差异01', name: '合成旧名称', sourceKind: 'platform_apply', verificationStatus: 'pending' }],
    differences: [{ enterpriseName: '合成差异00', titleCode: 'specialized_sme', direction: 'missing_in_miit', status: 'confirmed_reason', reasonCode: 'pending_review', measureCode: 'follow_review', verificationStatus: 'confirmed', recordedAt: '2026-10-19T00:00:00.000Z', evidenceQueryRef: { interface: 'business_list', queryKey: 'name:合成差异00', rdjb: '2' } }, { enterpriseName: '合成差异01', titleCode: 'specialized_sme', direction: 'extra_in_miit', status: 'confirmed_no_diff', measureCode: 'none', verificationStatus: 'confirmed', recordedAt: '2026-10-19T00:00:00.000Z' }, { enterpriseName: '合成差异02', titleCode: 'little_giant', direction: 'missing_in_miit', status: 'needs_review', reasonCode: 'moved_in', measureCode: 'record_moved_in', movedIn: { city: '合成城市' }, recordedAt: '2026-10-19T00:00:00.000Z' }] })
  const { parseRosterDifferenceQuery } = await import('../../../layers/sme-roster/server/utils/roster-read-query')
  for (const args of [{}, { page: '3', pageSize: '7' }, { page: '200', pageSize: '5' }, { q: '合成（旧）名称', title: 'specialized_sme,little_giant' }, { status: 'confirmed_reason,confirmed_no_diff', direction: 'missing_in_miit,extra_in_miit' }, { reason: 'pending_review,moved_in', pageSize: '1' }, { q: 'does-not-exist' }]) {
    const query = new URLSearchParams(args as Record<string, string>).toString()
    expect(await api.rest('?' + query)).toEqual(reference(f.db, parseRosterDifferenceQuery(args)))
  }
  const aliasRows = await api.rest('?q=' + encodeURIComponent('合成旧名称'))
  expect(aliasRows).toMatchObject({ total: 2, rows: [{ name: '合成差异00' }, { name: '合成差异00' }] })
  const pending = await api.rest('?reason=pending_review')
  expect(pending).toMatchObject({ total: 1, rows: [{ status: 'confirmed_reason', reasonCode: 'pending_review', measureCode: 'follow_review', queryCoverage: { status: 'failed' }, currentDecision: { current: { reasonCode: 'pending_review' } } }] })
  expect(pending.rows[0].evidence.relationIds).toHaveLength(2)
  expect((await api.rest('?reason=moved_in')).rows[0].movedIn).toEqual({ city: '合成城市', titleCode: null, year: null, batch: null, complete: false })
  expect((await api.mcp({ status: 'confirmed_no_diff' })).rows).toMatchObject([{ name: '合成差异01', status: 'confirmed_no_diff', reasonCode: null, measureCode: 'none' }])
  f.write({ announcement: { sourceDocument: { source: 'jxj', title: 'Synthetic derived only' }, records: [{ enterprise: { name: '仅有正式记录' }, titleCode: 'innovative_sme', events: [{ eventType: 'nurture', year: 2021 }] }] } })
  expect(await api.rest('?title=innovative_sme')).toMatchObject({ total: 1, rows: [{ name: '仅有正式记录', status: 'not_queried', explanationId: null }] })
  expect(await api.mcp({ title: 'innovative_sme' })).toEqual({ rows: [], counts: {} })
})

it('keeps title coverage history truncation and withdrawal fresh after application commits', async () => {
  const f = fixture(), api = await publicReads()
  const { listRosterDifferences: reference } = await import('../../../layers/sme-roster/lib/roster/enterprise-roster')
  const { saveDecision102 } = await import('../../../server/utils/decision-lifecycle-102')
  const first = (await api.rest('?q=合成差异00&direction=missing_in_miit')).rows[0]
  const scope = { enterpriseId: first.enterpriseId, titleCode: 'specialized_sme' as const, direction: 'missing_in_miit' as const }
  const latest = saveDecision102(f.db, { ...scope, action: 'replace', expectedCurrentId: first.explanationId, idempotencyKey: 'synthetic132-replace', actor: { type: 'agent', id: 'synthetic132' }, basis: 'synthetic independent decision', ruleVersion: '1', effectiveAt: '2026-10-20T00:00:00.000Z', decision: { status: 'confirmed_no_diff', measureCode: 'none', verificationStatus: 'confirmed' } })
  expect((await api.rest('?q=合成差异00&direction=missing_in_miit')).rows[0]).toMatchObject({ currentDecision: { versionId: latest.versionId, current: { status: 'confirmed_no_diff' } }, queryCoverage: { status: 'not_queried' } })
  f.write({ platformQueries: Array.from({ length: 52 }, (_, i) => ({ interface: 'business_list', queryKey: 'name:合成差异00', rdjb: '2', titleCode: 'specialized_sme', queriedAt: new Date(Date.UTC(2026, 9, 20, 0, 0, i)).toISOString(), status: i === 51 ? 'failed' as const : 'no_record' as const, rawResponse: 'SYNTHETIC', relations: [] })) })
  const row = (await api.rest('?q=合成差异00&direction=missing_in_miit')).rows[0]
  expect(row).toMatchObject({ status: 'confirmed_no_diff', currentDecision: { current: { status: 'confirmed_no_diff' } }, queryCoverage: { status: 'failed', truncated: true } })
  expect(row.queryCoverage.sources).toHaveLength(50)
  expect(row.queryCoverage.sources[0].queryStatus).toBe('failed')
  expect(row.queryCoverage.sources.every((s: any) => s.outcome === 'unknown')).toBe(true)
  expect(await api.rest('?q=合成差异00')).toEqual(reference(f.db, { q: '合成差异00' }))
  if (typeof latest.versionId !== 'number') throw new Error('Application decision receipt must include a numeric version')
  const withdrawn = saveDecision102(f.db, { ...scope, action: 'withdraw', expectedCurrentId: latest.versionId, idempotencyKey: 'synthetic132-withdraw', actor: { type: 'agent', id: 'synthetic132' }, basis: 'synthetic withdrawal', ruleVersion: '1', effectiveAt: '2026-10-20T00:00:00.000Z' })
  const rest = (await api.rest('?q=合成差异00&direction=missing_in_miit')).rows[0]
  const tool = (await api.mcp({ direction: 'missing_in_miit' })).rows.find((r: any) => r.enterpriseId === first.enterpriseId)
  for (const r of [rest, tool]) expect(r).toMatchObject({ assessment: 'withdrawn', currentDecision: { versionId: withdrawn.versionId, current: null }, explanationValidity: { status: 'not_applicable' }, queryCoverage: { truncated: true } })
})

it('does not materialize unrelated raw archives when added synthetic payload sizes grow', async () => {
  const f = fixture(), api = await publicReads()
  const expectedRest = await api.rest('?pageSize=20'), expectedMcp = await api.mcp({ pageSize: 20 })
  const meter = statementMeter(f.db)
  for (const factor of [1, 2, 5]) {
    f.write({ platformQueries: [{ interface: 'business_list', queryKey: `archive:unrelated-${factor}`, rdjb: '3', titleCode: 'little_giant', queriedAt: '2026-10-20T00:00:00.000Z', status: 'failed', rawResponse: 'SYNTHETIC_UNRELATED'.repeat(factor * 8192), relations: [{ sequenceNo: 1, rawFields: { body: 'SYNTHETIC_RELATION'.repeat(factor * 8192) } }] }] })
    meter.reset()
    expect(await api.rest('?pageSize=20')).toEqual(expectedRest)
    expect(meter.read().bytes).toBeLessThan(128 * 1024)
    expect(meter.read().statements).toBeLessThanOrEqual(120)
    meter.reset()
    expect(await api.mcp({ pageSize: 20 })).toEqual(expectedMcp)
    expect(meter.read().bytes).toBeLessThan(128 * 1024)
    expect(meter.read().statements).toBeLessThanOrEqual(120)
  }
})

it('preserves exact identity title partitions source conditions and no record outcomes on both public readers', async () => {
  const f = fixture(), api = await publicReads()
  const { listRosterDifferences: reference } = await import('../../../layers/sme-roster/lib/roster/enterprise-roster')
  const uscc = '91330211255994457P'
  const evidence = (source: 'queryBusList', rdjb: string, conditions: PlatformLiveQueryResult['effectiveConditions'] = { uscc, combination: 'and' }): PlatformLiveQueryResult => ({
    source, status: 'no_record' as const, effectiveConditions: conditions,
    titleScope: { mode: 'selected' as const, rdjb: [rdjb] },
    queriedAt: '2026-10-20T00:00:00.000Z', completedAt: '2026-10-20T00:00:01.000Z', rows: [],
    pages: [{ source, rdjb, page: 1, status: 'success' as const, fetchedCount: 0, declaredTotal: 0, error: null }],
    fetchedCount: 0, declaredTotal: 0, completeness: 'complete' as const, fullRange: true, unfinished: [], error: null,
    limits: { pageSize: 50, maxRequests: 100, maxRows: 5000, maxDurationMs: 60000 },
  })
  f.write({ platformQueries: [
    { interface: 'recognized_list', queryKey: uscc, titleCode: 'specialized_sme', rdjb: '2', queriedAt: '2026-10-20T00:00:00.000Z', status: 'no_record', collectionEvidence: evidence('queryBusList', '2') },
    { interface: 'business_list', queryKey: uscc.toLowerCase(), titleCode: 'specialized_sme', rdjb: '2', queriedAt: '2026-10-19T00:00:00.000Z', status: 'no_record', rawResponse: 'SYNTHETIC_EMPTY_RESPONSE' },
    { interface: 'business_list', queryKey: uscc, titleCode: 'innovative_sme', rdjb: '1', queriedAt: '2026-10-20T00:00:01.000Z', status: 'no_record', rawResponse: 'SYNTHETIC_EMPTY_RESPONSE' },
    { interface: 'apply_list', queryKey: uscc, rdjb: '', queriedAt: '2026-10-20T00:00:02.000Z', status: 'no_record', rawResponse: 'SYNTHETIC_EMPTY_RESPONSE' },
    { interface: 'recognized_list', queryKey: uscc, titleCode: 'specialized_sme', rdjb: '2', queriedAt: '2026-10-20T00:00:03.000Z', status: 'no_record', collectionEvidence: { ...evidence('queryBusList', '2', { uscc, rddqrq: '2025', combination: 'and' }), queriedAt: '2026-10-20T00:00:03.000Z', completedAt: '2026-10-20T00:00:04.000Z' } },
  ] })
  const rest = await api.rest('?q=91330211255994457p')
  expect(rest).toEqual(reference(f.db, { q: uscc }))
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
  f.write({ announcement: { sourceDocument: { source: 'miit', title: 'Synthetic aligned snapshot' }, records: [{ enterprise: { name: '合成差异00', uscc }, titleCode: 'specialized_sme', events: [{ eventType: 'maintain', year: 2025 }] }] } })
  const aligned = await api.rest('?q=' + uscc)
  expect(aligned.total).toBe(2)
  expect(aligned.rows.every((r: any) => r.inCurrentDifference === false && r.status === 'needs_review')).toBe(true)
  expect(aligned.rows.map((r: any) => r.explanationId)).toEqual(rest.rows.map((r: any) => r.explanationId))
})

it('bounds legacy key normalization by distinct raw keys while preserving public coverage history', async () => {
  let meter!: ReturnType<typeof coverageFunctionMeter>
  const f = fixture(db => { meter = coverageFunctionMeter(db) }), api = await publicReads()
  const { listRosterDifferences: reference } = await import('../../../layers/sme-roster/lib/roster/enterprise-roster')
  const legacy = [' 91330211\u200b255994457p ', '91330211\t255994457p']
  const excluded = ['９１３３０２１１２５５９９４４５７ｐ', '91330211255994457p\0', 'archive:91330211255994457p\u200b']
  const names = ['name:合成差异00', 'name:合成差异01']
  const at = '2026-10-20T00:00:00.000Z', later = '2026-10-20T00:00:01.000Z'
  const attempt = (queryKey: string, status: 'no_record' | 'not_queried' | 'partial' | 'failed' = 'no_record', queriedAt = at) => ({
    interface: 'business_list' as const, queryKey, rdjb: '2', titleCode: 'specialized_sme', queriedAt, status, rawResponse: 'SYNTHETIC_ATTEMPT_RESPONSE',
  })
  // Natural archive identities differ by interface/rdjb/time. Literal queryKey
  // strings are preserved by the application import API; no SQL fixture writes.
  const initial = f.write({ platformQueries: [
    ...Array.from({ length: 12 }, (_, i) => attempt(legacy[i % 2]!, 'partial', new Date(Date.parse(at) - i).toISOString())),
    ...excluded.flatMap(key => Array.from({ length: 8 }, (_, i) => attempt(key, 'failed', new Date(Date.parse(later) + i).toISOString()))),
    attempt(names[0]!, 'not_queried', later), attempt(names[1]!, 'failed', later),
    { ...attempt(excluded[2]!, 'failed', later), interface: 'apply_list', relations: [{ sequenceNo: 1, usccRaw: '91330211255994457P', nameRaw: '合成差异00' }] },
    attempt('archive:ascii-unrelated', 'failed', later),
  ] })
  const queryIds = (receipt: typeof initial) => receipt.items.filter(item => item.kind === 'platform_query').map(item => Number(item.ref.split(':')[1]))
  const initialIds = queryIds(initial)
  const relatedId = initialIds[38]!, nameId = initialIds[36]!, otherNameId = initialIds[37]!
  const check = async (truncated: boolean, tiedIds: number[] = []) => {
    meter.reset()
    const rest = await api.rest('?pageSize=50')
    // Actual SELECT execution and actual UDF inputs are both required: a fixed
    // expected count without this execution cannot satisfy the resource guard.
    expect(meter.read().selects).toBe(1)
    // Native SQL handles ASCII keys directly; only whitespace/non-ASCII keys
    // enter the UDF, once per distinct stored spelling regardless of retries.
    expect.soft(meter.read().calls).toEqual(Object.fromEntries([...legacy, ...excluded.slice(0, 2)].map(key => [key, 1])))
    expect(rest).toMatchObject({ total: 40, counts: { specialized_sme: { missing_in_miit: 20, extra_in_miit: 20 } } })
    const rows = rest.rows.filter((row: any) => row.name === '合成差异00')
    expect(rows.map((row: any) => row.direction).sort()).toEqual(['extra_in_miit', 'missing_in_miit'])
    for (const row of rows) {
      // The latest business query is name-only/not_queried; older partial or
      // failed retries with the same conditions cannot replace its semantics.
      expect(row).toMatchObject({ status: 'needs_review', currentDecision: { current: { status: 'needs_review' } }, queryCoverage: { status: 'unknown', truncated } })
      const sources = row.queryCoverage.sources
      expect(sources).toHaveLength(truncated ? 50 : 14)
      expect(sources.slice(0, 2)).toMatchObject([
        { queryId: relatedId, interface: 'apply_list', subjectMatch: 'matched_relation', status: 'failed', outcome: 'unknown' },
        { queryId: nameId, subjectMatch: 'name_only', queryStatus: 'not_queried', status: 'not_queried', outcome: 'unknown' },
      ])
      expect(sources.slice(2).map((s: any) => s.queryId)).toEqual(truncated ? tiedIds.slice().reverse() : initialIds.slice(0, 12))
      expect(sources.slice(2).every((s: any) => s.subjectMatch === 'exact_uscc' && s.outcome === 'unknown')).toBe(true)
      if (truncated) expect(sources.slice(2, 6).map((s: any) => s.queryStatus)).toEqual(['failed', 'partial', 'not_queried', 'no_record'])
    }
    expect(rest.rows.filter((row: any) => row.name === '合成差异01').every((row: any) => row.queryCoverage.sources.length === 1 && row.queryCoverage.sources[0].queryId === otherNameId && row.queryCoverage.sources[0].subjectMatch === 'name_only' && row.queryCoverage.status === 'failed')).toBe(true)
    expect(rest.rows.filter((row: any) => row.name === '合成差异02').every((row: any) => row.queryCoverage.status === 'not_queried')).toBe(true)
    meter.reset()
    const mcp = await api.mcp({ pageSize: 50 })
    expect(meter.read().selects).toBe(1)
    expect.soft(meter.read().calls).toEqual(Object.fromEntries([...legacy, ...excluded.slice(0, 2)].map(key => [key, 1])))
    expect(mcp.rows).toHaveLength(40)
    expect(mcp.counts).toEqual({ specialized_sme: { missing_in_miit: 20, extra_in_miit: 20 } })
    for (const row of rest.rows) {
      const matching = mcp.rows.find((r: any) => r.enterpriseId === row.enterpriseId && r.direction === row.direction)
      expect(matching.queryCoverage).toEqual(row.queryCoverage)
    }
    // Supplementary scalar-reference parity; literal assertions above own the
    // expected matching branches, statuses, ordering and history boundary.
    expect(rest).toEqual(reference(f.db, { pageSize: 50 }))
  }
  await check(false)
  const statuses = ['no_record', 'not_queried', 'partial', 'failed'] as const
  const repeated = f.write({ platformQueries: Array.from({ length: 48 }, (_, i) => ({
    ...attempt(legacy[i % 2]!, statuses[i % 4]), rdjb: `2,synthetic-${i}`,
    // All 48 timestamps tie: newest IDs must win, including across both keys.
    // The newest attempt also matches by relation: UNION must retain it once.
    ...(i === 47 ? { relations: [{ sequenceNo: 1, usccRaw: '91330211255994457P' }] } : {}),
  })) })
  await check(true, queryIds(repeated))
})
