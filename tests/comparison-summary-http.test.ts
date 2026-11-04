import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, createRouter, createError, defineEventHandler, getQuery, readBody, setHeader, setResponseStatus, toNodeListener } from 'h3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { useDb } from '../db'
import { handleRosterImportRequest } from '../server/utils/roster-import-http'
import { eq } from 'drizzle-orm'
import { enterprise } from '../db/schema'
import { reconcileKey } from '../lib/reconcile'
import { saveDecision102 } from '../server/utils/decision-lifecycle-102'
import { readQueryAssessment } from '../lib/roster/query-assessment'

const dir = mkdtempSync(join(tmpdir(), 'comparison-summary-http-'))
const db = useDb({ dbPath: join(dir, 'fixture.db') })
const curatedPath = join(dir, 'curated.json')
const reconcilePath = join(dir, 'reconcile.json')
const uscc = '91330211255994457P'
const raw = 'SYNTHETIC_RELATION_'.repeat(12000)
let server: Server
let base: string
let alphaId: number

async function get(query = '') {
  const response = await fetch(`${base}/api/comparison${query}`)
  expect(response.status).toBe(200)
  return response.json()
}

beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  vi.stubGlobal('getQuery', getQuery)
  vi.stubGlobal('createError', createError)
  vi.stubGlobal('readBody', readBody)
  vi.stubGlobal('setHeader', setHeader)
  vi.stubGlobal('setResponseStatus', setResponseStatus)
  vi.stubGlobal('useRuntimeConfig', () => ({ curatedPath, reconcilePath, apiToken: 'synthetic-token' }))
  vi.doMock('@db', () => ({ useDb: () => db }))
  const handler = (await import('../server/api/comparison.get')).default
  const evidence = (await import('../server/api/platform/queries/[queryId]/evidence.get')).default
  const curate = (await import('../server/api/comparison/curated.patch')).default
  const router = createRouter()
  router.get('/api/comparison', handler)
  const { comparisonScopeProofRoute } = await import('../server/utils/comparison-scope-proof-route')
  router.post('/api/roster/comparison-scope-proofs/preflight', comparisonScopeProofRoute('preflight'))
  router.post('/api/roster/comparison-scope-proofs/commit', comparisonScopeProofRoute('commit'))
  router.get('/api/roster/comparison-scope-proofs/:id', comparisonScopeProofRoute('get', 'id'))
  router.get('/api/roster/comparison-scope-proofs/:id/audit', comparisonScopeProofRoute('audit', 'id'))
  router.patch('/api/comparison/curated', curate)
  router.get('/api/platform/queries/:queryId/evidence', evidence)
  router.post('/api/roster/import/commit', defineEventHandler(async event => {
    const response = await handleRosterImportRequest('commit', {
      method: 'POST', headers: { authorization: 'Bearer synthetic-test-token' }, body: await readBody(event),
    }, { db, apiToken: 'synthetic-test-token' })
    return response.body
  }))
  const app = createApp().use(router)
  server = createServer(toNodeListener(app))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  base = `http://127.0.0.1:${address.port}`
  const response = await fetch(`${base}/api/roster/import/commit`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      idempotencyKey: 'comparison-summary-synthetic', sourceKind: 'announcement', sourceIdentity: 'synthetic/comparison',
      payload: {
        announcement: { sourceDocument: { source: 'jxj', title: 'Synthetic comparison' }, records: [
          { enterprise: { name: 'Alpha企业', uscc, district: '镇海区' }, titleCode: 'specialized_sme', events: [] },
          { enterprise: { name: 'Beta企业', district: '余姚市' }, titleCode: 'specialized_sme', events: [] },
          { enterprise: { name: 'Gamma企业' }, titleCode: 'innovative_sme', events: [] },
        ] },
        platformQueries: [
          { interface: 'business_list', queryKey: uscc, rdjb: '2', queriedAt: '2026-10-20T00:00:00Z', status: 'success', rawResponse: 'SYNTHETIC_RAW', relations: [
            { sequenceNo: 1, nameRaw: 'Alpha企业', usccRaw: uscc, matchBasis: 'uscc', verificationStatus: 'confirmed', rawFields: { large: raw } },
            { sequenceNo: 2, nameRaw: 'Unassigned候选', matchBasis: 'none', verificationStatus: 'pending', rawFields: { original: 'SYNTHETIC_PENDING' } },
          ] },
          { interface: 'apply_list', queryKey: 'name:Gamma企业', queriedAt: '2026-10-20T00:00:00Z', status: 'failed', failureReason: 'synthetic failure' },
          { interface: 'business_list', queryKey: 'name:Gamma企业', rdjb: '1', queriedAt: '2026-10-20T00:00:01Z', status: 'no_record' },
        ],
        aliases: [
          { uscc, name: 'Alpha旧名', sourceKind: 'manual', verificationStatus: 'confirmed' },
          { uscc, name: '待核旧名', sourceKind: 'manual', verificationStatus: 'pending' },
        ],
        differences: [{ uscc, titleCode: 'specialized_sme', direction: 'missing_in_miit', status: 'confirmed_reason', reasonCode: 'platform_stale', measureCode: 'mark_platform_snapshot', verificationStatus: 'confirmed', recordedAt: '2026-10-20T01:00:00Z' }],
      },
    }),
  })
  expect(await response.json()).toMatchObject({ status: 'committed' })
  const legacy = await get()
  alphaId = legacy.rows.find((row: { name: string }) => row.name === 'Alpha企业').enterpriseId
  writeFileSync(reconcilePath, JSON.stringify({ generatedAt: '2026-10-20', entries: [{
    key: reconcileKey({ uscc, nameNorm: 'Alpha企业', titleCode: 'specialized_sme', direction: 'missing_in_miit' }),
    titleCode: 'specialized_sme', direction: 'missing_in_miit', explanation: { code: 'on_platform', note: 'Synthetic cache' }, evidence: { records: [{ original: 'SYNTHETIC_CACHE_'.repeat(6000) }] },
  }] }))
}, 30000)

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

