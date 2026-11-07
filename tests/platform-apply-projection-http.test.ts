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
  return { idempotencyKey: key, sourceKind: 'platform_archive', sourceIdentity: 'tests/apply-projection', payload }
}
function applyQuery(time: string, raw: Record<string, unknown>, queryKey = 'name:合成企业'): RosterImportPlatformQuery {
  return {
    interface: 'apply_list' as const,
    queryKey,
    queriedAt: time,
    status: 'success' as const,
    relations: [{ sequenceNo: 1, relationKey: typeof raw.id === 'string' ? raw.id : null, rawFields: raw }],
  }
}
async function fixture(run: (db: Db, post: (action: string, body: unknown) => Promise<any>) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'apply452-')); dirs.push(dir)
  const db = initializeDb({ create: true, dbPath: join(dir, 'roster.db') })
  const server = await startRosterApi({ db, apiToken: 'synthetic-apply-token' })
  try {
    await run(db, async (action, body) => {
      const response = await fetch(`${server.baseUrl}/api/roster/import/${action}`, { method: 'POST', headers: { authorization: 'Bearer synthetic-apply-token', 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return { http: response.status, ...await response.json() as object }
    })
  } finally { await server.close() }
}

describe('apply_list typed projection through public import HTTP', () => {
  it.each([{ name: 'missing-row-title', title: null }, { name: 'source-row-title', title: '2' }])('reads back typed source fields exactly and leaves the original archive identity intact ($name)', async ({ title }) => fixture(async (db, post) => {
    const raw = {
      id: 'SQ-APPLY-1',
      qymc: ' 合成申报企业 ',
      tyshxydm: ' 91330211255994457P ',
      sblx: ' 申请 ',
      year: ' 2024 ',
      sqsj: ' 2024-03-01 09:00:00 ',
      cszt: ' 终审通过 ',
      szsfmc: ' 宁波市 ',
      unknownSourceField: '保留',
      ...(title === null ? {} : { rdjb: ` ${title} ` }),
    }
    const saved = await post('commit', request('typed-readback', { platformQueries: [applyQuery('2026-10-01T00:00:00Z', raw)] }))
    expect(saved.status).toBe('committed')

    const relation = db.get<{ id: number; queryId: number; rawText: string; relationKey: string }>(sql`SELECT id, query_id AS queryId, raw_fields AS rawText, relation_key AS relationKey FROM platform_relation`)
    expect(relation).toMatchObject({ relationKey: 'SQ-APPLY-1' })
    expect(JSON.parse(relation!.rawText)).toEqual(raw)
    const observation = db.get<{ relationId: number; recordId: number; versionId: number; projectionRuleVersion: string }>(sql`SELECT relation_id AS relationId, record_id AS recordId, version_id AS versionId, projection_rule_version AS projectionRuleVersion FROM platform_business_observation`)
    expect(observation).toMatchObject({ relationId: relation!.id })
    const projection = db.get(sql`SELECT * FROM platform_apply_projection`)
    expect(projection).toEqual({
      version_id: observation!.versionId,
      record_id: observation!.recordId,
      declare_kind: 'apply',
      declaration_year: 2024,
      applied_at: '2024-03-01 09:00:00',
      status: '终审通过',
      name_raw: '合成申报企业',
      uscc_raw: '91330211255994457P',
      title_raw: title,
      rule_version: 'platform-apply-v1',
      created_at: expect.any(String),
    })
    expect(observation!.projectionRuleVersion).toBe('platform-observation-v1')
    expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_apply_projection`)!.n).toBe(1)
  }))

  it('reuses the same content version and creates a new typed version only when raw content changes', async () => fixture(async (db, post) => {
    const raw = { id: 'SQ-REPLAY', qymc: '合成企业', sblx: '申请', year: '2024', sqsj: '2024-03-01 09:00:00', cszt: '待审核' }
    const first = await post('commit', request('replay-first', { platformQueries: [applyQuery('2026-10-01T00:00:00Z', raw)] }))
    expect(first.status).toBe('committed')
    expect(first.summary.canonicalProjection).toMatchObject({ recordsCreated: 1, versionsCreated: 1, observationsCreated: 1, applyProjectionsCreated: 1, applyProjectionsReused: 0 })
    const replay = await post('commit', request('replay-same', { platformQueries: [applyQuery('2026-10-01T00:00:00Z', raw)] }))
    expect(replay.status).toBe('committed')
    expect(replay.summary.canonicalProjection).toMatchObject({ recordsCreated: 0, versionsCreated: 0, observationsReused: 1, applyProjectionsCreated: 0, applyProjectionsReused: 1 })
    expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_apply_projection`)!.n).toBe(1)

    const changed = await post('commit', request('replay-changed', { platformQueries: [applyQuery('2026-10-02T00:00:00Z', { ...raw, cszt: '终审通过' })] }))
    expect(changed.status).toBe('committed')
    expect(changed.summary.canonicalProjection).toMatchObject({ recordsCreated: 0, versionsCreated: 1, observationsCreated: 1, applyProjectionsCreated: 1, applyProjectionsReused: 0 })
    expect(db.all<{ status: string }>(sql`SELECT status FROM platform_apply_projection ORDER BY version_id`)).toEqual([{ status: '待审核' }, { status: '终审通过' }])
    expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_relation`)!.n).toBe(2)
  }))

  it('keeps missing-key, conflicting-key and unverifiable observations isolated without a typed row', async () => fixture(async (db, post) => {
    const missing = applyQuery('2026-10-01T00:00:00Z', { qymc: '无编号企业', sblx: '申请', year: '2024' })
    const conflict = applyQuery('2026-10-02T00:00:00Z', { id: 'RAW-ID', qymc: '冲突企业' })
    conflict.relations![0]!.relationKey = 'RELATION-ID'
    const unverifiable = applyQuery('2026-10-03T00:00:00Z', { id: 'SQ-NO-RAW', qymc: '无原文' })
    unverifiable.relations![0]!.rawFields = null
    const saved = await post('commit', request('isolated', { platformQueries: [missing, conflict, unverifiable] }))
    expect(saved.status).toBe('committed')
    expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_apply_projection`)!.n).toBe(0)
    expect(db.all<{ identityState: string; contentState: string }>(sql`SELECT identity_state AS identityState, content_state AS contentState FROM platform_business_observation ORDER BY relation_id`)).toEqual([
      { identityState: 'missing_key', contentState: 'unverifiable' },
      { identityState: 'conflict', contentState: 'unverifiable' },
      { identityState: 'resolved', contentState: 'unverifiable' },
    ])
  }))

  it('backfills an existing observation through platformRecordObservations and reports typed receipt counts', async () => fixture(async (db, post) => {
    const queryId = db.insert(schema.platformQuery).values({ interface: 'apply_list', queryKey: 'name:历史企业', queriedAt: '2026-09-01T00:00:00Z', status: 'success' }).returning().get().id
    const relation = db.insert(schema.platformRelation).values({ queryId, sequenceNo: 1, relationKey: 'SQ-HISTORY', rawFields: { id: 'SQ-HISTORY', qymc: '历史企业', sblx: '复核', year: '2023', sqsj: '2023-02-01', cszt: '终审通过' } }).returning().get()
    const req = request('history-backfill', { platformRecordObservations: [{ relationId: relation.id }] })
    const before = db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_apply_projection`)!.n
    const plan = await post('preflight', req)
    expect(plan.preflight.conflicts).toEqual([])
    expect(plan.preflight.canonicalProjection[0]).toMatchObject({ relationId: relation.id, identityState: 'resolved', contentState: 'verified', applyProjection: { declareKind: 'review', declarationYear: 2023, status: '终审通过', ruleVersion: 'platform-apply-v1' } })
    expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_apply_projection`)!.n).toBe(before)

    const saved = await post('commit', req)
    expect(saved.status).toBe('committed')
    expect(saved.summary.canonicalProjection).toMatchObject({ recordsCreated: 1, versionsCreated: 1, observationsCreated: 1, applyProjectionsCreated: 1 })
    expect(db.get(sql`SELECT declare_kind AS declareKind, declaration_year AS declarationYear, status FROM platform_apply_projection`)).toEqual({ declareKind: 'review', declarationYear: 2023, status: '终审通过' })
    const retried = await post('commit', request('history-backfill-2', { platformRecordObservations: [{ relationId: relation.id }] }))
    expect(retried.status).toBe('committed')
    expect(retried.summary.canonicalProjection).toMatchObject({ observationsReused: 1, applyProjectionsCreated: 0, applyProjectionsReused: 1 })
    expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_apply_projection`)!.n).toBe(1)
  }))

  it('rolls back the archive, observation and typed row atomically on a typed insert failure', async () => fixture(async (db, post) => {
    db.run(sql.raw("CREATE TRIGGER fail_apply_projection BEFORE INSERT ON platform_apply_projection BEGIN SELECT RAISE(ABORT, 'synthetic typed failure'); END"))
    const req = request('atomic', { platformQueries: [applyQuery('2026-10-01T00:00:00Z', { id: 'SQ-ATOMIC', qymc: '原子企业', year: '2024' })] })
    const failed = await post('commit', req)
    expect(failed.status).toBe('failed')
    expect(failed.error).toContain('synthetic typed failure')
    for (const table of ['platform_query', 'platform_relation', 'platform_business_record', 'platform_business_record_version', 'platform_business_observation', 'platform_apply_projection']) {
      expect(db.get<{ n: number }>(sql.raw(`SELECT count(*) n FROM ${table}`))!.n, table).toBe(0)
    }
    db.run(sql.raw('DROP TRIGGER fail_apply_projection'))
    expect((await post('commit', req)).status).toBe('committed')
    expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_apply_projection`)!.n).toBe(1)
  }))
})
it('certifies unique eligible versions after shared observations and repairs missing projections on full replay', async () => fixture(async (db, post) => {
  const raw = { id: 'SQ-COMPLETE', qymc: '完成企业', year: '2024', cszt: '待审核' }
  const queries = [applyQuery('2026-10-01T00:00:00Z', raw), applyQuery('2026-10-02T00:00:00Z', raw)]
  const req = request('completion-first', { platformQueries: queries })
  expect((await post('preflight', req)).preflight.conflicts).toEqual([])
  const first = await post('commit', req)
  expect(first.summary.platformFields).toEqual({ status: 'ready', eligibleVersions: 1, projectionsCreated: 1, projectionsReused: 0, projectionsChecked: 1, observationsChecked: 2, quarantinedObservations: 0 })
  db.run(sql`DELETE FROM platform_apply_projection`)
  expect((await post('commit', req)).summary).toEqual(first.summary)
  expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_apply_projection`)!.n).toBe(0)
  const replay = await post('commit', request('completion-repair', { platformQueries: queries }))
  expect(replay.summary.written).toBe(0)
  expect(replay.summary.platformFields).toEqual(first.summary.platformFields)
  expect(db.get(sql`SELECT declaration_year AS year, status FROM platform_apply_projection`)).toEqual({ year: 2024, status: '待审核' })
}))

it('rejects a projection deleted after its writer before reporting completion and retains the failed receipt', async () => fixture(async (db, post) => {
  db.run(sql.raw('CREATE TRIGGER remove_projection AFTER INSERT ON platform_apply_projection BEGIN DELETE FROM platform_apply_projection WHERE version_id = NEW.version_id; END'))
  const result = await post('commit', request('completion-missing', { platformQueries: [applyQuery('2026-10-01T00:00:00Z', { id: 'SQ-MISSING', year: '2024' })] }))
  expect(result.status).toBe('failed')
  expect(result.error).toContain('Required source projection missing')
  expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_relation`)!.n).toBe(0)
  expect(db.get<{ status: string }>(sql`SELECT status FROM import_batch`)!.status).toBe('failed')
}))

