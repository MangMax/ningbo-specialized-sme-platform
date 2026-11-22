import { spawnCompiledApp } from '../../support/owned-process.mjs'
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type ChildProcess } from 'node:child_process'
import { expect, it } from 'vitest'
import { reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../../support/owned-process.mjs'
import { minimalPdf } from '../../support/minimal-pdf'
import { seedDifferenceReadFixture, assertDifferenceReadState } from './fixtures/difference-read-boundaries'
import { readBaselineComparison } from './oracles/enterprise-title-antijoin'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { enterprise, record } from '../fixtures/postgres-tables'
import { eq } from 'drizzle-orm'
import { singlePostgresFixtureRow } from '../../support/isolated-postgres-cases'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'

it('actual Nuxt preserves full summary differences and MCP evidence with canonical matches, legacy sources and acknowledged commits', async () => {
  const root = resolve(import.meta.dirname, '../../..'), dir = mkdtempSync(join(tmpdir(), 'comparison-canonical-http-'))
  let pool: pg.Pool | undefined
  let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
  let child: ChildProcess | undefined, output = ''
  try {
    // Real migrated schema/indexes: a canonical matched pair must disappear.
    // Separately retain historical non-jxj source compatibility in public DTOs.
    mkdirSync(join(dir, 'files/synthetic'), { recursive: true })
    writeFileSync(join(dir, 'files/synthetic/m2.pdf'), minimalPdf({ pages: 3 }))
    postgres = await postgresRuntimeFixture({ dir })
    pool = new pg.Pool({ connectionString: postgres.url })
    const db = drizzle(pool)
    const legacy = singlePostgresFixtureRow(await db.insert(enterprise).values({ name: 'Legacy history', nameNorm: 'Legacyhistory', usccNorm: '91330201753252106U' }).returning())
    const add = (enterpriseId: number, source: string, district: string) =>
      pool!.query("insert into business.record(enterprise_id,title_code,source,district) values($1,'specialized_sme',$2,$3)", [enterpriseId, source, district])
    await add(legacy.id, 'miit', 'first district')
    for (let n = 1; n < 32; n++) await add(legacy.id, `legacy-${n}`, 'later district')
    const canonical = singlePostgresFixtureRow(await db.insert(enterprise).values({ name: 'Canonical matched', nameNorm: 'Canonicalmatched', usccNorm: '91330211316904639T' }).returning())
    await add(canonical.id, 'jxj', 'canonical J district')
    await add(canonical.id, 'miit', 'canonical M district')
    const source = await db.select({
      enterpriseId: enterprise.id, name: enterprise.name, uscc: enterprise.usccNorm, currentCity: enterprise.city,
      regStatus: enterprise.regStatus, source: record.source, titleCode: record.titleCode, district: record.district,
    }).from(record).innerJoin(enterprise, eq(record.enterpriseId, enterprise.id)).orderBy(record.id)
    const baseline = readBaselineComparison(source)
    expect(baseline.rows).toEqual([{ enterpriseId: legacy.id, name: 'Legacy history', uscc: '91330201753252106U', district: 'first district', titleCode: 'specialized_sme', direction: 'extra_in_miit', curated: false,
      evidence: { matchedBy: 'uscc', otherSideUscc: null, currentCity: null, regStatus: null } }])
    const port = await reserveLoopbackPort(), base = `http://127.0.0.1:${port}`
    child = spawnCompiledApp(port, {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
        ...postgres.env, NUXT_BUILD_DIR: join(dir, 'build'),
        NUXT_API_TOKEN: 'synthetic-canonical', NUXT_MCP_TOKEN: 'synthetic-canonical', NUXT_CURATED_PATH: join(dir, 'curated.json'),
        NUXT_RECONCILE_PATH: join(dir, 'reconcile.json'), NUXT_FILES_DIR: join(dir, 'files'), NUXT_INCOMING_DIR: join(dir, 'incoming'),
      },
    })
    for (const stream of [child.stdout!, child.stderr!]) stream.on('data', data => { output = (output + data).slice(-16000) })
    await waitForHttp(base + '/api/roster/differences', { timeoutMs: 60000, child })
    const get = async (path: string) => { const r = await fetch(base + path); expect(r.status, await r.clone().text()).toBe(200); return r.json() }
    const full = await get('/api/comparison')
    expect(await get('/api/comparison?view=full')).toEqual(full)
    expect(full).toMatchObject({ total: 1, counts: baseline.counts, curatedCounts: { little_giant: { missing_in_miit: 0, extra_in_miit: 0 }, specialized_sme: { missing_in_miit: 0, extra_in_miit: 0 }, innovative_sme: { missing_in_miit: 0, extra_in_miit: 0 } }, rows: baseline.rows })
    const summary = await get('/api/comparison?view=summary')
    expect(summary).toMatchObject({ view: 'summary', total: 1, counts: baseline.counts, rows: [{ enterpriseId: legacy.id, district: 'first district', direction: 'extra_in_miit', evidenceIncluded: false }] })
    const diff = await get('/api/roster/differences')
    expect(diff).toMatchObject({ total: 1, counts: baseline.counts, rows: [{ enterpriseId: legacy.id, name: 'Legacy history', direction: 'extra_in_miit', district: 'first district', status: 'not_queried', explanationId: null, evidence: null, assessment: 'not_queried', queryCoverage: { status: 'not_queried', sources: [], truncated: false }, currentDecision: { versionId: null, current: null } }] })
    const rpc = async (args: Record<string, unknown> = {}) => {
      const r = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_differences', arguments: args } }) })
      expect(r.status).toBe(200)
      const raw = await r.text(), body = JSON.parse(raw.startsWith('event:') ? raw.split('\n').find(line => line.startsWith('data: '))!.slice(6) : raw)
      expect(body.error).toBeUndefined()
      return JSON.parse(body.result.content[0].text)
    }
    // MCP intentionally lists stored explanations only; it must not acquire
    // comparison-only rows when the shared comparison implementation changes.
    expect(await rpc()).toEqual({ rows: [], counts: {} })
    await seedDifferenceReadFixture(base, 'synthetic-canonical')
    const richDiff = await get('/api/roster/differences?q=M2R')
    assertDifferenceReadState(richDiff, await rpc())
    const richSummary = await get('/api/comparison?view=summary&q=M2R')
    expect(richSummary).toMatchObject({ view: 'summary', total: 9, counts: {
      little_giant: { missing_in_miit: 0, extra_in_miit: 0 }, specialized_sme: { missing_in_miit: 8, extra_in_miit: 1 }, innovative_sme: { missing_in_miit: 1, extra_in_miit: 0 },
    }, rows: [{ name: 'M2R合成00', evidenceIncluded: false, platform: { aliasCount: 1, confirmedAliasCount: 1, queryCount: 2, sourceRelationCount: 2, disposition: { status: 'confirmed_reason', reasonCode: 'pending_review' } } },
      ...Array.from({ length: 7 }, (_, i) => ({ name: `M2R合成${String(i + 1).padStart(2, '0')}`, evidenceIncluded: false })),
      { name: 'M2R仅比较坐标', evidenceIncluded: false },
    ] })
    const rich = await get('/api/comparison?q=M2R')
    expect(await get('/api/comparison?view=full&q=M2R')).toEqual(rich)
    expect(rich.rows).toHaveLength(9)
    expect(rich.rows[0].platform.queries).toHaveLength(2)
    expect(JSON.stringify(rich.rows[0].platform)).not.toMatch(/SYNTHETIC_RAW_ONLY|SYNTHETIC_TIED/)
    expect(rich.rows[0].platform.queries.flatMap((q: { relations: unknown[] }) => q.relations)).toHaveLength(2)
    expect(rich.rows[0].platform.disposition).toMatchObject({ status: 'confirmed_reason', reasonCode: 'pending_review', measureCode: 'follow_review' })
    // ACK is the actual API transaction receipt, then the retained child must
    // see the next committed record without process restart or cache clearing.
    const response = await fetch(base + '/api/roster/import/commit', { method: 'POST', headers: { authorization: 'Bearer synthetic-canonical', 'content-type': 'application/json' }, body: JSON.stringify({ idempotencyKey: 'canonical-next', sourceKind: 'announcement', sourceIdentity: 'synthetic/canonical-next', payload: { announcement: { sourceDocument: { source: 'jxj', title: 'Next history' }, records: [
      { enterprise: { name: 'Next acknowledged' }, titleCode: 'little_giant', events: [] },
      { enterprise: { name: 'Legacy history', uscc: legacy.usccNorm }, titleCode: 'specialized_sme', events: [] },
    ] } } }) })
    expect(response.status).toBe(200)
    const staged = await response.json()
    expect(staged.status).toBe('staged')
    const supplement = await fetch(base + `/api/roster/import/intake/${staged.intakeId}/supplement`, {
      method: 'POST', headers: { authorization: 'Bearer synthetic-canonical', 'content-type': 'application/json' },
      body: JSON.stringify({ sourceDigest: staged.sourceDigest, basis: 'Synthetic canonical identities', rows: [
        { action: 'create', fields: { name: 'Next acknowledged' } },
        { action: 'attach', enterpriseId: legacy.id, expectedRevision: 1 },
      ] }),
    })
    expect(await supplement.json()).toMatchObject({ status: 'supplemented' })
    for (const path of ['/api/comparison?q=Next', '/api/comparison?view=summary&q=Next', '/api/roster/differences?q=Next']) {
      expect(await get(path)).toMatchObject({ total: 1, rows: [{ name: 'Next acknowledged', titleCode: 'little_giant', direction: 'missing_in_miit' }] })
    }
    for (const path of ['/api/comparison?q=Legacy', '/api/comparison?view=summary&q=Legacy', '/api/roster/differences?q=Legacy']) {
      expect(await get(path)).toMatchObject({ total: 0, rows: [] })
    }
  } catch (error) { throw new Error(String(error) + '\n' + output, { cause: error }) }
  finally {
    if (child) await stopOwnedChild(child)
    await pool?.end()
    postgres?.close()
    rmSync(dir, { recursive: true, force: true })
    expect(existsSync(dir)).toBe(false)
  }
}, 90000)