describe('comparison lightweight list public HTTP seam', () => {
  it('keeps the legacy default and explicit full response including complete relation and cache evidence', async () => {
    const legacy = await get()
    expect(await get('?view=full')).toEqual(legacy)
    expect(Object.keys(legacy).sort()).toEqual(['counts', 'curatedCounts', 'platform', 'reconcile', 'rows', 'total'])
    const alpha = legacy.rows.find((row: { enterpriseId: number }) => row.enterpriseId === alphaId)
    expect(alpha.platform.queries[0].relations[0].rawFields.large).toBe(raw)
    expect(alpha.platform.queries[0].relations).toHaveLength(2)
    expect(alpha.platform.queries[0].relations[1]).toMatchObject({ nameRaw: 'Unassigned候选', matchBasis: 'none', verificationStatus: 'pending' })
    expect(alpha.explanation.evidence.records[0].original).toBe('SYNTHETIC_CACHE_'.repeat(6000))
  })

  it('opts into a scalar summary with unchanged row identity, counts and disposition without evidence payloads', async () => {
    const legacy = await get()
    const summary = await get('?view=summary&pageSize=1')
    expect(summary).toMatchObject({ view: 'summary', total: 3, counts: legacy.counts, curatedCounts: legacy.curatedCounts, platform: legacy.platform, reconcile: legacy.reconcile })
    expect(summary.rows).toHaveLength(1)
    expect(summary.rows[0]).toMatchObject({ enterpriseId: alphaId, name: 'Alpha企业', titleCode: 'specialized_sme', direction: 'missing_in_miit', evidenceIncluded: false,
      platform: { aliasCount: 2, confirmedAliasCount: 1, queryCount: 1, sourceRelationCount: 2, disposition: { status: 'confirmed_reason', reasonCode: 'platform_stale', measureCode: 'mark_platform_snapshot', verificationStatus: 'confirmed' } },
      explanation: { code: 'on_platform' },
    })
    expect(summary.rows[0].platform).not.toHaveProperty('queries')
    expect(summary.rows[0].platform).not.toHaveProperty('aliases')
    expect(summary.rows[0].explanation).not.toHaveProperty('evidence')
    expect(JSON.stringify(summary)).not.toContain('SYNTHETIC_')
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThan(4096)
  })

  it('retrieves the exact full comparison row and every original relation through the advertised evidence path', async () => {
    const summary = await get('?view=summary')
    const alpha = summary.rows.find((row: { enterpriseId: number }) => row.enterpriseId === alphaId)
    const detail = await get(alpha.detailUrl.slice('/api/comparison'.length))
    expect(detail.total).toBe(1)
    expect(detail.rows).toHaveLength(1)
    expect(detail.rows[0]).toEqual((await get()).rows.find((row: { enterpriseId: number }) => row.enterpriseId === alphaId))
    const queryId = detail.rows[0].platform.queries[0].id
    const ids = await (await fetch(`${base}/api/platform/queries/${queryId}/evidence?field=relations&pageSize=1`)).json()
    expect(ids).toMatchObject({ total: 2, rows: [{ sequenceNo: 1 }] })
    const secondPage = await (await fetch(`${base}/api/platform/queries/${queryId}/evidence?field=relations&pageSize=1&page=2`)).json()
    expect(secondPage).toMatchObject({ total: 2, rows: [{ sequenceNo: 2 }] })
    const pendingChunk = await (await fetch(`${base}/api/platform/queries/${queryId}/evidence?field=relation&relationId=${secondPage.rows[0].id}`)).json()
    expect(JSON.parse(Buffer.from(pendingChunk.data, 'base64').toString('utf8'))).toMatchObject({ enterpriseId: null, verificationStatus: 'pending', rawFields: { original: 'SYNTHETIC_PENDING' } })
    const chunks: Buffer[] = []
    let offset = 0
    for (;;) {
      const response = await fetch(`${base}/api/platform/queries/${queryId}/evidence?field=relation&relationId=${ids.rows[0].id}&offset=${offset}&length=65536`)
      expect(response.status).toBe(200)
      const chunk = await response.json()
      chunks.push(Buffer.from(chunk.data, 'base64'))
      offset += chunk.byteLength
      if (!chunk.hasMore) break
    }
    expect(JSON.parse(Buffer.concat(chunks).toString('utf8')).rawFields.large).toBe(raw)
  })

  it('rejects invalid summary selectors and never widens a missing exact enterprise into the global list', async () => {
    for (const query of ['?view=unknown', '?view=summary&view=full', '?enterpriseId=0', '?enterpriseId=1.5', '?enterpriseId=abc']) {
      expect((await fetch(`${base}/api/comparison${query}`)).status).toBe(400)
    }
    expect(await get('?view=summary&enterpriseId=999999')).toMatchObject({ total: 0, rows: [], platform: { withEvidence: 0, withExplanation: 0, withoutExplanation: 0 } })
    expect(await get('?view=full&enterpriseId=999999')).toMatchObject({ total: 0, rows: [] })
  })

  it('preserves normalized confirmed-alias search, district filters, order, empty pages and global counts', async () => {
    const global = await get()
    for (const query of ['q=Alpha%20旧名', 'q=94457p', 'q=待核旧名', 'district=余姚市', 'title=innovative_sme', 'direction=extra_in_miit', 'page=2&pageSize=1', 'page=99&pageSize=1']) {
      const full = await get(`?${query}`)
      const summary = await get(`?view=summary&${query}`)
      expect(summary.rows.map((row: { enterpriseId: number }) => row.enterpriseId)).toEqual(full.rows.map((row: { enterpriseId: number }) => row.enterpriseId))
      expect(summary).toMatchObject({ total: full.total, counts: global.counts, curatedCounts: global.curatedCounts, platform: full.platform, reconcile: full.reconcile })
    }
    expect((await get('?view=summary&q=Alpha%20旧名&district=镇海区')).rows).toMatchObject([{ enterpriseId: alphaId }])
    expect((await get('?view=summary&q=待核旧名')).rows).toEqual([])
  })

  it('does not infer disposition from failed or no-record queries and keeps absent evidence distinct', async () => {
    const full = await get()
    const summary = await get('?view=summary')
    const gamma = summary.rows.find((row: { name: string }) => row.name === 'Gamma企业')
    const beta = summary.rows.find((row: { name: string }) => row.name === 'Beta企业')
    expect(gamma.platform).toMatchObject({ queryCount: 2, sourceRelationCount: 0, disposition: { explanationId: null, status: 'not_queried', verificationStatus: 'pending' } })
    expect(beta.platform).toMatchObject({ queryCount: 0, sourceRelationCount: 0, disposition: { explanationId: null, status: 'not_queried' } })
    expect(full.rows.find((row: { name: string }) => row.name === 'Gamma企业').platform.queries.map((query: { status: string }) => query.status).sort()).toEqual(['failed', 'no_record'])
    expect(summary.platform).toEqual({ withEvidence: 2, withExplanation: 1, withoutExplanation: 2 })
  })

  it('preserves curated exclusion and notes in full detail while summary counts stay global', async () => {
    const curate = async (curated: boolean) => {
      const response = await fetch(`${base}/api/comparison/curated`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nameNorm: 'Beta企业', titleCode: 'specialized_sme', direction: 'missing_in_miit', curated, note: 'Synthetic curation note' }) })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ curated })
    }
    await curate(true)
    try {
      const summary = await get('?view=summary')
      expect(summary.total).toBe(2)
      expect(summary.curatedCounts.specialized_sme.missing_in_miit).toBe(1)
      const included = await get('?view=summary&showCurated=true&district=余姚市')
      expect(included).toMatchObject({ total: 1, counts: summary.counts, curatedCounts: summary.curatedCounts })
      expect(included.rows[0]).toMatchObject({ name: 'Beta企业', curated: true })
      expect(included.rows[0]).not.toHaveProperty('note')
      const detail = await get(included.rows[0].detailUrl.slice('/api/comparison'.length))
      expect(detail.rows).toMatchObject([{ name: 'Beta企业', note: 'Synthetic curation note' }])
    } finally { await curate(false) }
  })

  it('keeps a fixed summary unchanged when unrelated archived raw data grows through the import API', async () => {
    const before = await get('?view=summary&pageSize=50')
    const response = await fetch(`${base}/api/roster/import/commit`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        idempotencyKey: 'comparison-summary-unrelated', sourceKind: 'alias_evidence', sourceIdentity: 'synthetic/unrelated',
        payload: { platformQueries: [{ interface: 'apply_list', queryKey: 'name:Unrelated', queriedAt: '2026-10-20T00:00:00Z', status: 'partial', rawResponse: 'UNRELATED_ARCHIVE'.repeat(60000), relations: [
          { sequenceNo: 1, nameRaw: 'Unrelated', matchBasis: 'none', verificationStatus: 'pending', rawFields: { large: 'UNRELATED_FIELDS'.repeat(60000) } },
        ] }] },
      }),
    })
    expect(await response.json()).toMatchObject({ status: 'committed' })
    expect(await get('?view=summary&pageSize=50')).toEqual(before)
  })
  it('matches full query membership for legacy stored USCC without normalizing archived query keys or inferring ownership', async () => {
    const canonical = '91330201753252106U'
    const response = await fetch(`${base}/api/roster/import/commit`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        idempotencyKey: 'comparison-summary-legacy-uscc', sourceKind: 'announcement', sourceIdentity: 'synthetic/legacy-uscc',
        payload: {
          announcement: { sourceDocument: { source: 'jxj', title: 'Synthetic legacy compatibility' }, records: [
            { enterprise: { name: 'Legacy统代企业', uscc: canonical }, titleCode: 'specialized_sme', events: [] },
          ] },
          platformQueries: [
            { interface: 'apply_list', queryKey: canonical, queriedAt: '2026-10-20T00:00:00Z', status: 'failed', failureReason: 'synthetic failure' },
            { interface: 'business_list', queryKey: canonical, rdjb: '2', queriedAt: '2026-10-20T00:00:01Z', status: 'no_record' },
            { interface: 'business_list', queryKey: ' 91330201753252106u ', rdjb: '2', queriedAt: '2026-10-20T00:00:02Z', status: 'no_record' },
          ],
        },
      }),
    })
    const receipt = await response.json()
    expect(receipt, JSON.stringify(receipt)).toMatchObject({ status: 'committed' })
    const initial = await get('?q=Legacy统代企业')
    const enterpriseId = initial.rows[0].enterpriseId
    // Exact test-only exception: current import always canonicalizes enterprise USCC.
    // Reproduce a historical stored value only in this ephemeral API-created fixture;
    // all query creation and both read paths remain public API behavior.
    db.update(enterprise).set({ usccNorm: ' \t91330201\u200b753252106u\u3000' }).where(eq(enterprise.id, enterpriseId)).run()
    const summary = await get('?view=summary&q=Legacy统代企业')
    const full = await get('?view=full&q=Legacy统代企业')
    expect(full.rows).toHaveLength(1)
    expect(full.rows[0].platform.queries.map((query: { status: string }) => query.status).sort()).toEqual(['failed', 'no_record'])
    expect(full.rows[0].platform.queries.every((query: { relations: unknown[] }) => query.relations.length === 0)).toBe(true)
    expect(summary.rows[0].platform).toMatchObject({ queryCount: 2, sourceRelationCount: 0, disposition: { status: 'not_queried', explanationId: null } })
    expect(summary.platform).toEqual(full.platform)
    expect(summary.platform.withEvidence).toBe(1)
  })


})