it('reports quarantines and explicit references without claiming full readiness or repairing references', async () => fixture(async (db, post) => {
  const query = applyQuery('2026-10-01T00:00:00Z', { id: 'SQ-REFERENCE', year: '2024' })
  await post('commit', request('reference-seed', { platformQueries: [query] }))
  db.run(sql`DELETE FROM platform_apply_projection`)
  const reference = await post('commit', request('reference-only', { platformQueries: [{ ...query, reuseExisting: true }] }))
  expect(reference.summary.platformFields).toMatchObject({ status: 'partial', eligibleVersions: 0, projectionsChecked: 0 })
  expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_apply_projection`)!.n).toBe(0)
  const quarantine = await post('commit', request('quarantine-only', { platformQueries: [applyQuery('2026-10-02T00:00:00Z', { year: '2024' })] }))
  expect(quarantine.summary.platformFields).toMatchObject({ status: 'partial', eligibleVersions: 0, quarantinedObservations: 1, observationsChecked: 1 })
}))

it('rejects immutable projection field conflicts and rolls back the other rows', async () => fixture(async (db, post) => {
  const first = applyQuery('2026-10-01T00:00:00Z', { id: 'SQ-OWNER', year: '2024' })
  await post('commit', request('owner-first', { platformQueries: [first] }))
  await post('commit', request('owner-other', { platformQueries: [applyQuery('2026-10-02T00:00:00Z', { id: 'SQ-OTHER', year: '2023' })] }))
  db.run(sql`UPDATE platform_apply_projection SET status = 'conflicting stored value' WHERE version_id = (SELECT min(id) FROM platform_business_record_version)`)
  const result = await post('commit', request('owner-conflict', { platformQueries: [applyQuery('2026-10-03T00:00:00Z', { id: 'SQ-ROLLBACK', year: '2025' }), first] }))
  expect(result.status).toBe('failed')
  expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_business_record`)!.n).toBe(2)
  expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_relation`)!.n).toBe(2)
}))

it('does not invent fresh completion evidence on an old committed receipt', async () => fixture(async (db, post) => {
  const req = request('legacy-receipt', { platformQueries: [applyQuery('2026-10-01T00:00:00Z', { id: 'SQ-LEGACY', year: '2024' })] })
  const saved = await post('commit', req)
  const legacySummary = { ...saved.summary }; delete legacySummary.platformFields
  db.run(sql`UPDATE import_batch SET summary = ${JSON.stringify(legacySummary)} WHERE id = ${saved.batchId}`)
  db.run(sql`DELETE FROM platform_apply_projection`)
  const replay = await post('commit', req)
  expect(replay.summary).toEqual(legacySummary)
  expect(replay.summary).not.toHaveProperty('platformFields')
  expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_apply_projection`)!.n).toBe(0)
}))
