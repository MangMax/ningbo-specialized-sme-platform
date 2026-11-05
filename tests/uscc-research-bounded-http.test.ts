import { initializeDb } from '../db/client'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { useDb } from '../db'
import { createRosterImportClient } from '../lib/roster-import-client'
import { startEvidenceServer, type EvidenceServer } from './helpers/platform-evidence-server'

const dir = mkdtempSync(join(tmpdir(), 'uscc-131-'))
const db = initializeDb({ create: true, dbPath: join(dir, 'roster.db') })
const name = '宁波合成查证机械有限公司'
const canonicalName = '宁波合成查证机械股份有限公司'
const uscc = '91330211255994457P'
const token = 'synthetic-131'
let server: EvidenceServer
let input: Record<string, unknown> = {}
let targetId: number
let bytes = 0
let statements = 0
let measuring = false
const measurements: Array<{ method: string; bytes: number; statements: number; elapsedMs: number; heapAfter: number; rssAfter: number }> = []

// Supplemental resource observation at the real driver; no result is replaced.
const prepare = db.$client.prepare.bind(db.$client)
db.$client.prepare = ((...args: Parameters<typeof prepare>) => {
  const statement = prepare(...args)
  for (const method of ['all', 'get', 'iterate'] as const) {
    const run = statement[method].bind(statement)
    const count = (row: unknown) => { if (measuring) bytes += Buffer.byteLength(JSON.stringify(row) ?? '') }
    Object.defineProperty(statement, method, { value: (...params: unknown[]) => {
      if (measuring) statements++
      const result = run(...params)
      if (method === 'iterate') return (function* () { for (const row of result as Iterable<unknown>) { count(row); yield row } })()
      count(result)
      return result
    } })
  }
  return statement
}) as typeof db.$client.prepare

beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
  vi.stubGlobal('getQuery', () => input)
  vi.stubGlobal('readBody', async () => input)
  vi.stubGlobal('createError', (opts: object) => Object.assign(new Error('Invalid research input'), opts))
  vi.doMock('@db', () => ({ useDb: () => db }))
  const get = (await import('../server/api/roster/uscc-research.get')).default
  const post = (await import('../server/api/roster/uscc-research.post')).default
  server = await startEvidenceServer({ db, apiToken: token, getRoutes: {}, routes: {
    '/api/roster/uscc-research': async request => {
      input = request.method === 'POST' ? request.body as Record<string, unknown> : request.query
      return { status: 200, body: await (request.method === 'POST' ? post : get)({} as never) }
    },
  } })
  const client = createRosterImportClient({ baseUrl: server.baseUrl, token })
  const result = await client.commit({ idempotencyKey: 'synthetic-131-targets', sourceKind: 'announcement', sourceIdentity: 'synthetic/131', payload: {
    announcement: { sourceDocument: { source: 'jxj', title: 'Synthetic announcement' }, records: [
      { enterprise: { name, district: '镇海区' }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year: 2024, evidence: [{ sourceFile: 'synthetic/131.pdf', page: 7, listNo: 3 }] }] },
      { enterprise: { name: canonicalName, uscc }, titleCode: 'specialized_sme', events: [] },
      { enterprise: { name: '宁波合成未知文创有限公司' }, titleCode: 'innovative_sme', events: [] },
    ] },
  } })
  expect(result).toMatchObject({ status: 'committed', summary: { failed: 0 } })
  const res = await fetch(server.baseUrl + '/api/roster/uscc-research?q=' + encodeURIComponent(name))
  targetId = (await res.json()).checklist.rows[0].enterpriseId
  const evidence = await client.commit({ idempotencyKey: 'synthetic-131-evidence', sourceKind: 'alias_evidence', sourceIdentity: 'synthetic/131', payload: {
    platformQueries: [
      { interface: 'business_list', queryKey: '\u200b' + uscc.toLowerCase() + '\u3000', rdjb: '3', queriedAt: '2026-10-20T01:00:00Z', status: 'success', rawResponse: 'selected original'.repeat(65536), relations: [
        { sequenceNo: 1, nameRaw: '别的主体', usccRaw: uscc, rawFields: { original: 'selected original'.repeat(65536) } },
        { sequenceNo: 2, nameRaw: name, usccRaw: uscc, relationKey: 'selected-second', rawFields: { original: 'selected original'.repeat(65536) } },
        { sequenceNo: 3, nameRaw: name, usccRaw: uscc, relationKey: 'selected-third' },
      ] },
      ...(['failed', 'partial', 'not_queried'] as const).map((status, i) => ({ interface: 'apply_list' as const, queryKey: 'name:' + name, queriedAt: `2026-10-20T02:00:0${i}Z`, status, relations: i === 1 ? [{ sequenceNo: 1, nameRaw: name }, { sequenceNo: 2, nameRaw: name }] : [] })),
    ],
  } })
  expect(evidence).toMatchObject({ status: 'committed', summary: { failed: 0 } })
}, 30000)

