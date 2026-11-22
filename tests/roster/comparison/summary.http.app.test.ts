import { submitNewFixtureAnnouncement } from '../imports/fixtures/reviewed-announcement'
import { comparisonAppFixture } from './fixtures/comparison-app'
import { createRosterImportClient, type RosterImportRequest } from '../../../layers/sme-roster/lib/roster-import-client'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { reconcileKey } from '../../../layers/sme-roster/lib/reconcile'

const dir = mkdtempSync(join(tmpdir(), 'comparison-summary-http-'))
const uscc = '91330211255994457P'
const raw = 'SYNTHETIC_RELATION_'.repeat(12000)
const token = 'synthetic-comparison-summary'
const { app, reconcilePath } = comparisonAppFixture(dir, token)
const imported = (request: RosterImportRequest) => (request.payload.announcement
  ? submitNewFixtureAnnouncement(app.url(''), token, request)
  : createRosterImportClient({ baseUrl: app.url(''), token }).commit(request))
let alphaId: number

async function get(query = '') {
  const response = await fetch(app.url(`/api/comparison${query}`))
  expect(response.status).toBe(200)
  return response.json()
}

beforeAll(async () => {
  await app.start()
  const receipt = await imported({
    idempotencyKey: 'comparison-summary-synthetic', sourceKind: 'announcement', sourceIdentity: 'synthetic/comparison',
    payload: {
      announcement: { sourceDocument: { source: 'jxj', title: 'Synthetic comparison' }, records: [
        { enterprise: { name: 'Alpha企业', uscc, district: '镇海区' }, titleCode: 'specialized_sme', events: [] },
        { enterprise: { name: 'Beta企业', district: '余姚市' }, titleCode: 'specialized_sme', events: [] },
        { enterprise: { name: 'Gamma企业' }, titleCode: 'innovative_sme', events: [] },
      ] },
      platformQueries: [
        { interface: 'business_list', queryKey: uscc, rdjb: '2', queriedAt: '2026-10-20T00:00:00Z', status: 'success', rawResponse: 'SYNTHETIC_RAW', relations: [
          { sequenceNo: 1, nameRaw: 'Alpha企业', usccRaw: uscc, matchBasis: 'uscc', verificationStatus: 'confirmed', rawFields: { large: { body: raw } } },
          { sequenceNo: 2, nameRaw: 'Unassigned候选', matchBasis: 'none', verificationStatus: 'pending', rawFields: { original: { text: 'SYNTHETIC_PENDING' } } },
        ] },
        { interface: 'apply_list', queryKey: 'name:Gamma企业', queriedAt: '2026-10-20T00:00:00Z', status: 'failed', rawResponse: 'Explicit synthetic failed response', failureReason: 'synthetic failure' },
        { interface: 'business_list', queryKey: 'name:Gamma企业', rdjb: '1', queriedAt: '2026-10-20T00:00:01Z', status: 'no_record', rawResponse: 'Explicit synthetic empty response' },
      ],
      aliases: [
        { uscc, name: 'Alpha旧名', sourceKind: 'manual', verificationStatus: 'confirmed' },
        { uscc, name: '待核旧名', sourceKind: 'manual', verificationStatus: 'pending' },
      ],
      differences: [{ uscc, titleCode: 'specialized_sme', direction: 'missing_in_miit', status: 'confirmed_reason', reasonCode: 'platform_stale', measureCode: 'mark_platform_snapshot', verificationStatus: 'confirmed', recordedAt: '2026-10-20T01:00:00Z' }],
    },
  })
  expect(receipt).toMatchObject({ status: 'supplemented' })
  const legacy = await get()
  alphaId = legacy.rows.find((row: { name: string }) => row.name === 'Alpha企业').enterpriseId
  writeFileSync(reconcilePath, JSON.stringify({ generatedAt: '2026-10-20', entries: [{
    key: reconcileKey({ uscc, nameNorm: 'Alpha企业', titleCode: 'specialized_sme', direction: 'missing_in_miit' }),
    titleCode: 'specialized_sme', direction: 'missing_in_miit', explanation: { code: 'on_platform', note: 'Synthetic cache' }, evidence: { records: [{ original: 'SYNTHETIC_CACHE_'.repeat(6000) }] },
  }] }))
}, 90000)

afterAll(async () => {
  try { await app.close() } finally { rmSync(dir, { recursive: true, force: true }) }
})

