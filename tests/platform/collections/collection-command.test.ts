import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { closePostgresDirectoryDb, usePostgresDirectoryDb } from '../../../db/postgresql/client'
import { platformResultToImport } from '../../../layers/sme-roster/lib/platform/recognized-evidence'
import type { PlatformLiveQueryResult, PlatformQuerySource } from '../../../layers/sme-roster/lib/platform/live-query'
import type { RosterImportPlatformQuery } from '../../../layers/sme-roster/lib/roster-import-client'
import { commitPostgresPlatformCollection } from '../../../layers/sme-roster/server/utils/collection-import-postgres'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'

let root: string
let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>>
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'collection-command-'))
  postgres = await postgresRuntimeFixture({ dir: root })
  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', postgres.url)
  vi.stubEnv('NUXT_DB_READONLY', '0')
}, 60_000)
beforeEach(async () => {
  await usePostgresDirectoryDb().execute(sql`
    TRUNCATE platform_collection, platform_business_record, import_batch, enterprise RESTART IDENTITY CASCADE
  `)
})
afterAll(async () => {
  await closePostgresDirectoryDb()
  postgres?.close()
  if (root) rmSync(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

function evidence(source: PlatformQuerySource): PlatformLiveQueryResult {
  return { source, status: 'success', effectiveConditions: { name: 'Example', combination: 'and', ...(source === 'businessList' ? { name: undefined, uscc: '91330200712345678A' } : {}) }, titleScope: { mode: source === 'queryList' ? 'source_default' : 'selected', rdjb: source === 'queryList' ? [] : ['2'] }, queriedAt: '2026-11-11T00:00:00Z', completedAt: '2026-11-11T00:01:00Z', rows: [{ id: 'A', qymc: 'Example', rdjb: '2', year: ' 2028 ', whpcyear: 'false' }], dataRows: [{ id: 'A', qymc: 'Example', rdjb: '2', year: ' 2028 ', whpcyear: false }], pages: [{ source, rdjb: source === 'queryList' ? null : '2', page: 1, maxPage: 1, status: 'success', fetchedCount: 1, declaredTotal: 1, error: null }], fetchedCount: 1, declaredTotal: 1, completeness: 'complete', fullRange: true, unfinished: [], error: null, limits: { maxRequests: 100, maxRows: 5000, maxDurationMs: 60000, pageSize: 50 } }
}
function submit(key: string, ...queries: RosterImportPlatformQuery[]) {
  return commitPostgresPlatformCollection(usePostgresDirectoryDb(), {
    idempotencyKey: key, sourceKind: 'platform_archive', sourceIdentity: 'collection-command-test',
    payload: { platformQueries: queries },
  }, async () => {})
}

async function expectNoCollectionFacts() {
  const { rows } = await usePostgresDirectoryDb().execute(sql`
    SELECT (SELECT count(*) FROM platform_collection)::int AS collections,
      (SELECT count(*) FROM platform_collection_page)::int AS pages,
      (SELECT count(*) FROM platform_query_title_scope)::int AS scopes,
      (SELECT count(*) FROM platform_business_observation)::int AS observations,
      (SELECT count(*) FROM platform_business_record)::int AS records,
      (SELECT count(*) FROM platform_observation_assignment)::int AS assignments
  `)
  expect(rows).toEqual([{ collections: 0, pages: 0, scopes: 0, observations: 0, records: 0, assignments: 0 }])
}

it.each(['queryList', 'businessList', 'queryBusList'] as const)('writes complete %s metadata, evidence digest and row placement', async source => {
  const result = evidence(source)
  const query = platformResultToImport(result)
  expect(await submit('complete', query)).toMatchObject({
    status: 'committed', items: [{ ok: true, ref: 'query:1', detail: { rowsWritten: 2, relations: [1] } }],
  })
  const db = usePostgresDirectoryDb()
  expect((await db.execute(sql`
    SELECT source, queried_at, status, evidence_status, completeness, full_range::int, provenance_state, parse_state,
      evidence_sha256, condition_facts #>> '{values,combination,value}' AS combination
    FROM platform_collection
  `)).rows).toEqual([{
    source, queried_at: '2026-11-11T00:00:00Z', status: 'success', evidence_status: 'success', completeness: 'complete',
    full_range: 1, provenance_state: 'captured', parse_state: 'valid', combination: 'and',
    evidence_sha256: createHash('sha256').update(JSON.stringify(result)).digest('hex'),
  }])
  expect((await db.execute(sql`
    SELECT o.sequence_no::int, o.page_row_no::int, o.position_state, p.page_no::int,
      p.sequence_start::int, p.sequence_end::int
    FROM platform_business_observation o JOIN platform_collection_page p ON p.id=o.page_id
  `)).rows).toEqual([{ sequence_no: 1, page_row_no: 1, position_state: 'verified', page_no: 1, sequence_start: 1, sequence_end: 1 }])
  const scopes = (await db.execute(sql`SELECT rdjb FROM platform_query_title_scope`)).rows
  expect(scopes).toEqual(source === 'queryList' ? [] : [{ rdjb: '2' }])
})

it('retains collection receipts and one current observation for the same content', async () => {
  const original = evidence('queryBusList')
  const next = { ...original, queriedAt: '2026-11-11T00:00:30Z' }
  const firstQuery = platformResultToImport(original)
  const secondQuery = platformResultToImport(next)
  expect(await submit('first', firstQuery)).toMatchObject({ status: 'committed', items: [{ ref: 'query:1' }] })
  expect(await submit('second', secondQuery)).toMatchObject({ status: 'committed', items: [{ ref: 'query:2' }] })
  expect(await submit('new-identical', firstQuery)).toMatchObject({
    status: 'failed', items: [{ ok: false, error: { code: 'query_replay_offline' } }],
  })
  const { interface: source, queryKey, rdjb, queriedAt } = secondQuery
  expect(await submit('reference', { interface: source, queryKey, rdjb, queriedAt, reuseExisting: true, relations: [{ sequenceNo: 1, relationKey: 'A' }] }))
    .toMatchObject({ status: 'committed', items: [{ ref: 'query:2', detail: { rowsWritten: 0, skipped: 1 } }] })
  expect((await usePostgresDirectoryDb().execute(sql`
    SELECT c.public_id::int AS query_id, o.public_id::int AS relation_id, c.queried_at, o.version_id::int
    FROM platform_collection c JOIN platform_business_observation o ON o.collection_id=c.id ORDER BY query_id
  `)).rows).toEqual([
    { query_id: 2, relation_id: 2, queried_at: '2026-11-11T00:00:30Z', version_id: 1 },
  ])
})

it.each(['no_record', 'failed', 'auth_failed', 'not_queried'] as const)('retains %s without inventing observations or page positions', async status => {
  const e = evidence('queryBusList')
  e.rows = []; e.dataRows = []; e.fetchedCount = 0; e.declaredTotal = status === 'no_record' ? 0 : null; e.status = status
  e.completeness = status === 'no_record' ? 'complete' : status === 'not_queried' ? 'not_queried' : 'partial'
  e.unfinished = status === 'no_record' ? [] : [{ source: e.source, rdjb: '2', page: 1 }]
  e.error = status === 'failed' || status === 'auth_failed' ? { code: 'upstream_failed', message: '原错误\n' } : null
  e.pages = status === 'not_queried' ? [] : [{
    source: e.source, rdjb: '2', page: 1, fetchedCount: 0, declaredTotal: e.declaredTotal,
    status: status === 'no_record' ? 'success' : status, error: e.error,
  }]
  expect(await submit(status, platformResultToImport(e))).toMatchObject({
    status: 'committed', items: [{ detail: { relations: [], rowsWritten: 1 } }],
  })
  const db = usePostgresDirectoryDb()
  expect((await db.execute(sql`
    SELECT status, evidence_status, completeness, error_message, unfinished_positions FROM platform_collection
  `)).rows).toEqual([{
    status: status === 'auth_failed' ? 'failed' : status, evidence_status: status, completeness: e.completeness,
    error_message: e.error?.message ?? null,
    unfinished_positions: status === 'no_record' ? [] : [{ ordinal: 0, source: 'queryBusList', rdjb: '2', pageNo: 1 }],
  }])
  expect((await db.execute(sql`SELECT sequence_start, sequence_end FROM platform_collection_page`)).rows)
    .toEqual(status === 'not_queried' ? [] : [{ sequence_start: null, sequence_end: null }])
})

it('retains a zero-row page and assigns each observation its actual page ordinal', async () => {
  const e = evidence('queryBusList')
  e.titleScope.rdjb = ['3', '2']
  e.pages.unshift({ source: e.source, rdjb: '3', page: 1, fetchedCount: 0, declaredTotal: 0, status: 'success', error: null })
  expect(await submit('multi-title', platformResultToImport(e))).toMatchObject({ status: 'committed' })
  expect((await usePostgresDirectoryDb().execute(sql`
    SELECT p.ordinal::int, p.rdjb, p.max_page::int, p.sequence_start::int, p.sequence_end::int, o.page_row_no::int
    FROM platform_collection_page p LEFT JOIN platform_business_observation o ON o.page_id=p.id ORDER BY ordinal
  `)).rows).toEqual([
    { ordinal: 0, rdjb: '3', max_page: null, sequence_start: null, sequence_end: null, page_row_no: null },
    { ordinal: 1, rdjb: '2', max_page: 1, sequence_start: 1, sequence_end: 1, page_row_no: 1 },
  ])
})

it('retains unknown placement and original response digest without inferring missing coverage', async () => {
  const response = '原文\n '
  expect(await submit('without-coverage', {
    interface: 'apply_list', queryKey: 'without-coverage', queriedAt: '2026-11-11T00:00:00Z',
    status: 'success', rawResponse: response, relations: [{ sequenceNo: 1, rawFields: null }],
  })).toMatchObject({ status: 'committed' })
  expect((await usePostgresDirectoryDb().execute(sql`
    SELECT c.source, c.completeness, c.provenance_state, c.parse_state, c.full_range, c.page_size, c.fetched_count,
      c.raw_response_sha256, o.page_id, o.page_row_no, o.position_state
    FROM platform_collection c JOIN platform_business_observation o ON o.collection_id=c.id
  `)).rows).toEqual([{
    source: null, completeness: 'unknown', provenance_state: 'unknown', parse_state: 'absent', full_range: null,
    page_size: null, fetched_count: null, raw_response_sha256: createHash('sha256').update(response).digest('hex'),
    page_id: null, page_row_no: null, position_state: 'unknown',
  }])
})

it.each(['duplicate-page', 'wrong-source', 'wrong-position', 'missing-row', 'altered-raw', 'invalid-condition', 'missing-evidence'] as const)
  ('rejects %s before writing any collection facts', async kind => {
    const query = platformResultToImport(evidence('queryBusList'))
    const e = query.collectionEvidence!
    if (kind === 'duplicate-page') e.pages.push(e.pages[0]!)
    if (kind === 'wrong-source') e.pages[0]!.source = 'businessList'
    if (kind === 'wrong-position') e.pages[0]!.page = 2
    if (kind === 'missing-row') query.relations = []
    if (kind === 'altered-raw') query.relations![0]!.rawFields = { id: 'B' }
    if (kind === 'invalid-condition') Reflect.set(e.effectiveConditions, 'whpcyear', 1.5)
    if (kind === 'missing-evidence') delete query.collectionEvidence
    expect(await submit(kind, query)).toMatchObject({ status: 'failed', items: [{ error: { code: 'collection_evidence_invalid' } }] })
    await expectNoCollectionFacts()
  })

it('retains independent failure reasons and unfinished titles in source order', async () => {
  const e = evidence('businessList')
  e.titleScope.rdjb = ['1', '2', '3']
  e.status = 'partial'
  e.completeness = 'partial'
  e.declaredTotal = null
  e.pages[0]!.rdjb = '1'
  e.unfinished = [{ source: e.source, rdjb: '3', page: 1 }, { source: e.source, rdjb: '2', page: 1 }]
  e.error = { code: 'safety_limit', message: 'source error' }
  const query = platformResultToImport(e)
  query.failureReason = 'query reason'
  expect(await submit('unfinished', query)).toMatchObject({ status: 'committed' })
  expect((await usePostgresDirectoryDb().execute(sql`
    SELECT status, evidence_status, failure_reason, error_code, error_message, unfinished_positions,
      condition_facts->'values' AS conditions
    FROM platform_collection
  `)).rows).toEqual([{
    status: 'partial', evidence_status: 'partial', failure_reason: 'query reason', error_code: 'safety_limit',
    error_message: 'source error', unfinished_positions: [
      { ordinal: 0, source: 'businessList', rdjb: '3', pageNo: 1 },
      { ordinal: 1, source: 'businessList', rdjb: '2', pageNo: 1 },
    ],
    conditions: {
      combination: { kind: 'text', value: 'and' },
      uscc: { kind: 'text', value: '91330200712345678A' },
    },
  }])
})

it('retains exact recognized conditions and omits absent condition names', async () => {
  const db = usePostgresDirectoryDb()
  const full = evidence('queryBusList')
  full.effectiveConditions = {
    name: 'Example', uscc: '91330200712345678A', combination: 'and', sqsj: '2026/01/01 - 2026/11/11',
    rddqrq: '2028', whpcyear: '2026', whpc: '2', szq: '12345678', orderField: 'qymc', orderDirection: 'asc',
  }
  const titleWide = evidence('queryBusList')
  titleWide.effectiveConditions = { combination: 'and' }
  delete titleWide.dataRows
  const query = platformResultToImport(titleWide)
  query.queryKey = 'synthetic-title-wide'
  expect(await submit('conditions', platformResultToImport(full), query)).toMatchObject({ status: 'committed' })
  expect((await db.execute(sql`
    SELECT query_key, condition_facts->'values' AS conditions FROM platform_collection ORDER BY public_id
  `)).rows).toEqual([
    {
      query_key: '91330200712345678A', conditions: {
        name: { kind: 'text', value: 'Example' }, uscc: { kind: 'text', value: '91330200712345678A' },
        combination: { kind: 'text', value: 'and' }, sqsj: { kind: 'text', value: '2026/01/01 - 2026/11/11' },
        rddqrq: { kind: 'text', value: '2028' }, whpcyear: { kind: 'text', value: '2026' },
        whpc: { kind: 'text', value: '2' }, szq: { kind: 'text', value: '12345678' },
        orderField: { kind: 'text', value: 'qymc' }, orderDirection: { kind: 'text', value: 'asc' },
      },
    },
    { query_key: 'synthetic-title-wide', conditions: { combination: { kind: 'text', value: 'and' } } },
  ])
})

it('records raw-page evidence digest and recognized boolean source semantics', async () => {
  const e = evidence('queryBusList')
  const body = ' {"zrarData":{"grid":{"businessGrid":{"page":1,"pageSize":50,"maxCount":1,"maxPage":1,"pageSet":[{"id":"A","qymc":"Example","rdjb":"2","year":" 2028 ","whpcyear":false,"extra":[null," ",2]}]}}}}\n'
  e.rows[0]!.extra = '[null," ",2]'
  e.rawData = {
    version: 1, rows: [{ ...e.dataRows![0]!, extra: [null, ' ', 2] }],
    pages: [{ source: e.source, rdjb: '2', page: 1, format: 'json', body }],
  }
  delete e.dataRows
  expect(await submit('raw-data', platformResultToImport(e))).toMatchObject({ status: 'committed' })
  const db = usePostgresDirectoryDb()
  expect((await db.execute(sql`
    SELECT evidence_sha256, source_coverage ? 'rawData' AS stores_raw_data FROM platform_collection
  `)).rows).toEqual([{ evidence_sha256: createHash('sha256').update(JSON.stringify(e)).digest('hex'), stores_raw_data: false }])
  expect((await db.execute(sql`
    SELECT p.source_maintenance_year_absent::int
    FROM platform_business_observation o JOIN platform_recognized_projection p ON p.version_id=o.version_id
  `)).rows).toEqual([{ source_maintenance_year_absent: 0 }])
  e.rawData.pages[0]!.body = body.replace('[null," ",2]', '[2," ",null]')
  expect(() => platformResultToImport(e)).toThrow('Raw observations and legacy projection must match original responses')
})

it('keeps two original source rows ordered and rejects a reordering', async () => {
  const e = evidence('queryList')
  e.rows.push({ id: 'B', qymc: 'Second', rdjb: '3', year: '', whpcyear: '' })
  e.dataRows!.push({ id: 'B', qymc: 'Second', rdjb: '3', year: null, whpcyear: null })
  e.fetchedCount = 2
  e.declaredTotal = 2
  e.pages[0]!.fetchedCount = 2
  e.pages[0]!.declaredTotal = 2
  const query = platformResultToImport(e)
  expect(await submit('reordered', { ...query, relations: [...query.relations!].reverse() }))
    .toMatchObject({ status: 'failed', items: [{ error: { code: 'collection_evidence_invalid' } }] })
  await expectNoCollectionFacts()
  expect(await submit('in-order', query)).toMatchObject({ status: 'committed' })
  expect((await usePostgresDirectoryDb().execute(sql`
    SELECT sequence_no::int, page_row_no::int, source_relation_key
    FROM platform_business_observation ORDER BY sequence_no
  `)).rows).toEqual([
    { sequence_no: 1, page_row_no: 1, source_relation_key: 'A' }, { sequence_no: 2, page_row_no: 2, source_relation_key: 'B' },
  ])
})

it.each(['apply_list', 'business_list'] as const)('rejects a %s collection without original evidence or a reference', async source => {
  const query = { interface: source, queryKey: 'missing-evidence', queriedAt: '2026-11-11T00:00:00Z', relations: [] }
  expect(await submit('missing', query)).toMatchObject({ status: 'failed', items: [{ error: { code: 'query_source_required' } }] })
  expect(await submit('reference', { ...query, reuseExisting: true }))
    .toMatchObject({ status: 'failed', items: [{ error: { code: 'query_reuse_missing' } }] })
  await expectNoCollectionFacts()
})

it('matches explicit ownership by normalized USCC without rewriting the observed code', async () => {
  const observed = '91330200​712345678A'
  await usePostgresDirectoryDb().execute(sql`
    INSERT INTO enterprise (id, name, name_norm, uscc_norm) VALUES (100,'Example','Example','91330200712345678A')
  `)
  const e = evidence('queryBusList')
  e.rows[0]!.tyshxydm = observed
  e.dataRows![0]!.tyshxydm = observed
  const query = platformResultToImport(e)
  query.relations![0]!.enterpriseId = 100
  expect(await submit('owner', query)).toMatchObject({ status: 'committed' })
  expect((await usePostgresDirectoryDb().execute(sql`
    SELECT observation_id::int, revision::int, enterprise_id::int, uscc_raw FROM platform_observation_assignment
  `)).rows).toEqual([{ observation_id: 1, revision: 1, enterprise_id: 100, uscc_raw: observed }])
})

it.each(['queryList', 'businessList'] as const)('rejects inconsistent %s source status without partial writes', async source => {
  const e = evidence(source)
  e.rows[0]!.cszt = '终审通过'
  e.dataRows![0]!.cszt = '终审通过'
  const query = platformResultToImport(e)
  query.relations![0]!.status = '退回'
  expect(await submit('conflict', query)).toMatchObject({ status: 'failed', items: [{ error: { code: 'platform_field_conflict' } }] })
  await expectNoCollectionFacts()
})

it('rolls back earlier collections and placements after a later observation write fails', async () => {
  const db = usePostgresDirectoryDb()
  await db.execute(sql`
    ALTER TABLE platform_business_observation ADD CONSTRAINT reject_second_fixture
    CHECK (source_relation_key IS DISTINCT FROM 'REJECT')
  `)
  try {
    const first = platformResultToImport(evidence('queryList'))
    const e = evidence('businessList')
    e.rows[0]!.id = 'REJECT'
    e.dataRows![0]!.id = 'REJECT'
    const second = platformResultToImport(e)
    expect(await submit('rollback', first, second)).toMatchObject({
      status: 'failed', items: [{ error: { code: 'commit_rolled_back' } }, { error: { code: 'platform_write_failed' } }],
    })
    await expectNoCollectionFacts()
  } finally {
    await db.execute(sql`ALTER TABLE platform_business_observation DROP CONSTRAINT reject_second_fixture`)
  }
})