afterAll(async () => {
  if (process.env.USCC_131_RESOURCE_PATH) writeFileSync(process.env.USCC_131_RESOURCE_PATH, JSON.stringify({ sha: process.env.USCC_131_SHA, note: 'Synthetic local HTTP route tests; sampled heap/RSS after request, no peak or SLO claim', measurements }, null, 2))
  await server?.close(); vi.unstubAllGlobals(); vi.doUnmock('@db'); db.$client.close(); rmSync(dir, { recursive: true, force: true }) })

async function research(method: 'GET' | 'POST', extra = {}) {
  bytes = 0; statements = 0; measuring = true
  const start = performance.now()
  try {
    const response = await fetch(server.baseUrl + '/api/roster/uscc-research' + (method === 'GET' ? '?q=' + encodeURIComponent(name) + '&pageSize=1' : ''), method === 'POST' ? { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q: name, pageSize: 1, enterpriseIds: [targetId], ...extra }) } : {})
    expect(response.status).toBe(200)
    return await response.json()
  } finally {
    measuring = false
    const memory = process.memoryUsage()
    measurements.push({ method, bytes, statements, elapsedMs: performance.now() - start, heapAfter: memory.heapUsed, rssAfter: memory.rss })
  }
}

it('GET preserves target evidence and multi-relation selection without materializing unrelated archive bytes at 1x 2x 5x', async () => {
  const expected = await research('GET')
  expect(expected).toMatchObject({ checklist: { counts: { total: 1 }, rows: [{ enterpriseId: targetId, evidence: [{ page: 7 }], queries: [{ status: 'failed', relationCount: 0 }, { status: 'partial', relationCount: 2 }, { status: 'not_queried', relationCount: 0 }] }] }, plan: { counts: { targets: 1, filled: 1 }, ready: [{ uscc, evidence: { sequenceNo: 2, relationKey: 'selected-second' } }] } })
  const expectedPost = await research('POST')
  const client = createRosterImportClient({ baseUrl: server.baseUrl, token })
  let previousScale = 0
  for (const scale of [1, 2, 5]) {
    const imported = await client.commit({ idempotencyKey: `synthetic-131-growth-${scale}`, sourceKind: 'alias_evidence', sourceIdentity: 'synthetic/131', payload: { platformQueries: Array.from({ length: (scale - previousScale) * 4 }, (_, i) => ({ interface: 'apply_list', queryKey: `unrelated:${scale}:${i}`, queriedAt: '2026-10-20T03:00:00Z', status: 'success', rawResponse: 'unrelated original'.repeat(32768), relations: [{ sequenceNo: 1, nameRaw: '无关企业', rawFields: { original: 'unrelated original'.repeat(32768) } }] })) } })
    expect(imported).toMatchObject({ status: 'committed', summary: { failed: 0 } })
    expect(await research('GET')).toEqual(expected)
    expect(bytes).toBeLessThan(64 * 1024)
    expect(statements).toBeLessThan(45)
    expect(await research('POST')).toEqual(expectedPost)
    expect(bytes).toBeLessThan(64 * 1024)
    expect(statements).toBeLessThan(45)
    previousScale = scale
  }
}, 30000)