describe('comparison lightweight list public HTTP seam', () => {
  it('keeps the default and explicit full response including complete relation and cache evidence', async () => {
    const legacy = await get()
    expect(await get('?view=full')).toEqual(legacy)
    expect(Object.keys(legacy).sort()).toEqual(['counts', 'curatedCounts', 'platform', 'reconcile', 'rows', 'total'])
    const alpha = legacy.rows.find((row: { enterpriseId: number }) => row.enterpriseId === alphaId)
    expect(JSON.stringify(alpha.platform)).not.toContain('SYNTHETIC_RELATION_')
    expect(alpha.platform.queries[0].relations).toHaveLength(2)
    expect(alpha.platform.queries[0].relations[1]).toMatchObject({ nameRaw: 'Unassigned候选', matchBasis: 'none', verificationStatus: 'pending' })
    expect(alpha.explanation.evidence.records[0].original).toBe('SYNTHETIC_CACHE_'.repeat(6000))
  })

  it('opts into a scalar summary with unchanged row identity, counts and disposition without evidence payloads', async () => {
    const summary = await get('?view=summary&pageSize=1')
    expect(summary).toMatchObject({ view: 'summary', total: 3, counts: {specialized_sme:{missing_in_miit:2,extra_in_miit:0},innovative_sme:{missing_in_miit:1,extra_in_miit:0}}, platform:{withEvidence:2,withExplanation:1,withoutExplanation:2} })
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

  it('retrieves the exact comparison row and all extracted records from query history', async () => {
    const summary = await get('?view=summary')
    const alpha = summary.rows.find((row: { enterpriseId: number }) => row.enterpriseId === alphaId)
    const detail = await get(alpha.detailUrl.slice('/api/comparison'.length))
    expect(detail.total).toBe(1)
    expect(detail.rows).toHaveLength(1)
    expect(detail.rows[0]).toEqual((await get()).rows.find((row: { enterpriseId: number }) => row.enterpriseId === alphaId))
    const queryId = detail.rows[0].platform.queries[0].id
    const response = await fetch(app.url(`/api/platform/queries?queryId=${queryId}`))
    expect(response.status).toBe(200)
    const history = await response.json()
    expect(history).toMatchObject({ total: 1, rows: [{ query: { id: queryId, relationCount: 2 }, relations: [
      { sequenceNo: 1 }, { sequenceNo: 2, enterpriseId: null, verificationStatus: 'pending' },
    ] }] })
    expect(history.rows[0].relations.map((row: { id: number }) => row.id)).toEqual(
      detail.rows[0].platform.queries[0].relations.map((row: { id: number }) => row.id),
    )
    expect(JSON.stringify(history)).not.toMatch(/SYNTHETIC_PENDING|SYNTHETIC_RAW/)

  })

  it('rejects invalid summary selectors and never widens a missing exact enterprise into the global list', async () => {
    for (const query of ['?view=unknown', '?view=summary&view=full', '?enterpriseId=0', '?enterpriseId=1.5', '?enterpriseId=abc']) {
      expect((await fetch(app.url(`/api/comparison${query}`))).status).toBe(400)
    }
    expect(await get('?view=summary&enterpriseId=999999')).toMatchObject({ total: 0, rows: [], platform: { withEvidence: 0, withExplanation: 0, withoutExplanation: 0 } })
    expect(await get('?view=full&enterpriseId=999999')).toMatchObject({ total: 0, rows: [] })
  })

  it('preserves normalized confirmed-alias search, district filters, order, empty pages and global counts', async () => {
    for (const [query,names] of [
      ['q=Alpha%20旧名',['Alpha企业']], ['q=94457p',['Alpha企业']], ['q=待核旧名',[]],
      ['district=余姚市',['Beta企业']], ['title=innovative_sme',['Gamma企业']], ['direction=extra_in_miit',[]],
      ['page=2&pageSize=1',['Beta企业']], ['page=99&pageSize=1',[]],
    ] as const) {
      for(const view of ['full','summary']) {
        const result=await get(`?view=${view}&${query}`)
        expect(result.rows.map((row:{name:string})=>row.name)).toEqual(names)
        expect(result.counts).toMatchObject({specialized_sme:{missing_in_miit:2,extra_in_miit:0},innovative_sme:{missing_in_miit:1,extra_in_miit:0}})
      }
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
      const response = await fetch(app.url(`/api/comparison/curated`), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nameNorm: 'Beta企业', titleCode: 'specialized_sme', direction: 'missing_in_miit', curated, note: 'Synthetic curation note' }) })
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
    const receipt = await imported({
      idempotencyKey: 'comparison-summary-unrelated', sourceKind: 'alias_evidence', sourceIdentity: 'synthetic/unrelated',
      payload: { platformQueries: [{ interface: 'apply_list', queryKey: 'name:Unrelated', queriedAt: '2026-10-20T00:00:00Z', status: 'partial', rawResponse: 'UNRELATED_ARCHIVE'.repeat(60000), relations: [
        { sequenceNo: 1, nameRaw: 'Unrelated', matchBasis: 'none', verificationStatus: 'pending', rawFields: { large: 'UNRELATED_FIELDS'.repeat(60000) } },
      ] }] },
    })
    expect(receipt).toMatchObject({ status: 'committed' })
    expect(await get('?view=summary&pageSize=50')).toEqual(before)
  })
  it('matches canonical query membership for normalized stored USCC without normalizing archived query keys or inferring ownership', async () => {
    const canonical = '91330201753252106U'
    const receipt = await imported({
      idempotencyKey: 'comparison-summary-legacy-uscc', sourceKind: 'announcement', sourceIdentity: 'synthetic/legacy-uscc',
      payload: {
        announcement: { sourceDocument: { source: 'jxj', title: 'Synthetic legacy compatibility' }, records: [
          { enterprise: { name: 'Legacy统代企业', uscc: canonical }, titleCode: 'specialized_sme', events: [] },
        ] },
        platformQueries: [
          { interface: 'apply_list', queryKey: canonical, queriedAt: '2026-10-20T00:00:00Z', status: 'failed', rawResponse: 'Explicit synthetic failed response', failureReason: 'synthetic failure' },
          { interface: 'business_list', queryKey: canonical, rdjb: '2', queriedAt: '2026-10-20T00:00:01Z', status: 'no_record', rawResponse: 'Explicit synthetic empty response' },
          { interface: 'business_list', queryKey: ' 91330201753252106u ', rdjb: '2', queriedAt: '2026-10-20T00:00:02Z', status: 'no_record', rawResponse: 'Explicit synthetic empty response' },
        ],
      },
    })
    expect(receipt, JSON.stringify(receipt)).toMatchObject({ status: 'supplemented' })
    const initial = await get('?q=Legacy统代企业')
    const enterpriseId = initial.rows[0].enterpriseId
    // Exact test-only exception: current import always canonicalizes enterprise USCC.
    // Reproduce a historical stored value only in this ephemeral API-created fixture;
    // all query creation and both read paths remain public API behavior.
    const connectionString = app.postgresUrl
    if (!connectionString) throw new Error('PostgreSQL fixture is not running')
    const client = new pg.Client({ connectionString })
    await client.connect()
    try {
      await client.query('UPDATE business.enterprise SET uscc_norm = $1 WHERE id = $2', [' \t91330201\u200b753252106u\u3000', enterpriseId])
    } finally { await client.end() }
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
  const receipt = await imported({
    idempotencyKey: 'comparison-summary-state-regression', sourceKind: 'announcement', sourceIdentity: 'synthetic/state-regression',
    payload: {
      announcement: { sourceDocument: { source: 'jxj', title: 'Synthetic state regression' }, records: names.map(name => ({ enterprise: { name }, titleCode: 'specialized_sme', events: [] })) },
      platformQueries: [
        { interface: 'business_list', queryKey: `name:${names[0]}`, rdjb: '2', status: 'failed', rawResponse: 'Explicit synthetic failed response', failureReason: 'synthetic failure', queriedAt: '2026-10-21T00:00:00Z' },
        { interface: 'business_list', queryKey: `name:${names[3]}`, rdjb: '1', status: 'failed', rawResponse: 'Explicit synthetic failed response', failureReason: 'other title', queriedAt: '2026-10-21T00:00:00Z' },
      ],
    },
  })
  expect(receipt).toMatchObject({ status: 'supplemented' })
  const initial = await get('?view=summary&q=StateRegression')
  const withdrawnId = initial.rows.find((row: { name: string }) => row.name === names[1]).enterpriseId
  const scope = { enterpriseId: withdrawnId, titleCode: 'specialized_sme' as const, direction: 'missing_in_miit' as const }
  const metadata = { ...scope, actor: { type: 'agent' as const, id: 'synthetic' }, ruleVersion: 'synthetic', basis: 'Synthetic state regression', effectiveAt: '2026-10-21T00:00:00Z' }
  async function saveDecision(command: object) {
    const response = await app.request('/api/roster/decision-lifecycle/commands', { method: 'POST', body: JSON.stringify(command) })
    expect(response.ok, await response.clone().text()).toBe(true)
    return response.json()
  }
  const active = await saveDecision({ ...metadata, action: 'replace', expectedCurrentId: null, idempotencyKey: 'summary-state-active', decision: { status: 'needs_review', measureCode: 'manual_review', verificationStatus: 'pending' } })
  expect((await get('?view=summary&q=StateRegression')).rows.find((row: { enterpriseId: number }) => row.enterpriseId === withdrawnId).assessment).toMatchObject({ assessment: 'decided' })
  expect(active.versionId).toEqual(expect.any(Number))
  await saveDecision({ ...metadata, action: 'withdraw', expectedCurrentId: Number(active.versionId), idempotencyKey: 'summary-state-withdraw' })
  const result = await get('?view=summary&q=StateRegression')
  expect(result.rows).toHaveLength(4)
  for (const row of result.rows) {
    expect(row.assessment).not.toHaveProperty('currentDecision')
    expect(row.assessment.queryCoverage).not.toHaveProperty('sources')
  }
  expect(result.rows.find((row: { name: string }) => row.name === names[0]).assessment.queryCoverage.status).toBe('failed')
  expect(result.rows.find((row: { name: string }) => row.name === names[1]).assessment).toMatchObject({ assessment: 'withdrawn', explanationValidity: { status: 'not_applicable' } })
  for (const name of names.slice(2)) expect(result.rows.find((row: { name: string }) => row.name === name).assessment.queryCoverage.status).toBe('not_queried')
})