it('preserves failed coverage and withdrawn decisions in the bounded list assessment', async () => {
  const names = ['StateRegression失败', 'StateRegression撤回', 'StateRegression未查询', 'StateRegression其他称号']
  const response = await fetch(`${base}/api/roster/import/commit`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      idempotencyKey: 'comparison-summary-state-regression', sourceKind: 'announcement', sourceIdentity: 'synthetic/state-regression',
      payload: {
        announcement: { sourceDocument: { source: 'jxj', title: 'Synthetic state regression' }, records: names.map(name => ({ enterprise: { name }, titleCode: 'specialized_sme', events: [] })) },
        platformQueries: [
          { interface: 'business_list', queryKey: `name:${names[0]}`, rdjb: '2', status: 'failed', failureReason: 'synthetic failure', queriedAt: '2026-10-21T00:00:00Z' },
          { interface: 'business_list', queryKey: `name:${names[3]}`, rdjb: '1', status: 'failed', failureReason: 'other title', queriedAt: '2026-10-21T00:00:00Z' },
        ],
      },
    }),
  })
  expect(await response.json()).toMatchObject({ status: 'committed' })
  const initial = await get('?view=summary&q=StateRegression')
  const withdrawnId = initial.rows.find((row: { name: string }) => row.name === names[1]).enterpriseId
  const scope = { enterpriseId: withdrawnId, titleCode: 'specialized_sme' as const, direction: 'missing_in_miit' as const }
  const metadata = { ...scope, actor: { type: 'agent' as const, id: 'synthetic' }, ruleVersion: 'synthetic', basis: 'Synthetic state regression', effectiveAt: '2026-10-21T00:00:00Z' }
  const active = saveDecision102(db, { ...metadata, action: 'replace', expectedCurrentId: null, idempotencyKey: 'summary-state-active', decision: { status: 'needs_review', measureCode: 'manual_review', verificationStatus: 'pending' } })
  expect((await get('?view=summary&q=StateRegression')).rows.find((row: { enterpriseId: number }) => row.enterpriseId === withdrawnId).assessment).toMatchObject({ assessment: 'decided' })
  expect(active.versionId).toEqual(expect.any(Number))
  saveDecision102(db, { ...metadata, action: 'withdraw', expectedCurrentId: Number(active.versionId), idempotencyKey: 'summary-state-withdraw' })
  const result = await get('?view=summary&q=StateRegression')
  expect(result.rows).toHaveLength(4)
  for (const row of result.rows) {
    const expected = readQueryAssessment(db, { enterpriseId: row.enterpriseId, titleCode: row.titleCode, direction: row.direction })
    expect(row.assessment).toEqual({ queryCoverage: { status: expected.queryCoverage.status }, assessment: expected.assessment, explanationValidity: { status: expected.explanationValidity.status } })
    expect(row.assessment).not.toHaveProperty('currentDecision')
    expect(row.assessment.queryCoverage).not.toHaveProperty('sources')
  }
  expect(result.rows.find((row: { name: string }) => row.name === names[0]).assessment.queryCoverage.status).toBe('failed')
  expect(result.rows.find((row: { name: string }) => row.name === names[1]).assessment).toMatchObject({ assessment: 'withdrawn', explanationValidity: { status: 'not_applicable' } })
  for (const name of names.slice(2)) expect(result.rows.find((row: { name: string }) => row.name === name).assessment.queryCoverage.status).toBe('not_queried')
})