it('POST bounds evidence reads for explicit platform claims and preserves scope region conflicts and read-only replay', async () => {
  const claim = { enterpriseId: targetId, uscc }
  const first = await research('POST', { platformClaims: [claim] })
  expect(first).toMatchObject({ checklist: { counts: { total: 1 } }, plan: { counts: { targets: 1, filled: 1, byRoute: { platform_claim: 1 } }, ready: [{ route: 'platform_claim', evidence: { sequenceNo: 2, relationKey: 'selected-second' } }] } })
  expect(bytes).toBeLessThan(64 * 1024)
  expect(statements).toBeLessThan(45)
  expect(await research('POST', { platformClaims: [claim] })).toEqual(first)
  const region = await research('POST', { claims: [{ enterpriseId: targetId, uscc, source: { url: 'https://example.test/synthetic', checkedOn: '2026-10-20', basis: 'Explicit synthetic region', name, region: '杭州市' } }] })
  expect(region.plan).toMatchObject({ counts: { targets: 1, filled: 0, conflict: 1 }, request: null, pending: [{ code: 'region_mismatch' }] })
  const outOfScope = await research('POST', { enterpriseIds: [], platformClaims: [claim] })
  expect(outOfScope.plan).toMatchObject({ counts: { targets: 1, filled: 0, manual: 1 }, request: null, pending: [{ code: 'out_of_scope' }] })
  // Planning never executes the merge or overwrites the existing holder's code.
  expect(await research('GET')).toMatchObject({ checklist: { counts: { total: 1 }, rows: [{ enterpriseId: targetId }] }, plan: { ready: [{ uscc }] } })
})

