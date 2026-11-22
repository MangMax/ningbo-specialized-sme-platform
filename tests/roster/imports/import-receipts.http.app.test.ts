import { createRosterImportClient, type RosterImportRequest } from '../../../layers/sme-roster/lib/roster-import-client'
import { reviewPostgresFixtureRows } from './fixtures/reviewed-announcement-postgres'
import { readDevelopmentDiscovery } from '../current-export/fixtures/specialized-export'
import { spawnCompiledApp, reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../../support/owned-process.mjs'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { minimalPdf } from '../../support/minimal-pdf'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { request as httpRequest } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { importBatch, importReceipt } from '../../../db/postgresql/import-tables'
import { record, recordEvent, recordEvidence } from '../../../db/postgresql/ledger-tables'
import { enterprise } from '../../../db/postgresql/enterprise-tables'
import { rosterAnnouncementIntake } from '../../../db/postgresql/roster-selection-tables'
import { sourceDocument } from '../../../db/postgresql/official-evidence-tables'

const dir = mkdtempSync(join(tmpdir(), 'spec98-import-receipts-'))
let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
let pool: pg.Pool | undefined
let db: NodePgDatabase
let legacy: { id: number; idempotencyKey: string }
let processing: { id: number }
let foreignBatch: { id: number }
let longLegacy: { id: number }

async function seedReceiptFixture() {
  const createdAt = '2026-10-19T00:00:00Z'
  const [legacyRow, processingRow, foreignRow, longRow] = await db.insert(importBatch).values([
    { idempotencyKey: 'legacy/key?精确=1', sourceKind: 'announcement', sourceIdentity: 'synthetic/legacy', createdAt },
    { idempotencyKey: 'interrupted-worker', sourceKind: 'announcement', sourceIdentity: 'synthetic/processing', createdAt },
    { idempotencyKey: 'metrics-only', sourceKind: 'test_unrelated_operation', sourceIdentity: 'synthetic/operation', createdAt },
    { idempotencyKey: 'K'.repeat(4100), sourceKind: 'announcement', sourceIdentity: 'S'.repeat(4100), createdAt,
      status: 'committed', summary: JSON.stringify({ written: 1, skipped: 0, failed: 0 }),
      itemResults: JSON.stringify([{ ok: true, kind: 'record', ref: 'record:991', detail: { raw: 'LEGACY_RAW_ONLY'.repeat(8192) } }]) },
  ]).returning({ id: importBatch.id, idempotencyKey: importBatch.idempotencyKey })
  legacy = legacyRow!
  processing = processingRow!
  foreignBatch = foreignRow!
  longLegacy = longRow!
  await db.insert(importReceipt).values({
    batchId: processing.id, operation: 'commit', requestHash: 'synthetic-hash', status: 'processing', createdAt,
  })
  await db.execute(sql`
    CREATE FUNCTION business.synthetic_receipt_rollback() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'synthetic transaction rollback';
    END;
    $$
  `)
  await db.execute(sql`
    CREATE TRIGGER synthetic_receipt_rollback BEFORE INSERT ON business.record
    FOR EACH ROW WHEN (NEW.name_raw = '合成触发回滚企业') EXECUTE FUNCTION business.synthetic_receipt_rollback()
  `)
}
let service: { baseUrl: string; stop: () => Promise<void> }
const apiToken = 'synthetic-api-103'
const mcpToken = 'synthetic-mcp-103'
const api = (suffix = '') => `${service.baseUrl}/api/roster/import/receipts${suffix}`
const get = (suffix = '', token: string | null = apiToken) => fetch(api(suffix), { headers: token ? { authorization: `Bearer ${token}` } : {} })
const post = (action: string, body: unknown) => fetch(`${service.baseUrl}/api/roster/import/${action}`, { method: 'POST', headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
async function supplement(body: RosterImportRequest) {
  const client = createRosterImportClient({ baseUrl: service.baseUrl, token: apiToken })
  const staged = await client.commit(body)
  if (staged.status !== 'staged') throw new Error(JSON.stringify(staged))
  const intake = await client.readIntake(staged.intakeId)
  const review = intake.review ?? await reviewPostgresFixtureRows(db, staged.sourceDigest, body)
  return client.supplement(staged.intakeId, review)
}
async function rpc(name: string, args: Record<string, unknown>, token: string | null = mcpToken, method = 'tools/call') {
  const response = await fetch(`${service.baseUrl}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 103, method, params: method === 'tools/list' ? {} : { name, arguments: args } }) })
  const raw = await response.text()
  const payload = raw.startsWith('event:') ? raw.split('\n').find(line => line.startsWith('data: '))!.slice(6) : raw
  return { status: response.status, body: JSON.parse(payload) }
}
const value = (result: any) => JSON.parse(result.body.result.content[0].text)
const request = (key: string) => ({ idempotencyKey: key, sourceKind: 'announcement' as const, sourceIdentity: `synthetic/${key}`, payload: { announcement: { sourceDocument: { source: 'jxj' as const, title: '合成回执公告' }, records: [{ enterprise: { name: '合成回执企业' }, titleCode: 'specialized_sme', events: [{ eventType: 'award' as const, year: 2026 }] }] } } })

async function startService(configured = true) {
  const cwd = resolve(import.meta.dirname, '../../..')
  const port = await reserveLoopbackPort()
  const child = spawnCompiledApp(port, {
    cwd, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...postgres!.env, NUXT_DB_READONLY: '0',
      NUXT_BUILD_DIR: join(dir, configured ? 'nuxt-build' : 'nuxt-unconfigured'),
      NUXT_ROSTER_EXPORT_DIR: join(dir, 'exports'),
      NUXT_API_TOKEN: configured ? apiToken : '', NUXT_MCP_TOKEN: configured ? mcpToken : '',
      NUXT_FILES_DIR: join(dir, 'files'), NUXT_INCOMING_DIR: join(dir, 'incoming'),
    },
  })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output += data })
  service = { baseUrl: `http://127.0.0.1:${port}`, stop: () => stopOwnedChild(child) }
  try { await waitForHttp(`${service.baseUrl}/api/health`, { timeoutMs: 60000, child }) }
  catch (error) { await service.stop(); throw new Error(`${String(error)}\n${output.slice(-8000)}`) }
}
beforeAll(async () => {
  postgres = await postgresRuntimeFixture({ dir })
  pool = new pg.Pool({ connectionString: postgres.url })
  db = drizzle({ client: pool })
  await seedReceiptFixture()
  await readDevelopmentDiscovery()
  await startService()
}, 90_000)

afterAll(async () => {
  await service?.stop()
  await pool?.end()
  postgres?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('import receipts through real HTTP and MCP on isolated PostgreSQL', () => {
  it('reads an exact legacy batch by ID or key without creating a receipt', async () => {
    const response = await get(`?batchId=${legacy.id}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.json()
    expect(body).toMatchObject({ batchId: legacy.id, idempotencyKey: legacy.idempotencyKey, status: 'preflight', receiptId: null, itemCount: 0 })
    expect(body).not.toHaveProperty('items')
    expect(body).not.toHaveProperty('request')
    expect(await (await get(`?idempotencyKey=${encodeURIComponent(legacy.idempotencyKey)}`)).json()).toEqual(body)
    expect(value(await rpc('get_roster_import_receipt', { batchId: legacy.id }))).toEqual(body)
    expect(await (await get(`/history?batchId=${legacy.id}`)).json()).toMatchObject({ total: 0, rows: [] })
  })
  it('bounds legacy metadata and item projections without loading raw result details', async () => {
    const summary = await (await get(`?batchId=${longLegacy.id}`)).json()
    expect(summary.idempotencyKey).toHaveLength(4096)
    expect(summary).toMatchObject({ sourceIdentityTruncated: true, idempotencyKeyTruncated: true, summary: { written: 1, evidenceRepointed: 0 }, itemCount: 1 })
    expect(summary.sourceIdentity).toHaveLength(4096)
    const items = await get(`/items?batchId=${longLegacy.id}&pageSize=1`)
    const text = await items.text()
    expect(text.includes('LEGACY_RAW_ONLY')).toBe(false)
    expect(JSON.parse(text)).toMatchObject({ total: 1, rows: [{ ok: true, ref: 'record:991' }] })
    expect(Buffer.byteLength(text)).toBeLessThan(1024)
  })
  it('recovers a committed original-body submission after losing its response without replaying it', async () => {
    const submitted = request('disconnect/精确?key=103')
    const staged = await (await post('commit', submitted)).json()
    const review = await reviewPostgresFixtureRows(db, staged.sourceDigest, submitted)
    await new Promise<void>((resolve, reject) => {
      const outgoing = httpRequest(`${service.baseUrl}/api/roster/import/intake/${staged.intakeId}/supplement`, { method: 'POST', headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' } }, response => { response.destroy(); resolve() })
      outgoing.on('error', reject)
      outgoing.end(JSON.stringify(review))
    })
    const selector = `?idempotencyKey=${encodeURIComponent(submitted.idempotencyKey)}`
    const receipt = await (await get(selector)).json()
    expect(receipt).toMatchObject({ status: 'committed', itemCount: 1, summary: { written: 4, failed: 0 } })
    expect(receipt.receiptId).toBeGreaterThan(0)
    expect(value(await rpc('get_roster_import_receipt', { idempotencyKey: submitted.idempotencyKey }))).toEqual(receipt)
    const retry = await post('commit', submitted)
    expect(retry.status).toBe(200)
    expect(await retry.json()).toEqual(staged)
    expect(await supplement(submitted)).toMatchObject({ batchId: receipt.batchId, status: 'supplemented', summary: { written: 4, failed: 0 } })
    expect(await (await get(selector)).json()).toEqual(receipt)
    const reordered = { ...submitted, payload: { announcement: { records: submitted.payload.announcement.records, sourceDocument: { title: submitted.payload.announcement.sourceDocument.title, source: 'jxj' } } } }
    expect((await post('commit', reordered)).status).toBe(200)
    expect(await (await get(`/history${selector}&pageSize=1`)).json()).toMatchObject({ total: 1, rows: [{ receiptId: receipt.receiptId, status: 'committed' }] })
    expect((await post('commit', { request: submitted, planHash: 'not-the-import-protocol' })).status).toBe(400)
  })
  it('repoints evidence through explicit replay, keeps the internal targets private and resolves a changed default source', async () => {
    const idempotencyKey = 'explicit-replay/repoint'
    const pdf = minimalPdf({ pages: 7 })
    const sha256 = createHash('sha256').update(pdf).digest('hex')
    const name = '显式重放出处企业'
    const original = 'synthetic/replay-A.pdf'
    const moved = 'synthetic/replay-B.pdf'
    mkdirSync(join(dir, 'files', 'synthetic'), { recursive: true })
    for (const path of [original, moved]) writeFileSync(join(dir, 'files', path), pdf)
    function announcement(key: string, sourceFile: string, source: 'jxj' | 'miit'): RosterImportRequest {
      return { idempotencyKey: key, sourceKind: 'announcement', sourceIdentity: sourceFile, sourceSha256: sha256,
        payload: { announcement: { sourceDocument: { source, title: '合成重放公告' }, records: [{
          enterprise: { name }, titleCode: 'specialized_sme',
          events: [{ eventType: 'award', year: 2026, batchSeq: 1,
            evidence: [{ sourceFile, attachment: '附件1', listNo: 1, page: 7 }] }],
        }] } },
      }
    }
    const assertEvidence = async (jxj: string, miit: string) => {
      expect(await db.select({ source: record.source, path: recordEvidence.sourceFile, page: recordEvidence.page })
        .from(recordEvidence)
        .innerJoin(recordEvent, eq(recordEvent.id, recordEvidence.recordEventId))
        .innerJoin(record, eq(record.id, recordEvent.recordId))
        .innerJoin(enterprise, eq(enterprise.id, record.enterpriseId))
        .where(eq(enterprise.name, name)).orderBy(record.source)).toEqual([
        { source: 'jxj', path: jxj, page: 7 },
        { source: 'miit', path: miit, page: 7 },
      ])
    }
    for (const source of ['jxj', 'miit'] as const) {
      expect(await supplement(announcement('explicit-replay/base-' + source, original, source)))
        .toMatchObject({ status: 'supplemented' })
    }
    const repoint = announcement(idempotencyKey, moved, 'jxj')
    const committed = await supplement(repoint)
    expect(committed).toMatchObject({ status: 'supplemented', summary: { evidenceRepointed: 1 } })
    expect(JSON.stringify(committed)).not.toMatch(/evidenceRepointTargets|evidenceRepointPlanFingerprint/)
    const [originalBatch] = await db.select().from(importBatch).where(eq(importBatch.idempotencyKey, idempotencyKey))
    expect(JSON.parse(originalBatch!.itemResults!)).toMatchObject([{
      detail: { evidenceRepointTargets: [{ fromSourceFile: original, sourceFile: moved }],
        evidenceRepointPlanFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) },
    }])
    await assertEvidence(moved, original)

    // A new matching coordinate makes recomputation ambiguous. Matching replay can still use the saved ID.
    const [{ detail: { evidenceRepointTargets: [target] } }] = JSON.parse(originalBatch!.itemResults!)
    await db.update(recordEvidence).set({ sourceFile: original }).where(eq(recordEvidence.id, target.id))
    const [otherEvidence] = await db.insert(recordEvidence).values({
      recordEventId: target.recordEventId, sourceFile: moved, attachment: '附件1', listNo: 1, page: 7,
    }).returning({ id: recordEvidence.id })
    const matching = await post('replay', repoint)
    const matchingBody = await matching.json()
    expect(matching.status, JSON.stringify(matchingBody)).toBe(200)
    expect(matchingBody).toMatchObject({ status: 'replayed', evidenceRepointed: 1 })
    expect(await db.select({ path: recordEvidence.sourceFile }).from(recordEvidence)
      .where(eq(recordEvidence.id, target.id))).toEqual([{ path: moved }])
    await db.delete(recordEvidence).where(eq(recordEvidence.id, otherEvidence!.id))

    // Same batch and file, but the announcement's default source selects the other record.
    const replay = await post('replay', announcement(idempotencyKey, moved, 'miit'))
    const body = await replay.json()
    expect(replay.status, JSON.stringify(body)).toBe(200)
    expect(body).toMatchObject({ status: 'replayed', update: 1, evidenceRepointed: 1,
      items: [{ ok: true, kind: 'record', detail: { evidenceRepointed: 1 } }] })
    expect(body.items[0].detail).not.toHaveProperty('evidenceRepointTargets')
    expect(body.items[0].detail).not.toHaveProperty('evidenceRepointPlanFingerprint')
    await assertEvidence(moved, moved)

    const [batch] = await db.select().from(importBatch).where(eq(importBatch.id, body.batchId))
    expect(batch).toMatchObject({ idempotencyKey: idempotencyKey + '#repoint', status: 'committed' })
    const [internal] = JSON.parse(batch!.itemResults!)
    expect(internal.detail.evidenceRepointTargets).toMatchObject([{ fromSourceFile: original, sourceFile: moved }])
    expect(internal.detail.evidenceRepointPlanFingerprint).toMatch(/^[a-f0-9]{64}$/)
    const receipt = await (await get(`/items?batchId=${body.batchId}`)).json()
    expect(receipt).toMatchObject({ total: 1, rows: [{ ok: true, ref: body.items[0].ref }] })
    expect(JSON.stringify(receipt)).not.toMatch(/evidenceRepointTargets|evidenceRepointPlanFingerprint/)
    expect(await (await get(`/history?batchId=${body.batchId}`)).json())
      .toMatchObject({ total: 2, rows: [
        { operation: 'replay', status: 'committed' },
        { operation: 'replay', status: 'committed' },
      ] })

    const repeated = await post('replay', announcement(idempotencyKey, moved, 'miit'))
    expect(repeated.status).toBe(200)
    expect(await repeated.json()).toMatchObject({ batchId: body.batchId, status: 'replayed', evidenceRepointed: 0 })
    await assertEvidence(moved, moved)
  })

  it('preserves immutable failed history when corrected source rows use a new key', async () => {
    const submitted = request('retry-history')
    submitted.payload.announcement.records[0]!.titleCode = 'invalid_title'
    expect((await post('preflight', submitted)).status).toBe(200)
    const failed = await supplement(submitted)
    expect(failed).toMatchObject({ status: 'failed', summary: { written: 0, failed: 1 } })
    const selector = `?batchId=${failed.batchId}`
    const failure = await (await get(selector)).json()
    expect(failure.status).toBe('failed')
    expect(await (await get(`/items?receiptId=${failure.receiptId}`)).json()).toMatchObject({ total: 1, rows: [{ ok: false, errorCode: 'title_unknown', errorField: 'titleCode' }] })
    const corrected = request('retry-history-corrected')
    expect((await post('commit', { ...corrected, idempotencyKey: submitted.idempotencyKey })).status).toBe(409)
    const current = await supplement(corrected)
    expect(current).toMatchObject({ status: 'supplemented' })
    expect(current.batchId).not.toBe(failed.batchId)
    const historical = await (await get(`?receiptId=${failure.receiptId}`)).json()
    expect(historical).toEqual(failure)
    const history = await (await get(`/history${selector}`)).json()
    expect(history).toMatchObject({ total: 2, rows: [expect.objectContaining({ status: 'preflight' }), expect.objectContaining({ receiptId: failure.receiptId, status: 'failed' })] })
    expect(value(await rpc('list_roster_import_receipts', { batchId: failed.batchId }))).toEqual(history)
  })
  it('pages exact item outcomes in stable input order without raw or private details on either transport', async () => {
    const submitted = request('item-pages')
    submitted.payload.announcement.records = Array.from({ length: 3 }, (_, i) => ({ enterprise: { name: `合成分页企业${i}` }, titleCode: 'specialized_sme', events: [{ eventType: 'award' as const, year: 2026 }] }))
    const committed = await supplement(submitted)
    expect(committed.status).toBe('supplemented')
    const first = await get(`/items?batchId=${committed.batchId}&pageSize=2`)
    expect(first.status).toBe(200)
    const page = await first.json()
    expect(page).toMatchObject({ total: 3, page: 1, pageSize: 2, rows: [{ index: 0, ok: true, kind: 'record_event', ref: committed.items[0]!.ref }, { index: 1, ok: true, kind: 'record_event', ref: committed.items[1]!.ref }] })
    expect(page.rows[0]).not.toHaveProperty('detail')
    const second = await (await get(`/items?batchId=${committed.batchId}&page=2&pageSize=2`)).json()
    expect(second).toMatchObject({ total: 3, rows: [{ index: 2, ref: committed.items[2]!.ref }] })
    expect(value(await rpc('list_roster_import_items', { idempotencyKey: submitted.idempotencyKey, page: 2, pageSize: 2 }))).toEqual(second)
    expect(await (await get(`/items?batchId=${committed.batchId}&page=3&pageSize=2`)).json()).toMatchObject({ total: 3, rows: [] })
    expect(await (await get(`/items?batchId=${legacy.id}`)).json()).toMatchObject({ total: 0, rows: [] })
  })
  it('keeps source intake evidence and omits request bodies from receipt readback', async () => {
    const submitted = request('intake-source-evidence')
    submitted.payload.announcement.sourceDocument.title = '合成留存来源公告'
    submitted.payload.announcement.records[0]!.enterprise.name = '合成留存来源企业'
    const staged = await (await post('commit', submitted)).json()
    expect(staged).toMatchObject({ status: 'staged' })
    const committed = await supplement(submitted)
    expect(committed.status).toBe('supplemented')
    const [intake] = await db.select({ request: rosterAnnouncementIntake.request })
      .from(rosterAnnouncementIntake).where(eq(rosterAnnouncementIntake.idempotencyKey, submitted.idempotencyKey))
    expect(JSON.parse(intake!.request)).toMatchObject(submitted)
    const summary = await (await get(`?batchId=${committed.batchId}`)).json()
    expect(summary).toMatchObject({ status: 'committed', summary: committed.summary })
    expect(summary).not.toHaveProperty('originalRequest')
    const retiredRoute = await get(`/request?receiptId=${summary.receiptId}`)
    expect(retiredRoute.status).toBe(404)
    expect(await retiredRoute.text()).not.toContain('合成留存来源公告')
  })
  it('distinguishes processing, preflight, failure and not found without consuming missing keys', async () => {
    expect(await (await get(`?batchId=${processing.id}`)).json()).toMatchObject({ status: 'processing', committedAt: null, completedAt: null })
    expect(value(await rpc('get_roster_import_receipt', { batchId: processing.id }))).toMatchObject({ status: 'processing' })
    const submitted = request('not-created-by-lookup')
    expect((await get(`?idempotencyKey=${submitted.idempotencyKey}`)).status).toBe(404)
    expect((await get(`?idempotencyKey=${submitted.idempotencyKey}`)).status).toBe(404)
    expect((await get('?batchId=99999999')).status).toBe(404)
    expect((await get('?receiptId=99999999')).status).toBe(404)
    expect((await get(`?batchId=${foreignBatch.id}`)).status).toBe(404)
    expect((await rpc('get_roster_import_receipt', { batchId: 99999999 })).body.result.isError).toBe(true)
    expect(value(await rpc('get_roster_import_receipt', { batchId: 99999999 }))).toMatchObject({ error: { code: 'not_found' } })
    const preflight = await (await post('preflight', submitted)).json()
    expect(await (await get(`?batchId=${preflight.batchId}`)).json()).toMatchObject({ status: 'preflight', summary: null })
    expect(await supplement(submitted)).toMatchObject({ batchId: preflight.batchId, status: 'supplemented' })
  })
  it('retains failed transaction outcomes and rolls back business writes before a corrected version', async () => {
    const submitted = request('transaction-rollback')
    submitted.payload.announcement.sourceDocument.title = '合成事务回滚独立公告'
    submitted.payload.announcement.records[0]!.enterprise.name = '合成触发回滚企业'
    const failure = await supplement(submitted)
    expect(failure).toMatchObject({ status: 'failed', summary: { written: 0, failed: 1 } })
    expect(JSON.stringify(failure)).not.toContain('synthetic transaction rollback')
    expect(await db.select({ id: enterprise.id }).from(enterprise)
      .where(eq(enterprise.name, submitted.payload.announcement.records[0]!.enterprise.name))).toEqual([])
    expect(await db.select({ id: sourceDocument.id }).from(sourceDocument)
      .where(eq(sourceDocument.title, submitted.payload.announcement.sourceDocument.title))).toEqual([])
    const receipt = await (await get(`?batchId=${failure.batchId}`)).json()
    expect(receipt.status).toBe('failed')
    expect(await (await get(`/items?receiptId=${receipt.receiptId}`)).json()).toMatchObject({ rows: [{ ok: false, errorCode: 'commit_rolled_back' }] })
    const recovered = { ...submitted, idempotencyKey: 'transaction-rollback-corrected', payload: { announcement: { ...submitted.payload.announcement, records: [{ ...submitted.payload.announcement.records[0]!, enterprise: { name: '合成回滚恢复企业' } }] } } }
    const staged = value(await rpc('save_roster_batch', recovered))
    expect(staged).toMatchObject({ status: 'staged' })
    const committed = await supplement(recovered)
    expect(committed).toMatchObject({ status: 'supplemented', summary: { written: 4 } })
    expect(committed.batchId).not.toBe(failure.batchId)
    expect(await (await get(`?receiptId=${receipt.receiptId}`)).json()).toEqual(receipt)
  })
  it('enforces independent credentials and advertises read-only receipt tools only to authorized callers', async () => {
    for (const path of ['', '/items', '/history']) {
      for (const token of [null, 'wrong', mcpToken]) {
        const denied = await get(`${path}?batchId=${legacy.id}`, token)
        expect(denied.status).toBe(401)
        expect(denied.headers.get('cache-control')).toBe('no-store')
      }
    }
    const names = ['get_roster_import_receipt', 'list_roster_import_items', 'list_roster_import_receipts']
    const hidden = (await rpc('', {}, null, 'tools/list')).body.result.tools.map((tool: any) => tool.name)
    for (const name of names) {
      expect(hidden).not.toContain(name)
      expect((await rpc(name, { batchId: legacy.id }, null)).status).toBe(401)
      expect((await rpc(name, { batchId: legacy.id }, apiToken)).status).toBe(401)
    }
    const tools = (await rpc('', {}, mcpToken, 'tools/list')).body.result.tools
    expect(tools.map((tool: {name: string}) => tool.name)).not.toContain('get_roster_import_request')
    for (const name of names) expect(tools.find((tool: any) => tool.name === name)).toMatchObject({ annotations: { readOnlyHint: true, destructiveHint: false } })
    expect((await fetch(api(`?batchId=${legacy.id}`), { headers: { 'x-api-token': apiToken } })).status).toBe(200)
  })
  it('rejects invalid selectors and unbounded pagination on both public transports', async () => {
    for (const query of ['', '?batchId=0', '?batchId=1.5', '?batchId=1e2', '?batchId=1&batchId=2', '?idempotencyKey=', `?batchId=${legacy.id}&idempotencyKey=x`, `?batchId=${legacy.id}&includeRaw=true`]) expect((await get(query)).status).toBe(400)
    for (const path of ['/items', '/history']) for (const query of ['page=0', 'page=1000001', 'pageSize=0', 'pageSize=51', 'pageSize=2.5']) expect((await get(`${path}?batchId=${legacy.id}&${query}`)).status).toBe(400)
    for (const args of [{}, { batchId: 0 }, { batchId: legacy.id, idempotencyKey: 'x' }]) expect((await rpc('get_roster_import_receipt', args)).body.result.isError).toBe(true)
    for (const name of ['list_roster_import_items', 'list_roster_import_receipts']) expect((await rpc(name, { batchId: legacy.id, pageSize: 51 })).body.result.isError).toBe(true)
  })
  it('exposes all receipt reads in OpenAPI without replacing the original-body commit schema', async () => {
    const spec = await (await Promise.resolve(new Response(JSON.stringify(await readDevelopmentDiscovery())))).json()
    for (const suffix of ['', '/items', '/history']) expect(spec.paths[`/api/roster/import/receipts${suffix}`].get.security).toEqual([{ bearerAuth: [] }])
    expect(spec.paths['/api/roster/import/receipts/request']).toBeUndefined()
    const required = spec.paths['/api/roster/import/commit'].post.requestBody.content['application/json'].schema.required
    expect(required).toEqual(['idempotencyKey', 'sourceKind', 'sourceIdentity', 'payload'])
    expect(spec.paths['/api/roster/import/receipts'].get.responses['200'].content['application/json'].schema.properties.status.enum).toEqual(['preflight', 'processing', 'failed', 'committed'])
  })
  it('keeps fixed-page responses bounded when unrelated retained item bytes grow', async () => {
    const submitted = request('bounded-target')
    submitted.payload.announcement.sourceDocument.title = '合成有界分页公告'
    submitted.payload.announcement.records = Array.from({ length: 120 }, (_, i) => ({ enterprise: { name: `合成有界企业${i}` }, titleCode: 'specialized_sme', events: [{ eventType: 'award' as const, year: 2026 }] }))
    const committed = await supplement({ ...submitted, payload: { ...submitted.payload, rawPadding: 'TARGET_RAW_PADDING'.repeat(16384) } } as RosterImportRequest)
    expect(committed.status).toBe('supplemented')
    const path = `?batchId=${committed.batchId}`
    const before = await (await get(path)).text()
    const itemBefore = await (await get(`/items${path}&page=3&pageSize=50`)).text()
    expect(JSON.parse(itemBefore)).toMatchObject({ total: 120, page: 3, rows: Array.from({ length: 20 }, (_, i) => ({ index: 100 + i, ok: true })) })
    const padding = 'UNRELATED_RAW_PADDING'.repeat(8192)
    const createdAt = '2026-10-19T00:00:00Z'
    const itemResults = JSON.stringify([{ ok: true, kind: 'record', ref: 'unrelated', detail: { padding } }])
    await db.transaction(async tx => {
      const batches = await tx.insert(importBatch).values(Array.from({ length: 30 }, (_, i) => ({
        idempotencyKey: `bounded-unrelated-${i}`, sourceKind: 'announcement', sourceIdentity: `synthetic/unrelated-${i}`,
        status: 'committed', itemResults, createdAt,
      }))).returning({ id: importBatch.id })
      await tx.insert(importReceipt).values(batches.map(batch => ({
        batchId: batch.id, operation: 'commit', requestHash: 'synthetic',
        status: 'committed', createdAt, completedAt: '2026-10-19T00:01:00Z', itemResults,
      })))
    })
    const after = await (await get(path)).text()
    expect(after).toBe(before)
    const itemAfter = await (await get(`/items${path}&page=3&pageSize=50`)).text()
    expect(itemAfter).toBe(itemBefore)
    expect(Buffer.byteLength(after)).toBeLessThan(2048)
    expect(Buffer.byteLength(itemAfter)).toBeLessThan(16384)
    expect(value(await rpc('list_roster_import_items', { batchId: committed.batchId, page: 3, pageSize: 50 }))).toEqual(JSON.parse(itemAfter))
  }, 30_000)
  it('disables protected reads when credentials are unconfigured', async () => {
    await service.stop()
    await startService(false)
    expect((await get(`?batchId=${legacy.id}`)).status).toBe(401)
    expect((await rpc('get_roster_import_receipt', { batchId: legacy.id })).status).toBe(401)
    expect((await rpc('', {}, null, 'tools/list')).body.result.tools.map((tool: any) => tool.name)).not.toContain('get_roster_import_receipt')
  }, 90000)
})
