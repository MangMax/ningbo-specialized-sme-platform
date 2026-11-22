import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { createError } from 'h3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { closePostgresDirectoryDb } from '../../../db/postgresql/client'
import type { RosterImportRequest } from '../../../layers/sme-roster/lib/roster-import-client'
import { readRuntimeImportReceipt } from '../../../layers/sme-roster/server/utils/import-receipts-runtime'
import { handlePostgresRosterImportRequest } from '../../../layers/sme-roster/server/utils/roster-import-http'
import { submitRosterImportMcp } from '../../../layers/sme-roster/server/utils/roster-import-mcp-submission'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'

const queriedAt = '2026-11-11T00:00:00Z'
const queryKey = 'name:孤立历史'
describe('native PostgreSQL platform collection references and import receipts', () => {
  let root: string
  let runtime: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
  let client: pg.Client
  const token = 'isolated-platform-observation-test'
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'platform-observation-pg-'))
    runtime = await postgresRuntimeFixture({ dir: root })
    client = new pg.Client({ connectionString: runtime.url, options: '-c search_path=business,public' })
    await client.connect()
    await client.query(`
      INSERT INTO platform_collection(id,public_id,interface,query_key,rdjb,queried_at,created_at,status,completeness,provenance_state,parse_state,rule_version)
      VALUES (1,91,'recognized_list',$1,'2',$2,$2,'success','unknown','unknown','absent','fixture');
    `, [queryKey, queriedAt])
    await client.query(`
      INSERT INTO platform_business_observation(id,public_id,collection_id,sequence_no,source_relation_key,identity_state,content_state,position_state)
      VALUES (1,101,1,1,'history-A','not_indexed','not_indexed','unknown');
      INSERT INTO platform_observation_assignment(observation_id,revision,match_basis,verification_status,origin)
      VALUES (1,1,'none','pending','migrated_current');
    `)
    vi.stubGlobal('createError', createError)
    vi.stubGlobal('useRuntimeConfig', () => ({ filesDir: root }))
    vi.stubEnv('NUXT_DB_READONLY', '0')
    vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', runtime.url)
  }, 60_000)

  afterAll(async () => {
    try {
      await closePostgresDirectoryDb()
      await client?.end()
    } finally {
      try {
        runtime?.close()
      } finally {
        if (root) rmSync(root, { recursive: true, force: true })
        vi.unstubAllGlobals()
        vi.unstubAllEnvs()
      }
    }
  })

  function request(idempotencyKey: string, payload: RosterImportRequest['payload']): RosterImportRequest {
    return { idempotencyKey, sourceKind: 'platform_archive', sourceIdentity: 'isolated-history', payload }
  }

  const http = (action: 'commit' | 'preflight' | 'replay', body: RosterImportRequest) =>
    handlePostgresRosterImportRequest(action, { method: 'POST', headers: { authorization: 'Bearer ' + token }, body },
      { apiToken: token })

  const mcp = (action: 'commit' | 'preflight', body: RosterImportRequest) =>
    submitRosterImportMcp(action, { ...body, sourceSha256: body.sourceSha256 ?? undefined, payload: { ...body.payload } })

  it.each(['platformRecordObservations', 'platformLegacyProvenance'])('rejects retired %s before creating a receipt', async field => {
    const body = request('retired-' + field, { [field]: [] })
    for (const action of ['preflight', 'commit'] as const) {
      expect(await http(action, body)).toMatchObject({ status: 400, body: { message: expect.stringContaining(field + ' 已停用') } })
      await expect(mcp(action, body)).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining(field + ' 已停用') })
    }
    expect(await client.query('SELECT id FROM import_batch WHERE idempotency_key=$1', [body.idempotencyKey]))
      .toMatchObject({ rowCount: 0 })
  })

  it('replays a committed import and reads bounded receipt pages without request bodies', async () => {
    const body = { ...request('bounded-receipt', { platformQueries: [{
      interface: 'recognized_list', queryKey, rdjb: '2', queriedAt, reuseExisting: true as const, relations: [{ sequenceNo: 1 }],
    }] }), sourceIdentity: '隔离历史🧾' }
    expect(await http('preflight', body)).toMatchObject({ status: 200, body: { status: 'preflight' } })
    const committed = await http('commit', body)
    expect(committed).toMatchObject({ status: 200, body: { status: 'committed', items: [{ ref: 'query:91' }] } })
    expect(await http('commit', body)).toMatchObject({ status: 200, body: committed.body })

    const receipt = z.object({ batchId: z.number(), receiptId: z.number() }).parse(
      await readRuntimeImportReceipt('get', { idempotencyKey: body.idempotencyKey }),
    )
    const history = await readRuntimeImportReceipt('history', { batchId: receipt.batchId, page: 2, pageSize: 1 })
    expect(history).toMatchObject({ page: 2, pageSize: 1, total: 2, rows: [
      { receiptId: receipt.receiptId, operation: 'commit', status: 'committed', itemCount: 1 },
    ] })
    expect(await readRuntimeImportReceipt('items', { receiptId: receipt.receiptId, pageSize: 1 }))
      .toMatchObject({ page: 1, pageSize: 1, total: 1, rows: [{ index: 0, ref: 'query:91', ok: true }] })
    expect(await readRuntimeImportReceipt('items', { receiptId: receipt.receiptId, page: 2, pageSize: 1 }))
      .toMatchObject({ page: 2, pageSize: 1, total: 1, rows: [] })

    const { rows } = await client.query('SELECT request_hash, historical_projection FROM import_receipt WHERE batch_id=$1 ORDER BY id', [receipt.batchId])
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ request_hash: expect.stringMatching(/^[a-f0-9]{64}$/), historical_projection: false })
    expect(rows[1]).toEqual(rows[0])
  })

  it('projects only the selected retained import item and enforces snapshot byte limits', async () => {
    const itemResults = JSON.stringify([
      { ok: true, kind: 'record_event', ref: 'record:12', detail: { enterpriseId: 5, recordId: 12 } },
      { ok: true, kind: 'merge', detail: { lineage: {
        fromEnterpriseId: 5, intoEnterpriseId: 6,
        recordsFolded: [{
          fromRecordId: 12, intoRecordId: 13, eventIds: [81, 82],
          fromRecordSnapshot: {
            id: 12, enterpriseId: 5, titleCode: 'specialized_sme', source: 'jxj',
            nameRaw: '保留的原名称', usccRaw: null, district: null, qualityFlags: ['unconfirmed'],
          },
        }],
      } } },
    ])
    const { rows: [batch] } = await client.query(`
      INSERT INTO import_batch(idempotency_key,source_kind,source_identity,status,created_at,item_results)
      VALUES ('retained-projection','announcement','历史名单','committed',$1,$2) RETURNING id
    `, [queriedAt, itemResults])
    const source = { source: 'private_batch', batchId: Number(batch.id) }
    const qualification = { ...source, projection: 'qualification', itemIndex: 0 }
    expect(await readRuntimeImportReceipt('items', qualification)).toMatchObject({
      itemIndex: 0, target: null, qualificationReadback: { status: 'not_retained', reason: 'legacy_receipt' },
      qualificationDiagnostics: { status: 'not_retained', reason: 'legacy_receipt' },
    })
    const selector = { ...source, itemIndex: 1, oldRecordId: 12 }
    expect(await readRuntimeImportReceipt('items', { ...selector, projection: 'snapshot' })).toMatchObject({
      availability: 'available', origin: { fromEnterpriseId: 5, intoEnterpriseId: 6, intoRecordId: 13 },
      snapshot: { id: 12, nameRaw: '保留的原名称', qualityFlags: ['unconfirmed'] },
    })
    await expect(readRuntimeImportReceipt('items', { ...selector, projection: 'snapshot', maxBytes: 1 }))
      .rejects.toMatchObject({ statusCode: 413, code: 'response_limit' })
    const events = { ...selector, projection: 'eventIds', pageSize: 1 }
    const first = z.object({ eventIds: z.array(z.number()), nextCursor: z.string() })
      .parse(await readRuntimeImportReceipt('items', events))
    expect(first.eventIds).toEqual([81])
    expect(await readRuntimeImportReceipt('items', { ...events, cursor: first.nextCursor }))
      .toMatchObject({ eventIds: [82], nextCursor: null })
  })

  it('replays matching export rows and rejects changed raw fields before recording a replacement', async () => {
    const snapshot = {
      titleCode: 'specialized_sme', year: 2024, collectedOn: '2026-11-18',
      originalFilename: '隔离快照.xlsx', sha256: 'a'.repeat(64),
      rows: [{ sourceRowNo: 3, nameRaw: '企业🧾', rawFields: { 原始列: ' 保留空格 ' } }],
    } as const
    const body = (key: string, exportSnapshot: NonNullable<RosterImportRequest['payload']['exportSnapshot']>): RosterImportRequest => ({
      idempotencyKey: key, sourceKind: 'platform_export', sourceIdentity: 'isolated-export', payload: { exportSnapshot },
    })
    const first = { ...snapshot, rows: [...snapshot.rows] }
    const imported = await http('commit', body('export-first', first))
    expect(imported).toMatchObject({ status: 200, body: { status: 'committed', items: [
      { ok: true, ref: expect.stringMatching(/^export:\d+$/), detail: { rowsWritten: 2 } },
    ] } })
    const replay = await http('commit', body('export-replay', first))
    expect(replay).toMatchObject({ status: 200, body: { status: 'committed', items: [
      { ok: true, detail: { skipped: 1, rows: [], rowsWritten: 0 } },
    ] } })
    const changed = { ...first, rows: [{ ...first.rows[0]!, rawFields: { 原始列: '保留空格' } }] }
    const conflict = await http('preflight', body('export-conflict', changed))
    expect(conflict).toMatchObject({ status: 200, body: { status: 'preflight', preflight: { conflicts: [
      { error: { code: 'export_row_payload_conflict', field: 'rows.rawFields' } },
    ] } } })
    expect(await http('commit', body('export-replacement', { ...changed, sha256: 'b'.repeat(64) })))
      .toMatchObject({ status: 200, body: { status: 'committed', items: [{ ok: true, detail: { rowsWritten: 2 } }] } })
    const { rows } = await client.query(`
      SELECT b.sha256, p.sha256 AS previous, r.raw_fields
      FROM platform_export_batch b LEFT JOIN platform_export_batch p ON p.id=b.replaced_batch_id
      JOIN platform_export_row r ON r.batch_id=b.id ORDER BY b.id
    `)
    expect(rows).toEqual([
      { sha256: 'a'.repeat(64), previous: null, raw_fields: '{"原始列":" 保留空格 "}' },
      { sha256: 'b'.repeat(64), previous: 'a'.repeat(64), raw_fields: '{"原始列":"保留空格"}' },
    ])
  })

})
