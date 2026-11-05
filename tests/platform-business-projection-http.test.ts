import { initializeDb } from '../db/client'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { schema, useDb } from '../db'
import type { RosterImportPayload, RosterImportPlatformQuery, RosterImportRequest } from '../lib/roster-import-client'
import { startRosterApi } from './helpers/roster-http-server'

const dirs: string[] = []
afterAll(() => dirs.forEach(dir => rmSync(dir, { recursive: true, force: true })))
type Db = ReturnType<typeof useDb>

function request(key: string, payload: RosterImportPayload): RosterImportRequest {
  return { idempotencyKey: key, sourceKind: 'platform_archive', sourceIdentity: 'tests/business-projection', payload }
}
function businessQuery(time: string, raw: Record<string, unknown> | null, queryKey = '91330211255994457P'): RosterImportPlatformQuery {
  return {
    interface: 'business_list' as const,
    queryKey,
    rdjb: '2',
    queriedAt: time,
    status: 'success' as const,
    relations: [{
      sequenceNo: 1,
      relationKey: raw && typeof raw.id === 'string' ? raw.id : null,
      rawFields: raw as never,
    }],
  }
}
async function fixture(run: (db: Db, post: (action: string, body: unknown) => Promise<Record<string, any>>) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'business457-')); dirs.push(dir)
  const db = initializeDb({ create: true, dbPath: join(dir, 'roster.db') })
  const server = await startRosterApi({ db, apiToken: 'synthetic-apply-token' })
  try {
    await run(db, async (action, body) => {
      const response = await fetch(`${server.baseUrl}/api/roster/import/${action}`, { method: 'POST', headers: { authorization: 'Bearer synthetic-apply-token', 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return { http: response.status, ...await response.json() as object }
    })
  } finally { await server.close() }
}

describe('business_list typed projection through public import HTTP', () => {
  it('reads back typed source fields exactly and leaves the original archive identity intact', async () => fixture(async (db, post) => {
    const raw = {
      id: 'SQ-BUSINESS-1',
      qymc: ' 合成办理企业 ',
      tyshxydm: ' 91330211255994457P ',
      sblx: ' 复核 ',
      year: 2025,
      sqsj: ' 2025-06-03 09:00:00 ',
      cszt: ' 终审通过 ',
      whpc: ' 2025-1 ',
      personuuid: ' 第四批 ',
      szsfmc: ' 宁波市 ',
      unknownSourceField: '保留',
    }
    const saved = await post('commit', request('typed-readback', { platformQueries: [businessQuery('2026-10-01T00:00:00Z', raw)] }))
    expect(saved.status).toBe('committed')

    const relation = db.get<{ id: number; queryId: number; rawText: string; relationKey: string }>(sql`SELECT id, query_id AS queryId, raw_fields AS rawText, relation_key AS relationKey FROM platform_relation`)
    expect(relation).toMatchObject({ relationKey: 'SQ-BUSINESS-1' })
    expect(JSON.parse(relation!.rawText)).toEqual(raw)
    const observation = db.get<{ relationId: number; recordId: number; versionId: number; projectionRuleVersion: string }>(sql`SELECT relation_id AS relationId, record_id AS recordId, version_id AS versionId, projection_rule_version AS projectionRuleVersion FROM platform_business_observation`)
    expect(observation).toMatchObject({ relationId: relation!.id })
    const projection = db.get(sql`SELECT * FROM platform_business_projection`)
    expect(projection).toEqual({
      version_id: observation!.versionId,
      record_id: observation!.recordId,
      declare_kind: 'review',
      business_year: 2025,
      applied_at: '2025-06-03 09:00:00',
      status: '终审通过',
      batch: '2025-1',
      award_batch_label: '第四批',
      province: '宁波市',
      name_raw: '合成办理企业',
      uscc_raw: '91330211255994457P',
      rule_version: 'platform-business-v1',
      created_at: expect.any(String),
    })
    expect(observation!.projectionRuleVersion).toBe('platform-observation-v1')
    expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_business_projection`)!.n).toBe(1)
  }))

  it('reuses the same content version and creates a new typed version only when raw content changes', async () => fixture(async (db, post) => {
    const raw = { id: 'SQ-REPLAY-B', qymc: '合成企业', sblx: '申请', year: 2024, sqsj: '2024-03-01 09:00:00', cszt: '待审核', whpc: '2024-1' }
    const first = await post('commit', request('replay-first', { platformQueries: [businessQuery('2026-10-01T00:00:00Z', raw)] }))
    expect(first.status).toBe('committed')
    expect(first.summary.canonicalProjection).toMatchObject({ recordsCreated: 1, versionsCreated: 1, observationsCreated: 1, businessProjectionsCreated: 1, businessProjectionsReused: 0 })
    const replay = await post('commit', request('replay-same', { platformQueries: [businessQuery('2026-10-01T00:00:00Z', raw)] }))
    expect(replay.status).toBe('committed')
    expect(replay.summary.canonicalProjection).toMatchObject({ recordsCreated: 0, versionsCreated: 0, observationsReused: 1, businessProjectionsCreated: 0, businessProjectionsReused: 1 })
    expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_business_projection`)!.n).toBe(1)

    const changed = await post('commit', request('replay-changed', { platformQueries: [businessQuery('2026-10-02T00:00:00Z', { ...raw, cszt: '终审通过' })] }))
    expect(changed.status).toBe('committed')
    expect(changed.summary.canonicalProjection).toMatchObject({ recordsCreated: 0, versionsCreated: 1, observationsCreated: 1, businessProjectionsCreated: 1, businessProjectionsReused: 0 })
    expect(db.all<{ status: string }>(sql`SELECT status FROM platform_business_projection ORDER BY version_id`)).toEqual([{ status: '待审核' }, { status: '终审通过' }])
    expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_relation`)!.n).toBe(2)
  }))

  it('does not create a second version or typed row when the same raw is observed under different query title scopes', async () => fixture(async (db, post) => {
    const raw = { id: 'SQ-SCOPE-B', qymc: '称号范围企业', sblx: '复核', year: '2023', sqsj: '2023-02-01', cszt: '终审通过', whpc: '2023-2' }
    const one = businessQuery('2026-10-01T00:00:00Z', raw, '2')
    const two = businessQuery('2026-10-02T00:00:00Z', raw, '1')
    const saved = await post('commit', request('scope-replay', { platformQueries: [one, two] }))
    expect(saved.status).toBe('committed')
    expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_business_projection`)!.n).toBe(1)
    expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_business_record_version`)!.n).toBe(1)
    expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_business_observation`)!.n).toBe(2)
    expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_business_record`)!.n).toBe(1)
  }))

  it('preserves unknown status and maintenance batch verbatim without inventing a year', async () => fixture(async (db, post) => {
    const raw = { id: 'SQ-UNKNOWN-B', qymc: '未知值企业', sblx: '其他事项', year: null, cszt: '未知状态', whpc: '未知批次' }
    const saved = await post('commit', request('unknown-values', { platformQueries: [businessQuery('2026-10-05T00:00:00Z', raw)] }))
    expect(saved.status).toBe('committed')
    expect(db.get(sql`SELECT declare_kind AS declareKind, business_year AS businessYear, status, batch FROM platform_business_projection`)).toEqual({ declareKind: '其他事项', businessYear: null, status: '未知状态', batch: '未知批次' })
  }))

  it('keeps missing-key, conflicting-key and unverifiable observations isolated without a typed row', async () => fixture(async (db, post) => {
    const missing = businessQuery('2026-10-01T00:00:00Z', { qymc: '无编号企业', sblx: '申请', year: '2024' })
    const conflict = businessQuery('2026-10-02T00:00:00Z', { id: 'RAW-ID', qymc: '冲突企业' })
    conflict.relations![0]!.relationKey = 'RELATION-ID'
    const unverifiable = businessQuery('2026-10-03T00:00:00Z', null)
    unverifiable.relations![0]!.relationKey = 'SQ-NO-RAW'
    const saved = await post('commit', request('isolated', { platformQueries: [missing, conflict, unverifiable] }))
    expect(saved.status).toBe('committed')
    expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_business_projection`)!.n).toBe(0)
    expect(db.all<{ identityState: string; contentState: string }>(sql`SELECT identity_state AS identityState, content_state AS contentState FROM platform_business_observation ORDER BY relation_id`)).toEqual([
      { identityState: 'missing_key', contentState: 'unverifiable' },
      { identityState: 'conflict', contentState: 'unverifiable' },
      { identityState: 'resolved', contentState: 'unverifiable' },
    ])
  }))

  it('never merges the same platform key across apply_list and business_list', async () => fixture(async (db, post) => {
    const sharedKey = 'SHARED-KEY-1'
    const apply = { ...businessQuery('2026-10-01T00:00:00Z', { id: sharedKey, qymc: '同一编号企业', sblx: '申请', year: 2024 }), interface: 'apply_list' as const, rdjb: '' }
    const saved = await post('commit', request('cross-interface', { platformQueries: [businessQuery('2026-10-01T00:00:00Z', { id: sharedKey, qymc: '同一编号企业', sblx: '复核', cszt: '终审通过' }), apply] }))
    expect(saved.status).toBe('committed')
    expect(db.all<{ interface: string; platformKey: string }>(sql`SELECT interface, platform_key AS platformKey FROM platform_business_record ORDER BY interface`)).toEqual([
      { interface: 'apply_list', platformKey: sharedKey },
      { interface: 'business_list', platformKey: sharedKey },
    ])
    expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_apply_projection`)!.n).toBe(1)
    expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_business_projection`)!.n).toBe(1)
  }))

  it('backfills an existing observation through platformRecordObservations and reports typed receipt counts', async () => fixture(async (db, post) => {
    const queryId = db.insert(schema.platformQuery).values({ interface: 'business_list', queryKey: '91330211255994457P', rdjb: '2', queriedAt: '2026-09-01T00:00:00Z', status: 'success' }).returning().get().id
    const relation = db.insert(schema.platformRelation).values({ queryId, sequenceNo: 1, relationKey: 'SQ-HISTORY-B', rawFields: { id: 'SQ-HISTORY-B', qymc: '历史办理企业', sblx: '复核', year: '2023', sqsj: '2023-02-01', cszt: '终审通过', whpc: '2023-2', personuuid: '第三批', szsfmc: '浙江省' } }).returning().get()
    const req = request('history-backfill', { platformRecordObservations: [{ relationId: relation.id }] })
    const before = db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_business_projection`)!.n
    const plan = await post('preflight', req)
    expect(plan.preflight.conflicts).toEqual([])
    expect(plan.preflight.canonicalProjection[0]).toMatchObject({
      relationId: relation.id,
      identityState: 'resolved',
      contentState: 'verified',
      businessProjection: { declareKind: 'review', businessYear: 2023, status: '终审通过', batch: '2023-2', awardBatchLabel: '第三批', province: '浙江省', ruleVersion: 'platform-business-v1' },
    })
    expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_business_projection`)!.n).toBe(before)

    const saved = await post('commit', req)
    expect(saved.status).toBe('committed')
    expect(saved.summary.canonicalProjection).toMatchObject({ recordsCreated: 1, versionsCreated: 1, observationsCreated: 1, businessProjectionsCreated: 1 })
    expect(db.get(sql`SELECT declare_kind AS declareKind, business_year AS businessYear, status, batch, award_batch_label AS awardBatchLabel, province FROM platform_business_projection`)).toEqual({ declareKind: 'review', businessYear: 2023, status: '终审通过', batch: '2023-2', awardBatchLabel: '第三批', province: '浙江省' })
    const retried = await post('commit', request('history-backfill-2', { platformRecordObservations: [{ relationId: relation.id }] }))
    expect(retried.status).toBe('committed')
    expect(retried.summary.canonicalProjection).toMatchObject({ observationsReused: 1, businessProjectionsCreated: 0, businessProjectionsReused: 1 })
    expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_business_projection`)!.n).toBe(1)
  }))

  it('rejects a same-version typed projection drift without silently reinterpreting it', async () => fixture(async (db, post) => {
    const raw = { id: 'SQ-DRIFT-B', qymc: '漂移企业', sblx: '复核', year: 2024, cszt: '待审核', whpc: '2024-1' }
    const requestBody = request('drift-first', { platformQueries: [businessQuery('2026-10-01T00:00:00Z', raw)] })
    expect((await post('commit', requestBody)).status).toBe('committed')
    db.run(sql`UPDATE platform_business_projection SET status = 'tampered'`)
    const failed = await post('commit', request('drift-second', { platformQueries: [businessQuery('2026-10-01T00:00:00Z', raw)] }))
    expect(failed.status).toBe('failed')
    expect(failed.items[0].error.code).toBe('business_projection_conflict')
    expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_business_projection`)!.n).toBe(1)
    expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_relation`)!.n).toBe(1)
  }))

  it('rolls back the archive, observation and typed row atomically on a typed insert failure', async () => fixture(async (db, post) => {
    db.run(sql.raw("CREATE TRIGGER fail_business_projection BEFORE INSERT ON platform_business_projection BEGIN SELECT RAISE(ABORT, 'synthetic typed failure'); END"))
    const req = request('atomic', { platformQueries: [businessQuery('2026-10-01T00:00:00Z', { id: 'SQ-ATOMIC-B', qymc: '原子企业', year: 2024 })] })
    const failed = await post('commit', req)
    expect(failed.status).toBe('failed')
    expect(failed.error).toContain('synthetic typed failure')
    for (const table of ['platform_query', 'platform_relation', 'platform_business_record', 'platform_business_record_version', 'platform_business_observation', 'platform_business_projection']) {
      expect(db.get<{ n: number }>(sql.raw(`SELECT count(*) n FROM ${table}`))!.n, table).toBe(0)
    }
    db.run(sql.raw('DROP TRIGGER fail_business_projection'))
    expect((await post('commit', req)).status).toBe('committed')
    expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_business_projection`)!.n).toBe(1)
  }))
})