it('473 same SQLite snapshot full HTTP shadow preserves pagination filters evidence IDs and states', async () => {
  const { ensurePlatformObservation } = await import('../server/utils/platform-business-record')
  const { platformRelation, platformQuery } = await import('../db/schema')
  // Archive bootstrap deliberately precedes the read-only public HTTP shadow.
  for (const [index, source] of (['apply_list', 'business_list', 'recognized_list'] as const).entries()) {
    const query = db.insert(platformQuery).values({ interface: source, queryKey: uscc, rdjb: '2', queriedAt: '2026-11-01T00:00:00Z', status: 'success' }).returning().get()
    db.insert(platformRelation).values({ queryId: query.id, sequenceNo: 1, relationKey: `473-${index}`, enterpriseId: alphaId, nameRaw: 'Alpha企业', usccRaw: uscc,
      matchBasis: 'uscc', verificationStatus: 'confirmed', rawFields: { id: `473-${index}`, qymc: 'Alpha企业', tyshxydm: uscc, cszt: '上游新状态', sblx: '申请', year: '2024', whpc: '2024-1' } }).run()
  }
  for (const r of db.select().from(platformRelation).all()) ensurePlatformObservation(db, r.id)
  const before = db.$client.prepare('select total_changes() n').get()
  db.$client.pragma('query_only=ON')
  try {
    for (const query of ['', '?pageSize=1&page=2', '?title=specialized_sme', '?q=Alpha', '?district=镇海区', '?direction=missing_in_miit', '?q=不存在', '?q=Legacy统代企业']) {
      vi.stubEnv('ROSTER_COMPARISON_TYPED_READ', 'legacy')
      const legacy = await get(query)
      vi.stubEnv('ROSTER_COMPARISON_TYPED_READ', 'typed')
      const typed = await get(query)
      expect(typed).toEqual(legacy)
    }
    expect(db.$client.prepare('select total_changes() n').get()).toEqual(before)
  } finally {
    db.$client.pragma('query_only=OFF')
    vi.unstubAllEnvs()
  }
})

