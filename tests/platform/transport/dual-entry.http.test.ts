import { closeApplicationLogging } from '../../../layers/core/lib/logging'
import { execFileSync } from 'node:child_process'
import { beforeAll, it, expect, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createApp, createRouter, toNodeListener, defineEventHandler, setHeader, getQuery, getRouterParam, createError, readBody, getHeader, setResponseStatus } from 'h3'
import { sql } from 'drizzle-orm'
import { closePostgresDirectoryDb, usePostgresDirectoryDb } from '../../../db/postgresql/client'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import { createRosterImportHandler } from '../../../layers/sme-roster/server/utils/roster-import-route'
import type { RosterImportRequest, RosterImportPlatformQuery } from '../../../layers/sme-roster/lib/roster-import-client'

const platformSources = ['declarations', 'business-processes', 'recognized-directory'] as const
let platformRoutes: { source: typeof platformSources[number]; list: import('h3').EventHandler; detail: import('h3').EventHandler }[]
beforeAll(async () => {
  for (const [key, value] of Object.entries({ defineEventHandler, setHeader, getQuery, getRouterParam, createError, readBody, getHeader, setResponseStatus })) vi.stubGlobal(key, value)
  // Prepare real handlers before exercising replay, as the running HTTP server
  // does. Cold module loading is setup, separate from the default 5s case budget.
  platformRoutes = await Promise.all(platformSources.map(async source => ({
    source,
    list: (await import(`../../../layers/sme-roster/server/api/platform/${source}.get.ts`)).default,
    detail: (await import(`../../../layers/sme-roster/server/api/platform/${source}/[recordId].get.ts`)).default,
  })))
})

