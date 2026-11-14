import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { request as httpRequest } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { initializeDb, schema } from '../db/client'
import { spawnOwnedChild as spawn, reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../scripts/lib/isolated-local-services.mjs'

const dir = mkdtempSync(join(tmpdir(), 'spec98-import-receipts-'))
const dbPath = join(dir, 'synthetic.db')
const db = initializeDb({ create: true,  dbPath })
const legacy = db.insert(schema.importBatch).values({ idempotencyKey: 'legacy/key?精确=1', sourceKind: 'announcement', sourceIdentity: 'synthetic/legacy', status: 'preflight' }).returning().get()
const processing = db.insert(schema.importBatch).values({ idempotencyKey: 'interrupted-worker', sourceKind: 'announcement', sourceIdentity: 'synthetic/processing' }).returning().get()
db.insert(schema.importReceipt).values({ batchId: processing.id, operation: 'commit', requestHash: 'synthetic-hash', requestBody: '{}', status: 'processing', createdAt: '2026-10-19T00:00:00Z' }).run()
const foreignBatch = db.insert(schema.importBatch).values({ idempotencyKey: 'correspondence-only', sourceKind: 'correspondence_decision', sourceIdentity: 'synthetic/correspondence' }).returning().get()
const longLegacy = db.insert(schema.importBatch).values({ idempotencyKey: 'K'.repeat(4100), sourceKind: 'announcement', sourceIdentity: 'S'.repeat(4100), status: 'committed', summary: { written: 1, skipped: 0, failed: 0 }, itemResults: [{ ok: true, kind: 'record', ref: 'record:991', detail: { raw: 'LEGACY_RAW_ONLY'.repeat(8192) } }] }).returning().get()
db.run(sql`CREATE TRIGGER synthetic_receipt_rollback BEFORE INSERT ON enterprise WHEN NEW.name = '合成触发回滚企业' BEGIN SELECT RAISE(ABORT, 'synthetic transaction rollback'); END`)
let service: { baseUrl: string; stop: () => Promise<void> }
const apiToken = 'synthetic-api-103'
const mcpToken = 'synthetic-mcp-103'
const api = (suffix = '') => `${service.baseUrl}/api/roster/import/receipts${suffix}`
const get = (suffix = '', token: string | null = apiToken) => fetch(api(suffix), { headers: token ? { authorization: `Bearer ${token}` } : {} })
const post = (action: string, body: unknown) => fetch(`${service.baseUrl}/api/roster/import/${action}`, { method: 'POST', headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
async function rpc(name: string, args: Record<string, unknown>, token: string | null = mcpToken, method = 'tools/call') {
  const response = await fetch(`${service.baseUrl}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 103, method, params: method === 'tools/list' ? {} : { name, arguments: args } }) })
  const raw = await response.text()
  const payload = raw.startsWith('event:') ? raw.split('\n').find(line => line.startsWith('data: '))!.slice(6) : raw
  return { status: response.status, body: JSON.parse(payload) }
}
const value = (result: any) => JSON.parse(result.body.result.content[0].text)
const request = (key: string) => ({ idempotencyKey: key, sourceKind: 'announcement', sourceIdentity: `synthetic/${key}`, payload: { announcement: { sourceDocument: { source: 'jxj', title: '合成回执公告' }, records: [{ enterprise: { name: '合成回执企业' }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year: 2026 }] }] } } })

async function startService(configured = true) {
  const cwd = resolve(import.meta.dirname, '..')
  const port = await reserveLoopbackPort()
  const child = spawn(process.execPath, [join(cwd, 'node_modules/nuxt/bin/nuxt.mjs'), 'dev', '--host', '127.0.0.1', '--port', String(port)], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NUXT_BUILD_DIR: join(dir, configured ? 'nuxt-build' : 'nuxt-unconfigured'), NUXT_DB_PATH: dbPath, NUXT_API_TOKEN: configured ? apiToken : '', NUXT_MCP_TOKEN: configured ? mcpToken : '', NUXT_FILES_DIR: join(dir, 'files'), NUXT_INCOMING_DIR: join(dir, 'incoming') } })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output += data })
  service = { baseUrl: `http://127.0.0.1:${port}`, stop: () => stopOwnedChild(child) }
  try { await waitForHttp(`${service.baseUrl}/api/stats`, { timeoutMs: 60000, child }) }
  catch (error) { await service.stop(); throw new Error(`${String(error)}\n${output.slice(-8000)}`) }
}
beforeAll(() => startService(), 90000)
afterAll(async () => { if (service) await service.stop(); rmSync(dir, { recursive: true, force: true }) })

describe('import receipts through real HTTP and MCP on isolated SQLite', () => {
  it('reads an exact legacy batch by ID or key without creating a receipt', async () => {
    const response = await get(`?batchId=${legacy.id}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.json()
    expect(body).toMatchObject({ batchId: legacy.id, idempotencyKey: legacy.idempotencyKey, status: 'preflight', receiptId: null, originalRequest: 'not_retained', itemCount: 0 })
    expect(body).not.toHaveProperty('items')
    expect(body).not.toHaveProperty('request')
    expect(await (await get(`?idempotencyKey=${encodeURIComponent(legacy.idempotencyKey)}`)).json()).toEqual(body)
    expect(value(await rpc('get_roster_import_receipt', { batchId: legacy.id }))).toEqual(body)
    expect(await (await get(`/history?batchId=${legacy.id}`)).json()).toMatchObject({ total: 0, rows: [] })
  })
  it('bounds legacy metadata and item projections without loading raw result details', async () => {
    const summary = await (await get(`?batchId=${longLegacy.id}`)).json()
    expect(summary.idempotencyKey).toHaveLength(4096)
    expect(summary).toMatchObject({ sourceIdentityTruncated: true, idempotencyKeyTruncated: true, summary: { written: 1, evidenceRepointed: 0 }, itemCount: 1, originalRequest: 'not_retained' })
    expect(summary.sourceIdentity).toHaveLength(4096)
    const items = await get(`/items?batchId=${longLegacy.id}&pageSize=1`)
    const text = await items.text()
    expect(text.includes('LEGACY_RAW_ONLY')).toBe(false)
    expect(JSON.parse(text)).toMatchObject({ total: 1, rows: [{ ok: true, ref: 'record:991' }] })
    expect(Buffer.byteLength(text)).toBeLessThan(1024)
  })
  it('recovers a committed original-body submission after losing its response without replaying it', async () => {
    const submitted = request('disconnect/精确?key=103')
    await new Promise<void>((resolve, reject) => {
      const outgoing = httpRequest(`${service.baseUrl}/api/roster/import/commit`, { method: 'POST', headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' } }, response => { response.destroy(); resolve() })
      outgoing.on('error', reject)
      outgoing.end(JSON.stringify(submitted))
    })
    const selector = `?idempotencyKey=${encodeURIComponent(submitted.idempotencyKey)}`
    const receipt = await (await get(selector)).json()
    expect(receipt).toMatchObject({ status: 'committed', originalRequest: 'redacted', itemCount: 1, summary: { written: 4, failed: 0 } })
    expect(receipt.receiptId).toBeGreaterThan(0)
    expect(value(await rpc('get_roster_import_receipt', { idempotencyKey: submitted.idempotencyKey }))).toEqual(receipt)
    const retry = await post('commit', submitted)
    expect(retry.status).toBe(200)
    expect(await retry.json()).toMatchObject({ batchId: receipt.batchId, status: 'committed', summary: { written: 4, failed: 0 } })
    expect(await (await get(selector)).json()).toEqual(receipt)
    const reordered = { ...submitted, payload: { announcement: { records: submitted.payload.announcement.records, sourceDocument: { title: submitted.payload.announcement.sourceDocument.title, source: 'jxj' } } } }
    expect((await post('commit', reordered)).status).toBe(200)
    expect(await (await get(`/history${selector}&pageSize=1`)).json()).toMatchObject({ total: 1, rows: [{ receiptId: receipt.receiptId, status: 'committed' }] })
    expect((await post('commit', { request: submitted, planHash: 'not-the-import-protocol' })).status).toBe(400)
  })
  it('preserves immutable failed history while correcting the same key and rejects a different committed request', async () => {
    const submitted = request('retry-history')
    submitted.payload.announcement.records[0]!.titleCode = 'invalid_title'
    expect((await post('preflight', submitted)).status).toBe(200)
    const failed = await (await post('commit', submitted)).json()
    expect(failed).toMatchObject({ status: 'failed', summary: { written: 0, failed: 1 } })
    const selector = `?batchId=${failed.batchId}`
    const failure = await (await get(selector)).json()
    expect(failure.status).toBe('failed')
    expect(await (await get(`/items?receiptId=${failure.receiptId}`)).json()).toMatchObject({ total: 1, rows: [{ ok: false, errorCode: 'title_unknown', errorField: 'titleCode' }] })
    submitted.payload.announcement.records[0]!.titleCode = 'specialized_sme'
    expect(await (await post('commit', submitted)).json()).toMatchObject({ batchId: failed.batchId, status: 'committed' })
    const current = await (await get(selector)).json()
    expect(current.receiptId).not.toBe(failure.receiptId)
    const historical = await (await get(`?receiptId=${failure.receiptId}`)).json()
    expect(historical).toEqual(failure)
    expect(historical).toMatchObject({ status: 'failed', summary: { written: 0, failed: 1 }, receiptId: failure.receiptId })
    const history = await (await get(`/history${selector}&page=2&pageSize=1`)).json()
    expect(history).toMatchObject({ total: 3, rows: [{ receiptId: failure.receiptId, status: 'failed' }] })
    expect(value(await rpc('list_roster_import_receipts', { batchId: failed.batchId, page: 2, pageSize: 1 }))).toEqual(history)
    const conflict = await post('commit', { ...submitted, payload: {} })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ error: { code: 'idempotency_conflict' } })
    expect((await post('commit', { ...submitted, sourceIdentity: 'synthetic/different' })).status).toBe(409)
    const mcpConflict = await rpc('save_roster_batch', { ...submitted, payload: {} })
    expect(mcpConflict.body.result.isError).toBe(true)
    expect(value(mcpConflict)).toMatchObject({ error: { code: 'idempotency_conflict' } })
    expect(await (await get(selector)).json()).toEqual(current)
    expect(await (await get(`/history${selector}`)).json()).toMatchObject({ total: 3 })
  })
  it('pages exact item outcomes in stable input order without raw or private details on either transport', async () => {
    const submitted = request('item-pages')
    submitted.payload.announcement.records = Array.from({ length: 3 }, (_, i) => ({ enterprise: { name: `合成分页企业${i}` }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year: 2026 }] }))
    const committed = await (await post('commit', submitted)).json()
    expect(committed.status).toBe('committed')
    const first = await get(`/items?batchId=${committed.batchId}&pageSize=2`)
    expect(first.status).toBe(200)
    const page = await first.json()
    expect(page).toMatchObject({ total: 3, page: 1, pageSize: 2, rows: [{ index: 0, ok: true, kind: 'record_event', ref: committed.items[0].ref }, { index: 1, ok: true, kind: 'record_event', ref: committed.items[1].ref }] })
    expect(page.rows[0]).not.toHaveProperty('detail')
    const second = await (await get(`/items?batchId=${committed.batchId}&page=2&pageSize=2`)).json()
    expect(second).toMatchObject({ total: 3, rows: [{ index: 2, ref: committed.items[2].ref }] })
    expect(value(await rpc('list_roster_import_items', { idempotencyKey: submitted.idempotencyKey, page: 2, pageSize: 2 }))).toEqual(second)
    expect(await (await get(`/items?batchId=${committed.batchId}&page=3&pageSize=2`)).json()).toMatchObject({ total: 3, rows: [] })
    expect(await (await get(`/items?batchId=${legacy.id}`)).json()).toMatchObject({ total: 0, rows: [] })
  })
  it('reads only explicitly requested redacted UTF8 byte chunks and never defaults to the full request', async () => {
    const submitted = { ...request('raw-chunks'), payload: { ...request('raw-chunks').payload, externalRaw: { marker: 'RAW_ONLY_103_中文'.repeat(6000), Authorization: 'Bearer FAKE_AUTH_103', cookie: 'FAKE_COOKIE_103', api_key: 'FAKE_KEY_103', echo: apiToken, encoded: encodeURIComponent('{"session":"FAKE_SESSION_103"}'), nested: [{ password: 'FAKE_PASS_103', value: '{"access_token":"FAKE_JSON_TOKEN_103","name":"保留原事实"}' }] } } }
    const committed = await (await post('commit', submitted)).json()
    expect(committed.status).toBe('committed')
    const summary = await (await get(`?batchId=${committed.batchId}`)).json()
    expect(JSON.stringify(summary)).not.toContain('RAW_ONLY_103')
    expect(summary.originalRequest).toBe('redacted')
    const firstResponse = await get(`/request?receiptId=${summary.receiptId}&maxBytes=17`)
    expect(firstResponse.status).toBe(200)
    const first = await firstResponse.json()
    expect(first).toMatchObject({ redacted: true, encoding: 'base64', offset: 0, nextOffset: 17 })
    expect(Buffer.from(first.data, 'base64')).toHaveLength(17)
    const chunks: Buffer[] = []
    let offset: number | null = 0
    while (offset !== null) {
      const chunk: any = await (await get(`/request?receiptId=${summary.receiptId}&offset=${offset}&maxBytes=65536`)).json()
      chunks.push(Buffer.from(chunk.data, 'base64'))
      expect(Buffer.from(chunk.data, 'base64').length).toBeLessThanOrEqual(65536)
      offset = chunk.nextOffset
    }
    const text = Buffer.concat(chunks).toString('utf8')
    expect(/FAKE_(AUTH|COOKIE|KEY|PASS|JSON_TOKEN|SESSION)_103/.test(text)).toBe(false)
    expect(text.includes(apiToken)).toBe(false)
    expect(JSON.parse(text).payload.externalRaw).toMatchObject({ marker: submitted.payload.externalRaw.marker, Authorization: '[REDACTED]', cookie: '[REDACTED]', api_key: '[REDACTED]', nested: [{ password: '[REDACTED]', value: '{"access_token":"[REDACTED]","name":"保留原事实"}' }] })
    expect(value(await rpc('get_roster_import_request', { receiptId: summary.receiptId, offset: 0, maxBytes: 17 }))).toEqual(first)
    expect(await (await get(`/request?receiptId=${summary.receiptId}&offset=${first.totalBytes}`)).json()).toMatchObject({ data: '', nextOffset: null })
    expect((await get(`/request?receiptId=${summary.receiptId}&offset=${first.totalBytes + 1}`)).status).toBe(400)
    expect((await get(`/request?batchId=${legacy.id}`)).status).toBe(404)
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
    expect(await (await post('commit', submitted)).json()).toMatchObject({ batchId: preflight.batchId, status: 'committed' })
  })
  it('retains failed transaction outcomes and rolls back business writes before same-key correction', async () => {
    const submitted = request('transaction-rollback')
    submitted.payload.announcement.sourceDocument.title = '合成事务回滚独立公告'
    submitted.payload.announcement.records[0]!.enterprise.name = '合成触发回滚企业'
    const failure = await (await post('commit', submitted)).json()
    expect(failure).toMatchObject({ status: 'failed', summary: { written: 0, failed: 1 } })
    const receipt = await (await get(`?batchId=${failure.batchId}`)).json()
    expect(receipt.status).toBe('failed')
    expect(await (await get(`/items?receiptId=${receipt.receiptId}`)).json()).toMatchObject({ rows: [{ ok: false, errorCode: 'commit_rolled_back' }] })
    const recovered = await rpc('save_roster_batch', { ...submitted, payload: { announcement: { ...submitted.payload.announcement, records: [{ ...submitted.payload.announcement.records[0], enterprise: { name: '合成回滚恢复企业' } }] } } })
    expect(value(recovered)).toMatchObject({ status: 'committed', batchId: failure.batchId, summary: { written: 4 } })
    expect(await (await get(`?receiptId=${receipt.receiptId}`)).json()).toEqual(receipt)
  })
  it('enforces independent credentials and advertises read-only receipt tools only to authorized callers', async () => {
    for (const path of ['', '/items', '/history', '/request']) {
      for (const token of [null, 'wrong', mcpToken]) {
        const denied = await get(`${path}?batchId=${legacy.id}`, token)
        expect(denied.status).toBe(401)
        expect(denied.headers.get('cache-control')).toBe('no-store')
      }
    }
    const names = ['get_roster_import_receipt', 'list_roster_import_items', 'list_roster_import_receipts', 'get_roster_import_request']
    const hidden = (await rpc('', {}, null, 'tools/list')).body.result.tools.map((tool: any) => tool.name)
    for (const name of names) {
      expect(hidden).not.toContain(name)
      expect((await rpc(name, { batchId: legacy.id }, null)).status).toBe(401)
      expect((await rpc(name, { batchId: legacy.id }, apiToken)).status).toBe(401)
    }
    const tools = (await rpc('', {}, mcpToken, 'tools/list')).body.result.tools
    for (const name of names) expect(tools.find((tool: any) => tool.name === name)).toMatchObject({ annotations: { readOnlyHint: true, destructiveHint: false } })
    expect((await fetch(api(`?batchId=${legacy.id}`), { headers: { 'x-api-token': apiToken } })).status).toBe(200)
  })
  it('rejects invalid selectors and unbounded pagination on both public transports', async () => {
    for (const query of ['', '?batchId=0', '?batchId=1.5', '?batchId=1e2', '?batchId=1&batchId=2', '?idempotencyKey=', `?batchId=${legacy.id}&idempotencyKey=x`, `?batchId=${legacy.id}&includeRaw=true`]) expect((await get(query)).status).toBe(400)
    for (const path of ['/items', '/history']) for (const query of ['page=0', 'page=1000001', 'pageSize=0', 'pageSize=51', 'pageSize=2.5']) expect((await get(`${path}?batchId=${legacy.id}&${query}`)).status).toBe(400)
    for (const query of ['offset=-1', 'maxBytes=0', 'maxBytes=65537']) expect((await get(`/request?batchId=${legacy.id}&${query}`)).status).toBe(400)
    for (const args of [{}, { batchId: 0 }, { batchId: legacy.id, idempotencyKey: 'x' }]) expect((await rpc('get_roster_import_receipt', args)).body.result.isError).toBe(true)
    for (const name of ['list_roster_import_items', 'list_roster_import_receipts']) expect((await rpc(name, { batchId: legacy.id, pageSize: 51 })).body.result.isError).toBe(true)
    expect((await rpc('get_roster_import_request', { batchId: legacy.id, maxBytes: 65537 })).body.result.isError).toBe(true)
  })
  it('exposes all receipt reads in OpenAPI without replacing the original-body commit schema', async () => {
    const spec = await (await fetch(`${service.baseUrl}/_openapi.json`)).json()
    for (const suffix of ['', '/items', '/history', '/request']) expect(spec.paths[`/api/roster/import/receipts${suffix}`].get.security).toEqual([{ bearerAuth: [] }])
    const required = spec.paths['/api/roster/import/commit'].post.requestBody.content['application/json'].schema.required
    expect(required).toEqual(['idempotencyKey', 'sourceKind', 'sourceIdentity', 'payload'])
    expect(spec.paths['/api/roster/import/receipts'].get.responses['200'].content['application/json'].schema.properties.status.enum).toEqual(['preflight', 'processing', 'failed', 'committed'])
  })
  it('keeps fixed-page responses bounded when unrelated retained request bytes grow', async () => {
    const submitted = request('bounded-target')
    submitted.payload.announcement.sourceDocument.title = '合成有界分页公告'
    submitted.payload.announcement.records = Array.from({ length: 120 }, (_, i) => ({ enterprise: { name: `合成有界企业${i}` }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year: 2026 }] }))
    const committed = await (await post('commit', { ...submitted, payload: { ...submitted.payload, rawPadding: 'TARGET_RAW_PADDING'.repeat(16384) } })).json()
    expect(committed.status).toBe('committed')
    const path = `?batchId=${committed.batchId}`
    const before = await (await get(path)).text()
    const itemBefore = await (await get(`/items${path}&page=3&pageSize=50`)).text()
    expect(JSON.parse(itemBefore)).toMatchObject({ total: 120, page: 3, rows: Array.from({ length: 20 }, (_, i) => ({ index: 100 + i, ok: true })) })
    const padding = 'UNRELATED_RAW_PADDING'.repeat(8192)
    db.transaction(() => {
      for (let i = 0; i < 30; i++) {
        const batch = db.insert(schema.importBatch).values({ idempotencyKey: `bounded-unrelated-${i}`, sourceKind: 'announcement', sourceIdentity: `synthetic/unrelated-${i}`, status: 'committed', itemResults: [{ ok: true, kind: 'record', ref: 'unrelated', detail: { padding } }] }).returning().get()
        db.insert(schema.importReceipt).values({ batchId: batch.id, operation: 'commit', requestHash: 'synthetic', requestBody: JSON.stringify({ padding }), status: 'committed', createdAt: '2026-10-19T00:00:00Z', completedAt: '2026-10-19T00:01:00Z', itemResults: [{ ok: true, kind: 'record', ref: 'unrelated', detail: { padding } }] }).run()
      }
    })
    const after = await (await get(path)).text()
    expect(after).toBe(before)
    const itemAfter = await (await get(`/items${path}&page=3&pageSize=50`)).text()
    expect(itemAfter).toBe(itemBefore)
    expect(Buffer.byteLength(after)).toBeLessThan(2048)
    expect(Buffer.byteLength(itemAfter)).toBeLessThan(16384)
    expect(value(await rpc('list_roster_import_items', { batchId: committed.batchId, page: 3, pageSize: 50 }))).toEqual(JSON.parse(itemAfter))
    const raw = await (await get(`/request${path}&maxBytes=4096`)).json()
    expect(Buffer.from(raw.data, 'base64')).toHaveLength(4096)
  })
  it('disables protected reads when credentials are unconfigured', async () => {
    await service.stop()
    await startService(false)
    expect((await get(`?batchId=${legacy.id}`)).status).toBe(401)
    expect((await rpc('get_roster_import_receipt', { batchId: legacy.id })).status).toBe(401)
    expect((await rpc('', {}, null, 'tools/list')).body.result.tools.map((tool: any) => tool.name)).not.toContain('get_roster_import_receipt')
  }, 90000)
})