it.each([
  { label: 'modeled null retains archived status and year', rawFields: { id: '473-null' }, expected: { status: '终审通过', year: 2024 } },
  { label: 'divergent source identity retains archived identity and ownership', rawFields: { id: '473-identity', qymc: 'Source Name', tyshxydm: '91330211000000001X' }, expected: { nameRaw: 'Archived Name', usccRaw: uscc } },
])('473 public HTTP compatibility: $label', async ({ rawFields, expected }) => {
  const { ensurePlatformObservation } = await import('../server/utils/platform-business-record')
  const { platformRelation, platformQuery } = await import('../db/schema')
  const query = db.insert(platformQuery).values({ interface: 'business_list', queryKey: uscc, rdjb: '2', queriedAt: rawFields.id === '473-null' ? '2026-11-02T00:00:00Z' : '2026-11-02T00:00:01Z', status: 'success' }).returning().get()
  const relation = db.insert(platformRelation).values({ queryId: query.id, sequenceNo: 1, enterpriseId: alphaId,
    nameRaw: 'Archived Name', usccRaw: uscc, status: '终审通过', year: 2024,
    matchBasis: 'uscc', verificationStatus: 'confirmed', rawFields }).returning().get()
  expect(ensurePlatformObservation(db, relation.id).versionId).toEqual(expect.any(Number))
  db.$client.pragma('query_only=ON')
  try {
    vi.stubEnv('ROSTER_COMPARISON_TYPED_READ', 'legacy')
    const legacy = await get(`?enterpriseId=${alphaId}`)
    vi.stubEnv('ROSTER_COMPARISON_TYPED_READ', 'typed')
    const typed = await get(`?enterpriseId=${alphaId}`)
    const evidence = typed.rows[0].platform.queries.find((q: { id: number }) => q.id === query.id)
    expect(evidence.relations).toMatchObject([{ id: relation.id, queryId: query.id, normalizationConflicts: [], ...expected }])
    expect(typed).toEqual(legacy)
    const response = await fetch(`${base}/api/platform/queries/${query.id}/evidence?field=relation&relationId=${relation.id}`)
    expect(response.status).toBe(200)
    const chunk = await response.json()
    expect(JSON.parse(Buffer.from(chunk.data, 'base64').toString('utf8'))).toMatchObject({ id: relation.id, queryId: query.id, enterpriseId: alphaId, nameRaw: 'Archived Name', usccRaw: uscc, status: '终审通过', year: 2024, rawFields })
  } finally {
    db.$client.pragma('query_only=OFF')
    vi.unstubAllEnvs()
  }
})