it('GET batches evidence and holder lookup for many targets sharing a candidate without losing any target', async () => {
  const labels = [...'甲乙丙丁戊己庚辛壬癸子丑']
  const holderUscc = '91330201753252106U'
  const client = createRosterImportClient({ baseUrl: server.baseUrl, token })
  const imported = await client.commit({ idempotencyKey: 'synthetic-131-batch-targets', sourceKind: 'announcement', sourceIdentity: 'synthetic/131/batch', payload: {
    announcement: { sourceDocument: { source: 'jxj', title: 'Synthetic batch' }, records: [
      ...labels.map(label => ({ enterprise: { name: `宁波批量${label}有限公司` }, titleCode: 'specialized_sme', events: [] })),
      { enterprise: { name: `宁波${labels.map(label => '批量' + label).join('')}股份有限公司`, uscc: holderUscc }, titleCode: 'specialized_sme', events: [] },
    ] },
    platformQueries: [{ interface: 'business_list', queryKey: holderUscc, rdjb: '3', queriedAt: '2026-10-20T04:00:00Z', status: 'success', relations: labels.map((label, i) => ({ sequenceNo: i + 1, nameRaw: `宁波批量${label}有限公司`, usccRaw: holderUscc })) }],
  } })
  expect(imported).toMatchObject({ status: 'committed', summary: { failed: 0 } })
  bytes = 0; statements = 0; measuring = true
  let result
  try {
    const response = await fetch(server.baseUrl + '/api/roster/uscc-research?q=' + encodeURIComponent('批量') + '&pageSize=1')
    expect(response.status).toBe(200)
    result = await response.json()
  } finally { measuring = false }
  expect(result.checklist).toMatchObject({ counts: { total: 12 }, pageSize: 1 })
  expect(result.checklist.rows).toHaveLength(1)
  expect(result.plan.counts).toMatchObject({ targets: 12, filled: 12, ready: 12 })
  expect(result.plan.ready.map((row: { targetName: string }) => row.targetName)).toEqual(labels.map(label => `宁波批量${label}有限公司`))
  expect(result.plan.ready.map((row: { evidence: { sequenceNo: number } }) => row.evidence.sequenceNo)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  expect(statements).toBeLessThan(25)
})

it('GET keeps confirmed-alias filters current membership multiple titles and same-name subject conflicts', async () => {
  const client = createRosterImportClient({ baseUrl: server.baseUrl, token })
  const subject = '宁波合成同名有限公司'
  const filterName = '宁波合成筛选机械有限公司'
  const codes = ['91330213MA2CL6FP21', '91330206793007818K']
  const imported = await client.commit({ idempotencyKey: 'synthetic-131-semantic', sourceKind: 'announcement', sourceIdentity: 'synthetic/131/semantic', payload: {
    announcement: { sourceDocument: { source: 'jxj', title: 'Synthetic semantic' }, records: [
      { enterprise: { name: subject }, titleCode: 'specialized_sme', events: [] },
      ...['合成平台已移出', '合成平台仍在册'].map(name => ({ enterprise: { name }, source: 'miit' as const, titleCode: 'innovative_sme', events: [] })),
      { enterprise: { name: filterName }, titleCode: 'little_giant', events: [] },
      { enterprise: { name: filterName }, titleCode: 'innovative_sme', events: [] },
      ...codes.map((code, i) => ({ enterprise: { name: i ? '宁波合成同名集团有限公司' : '宁波合成同名股份有限公司', uscc: code }, titleCode: 'specialized_sme', events: [] })),
    ] },
    aliases: [
      { enterpriseName: filterName, name: '合成已确认检索词', sourceKind: 'manual', verificationStatus: 'confirmed' },
      { enterpriseName: filterName, name: '合成待核检索词', sourceKind: 'manual', verificationStatus: 'pending' },
    ],
    platformQueries: codes.map(code => ({ interface: 'apply_list', queryKey: code, queriedAt: '2026-10-20T05:00:00Z', status: 'success', relations: [{ sequenceNo: 1, nameRaw: subject, usccRaw: code }] })),
  } })
  expect(imported).toMatchObject({ status: 'committed', summary: { failed: 0 } })
  for (const [i, year] of [2025, 2026].entries()) {
    const snapshot = await client.commit({ idempotencyKey: `synthetic-131-snapshot-${year}`, sourceKind: 'platform_export', sourceIdentity: 'synthetic/131/snapshot', payload: { exportSnapshot: { titleCode: 'innovative_sme', year, collectedOn: `${year}-10-20`, originalFilename: 'synthetic.xlsx', sha256: String(i + 1).repeat(64), rows: [{ sourceRowNo: 1, nameRaw: i ? '合成平台仍在册' : '合成平台已移出' }] } } })
    expect(snapshot).toMatchObject({ status: 'committed', summary: { failed: 0 } })
  }
  const read = async (query: string) => {
    const response = await fetch(server.baseUrl + '/api/roster/uscc-research?' + query)
    expect(response.status).toBe(200)
    return response.json()
  }
  const alias = await read('q=' + encodeURIComponent('合成已确认检索词'))
  expect(alias.checklist).toMatchObject({ counts: { total: 1 }, rows: [{ name: filterName, titles: ['little_giant', 'innovative_sme'], aliasNames: ['合成已确认检索词'] }] })
  const conflict = await read('q=' + encodeURIComponent(subject))
  expect(conflict.plan).toMatchObject({ counts: { targets: 1, filled: 0, conflict: 1 }, request: null, pending: [{ code: 'multiple_subjects' }] })
  expect(conflict.plan.pending[0].candidates.map((row: { uscc: string }) => row.uscc)).toEqual(codes)
  expect((await read('q=' + encodeURIComponent('合成待核检索词'))).checklist.counts.total).toBe(0)
  expect((await read('q=' + encodeURIComponent('合成平台'))).checklist.rows.map((row: { name: string }) => row.name)).toEqual(['合成平台仍在册'])
  expect((await read('q=' + encodeURIComponent(filterName) + '&title=innovative_sme&page=2&pageSize=1')).checklist).toMatchObject({ rows: [], counts: { total: 1, titles: { little_giant: 1, innovative_sme: 1 } }, page: 2 })
})

it('GET and POST retain invalid-input HTTP errors', async () => {
  expect((await fetch(server.baseUrl + '/api/roster/uscc-research?title=unknown')).status).toBe(400)
  expect((await fetch(server.baseUrl + '/api/roster/uscc-research', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ claims: {} }) })).status).toBe(400)
})
