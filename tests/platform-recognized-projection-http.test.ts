import { initializeDb } from '../db/client'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { schema, useDb } from '../db'
import type { RosterImportPayload, RosterImportPlatformQuery, RosterImportRequest } from '../lib/roster-import-client'
import { listCurrentQualified } from '../lib/roster/current-qualified-query'
import { startRosterApi } from './helpers/roster-http-server'

const dirs: string[] = []
afterAll(() => dirs.forEach(dir => rmSync(dir, { recursive: true, force: true })))
type Db = ReturnType<typeof useDb>

function request(key: string, payload: RosterImportPayload): RosterImportRequest {
  return { idempotencyKey: key, sourceKind: 'platform_archive', sourceIdentity: 'tests/recognized-projection', payload }
}

/** A valid original queryBusList envelope for the public import seam. Legacy rows are
 * string-only; typed JSON rows are exercised through platformRecordObservations. */
function recognizedQuery(time: string, rows: Record<string, string>[], rdjb = '2', queryKey = '91330200RECOGNIZED01'): RosterImportPlatformQuery {
  const evidence = {
    source: 'queryBusList' as const, status: 'success' as const,
    effectiveConditions: { combination: 'and' as const },
    titleScope: { mode: 'selected' as const, rdjb: [rdjb] },
    queriedAt: time, completedAt: new Date(Date.parse(time) + 60000).toISOString(),
    rows, fetchedCount: rows.length, declaredTotal: rows.length,
    pages: [{ source: 'queryBusList' as const, rdjb, page: 1, status: 'success' as const, fetchedCount: rows.length, declaredTotal: rows.length, maxPage: 1, error: null }],
    completeness: 'complete' as const, fullRange: true, unfinished: [], error: null,
    limits: { pageSize: 50, maxRequests: 100, maxRows: 5000, maxDurationMs: 60000 },
  }
  return {
    interface: 'recognized_list' as const,
    queryKey, rdjb,
    titleCode: ({ '1': 'innovative_sme', '2': 'specialized_sme', '3': 'little_giant' } as const)[rdjb as '1' | '2' | '3'],
    queriedAt: time, status: 'success' as const, collectionEvidence: evidence as never,
    relations: rows.map((raw, index) => ({
      sequenceNo: index + 1,
      relationKey: raw.id ?? null,
      usccRaw: raw.tyshxydm ?? null,
      nameRaw: raw.qymc ?? null,
      rawFields: raw as never,
    })),
  }
}

/** Historical projection path: seeded archive row with typed JSON, projected by relationId. */
function seedArchived(db: Db, options: { time: string; relationKey: string | null; raw: unknown }) {
  const query = db.insert(schema.platformQuery).values({
    interface: 'recognized_list', queryKey: '91330200RECOGNIZED01', rdjb: '2', queriedAt: options.time, status: 'success',
  }).returning().get()
  return db.insert(schema.platformRelation).values({
    queryId: query.id, sequenceNo: 1, relationKey: options.relationKey, rawFields: options.raw as never,
  }).returning().get()
}

