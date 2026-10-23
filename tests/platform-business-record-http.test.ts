import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { schema, useDb } from '../db'
import { readImportReceipt } from '../server/utils/import-receipts'
import { getRecordCorrespondence, preflightRecordCorrespondences, commitRecordCorrespondences } from '../server/utils/record-correspondence'
import { planPlatformObservation, PLATFORM_RAW_HASH_RULE } from '../server/utils/platform-business-record'
import type { RosterImportPayload, RosterImportRequest } from '../lib/roster-import-client'
import { startRosterApi } from './helpers/roster-http-server'

const dirs: string[] = []
afterAll(() => dirs.forEach(dir => rmSync(dir, { recursive: true, force: true })))
type Db = ReturnType<typeof useDb>
function request(key: string, payload: RosterImportPayload): RosterImportRequest {
  return { idempotencyKey: key, sourceKind: 'platform_archive', sourceIdentity: 'tests/platform-archive', payload }
}
function query(time: string, raw: Record<string, unknown> | null = { id: 'SQ1', qymc: '乐乐互游' }, source: 'business_list' | 'apply_list' = 'business_list', key: string | null = 'SQ1') {
  return { interface: source, queryKey: 'name:乐乐互游', queriedAt: time, status: 'success' as const, relations: [{ sequenceNo: 1, relationKey: key, rawFields: raw }] }
}
function counts(db: Db) {
  return ['platform_business_record', 'platform_business_record_version', 'platform_business_observation'].map(table => db.get<{ n: number }>(sql.raw(`SELECT count(*) n FROM ${table}`))!.n)
}
async function fixture(run: (db: Db, post: (action: string, body: unknown) => Promise<any>) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'identity244-')); dirs.push(dir)
  const db = useDb({ dbPath: join(dir, 'roster.db') })
  const server = await startRosterApi({ db, apiToken: 'synthetic-test-token' })
  try {
    await run(db, async (action, body) => {
      const response = await fetch(`${server.baseUrl}/api/roster/import/${action}`, { method: 'POST', headers: { authorization: 'Bearer synthetic-test-token', 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return { http: response.status, ...await response.json() as object }
    })
  } finally { await server.close() }
}
function legacy(db: Db, id: number, rawFields: Record<string, unknown> | null = { id: 'SQ1', year: '2022', qymc: '合成乐乐互游' }, source: 'business_list' | 'apply_list' = 'business_list') {
  const queryId = db.insert(schema.platformQuery).values({ id: ({ 1076: 557, 3161: 2788, 1077: 560, 3160: 2787 } as Record<number, number>)[id], interface: source, queryKey: 'name:合成乐乐互游', queriedAt: String(id), status: 'success', rawResponse: '原响应保留', rdjb: '2', titleCode: 'specialized_sme' }).returning().get().id
  return db.insert(schema.platformRelation).values({ id, queryId, sequenceNo: 1, relationKey: 'SQ1', rawFields, year: null, sourceText: '原观察文本' }).returning().get()
}

describe('platform identity through public import HTTP', () => {
  it.each([null, 2, 'invalid', {}])('returns item errors for malformed relation %j without partially writing archives', async invalid => fixture(async (db, post) => {
    const body = {
      ...request('invalid-row', {}),
      payload: { platformQueries: [query('valid'), { ...query('invalid'), relations: [invalid] }] },
    }
    const preview = await post('preflight', body)
    expect(preview.http).toBe(200)
    expect(preview.preflight.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ error: expect.objectContaining({ code: 'sequence_no_required' }) })]))
    const saved = await post('commit', body)
    expect(saved.http).toBe(200)
    expect(saved.status).toBe('failed')
    expect(saved.items).toEqual(expect.arrayContaining([expect.objectContaining({ error: expect.objectContaining({ code: 'sequence_no_required' }) })]))
    expect(counts(db)).toEqual([0, 0, 0])
    expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_query`)!.n).toBe(0)
  }))

  it('keeps two interface records and versions for four sample observations and reuses skip projections', async () => fixture(async (db, post) => {
    const payload = { platformQueries: [query('2026-10-01'), query('2026-10-02'), query('2026-10-01', undefined, 'apply_list'), query('2026-10-02', undefined, 'apply_list')] }
    const pre = await post('preflight', request('sample', payload))
    expect(pre.http).toBe(200); expect(pre.preflight.conflicts).toEqual([]); expect(counts(db)).toEqual([0, 0, 0])
    const saved = await post('commit', request('sample', payload))
    expect(saved.status).toBe('committed'); expect(counts(db)).toEqual([2, 2, 4])
    const replay = await post('commit', request('sample-skip', payload))
    expect(replay.status).toBe('committed'); expect(replay.summary.written).toBe(0); expect(counts(db)).toEqual([2, 2, 4])
    expect(replay.items.flatMap((i: any) => i.detail.canonicalProjection).every((o: any) => o.recordId && o.versionId && !o.observationCreated)).toBe(true)
  }))

  it('preserves A to B to A and recursive object order while retaining arrays types null and missing keys', async () => fixture(async (db, post) => {
    const raws = [
      { id: 'SQ1', nested: { b: 2, a: 1 }, values: [1, 2] },
      { id: 'SQ1', nested: { a: 1, b: 2 }, values: [2, 1] },
      { values: [1, 2], nested: { a: 1, b: 2 }, id: 'SQ1' },
      { id: 'SQ1', nested: { a: '1', b: 2 }, values: [1, 2] },
      { id: 'SQ1', nested: { a: 1, b: 2 }, values: [1, 2], extra: null },
    ]
    const out = await post('commit', request('versions', { platformQueries: raws.map((raw, i) => query(`2026-10-${10 + i}`, raw)) }))
    expect(out.status).toBe('committed'); expect(counts(db)).toEqual([1, 4, 5])
    const observations = db.all<{ versionId: number }>(sql`SELECT version_id AS versionId FROM platform_business_observation ORDER BY relation_id`)
    expect(observations[0]!.versionId).toBe(observations[2]!.versionId)
    expect(observations[0]!.versionId).not.toBe(observations[1]!.versionId)
  }))

  it('retains missing keys raw and contradictory keys without synthesizing versions from normalized columns', async () => fixture(async (db, post) => {
    const payload = { platformQueries: [query('1', { qymc: '同名' }, 'business_list', null), query('2', { qymc: '同名' }, 'business_list', null), query('3', null), query('4', {}, 'business_list', 'SQ2'), query('5', { id: 'OTHER' })] }
    const out = await post('commit', request('unknown', payload))
    expect(out.status).toBe('committed'); expect(counts(db)).toEqual([2, 0, 5])
    expect(db.all(sql`SELECT identity_state, content_state, version_id FROM platform_business_observation ORDER BY relation_id`)).toEqual([
      { identity_state: 'missing_key', content_state: 'unverifiable', version_id: null },
      { identity_state: 'missing_key', content_state: 'unverifiable', version_id: null },
      { identity_state: 'resolved', content_state: 'unverifiable', version_id: null },
      { identity_state: 'resolved', content_state: 'unverifiable', version_id: null },
      { identity_state: 'conflict', content_state: 'unverifiable', version_id: null },
    ])
    expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_relation`)!.n).toBe(5)
  }))

  it.each(['raw', 'key'])('rejects changed %s at the same collection row and rolls back the whole batch', async mode => fixture(async (db, post) => {
    expect((await post('commit', request('original', { platformQueries: [query('1')] }))).status).toBe('committed')
    const changed = mode === 'raw' ? query('1', { id: 'SQ1', qymc: 'changed' }) : query('1', { id: 'SQ1', qymc: '乐乐互游' }, 'business_list', 'SQ2')
    const out = await post('commit', request(`conflict-${mode}`, { platformQueries: [query('2'), changed] }))
    expect(out.status).toBe('failed'); expect(out.items.some((i: any) => i.error?.code === 'observation_payload_conflict')).toBe(true)
    expect(counts(db)).toEqual([1, 1, 1]); expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_query`)!.n).toBe(1)
  }))

  it('rejects different same-batch row payloads before any business write', async () => fixture(async (db, post) => {
    const out = await post('commit', request('same-batch', { platformQueries: [query('1'), query('1', { id: 'SQ2' }, 'business_list', 'SQ2')] }))
    expect(out.status).toBe('failed'); expect(out.items.some((i: any) => i.error?.code === 'observation_payload_conflict')).toBe(true); expect(counts(db)).toEqual([0, 0, 0])
  }))

  it('serializes concurrent HTTP imports with database uniqueness and durable receipts', async () => fixture(async (db, post) => {
    const results = await Promise.all([1, 2, 3].map(i => post('commit', request(`concurrent-${i}`, { platformQueries: [query(String(i))] }))))
    expect(results.map(r => r.status)).toEqual(['committed', 'committed', 'committed']); expect(counts(db)).toEqual([1, 1, 3])
    const same = await Promise.all([1, 2].map(() => post('commit', request('concurrent-1', { platformQueries: [query('1')] }))))
    expect(same[0].batchId).toBe(same[1].batchId); expect(counts(db)).toEqual([1, 1, 3])
  }))

  it('backfills sample relation IDs with unchanged old references fingerprints raw audit and normalized gaps', async () => fixture(async (db, post) => {
    // Synthetic fixture reproducing the supplied IDs/pattern; no production backup is read.
    const rows = [legacy(db, 1076), legacy(db, 3161), legacy(db, 1077, undefined, 'apply_list'), legacy(db, 3160, undefined, 'apply_list')]
    const enterprise = db.insert(schema.enterprise).values({ name: '合成乐乐互游', nameNorm: '合成乐乐互游', usccNorm: '91330211255994457P' }).returning().get()
    const record = db.insert(schema.record).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', source: 'jxj' }).returning().get()
    const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2022 }).returning().get()
    db.run(sql`UPDATE platform_relation SET enterprise_id=${enterprise.id}, uscc_raw=${enterprise.usccNorm}, match_basis='uscc', verification_status='confirmed' WHERE id=1076`)
    const correspondenceRequest = { idempotencyKey: 'old-decision', sourceIdentity: 'synthetic-old', actor: { type: 'agent' as const, id: 'test' }, basis: 'fixture', ruleId: 'manual', ruleVersion: '1', operations: [{ action: 'create' as const, status: 'confirmed' as const, edge: { type: 'event_process' as const, eventId: event.id, relationId: 1076, role: 'context_only' as const } }] }
    db.run(sql`INSERT INTO sqlite_sequence(name,seq) VALUES ('record_correspondence',328)`)
    const plan = preflightRecordCorrespondences(db, correspondenceRequest)
    const receipt = commitRecordCorrespondences(db, correspondenceRequest, plan.planHash)
    const oldId = receipt.correspondenceIds[0]!
    expect(oldId).toBe(329)
    db.insert(schema.enterpriseAlias).values({ enterpriseId: enterprise.id, name: '旧称', nameNorm: '旧称', sourceKind: 'platform_business', sourceRefId: 1076 }).run()
    db.insert(schema.differenceReason).values({ id: 1055, enterpriseId: enterprise.id, titleCode: 'specialized_sme', direction: 'missing_in_miit', recordedAt: '2026-10-01', evidenceQueryId: rows[0]!.queryId, evidenceRelationId: 1076 }).run()
    const oldDecision = getRecordCorrespondence(db, oldId)
    expect(oldDecision?.requiresRevalidation).toBe(false)
    const snapshot = () => ['platform_query', 'platform_relation', 'record_correspondence', 'record_correspondence_audit', 'difference_reason', 'enterprise_alias'].map(table => db.all(sql.raw(`SELECT * FROM ${table} ORDER BY id`)))
    const before = snapshot()
    const req = request('history', { platformRecordObservations: rows.map(row => ({ relationId: row.id })) })
    expect((await post('preflight', req)).preflight.canonicalProjection).toHaveLength(4); expect(counts(db)).toEqual([0, 0, 0]); expect(snapshot()).toEqual(before)
    const saved = await post('commit', req)
    expect(saved.status).toBe('committed'); expect(saved.summary.written).toBe(0); expect(saved.summary.canonicalProjection).toMatchObject({ recordsCreated: 2, versionsCreated: 2, observationsCreated: 4 })
    expect(counts(db)).toEqual([2, 2, 4]); expect(snapshot()).toEqual(before); expect(getRecordCorrespondence(db, oldId)).toEqual(oldDecision)
    expect((await post('commit', req))).toMatchObject({ batchId: saved.batchId, summary: saved.summary, items: saved.items })
    expect(readImportReceipt(db, 'get', { idempotencyKey: 'history' })).toMatchObject({ status: 'committed', sourceKind: 'platform_archive', itemCount: 4 })
    const retried = await post('commit', request('history-resume', req.payload))
    expect(retried.status).toBe('committed'); expect(retried.summary.canonicalProjection).toMatchObject({ recordsCreated: 0, versionsCreated: 0, observationsCreated: 0, observationsReused: 4 }); expect(counts(db)).toEqual([2, 2, 4])
    // New normalized year is filled from identical raw, without manufacturing a content version.
    expect((await post('commit', request('new-normalized', { platformQueries: [query('new', rows[0]!.rawFields)] }))).status).toBe('committed')
    expect(counts(db)).toEqual([2, 2, 5]); expect(db.get(sql`SELECT year FROM platform_relation WHERE id=1076`)).toEqual({ year: null })
  }))

  it('reports absent historical sources and recovers a failed batch with the same key', async () => fixture(async (db, post) => {
    const req = request('recover', { platformRecordObservations: [{ relationId: 1 }] })
    const failed = await post('commit', req)
    expect(failed.status).toBe('failed'); expect(failed.items[0].error.code).toBe('projection_source_missing'); expect(counts(db)).toEqual([0, 0, 0])
    legacy(db, 1)
    const recovered = await post('commit', req)
    expect(recovered.status).toBe('committed'); expect(recovered.batchId).toBe(failed.batchId); expect(counts(db)).toEqual([1, 1, 1])
    expect(readImportReceipt(db, 'history', { idempotencyKey: 'recover' })).toMatchObject({ total: 2 })
    const conflict = await post('commit', request('recover', { platformRecordObservations: [{ relationId: 2 }] }))
    expect(conflict.http).toBe(409); expect(conflict.error.code).toBe('idempotency_conflict')
  }))

  it('rejects source drift since preflight or mapping and preserves the frozen input across retries', async () => fixture(async (db, post) => {
    legacy(db, 1); legacy(db, 2)
    const req = request('drift', { platformRecordObservations: [{ relationId: 1 }, { relationId: 2 }] })
    expect((await post('preflight', req)).preflight.conflicts).toEqual([])
    const changedCommand = { ...req, payload: { ...req.payload, aliases: [] } }
    expect((await post('preflight', changedCommand)).http).toBe(409)
    db.run(sql`UPDATE platform_relation SET raw_fields='{"id":"SQ1","changed":true}' WHERE id=2`)
    for (let i = 0; i < 2; i++) {
      const out = await post('commit', req)
      expect(out.status).toBe('failed'); expect(out.items.some((item: any) => item.error?.code === 'projection_source_drift')).toBe(true); expect(counts(db)).toEqual([0, 0, 0])
    }
    expect((await post('commit', request('drift-new-plan', req.payload))).status).toBe('committed')
    db.run(sql`UPDATE platform_relation SET relation_key='changed' WHERE id=1`)
    const out = await post('commit', request('drift-mapped', { platformRecordObservations: [{ relationId: 1 }] }))
    expect(out.status).toBe('failed'); expect(out.items[0].error.code).toBe('projection_source_drift'); expect(counts(db)).toEqual([1, 2, 2])
  }))

  it('rolls back original archives and all projections on an injected transaction failure then recovers', async () => fixture(async (db, post) => {
    db.run(sql.raw("CREATE TRIGGER fail_projection BEFORE INSERT ON platform_business_observation WHEN NEW.relation_id=2 BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END"))
    const req = request('rollback', { platformQueries: [query('1'), query('2')] })
    const failed = await post('commit', req)
    expect(failed.status).toBe('failed'); expect(failed.error).toContain('synthetic failure'); expect(counts(db)).toEqual([0, 0, 0]); expect(db.get(sql`SELECT count(*) n FROM platform_relation`)).toEqual({ n: 0 }); expect(db.get(sql`SELECT count(*) n FROM platform_query`)).toEqual({ n: 0 })
    expect(readImportReceipt(db, 'get', { idempotencyKey: 'rollback' })).toMatchObject({ status: 'failed', summary: { written: 0 } })
    db.run(sql`DROP TRIGGER fail_projection`)
    const recovered = await post('commit', req)
    expect(recovered.status).toBe('committed'); expect(recovered.batchId).toBe(failed.batchId); expect(counts(db)).toEqual([1, 1, 2])
  }))

  it('checks canonical raw on a hash hit and atomically refuses corrupt content reuse', async () => fixture(async (db, post) => {
    legacy(db, 1)
    const plan = planPlatformObservation({ interface: 'business_list', relationKey: 'SQ1', rawFields: { id: 'SQ1', year: '2022', qymc: '合成乐乐互游' } })
    const record = db.insert(schema.platformBusinessRecord).values({ interface: 'business_list', platformKey: 'SQ1', identityRuleVersion: 'platform-observation-v1' }).returning().get()
    db.insert(schema.platformBusinessRecordVersion).values({ recordId: record.id, hashAlgorithm: PLATFORM_RAW_HASH_RULE, contentHash: plan.contentHash!, canonicalRawJson: '{"different":true}' }).run()
    const out = await post('commit', request('collision', { platformQueries: [query('new', { id: 'NEW' }, 'business_list', 'NEW')], platformRecordObservations: [{ relationId: 1 }] }))
    expect(out.status).toBe('failed'); expect(out.items.some((i: any) => i.error?.code === 'platform_content_hash_conflict')).toBe(true); expect(counts(db)).toEqual([1, 1, 0]); expect(db.get(sql`SELECT count(*) n FROM platform_relation`)).toEqual({ n: 1 })
  }))

  it('keeps malformed historical raw unverifiable and derives keys only from real raw ids', async () => fixture(async (db, post) => {
    legacy(db, 1); legacy(db, 2); legacy(db, 3, { id: '  real-id  ', unknown: [null, true] }); legacy(db, 4, { id: 42, qymc: 'same' })
    db.run(sql`UPDATE platform_relation SET raw_fields='broken-json' WHERE id=1`)
    db.run(sql`UPDATE platform_relation SET raw_fields=NULL, year=2022, status='终审通过' WHERE id=2`)
    db.run(sql`UPDATE platform_relation SET relation_key=NULL WHERE id IN (3,4)`)
    const out = await post('commit', request('malformed', { platformRecordObservations: [1, 2, 3, 4].map(relationId => ({ relationId })) }))
    expect(out.status).toBe('committed'); expect(counts(db)).toEqual([2, 1, 4])
    expect(db.all(sql`SELECT identity_state,content_state,key_source,version_id FROM platform_business_observation ORDER BY relation_id`)).toEqual([
      { identity_state: 'resolved', content_state: 'unverifiable', key_source: 'relation_key', version_id: null },
      { identity_state: 'resolved', content_state: 'unverifiable', key_source: 'relation_key', version_id: null },
      { identity_state: 'resolved', content_state: 'verified', key_source: 'raw_id', version_id: expect.any(Number) },
      { identity_state: 'missing_key', content_state: 'unverifiable', key_source: 'none', version_id: null },
    ])
    expect(db.get(sql`SELECT platform_key FROM platform_business_record WHERE platform_key='real-id'`)).toEqual({ platform_key: 'real-id' })
  }))

  it.each([
    { label: 'null', value: null }, { label: 'object', value: {} }, { label: 'empty', value: [] },
    { label: 'zero-id', value: [{ relationId: 0 }] }, { label: 'fraction-id', value: [{ relationId: 1.5 }] },
    { label: 'string-id', value: [{ relationId: '1' }] }, { label: 'unsafe-id', value: [{ relationId: Number.MAX_SAFE_INTEGER + 1 }] },
    { label: 'client-hash', value: [{ relationId: 1, contentHash: 'client' }] },
    { label: 'duplicate-id', value: [{ relationId: 1 }, { relationId: 1 }] },
    { label: 'over-100', value: Array.from({ length: 101 }, (_, i) => ({ relationId: i + 1 })) },
  ])('rejects malformed historical projection commands without false success case $label', async ({ value }) => fixture(async (db, post) => {
    const out = await post('commit', request('invalid', { platformRecordObservations: value } as any))
    expect(out.http).toBe(400); expect(db.get(sql`SELECT count(*) n FROM import_batch`)).toEqual({ n: 0 }); expect(counts(db)).toEqual([0, 0, 0])
  }))

  it('accepts exactly 100 historical sources and rejects archive noops or a wrong source kind', async () => fixture(async (db, post) => {
    for (let i = 1; i <= 100; i++) legacy(db, i)
    expect((await post('commit', request('boundary100', { platformRecordObservations: Array.from({ length: 100 }, (_, i) => ({ relationId: i + 1 })) }))).status).toBe('committed'); expect(counts(db)).toEqual([1, 1, 100])
    expect((await post('commit', request('empty', {}))).http).toBe(400)
    expect((await post('commit', { ...request('wrong-source', { platformRecordObservations: [{ relationId: 1 }] }), sourceKind: 'alias_evidence' })).http).toBe(400)
    expect((await post('replay', request('wrong-action', { platformRecordObservations: [{ relationId: 1 }] }))).http).toBe(400)
  }))

  it('projects the existing skip branch for an unindexed legacy row without changing archive metadata', async () => fixture(async (db, post) => {
    const row = legacy(db, 1)
    const before = db.all(sql`SELECT * FROM platform_relation`)
    const out = await post('commit', request('legacy-skip', { platformQueries: [{ ...query('1', row.rawFields), queryKey: 'name:合成乐乐互游', rdjb: '2', titleCode: 'specialized_sme' }] }))
    expect(out.status).toBe('committed'); expect(out.summary.written).toBe(0); expect(counts(db)).toEqual([1, 1, 1]); expect(db.all(sql`SELECT * FROM platform_relation`)).toEqual(before)
  }))

  it('rejects differing repeated sequence rows and reuses identical rows within one batch', async () => fixture(async (db, post) => {
    const q = query('one')
    const different = { ...q, relations: [...q.relations, { ...q.relations[0]!, relationKey: 'different' }] }
    const failed = await post('commit', request('seq-conflict', { platformQueries: [different] }))
    expect(failed.status).toBe('failed'); expect(failed.items[0].error.code).toBe('observation_payload_conflict'); expect(counts(db)).toEqual([0, 0, 0])
    const same = { ...q, relations: [...q.relations, ...q.relations] }
    expect((await post('commit', request('seq-identical', { platformQueries: [same, q] }))).status).toBe('committed'); expect(counts(db)).toEqual([1, 1, 1])
  }))
})