it('structured readback and reference reuse preserve all three sources across rejected offline replay and write recovery', async () => {
  const retained = process.env.ACCEPTANCE_598_DIR
  const dir = retained ?? mkdtempSync(join(tmpdir(), 'dual-entry-598-'))
  const checkpoint = join(dir, 'before-replay.pg')
  if (existsSync(checkpoint)) throw new Error('Acceptance requires a new empty external directory')
  const postgres = await postgresRuntimeFixture({ dir })
  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', postgres.url)
  vi.stubEnv('NUXT_POSTGRES_LOG_URL', postgres.url)
  vi.stubEnv('NUXT_DB_READONLY', '0')
  vi.stubGlobal('useRuntimeConfig', () => ({ apiToken: '598-isolated-token', filesDir: dir }))
  const db = usePostgresDirectoryDb()
  const raw = { id: '598-controlled', qymc: '受控样本企业', rdjb: '2', sblx: '复核', year: '2024', cszt: '待审核', whpc: '2024-2', rddqrq: '原值日期' }
  const queries: RosterImportPlatformQuery[] = ['apply_list', 'business_list', 'recognized_list'].map(source => ({
    interface: source as RosterImportPlatformQuery['interface'], queryKey: 'name:受控样本企业', rdjb: '2', queriedAt: '2026-11-01T00:00:00Z', status: 'success', rawResponse: JSON.stringify({syntheticSource:source,rows:[raw]}),
    relations: [{ sequenceNo: 1, relationKey: raw.id, nameRaw: raw.qymc, rawFields: raw }],
  }))
  // Recognized full-row ingestion requires the original complete queryBusList envelope.
  queries[2]!.titleCode = 'specialized_sme'
  queries[2]!.collectionEvidence = {
    source: 'queryBusList', status: 'success', effectiveConditions: { combination: 'and' }, titleScope: { mode: 'selected', rdjb: ['2'] },
    queriedAt: '2026-11-01T00:00:00Z', completedAt: '2026-11-01T00:01:00Z', rows: [raw], fetchedCount: 1, declaredTotal: 1,
    pages: [{ source: 'queryBusList', rdjb: '2', page: 1, status: 'success', fetchedCount: 1, declaredTotal: 1, maxPage: 1, error: null }],
    completeness: 'complete', fullRange: true, unfinished: [], error: null,
    limits: { pageSize: 50, maxRequests: 100, maxRows: 5000, maxDurationMs: 60000 },
  } as never
  const request = (key: string, payload: RosterImportRequest['payload']): RosterImportRequest => ({ idempotencyKey: key, sourceKind: 'platform_archive', sourceIdentity: 'tests/598-controlled', payload })
  const router = createRouter()
  for (const action of ['preflight', 'commit'] as const) router.post(`/api/roster/import/${action}`, createRosterImportHandler(action))
  for (const { source, list, detail } of platformRoutes) {
    router.get(`/api/platform/${source}`, list)
    router.get(`/api/platform/${source}/:recordId`, detail)
  }
  const server = createServer(toNodeListener(createApp().use(router)))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
  const receipts: unknown[] = []
  const post = async (action: string, body: unknown, expectedStatus = 200) => {
    const response = await fetch(`${base}/api/roster/import/${action}`, { method: 'POST', headers: { authorization: 'Bearer 598-isolated-token', 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect(response.status).toBe(expectedStatus)
    const result = await response.json(); receipts.push(result); return result
  }
  const invariantTables = ['platform_apply_projection', 'platform_business_projection', 'platform_recognized_projection', 'platform_collection', 'platform_observation_assignment', 'platform_business_record', 'platform_business_record_version', 'platform_business_observation', 'enterprise', 'record', 'record_event', 'enterprise_alias', 'record_correspondence', 'record_correspondence_audit', 'difference_reason']
  const snapshot = async () => Object.fromEntries(await Promise.all(invariantTables.map(async table => {
    const result = await db.execute<{ content: string }>(sql`SELECT row_to_json(item)::text AS content
      FROM business.${sql.identifier(table)} AS item ORDER BY (row_to_json(item)::text) COLLATE "C"`)
    return [table, result.rows.map(row => row.content)]
  })))
  const check = async () => {
    for (const [source, expected] of [
      ['declarations', { declarationYear: 2024, status: '待审核', declareKind: 'review', titleRaw: '2' }],
      ['business-processes', { businessYear: 2024, status: '待审核', declareKind: 'review', titleRaw: '2' }],
      ['recognized-directory', { titleRaw: '2', validityDateRaw: '原值日期', maintenanceBatch: '2024-2', maintenanceYear: null, district: null, awardNote: null }],
    ] as const) {
      const response = await fetch(`${base}/api/platform/${source}`)
      expect(response.status).toBe(200)
      const list = await response.json()
      expect(list.total).toBe(1)
      expect(list.rows[0].matchedVersion).toMatchObject(expected)
      expect(list.rows[0].matchedVersion.ruleVersion).toBeTruthy()
      const detail = await (await fetch(`${base}/api/platform/${source}/${list.rows[0].record.id}`)).json()
      expect(detail.versions).toHaveLength(1)
      expect(detail.versions[0]).toMatchObject(expected)
    }
  }
  try {
    const seed = request('598-seed', { platformQueries: queries })
    const preflight=await post('preflight',seed);expect(preflight.preflight.conflicts,JSON.stringify(preflight)).toEqual([])
    expect((await post('commit', seed)).summary.platformFields).toMatchObject({ status: 'ready', eligibleVersions: 3, projectionsChecked: 3 })
    await check()
    // Independent controlled decisions, deliberately alongside the actual-source
    // receipts retained externally; never described as original production decisions.
    await db.execute(sql`
      INSERT INTO enterprise(id,name,name_norm) VALUES(598,'受控人工决定企业','受控人工决定企业');
      INSERT INTO difference_reason(enterprise_id,title_code,direction,status,reason_note,recorded_at,created_at)
        VALUES(598,'specialized_sme','missing_in_miit','needs_review','598 independent controlled decision','2026-11-01','2026-11-01');
      INSERT INTO record_correspondence(id,edge_key,type,role,enterprise_id,title_code,status,revision,target_identity,provenance,source_fingerprint,rule_id,rule_version,created_at)
        VALUES(598,'598-controlled','event_process','controlled',598,'specialized_sme','confirmed',1,'{}','{}','598-independent','controlled','1','2026-11-01');
      INSERT INTO record_correspondence_audit(batch_id,correspondence_id,idempotency_key,to_status,expected_revision,resulting_revision,actor_type,actor_id,basis,rule_id,rule_version,evidence,decided_at)
        VALUES((SELECT id FROM import_batch LIMIT 1),598,'598-controlled-decision','confirmed',0,1,'agent','598-controlled','independent fixture','controlled','1','{}','2026-11-01');
    `)
    const before = await snapshot()
    expect(before.difference_reason).toHaveLength(1)
    expect(before.record_correspondence).toHaveLength(1)
    expect(before.record_correspondence_audit).toHaveLength(1)
    execFileSync(join(process.env.ROSTER_TEST_POSTGRES_BIN!, 'pg_dump'), ['--format=custom', '--schema=business', '--file=' + checkpoint, postgres.url])
    const replay = await post('commit', request('598-offline-replay', { platformQueries: queries }))
    expect(replay).toMatchObject({ status: 'failed', items: expect.arrayContaining([
      expect.objectContaining({ error: expect.objectContaining({ code: 'query_replay_offline' }) }),
    ]) })
    const referenced = queries.map(({ rawResponse: _raw, collectionEvidence: _coverage, relations, ...position }) => ({
      ...position, reuseExisting: true as const, relations: relations?.map(({ sequenceNo, relationKey }) => ({ sequenceNo, relationKey })),
    }))
    const reuse = await post('commit', request('598-reference-reuse', { platformQueries: referenced }))
    expect(reuse).toMatchObject({ status: 'committed', summary: { written: 0 } })
    const { rows: ids } = await db.execute<{ id: string }>(sql`SELECT public_id id FROM platform_business_observation ORDER BY public_id`)
    const repair = { ...request('598-maintenance', {}), payload: { platformRecordObservations: ids.map(({ id }) => ({ relationId: Number(id) })) } }
    await post('preflight', repair, 400)
    await post('commit', repair, 400)
    await check()
    expect(await snapshot()).toEqual(before)
    // The original submitted file is outside the PostgreSQL transaction. A hard
    // third-source failure must retain its exact bytes and the failed receipt.
    const originalFile = join(dir, 'original-submission.json')
    const freshQueries = structuredClone(queries)
    for (const q of freshQueries) { q.queryKey += ':failure'; q.queriedAt = '2026-11-02T00:00:00Z'; if (q.collectionEvidence) { q.collectionEvidence.queriedAt = q.queriedAt; q.collectionEvidence.completedAt = q.queriedAt } }
    await db.execute(sql`
      CREATE FUNCTION business.reject_recognized_observation() RETURNS trigger LANGUAGE plpgsql AS
      $$
      BEGIN
        IF EXISTS (SELECT 1 FROM business.platform_collection WHERE id=NEW.collection_id AND interface='recognized_list') THEN
          RAISE EXCEPTION '598 hard failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fail_598 BEFORE INSERT ON business.platform_business_observation
        FOR EACH ROW EXECUTE FUNCTION business.reject_recognized_observation();
    `)
    const failedRequest = request('598-failure', { platformQueries: freshQueries })
    const originalBytes = JSON.stringify(failedRequest)
    writeFileSync(originalFile, originalBytes)
    const failed = await post('commit', JSON.parse(readFileSync(originalFile, 'utf8')))
    expect(failed.status).toBe('failed')
    expect(failed.items.map((item: { error: { code: string } }) => item.error.code))
      .toEqual(['commit_rolled_back', 'commit_rolled_back', 'platform_write_failed'])
    expect(await snapshot()).toEqual(before)
    expect((await db.execute(sql`SELECT status FROM import_batch WHERE idempotency_key='598-failure'`)).rows).toEqual([{ status: 'failed' }])
    expect(readFileSync(originalFile, 'utf8')).toBe(originalBytes)
    writeFileSync(join(dir, 'failed-receipt.json'), JSON.stringify(failed, null, 2))
    await db.execute(sql`DROP TRIGGER fail_598 ON business.platform_business_observation`)
    expect((await post('commit', failedRequest)).status).toBe('committed')
    await check()
    const recovered = await snapshot()
    for (const table of ['difference_reason', 'record_correspondence', 'record_correspondence_audit'])
      expect(recovered[table]).toEqual(before[table])
    expect(readFileSync(originalFile, 'utf8')).toBe(originalBytes)
    expect(JSON.parse(readFileSync(join(dir, 'failed-receipt.json'), 'utf8'))).toEqual(failed)
    if (retained) writeFileSync(join(dir, 'receipts.json'), JSON.stringify({ raw, queries, receipts, invariantSnapshot: before }, null, 2))
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await closeApplicationLogging()
    await closePostgresDirectoryDb()
    postgres.close()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    if (!retained) rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)