async function fixture(run: (db: Db, post: (action: string, body: unknown) => Promise<Record<string, any>>) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'recognized461-')); dirs.push(dir)
  const db = initializeDb({ create: true, dbPath: join(dir, 'roster.db') })
  const server = await startRosterApi({ db, apiToken: 'synthetic-apply-token' })
  try {
    await run(db, async (action, body) => {
      const response = await fetch(server.baseUrl + '/api/roster/import/' + action, { method: 'POST', headers: { authorization: 'Bearer synthetic-apply-token', 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return { http: response.status, ...await response.json() as object }
    })
  } finally { await server.close() }
}

describe('recognized_list typed projection through public import HTTP', () => {
  it('reads back typed source fields exactly and leaves the original archive identity intact', async () => fixture(async (db, post) => {
    const raw = {
      id: ' UUID-RECOGNIZED-1 ',
      qymc: ' 合成认定企业 ',
      tyshxydm: ' 91330211255994457P ',
      rddqrq: ' 2027-06-30 ',
      whpcyear: '2024',
      whpc: ' 2 ',
      szq: ' 33020000 ',
      rdxx: ' 原认定说明 ',
      rdjb: ' 2 ',
      unknownSourceField: '保留',
    }
    const saved = await post('commit', request('typed-readback', { platformQueries: [recognizedQuery('2026-10-01T00:00:00Z', [raw])] }))
    expect(saved.status).toBe('committed')

    const relation = db.get<{ id: number; queryId: number; rawText: string; relationKey: string }>(sql`SELECT id, query_id AS queryId, raw_fields AS rawText, relation_key AS relationKey FROM platform_relation`)
    expect(relation).toMatchObject({ relationKey: raw.id.trim() })
    expect(JSON.parse(relation!.rawText)).toEqual(raw)
    const observation = db.get<{ relationId: number; recordId: number; versionId: number; projectionRuleVersion: string; identityState: string; contentState: string }>(sql`SELECT relation_id AS relationId, record_id AS recordId, version_id AS versionId, projection_rule_version AS projectionRuleVersion, identity_state AS identityState, content_state AS contentState FROM platform_business_observation`)
    expect(observation).toMatchObject({ relationId: relation!.id, identityState: 'resolved', contentState: 'verified', projectionRuleVersion: 'platform-observation-v1' })
    expect(db.get(sql`SELECT * FROM platform_recognized_projection`)).toEqual({
      version_id: observation!.versionId,
      record_id: observation!.recordId,
      validity_date_raw: '2027-06-30',
      maintenance_year: 2024,
      maintenance_batch: '2',
      source_validity_date: ' 2027-06-30 ',
      source_maintenance_batch: ' 2 ',
      source_maintenance_year_absent: 0,
      district: '33020000',
      award_note: '原认定说明',
      title_raw: '2',
      name_raw: '合成认定企业',
      uscc_raw: '91330211255994457P',
      rule_version: 'platform-recognized-v1',
      created_at: expect.any(String),
    })
    // The query title scope stays a query fact; the row-level raw title is separate.
    expect(db.get(sql`SELECT rdjb FROM platform_query`)).toEqual({ rdjb: '2' })
    expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_recognized_projection`)!.n).toBe(1)
  }))

  it('completes uncaptured fidelity with a new public command, replays idempotently and rolls back captured conflicts atomically', async () => fixture(async (db, post) => {
    const a = seedArchived(db, {time: '2026-10-01T00:00:00Z', relationKey: 'COMPLETE-A', raw: {id: 'COMPLETE-A', rddqrq: ' 2028-11-20 ', whpc: '2026-1', whpcyear: false}})
    const b = seedArchived(db, {time: '2026-10-02T00:00:00Z', relationKey: 'COMPLETE-B', raw: {id: 'COMPLETE-B', rddqrq: 2028, whpc: null}})
    const payload = {platformRecordObservations: [{relationId: a.id}, {relationId: b.id}]}
    const originalRequest = request('fidelity-original', payload)
    expect((await post('commit', originalRequest)).status).toBe('committed')
    const originals = () => Object.fromEntries(['platform_relation', 'platform_query', 'platform_business_record', 'platform_business_record_version', 'platform_business_observation'].map(table => [table, db.all(sql.raw('SELECT * FROM ' + table))]))
    const original = originals()
    const normalized = () => db.all(sql`SELECT version_id,record_id,validity_date_raw,maintenance_year,maintenance_batch,district,award_note,title_raw,name_raw,uscc_raw,rule_version,created_at FROM platform_recognized_projection ORDER BY version_id`)
    const normalizedBefore = normalized()
    const fidelity = () => db.all(sql`SELECT source_validity_date,source_maintenance_batch,source_maintenance_year_absent FROM platform_recognized_projection ORDER BY version_id`)
    const captured = fidelity()
    expect(captured).toEqual([
      {source_validity_date: ' 2028-11-20 ', source_maintenance_batch: '2026-1', source_maintenance_year_absent: 0},
      {source_validity_date: null, source_maintenance_batch: null, source_maintenance_year_absent: 1},
    ])
    db.run(sql`UPDATE platform_recognized_projection SET source_validity_date=NULL,source_maintenance_batch=NULL,source_maintenance_year_absent=NULL`)
    const uncaptured = fidelity()
    // A committed idempotency key returns its old receipt and cannot fill new facts.
    expect((await post('commit', originalRequest)).status).toBe('committed')
    expect(fidelity()).toEqual(uncaptured)
    const completion = request('source-fidelity-v1/complete', payload)
    expect((await post('preflight', completion)).http).toBe(200)
    expect(fidelity()).toEqual(uncaptured)
    expect((await post('commit', completion)).status).toBe('committed')
    expect(fidelity()).toEqual(captured)
    expect(originals()).toEqual(original)
    expect(normalized()).toEqual(normalizedBefore)
    const retry = await post('commit', completion)
    expect(retry.status).toBe('committed')
    expect(fidelity()).toEqual(captured)
    expect((await post('commit', request('source-fidelity-v1/recheck', payload))).summary.canonicalProjection).toMatchObject({recognizedProjectionsCreated: 0, recognizedProjectionsReused: 2})
    // Each captured scalar is independently protected. A prior completion in
    // the same batch must roll back when the second row conflicts.
    for (const [index, tamper] of [
      'source_maintenance_year_absent=0',
      "source_validity_date='tampered'",
      "source_maintenance_batch='tampered'",
      "source_maintenance_year_absent=NULL,source_validity_date='partial'",
    ].entries()) {
      db.run(sql`UPDATE platform_recognized_projection SET source_validity_date=NULL,source_maintenance_batch=NULL,source_maintenance_year_absent=NULL WHERE version_id=(SELECT min(version_id) FROM platform_recognized_projection)`)
      db.run(sql`UPDATE platform_recognized_projection SET source_validity_date=NULL,source_maintenance_batch=NULL,source_maintenance_year_absent=1 WHERE version_id=(SELECT max(version_id) FROM platform_recognized_projection)`)
      db.run(sql.raw('UPDATE platform_recognized_projection SET ' + tamper + ' WHERE version_id=(SELECT max(version_id) FROM platform_recognized_projection)'))
      const beforeConflict = fidelity()
      const failed = await post('commit', request('source-fidelity-v1/conflict/' + index, payload))
      expect(failed.status).toBe('failed')
      expect(failed.items.some((item: any) => item.error?.code === 'recognized_projection_conflict')).toBe(true)
      expect(fidelity()).toEqual(beforeConflict)
      expect(originals()).toEqual(original)
      expect(normalized()).toEqual(normalizedBefore)
    }
  }))

  it('preserves validity value precision, accepts number/string maintenance years and never parses a date', async () => fixture(async (db, post) => {
    const numeric = seedArchived(db, { time: '2026-10-01T00:00:00Z', relationKey: 'UUID-NUMERIC', raw: { id: 'UUID-NUMERIC', qymc: '数字年份企业', rddqrq: '2027', whpcyear: 2024, whpc: '2', szq: '33020000' } })
    const textual = seedArchived(db, { time: '2026-10-02T00:00:00Z', relationKey: 'UUID-TEXTUAL', raw: { id: 'UUID-TEXTUAL', qymc: '文本年份企业', rddqrq: '2027/06/30', whpcyear: '2023', whpc: '1' } })
    const unknown = seedArchived(db, { time: '2026-10-03T00:00:00Z', relationKey: 'UUID-UNKNOWN', raw: { id: 'UUID-UNKNOWN', qymc: '未知值企业', rddqrq: '2027-06-30', whpcyear: ' 2024 ', whpc: '未知批次', szq: ' 原始属地 ', rdxx: '', rdjb: null } })
    const saved = await post('commit', request('typed-numeric', { platformRecordObservations: [{ relationId: numeric.id }, { relationId: textual.id }, { relationId: unknown.id }] }))
    expect(saved.status).toBe('committed')
    expect(saved.summary.canonicalProjection).toMatchObject({ recognizedProjectionsCreated: 3, recognizedProjectionsReused: 0 })
    expect(db.all(sql`SELECT validity_date_raw AS validityDateRaw, maintenance_year AS maintenanceYear, maintenance_batch AS maintenanceBatch, district, award_note AS awardNote, title_raw AS titleRaw FROM platform_recognized_projection ORDER BY version_id`)).toEqual([
      { validityDateRaw: '2027', maintenanceYear: 2024, maintenanceBatch: '2', district: '33020000', awardNote: null, titleRaw: null },
      { validityDateRaw: '2027/06/30', maintenanceYear: 2023, maintenanceBatch: '1', district: null, awardNote: null, titleRaw: null },
      { validityDateRaw: '2027-06-30', maintenanceYear: null, maintenanceBatch: '未知批次', district: '原始属地', awardNote: null, titleRaw: null },
    ])
  }))

  it('reuses the same content version and creates a new typed version only when raw content changes', async () => fixture(async (db, post) => {
    const raw = { id: 'UUID-REPLAY', qymc: '合成认定企业', rddqrq: '2027', whpcyear: '2024', whpc: '2' }
    const first = await post('commit', request('replay-first', { platformQueries: [recognizedQuery('2026-10-01T00:00:00Z', [raw])] }))
    expect(first.status).toBe('committed')
    expect(first.summary.canonicalProjection).toMatchObject({ recordsCreated: 1, versionsCreated: 1, observationsCreated: 1, recognizedProjectionsCreated: 1, recognizedProjectionsReused: 0 })
    const replay = await post('commit', request('replay-same', { platformQueries: [recognizedQuery('2026-10-01T00:00:00Z', [raw])] }))
    expect(replay.status).toBe('committed')
    expect(replay.summary.canonicalProjection).toMatchObject({ recordsCreated: 0, versionsCreated: 0, observationsReused: 1, recognizedProjectionsCreated: 0, recognizedProjectionsReused: 1 })
    expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_recognized_projection`)!.n).toBe(1)

    const changed = await post('commit', request('replay-changed', { platformQueries: [recognizedQuery('2026-10-02T00:00:00Z', [{ ...raw, whpc: '3' }])] }))
    expect(changed.status).toBe('committed')
    expect(changed.summary.canonicalProjection).toMatchObject({ recordsCreated: 0, versionsCreated: 1, observationsCreated: 1, recognizedProjectionsCreated: 1, recognizedProjectionsReused: 0 })
    expect(db.all(sql`SELECT maintenance_batch AS maintenanceBatch FROM platform_recognized_projection ORDER BY version_id`)).toEqual([{ maintenanceBatch: '2' }, { maintenanceBatch: '3' }])
    expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_relation`)!.n).toBe(2)
  }))

  it('does not create a second version or typed row for the same raw under different query title scopes', async () => fixture(async (db, post) => {
    const raw = { id: 'UUID-SCOPE', qymc: '称号范围企业', rddqrq: '2027', whpcyear: '2024', whpc: '2' }
    const saved = await post('commit', request('scope-replay', { platformQueries: [recognizedQuery('2026-10-01T00:00:00Z', [raw], '2'), recognizedQuery('2026-10-02T00:00:00Z', [raw], '1')] }))
    expect(saved.status).toBe('committed')
    expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_recognized_projection`)!.n).toBe(1)
    expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_business_record_version`)!.n).toBe(1)
    expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_business_observation`)!.n).toBe(2)
    expect(db.all<{ rdjb: string }>(sql`SELECT rdjb FROM platform_query ORDER BY id`)).toEqual([{ rdjb: '2' }, { rdjb: '1' }])
    expect(db.get<{ titleRaw: string | null }>(sql`SELECT title_raw AS titleRaw FROM platform_recognized_projection`)).toEqual({ titleRaw: null })
  }))

  it('keeps a row-level title separate from the query title scope without promoting or writing back', async () => fixture(async (db, post) => {
    const raw = { id: 'UUID-TITLE', qymc: '行称号企业', rdjb: ' 3 ', rddqrq: '2027' }
    const saved = await post('commit', request('row-title', { platformQueries: [recognizedQuery('2026-10-01T00:00:00Z', [raw], '2')] }))
    expect(saved.status).toBe('committed')
    expect(db.get(sql`SELECT title_raw AS titleRaw, validity_date_raw AS validityDateRaw FROM platform_recognized_projection`)).toEqual({ titleRaw: '3', validityDateRaw: '2027' })
    expect(db.get(sql`SELECT rdjb FROM platform_query`)).toEqual({ rdjb: '2' })
    // A different query scope over identical content does not reinterpret the row title.
    await post('commit', request('row-title-scope', { platformQueries: [recognizedQuery('2026-10-03T00:00:00Z', [raw], '1')] }))
    expect(db.all(sql`SELECT title_raw AS titleRaw FROM platform_recognized_projection ORDER BY version_id`)).toEqual([{ titleRaw: '3' }])
    expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_business_record_version`)!.n).toBe(1)
  }))

  it('keeps missing-key, conflicting-key and unverifiable observations isolated without a typed row', async () => fixture(async (db, post) => {
    const missing = seedArchived(db, { time: '2026-10-01T00:00:00Z', relationKey: null, raw: { qymc: '无编号企业', whpcyear: '2024' } })
    const conflict = seedArchived(db, { time: '2026-10-02T00:00:00Z', relationKey: 'RELATION-ID', raw: { id: 'RAW-ID', qymc: '冲突企业' } })
    const unverifiable = seedArchived(db, { time: '2026-10-03T00:00:00Z', relationKey: 'UUID-NO-RAW', raw: null })
    const saved = await post('commit', request('isolated', { platformRecordObservations: [{ relationId: missing.id }, { relationId: conflict.id }, { relationId: unverifiable.id }] }))
    expect(saved.status).toBe('committed')
    expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_recognized_projection`)!.n).toBe(0)
    expect(db.all<{ identityState: string; contentState: string }>(sql`SELECT identity_state AS identityState, content_state AS contentState FROM platform_business_observation ORDER BY relation_id`)).toEqual([
      { identityState: 'missing_key', contentState: 'unverifiable' },
      { identityState: 'conflict', contentState: 'unverifiable' },
      { identityState: 'resolved', contentState: 'unverifiable' },
    ])
  }))

  it('never merges the same platform key across apply_list, business_list and recognized_list', async () => fixture(async (db, post) => {
    const sharedKey = 'SHARED-KEY-1'
    const apply = { interface: 'apply_list' as const, queryKey: sharedKey, rdjb: '', queriedAt: '2026-10-01T00:00:00Z', status: 'success' as const, relations: [{ sequenceNo: 1, relationKey: sharedKey, rawFields: { id: sharedKey, qymc: '同一编号企业', sblx: '申请', year: 2024 } }] }
    const business = { interface: 'business_list' as const, queryKey: sharedKey, rdjb: '2', queriedAt: '2026-10-01T00:00:00Z', status: 'success' as const, relations: [{ sequenceNo: 1, relationKey: sharedKey, rawFields: { id: sharedKey, qymc: '同一编号企业', sblx: '复核', cszt: '终审通过' } }] }
    const recognized = recognizedQuery('2026-10-01T00:00:00Z', [{ id: sharedKey, qymc: '同一编号企业', rddqrq: '2027' }], '2', sharedKey)
    const saved = await post('commit', request('cross-interface', { platformQueries: [business, apply, recognized] }))
    expect(saved.status).toBe('committed')
    expect(db.all<{ interface: string; platformKey: string }>(sql`SELECT interface, platform_key AS platformKey FROM platform_business_record ORDER BY interface`)).toEqual([
      { interface: 'apply_list', platformKey: sharedKey },
      { interface: 'business_list', platformKey: sharedKey },
      { interface: 'recognized_list', platformKey: sharedKey },
    ])
    expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_apply_projection`)!.n).toBe(1)
    expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_business_projection`)!.n).toBe(1)
    expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_recognized_projection`)!.n).toBe(1)
  }))

  it('backfills an existing observation through platformRecordObservations and reports typed receipt counts', async () => fixture(async (db, post) => {
    const relation = seedArchived(db, { time: '2026-09-01T00:00:00Z', relationKey: 'UUID-HISTORY', raw: { id: 'UUID-HISTORY', qymc: '历史认定企业', rddqrq: '2027-12-31', whpcyear: 2023, whpc: '4', szq: '33028100', rdxx: '历史认定说明', rdjb: '1' } })
    const req = request('history-backfill', { platformRecordObservations: [{ relationId: relation.id }] })
    const plan = await post('preflight', req)
    expect(plan.preflight.conflicts).toEqual([])
    expect(plan.preflight.canonicalProjection[0]).toMatchObject({
      relationId: relation.id,
      identityState: 'resolved',
      contentState: 'verified',
      recognizedProjection: { validityDateRaw: '2027-12-31', maintenanceYear: 2023, maintenanceBatch: '4', district: '33028100', awardNote: '历史认定说明', titleRaw: '1', ruleVersion: 'platform-recognized-v1' },
    })
    expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_recognized_projection`)!.n).toBe(0)

    const saved = await post('commit', req)
    expect(saved.status).toBe('committed')
    expect(saved.summary.canonicalProjection).toMatchObject({ recordsCreated: 1, versionsCreated: 1, observationsCreated: 1, recognizedProjectionsCreated: 1 })
    expect(db.get(sql`SELECT validity_date_raw AS validityDateRaw, maintenance_year AS maintenanceYear, maintenance_batch AS maintenanceBatch, district, award_note AS awardNote, title_raw AS titleRaw, rule_version AS ruleVersion FROM platform_recognized_projection`)).toEqual({
      validityDateRaw: '2027-12-31', maintenanceYear: 2023, maintenanceBatch: '4', district: '33028100', awardNote: '历史认定说明', titleRaw: '1', ruleVersion: 'platform-recognized-v1',
    })
    const retried = await post('commit', request('history-backfill-2', { platformRecordObservations: [{ relationId: relation.id }] }))
    expect(retried.status).toBe('committed')
    expect(retried.summary.canonicalProjection).toMatchObject({ observationsReused: 1, recognizedProjectionsCreated: 0, recognizedProjectionsReused: 1 })
    expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_recognized_projection`)!.n).toBe(1)
  }))

  it('returns the original receipt on an identical idempotent replay', async () => fixture(async (_db, post) => {
    const req = request('idempotent', { platformQueries: [recognizedQuery('2026-10-01T00:00:00Z', [{ id: 'UUID-IDEMPOTENT', qymc: '幂等企业', rddqrq: '2027' }])] })
    const first = await post('commit', req)
    expect(first.status).toBe('committed')
    const replay = await post('commit', req)
    expect(replay).toEqual(first)
  }))

  it('rejects a same-version typed projection drift without silently reinterpreting it', async () => fixture(async (db, post) => {
    const req = request('drift-first', { platformQueries: [recognizedQuery('2026-10-01T00:00:00Z', [{ id: 'UUID-DRIFT', qymc: '漂移企业', rddqrq: '2027', whpcyear: '2024' }])] })
    expect((await post('commit', req)).status).toBe('committed')
    db.run(sql`UPDATE platform_recognized_projection SET maintenance_batch = 'tampered'`)
    const failed = await post('commit', request('drift-second', { platformQueries: [recognizedQuery('2026-10-01T00:00:00Z', [{ id: 'UUID-DRIFT', qymc: '漂移企业', rddqrq: '2027', whpcyear: '2024' }])] }))
    expect(failed.status).toBe('failed')
    expect(failed.items[0].error.code).toBe('recognized_projection_conflict')
    expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_recognized_projection`)!.n).toBe(1)
    expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_relation`)!.n).toBe(1)
  }))

  it('rolls back the archive, observation and typed row atomically on a typed insert failure', async () => fixture(async (db, post) => {
    db.run(sql.raw("CREATE TRIGGER fail_recognized_projection BEFORE INSERT ON platform_recognized_projection BEGIN SELECT RAISE(ABORT, 'synthetic typed failure'); END"))
    const req = request('atomic', { platformQueries: [recognizedQuery('2026-10-01T00:00:00Z', [{ id: 'UUID-ATOMIC', qymc: '原子企业', rddqrq: '2027' }])] })
    const failed = await post('commit', req)
    expect(failed.status).toBe('failed')
    expect(failed.error).toContain('synthetic typed failure')
    for (const table of ['platform_query', 'platform_relation', 'platform_business_record', 'platform_business_record_version', 'platform_business_observation', 'platform_recognized_projection']) {
      expect(db.get<{ n: number }>(sql.raw('SELECT count(*) n FROM ' + table))!.n, table).toBe(0)
    }
    db.run(sql.raw('DROP TRIGGER fail_recognized_projection'))
    expect((await post('commit', req)).status).toBe('committed')
    expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_recognized_projection`)!.n).toBe(1)
  }))

  it('does not change formal events or current qualified results when a directory observation disappears', async () => fixture(async (db, post) => {
    const year = new Date().getUTCFullYear()
    const enterprise = db.insert(schema.enterprise).values({ name: '合成优质企业', nameNorm: '合成优质企业', usccNorm: '91330211255994457P', city: '宁波市', district: '鄞州区' }).returning().get()
    const record = db.insert(schema.record).values({ enterpriseId: enterprise.id, source: 'jxj', titleCode: 'innovative_sme', nameRaw: enterprise.name }).returning().get()
    const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year, decidedYear: year, batchSeq: 1 }).returning().get()
    db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: 'synthetic/recognized/formal.pdf', listNo: 1 }).run()
    const filter = { titleCode: 'innovative_sme' as const, page: 1, pageSize: 25 }
    const formal = () => ({
      record: db.all(sql`SELECT * FROM record ORDER BY id`),
      event: db.all(sql`SELECT * FROM record_event ORDER BY id`),
      evidence: db.all(sql`SELECT * FROM record_evidence ORDER BY id`),
    })
    const before = listCurrentQualified(db.$client, filter)
    expect(before.total).toBe(1)
    expect(before.rows).toHaveLength(1)
    const formalBefore = formal()

    const saved = await post('commit', request('qualified', { platformQueries: [recognizedQuery('2026-10-01T00:00:00Z', [{ id: 'UUID-QUALIFIED', qymc: '合成优质企业', tyshxydm: '91330211255994457P', rddqrq: String(year + 1) + '-06-30', whpcyear: String(year), whpc: '2' }], '1')] }))
    expect(saved.status).toBe('committed')
    expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_recognized_projection`)!.n).toBe(1)

    // The directory observation disappears; the original relation/raw/version and the old
    // correspondence stay readable and are not rewritten.
    const archive = () => ({
      relation: db.all(sql`SELECT * FROM platform_relation ORDER BY id`),
      query: db.all(sql`SELECT * FROM platform_query ORDER BY id`),
      version: db.all(sql`SELECT * FROM platform_business_record_version ORDER BY id`),
      correspondence: db.all(sql`SELECT * FROM record_correspondence ORDER BY id`),
    })
    const archiveBefore = archive()
    expect(archiveBefore.correspondence).toHaveLength(1)
    db.run(sql`DELETE FROM platform_recognized_projection`)
    db.run(sql`DELETE FROM platform_business_observation`)
    expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_business_observation`)!.n).toBe(0)
    expect(archive()).toEqual(archiveBefore)
    expect(formal()).toEqual(formalBefore)
    const after = listCurrentQualified(db.$client, filter)
    // The current valid enterprise result and formal title qualification stay identical; only
    // the now-removed platform observation/correspondence metadata is absent.
    const outcome = (result: typeof before) => result.rows.map(row => ({
      enterpriseId: row.enterpriseId,
      group: row.group,
      titles: row.qualificationAssessment.titles.map(title => ({
        titleCode: title.titleCode,
        officialQualification: title.officialQualification,
        subject: title.subject,
        region: title.region,
        cycles: title.cycles,
      })),
    }))
    expect(outcome(after)).toEqual(outcome(before))
    expect(after.total).toBe(before.total)
    expect(after.uncertainTotal).toBe(before.uncertainTotal)
    expect(after.rows.map(row => row.enterpriseId)).toEqual([enterprise.id])
  }))
})