it('473 same-input HTTP shadow retains proof IDs and append-only audit IDs', async () => {
  const schema = await import('../db/schema')
  const file = db.insert(schema.storedFile).values({ relPath: 'synthetic/473.pdf', filename: '473.pdf', ext: 'pdf', bytes: 8, sha256: 'a'.repeat(64), source: 'jxj', kind: 'announcement' }).returning().get()
  const doc = db.insert(schema.sourceDocument).values({ source: 'jxj', title: '473 synthetic proof', path: file.relPath }).returning().get()
  const record = db.select().from(schema.record).all().find(r => r.enterpriseId === alphaId)!
  const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2024 }).returning().get()
  db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: doc.path, page: 1, listNo: 1 }).run()
  const request = { idempotencyKey: '473-proof', sourceIdentity: 'synthetic/473-proof', actor: { type: 'agent', id: 'synthetic' }, basis: 'Synthetic complete announcement scope reviewed', ruleId: 'manual-scope', ruleVersion: '1', operations: [{ action: 'create', kind: 'official_coverage', status: 'confirmed', evidence: { titleCode: 'specialized_sme', fromYear: 2024, throughYear: 2024, enterpriseIds: null, fullRange: true, sourceDocuments: [{ id: doc.id, fileId: file.id, sha256: file.sha256, reference: { field: 'record_evidence.source_file', page: 1, listNo: 1 } }] } }] }
  const post = async (action: string, body: unknown) => {
    const response = await fetch(`${base}/api/roster/comparison-scope-proofs/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-token' }, body: JSON.stringify(body) })
    expect(response.status).toBe(200)
    return response.json()
  }
  const plan = await post('preflight', request)
  const receipt = await post('commit', { request, planHash: plan.planHash })
  expect(receipt.proofIds).toHaveLength(1)
  const id = receipt.proofIds[0]
  const snapshots: unknown[] = []
  db.$client.pragma('query_only=ON')
  try {
    for (const mode of ['legacy', 'typed']) {
      vi.stubEnv('ROSTER_COMPARISON_TYPED_READ', mode)
      await get(`?enterpriseId=${alphaId}`)
      const proofResponse = await fetch(`${base}/api/roster/comparison-scope-proofs/${id}`)
      const auditResponse = await fetch(`${base}/api/roster/comparison-scope-proofs/${id}/audit`)
      expect(proofResponse.status).toBe(200)
      expect(auditResponse.status).toBe(200)
      const proof = await proofResponse.json()
      const audit = await auditResponse.json()
      expect(proof).toMatchObject({ id, status: 'confirmed', valid: true, revision: 2 })
      expect(audit.rows.map((r: { toStatus: string }) => r.toStatus)).toEqual(['candidate', 'confirmed'])
      expect(audit.rows.every((r: { id: number }) => Number.isInteger(r.id))).toBe(true)
      snapshots.push({ proof, audit })
    }
    expect(snapshots[1]).toEqual(snapshots[0])
  } finally {
    db.$client.pragma('query_only=OFF')
    vi.unstubAllEnvs()
  }
})

it.each(['apply_list', 'business_list', 'recognized_list'] as const)('473 HTTP archive seam retains %s conflicts unmodeled fields and null identities', async (source) => {
  const { ensurePlatformObservation } = await import('../server/utils/platform-business-record')
  const { platformRelation, platformQuery } = await import('../db/schema')
  const query = db.insert(platformQuery).values({ interface: source, queryKey: uscc, rdjb: '2', queriedAt: '2026-11-04T00:00:00Z', status: 'success' }).returning().get()
  const rawFields = { id: 'archive-seam', qymc: 'Source Identity', cszt: '终审通过', year: '2024', szsfmc: '浙江省' }
  const relation = db.insert(platformRelation).values({ queryId: query.id, sequenceNo: 1, enterpriseId: alphaId,
    nameRaw: null, usccRaw: null, aliasNameRaw: 'Archived Alias', status: '已退回', year: 2023,
    matchBasis: 'name', verificationStatus: 'pending', rawFields }).returning().get()
  for (const projected of [false, true]) {
    if (projected) ensurePlatformObservation(db, relation.id)
    db.$client.pragma('query_only=ON')
    try {
      vi.stubEnv('ROSTER_COMPARISON_TYPED_READ', 'legacy')
      const legacy = await get(`?enterpriseId=${alphaId}`)
      vi.stubEnv('ROSTER_COMPARISON_TYPED_READ', 'typed')
      const typed = await get(`?enterpriseId=${alphaId}`)
      expect(typed).toEqual(legacy)
      const row = typed.rows[0].platform.queries.find((q: { id: number }) => q.id === query.id).relations[0]
      expect(row).toMatchObject({ id: relation.id, queryId: query.id, nameRaw: null, usccRaw: null, aliasNameRaw: 'Archived Alias', rawFields,
        status: source === 'recognized_list' ? '已退回' : null, year: source === 'recognized_list' ? 2023 : null })
      expect(row.normalizationConflicts).toEqual(source === 'recognized_list' ? [] : [
        { field: 'status', storedValue: '已退回', rawValue: '终审通过' },
        { field: 'year', storedValue: 2023, rawValue: 2024 },
      ])
    } finally {
      db.$client.pragma('query_only=OFF')
      vi.unstubAllEnvs()
    }
  }
})
