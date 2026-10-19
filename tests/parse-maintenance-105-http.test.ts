import { appendFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { useDb, schema } from '../db/client'
import { reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../scripts/lib/isolated-local-services.mjs'

const dir = mkdtempSync(join(tmpdir(), 'parse-maintenance-105-'))
const dbPath = join(dir, 'roster.db')
const db = useDb({ dbPath })
const token = 'synthetic-105-token'
let service: { baseUrl: string; stop: () => Promise<void> }
let serial = 0
function file() {
  serial++
  return db.insert(schema.storedFile).values({ relPath: `synthetic-${serial}.pdf`, filename: `synthetic-${serial}.pdf`, ext: 'pdf', bytes: 9, sha256: 'synthetic', categoryState: 'unset' }).returning().get()
}
const part = { titleCode: 'specialized_sme', eventKind: 'award', year: 2024, batch: 2, attachment: '附 件 1', rowCount: 3 }
const actor = { type: 'agent', id: 'test-105' }
const write = (version: string, key: string, fields: object) => ({ expectedVersion: version, idempotencyKey: key, actor, reason: '纠正解析声明', ...fields })
async function http(id: number | string, method = 'GET', body?: unknown, suffix = '', authorized = true) {
  return fetch(`${service.baseUrl}/api/files/${id}/parse-result${suffix}`, { method, headers: { 'content-type': 'application/json', ...(authorized ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
async function state(id: number) {
  const response = await http(id)
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toContain('no-store')
  return response.json()
}
async function rpc(method: string, params: unknown, authorized = true) {
  const response = await fetch(`${service.baseUrl}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...(authorized ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 105, method, params }) })
  const raw = await response.text()
  const payload = raw.startsWith('event:') ? raw.split('\n').find(line => line.startsWith('data: '))!.slice(6) : raw
  return { status: response.status, body: JSON.parse(payload) }
}
async function call(name: string, args: object) {
  const response = await rpc('tools/call', { name, arguments: args })
  expect(response.status).toBe(200)
  expect(response.body.error).toBeUndefined()
  expect(response.body.result.isError).not.toBe(true)
  return JSON.parse(response.body.result.content[0].text)
}
async function startService() {
  const cwd = resolve(import.meta.dirname, '..')
  const port = await reserveLoopbackPort()
  mkdirSync(join(dir, 'files'), { recursive: true })
  const child = spawn(process.execPath, [join(cwd, 'node_modules/nuxt/bin/nuxt.mjs'), 'dev', '--host', '127.0.0.1', '--port', String(port)], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NUXT_BUILD_DIR: join(dir, 'build'), NUXT_DB_PATH: dbPath, NUXT_FILES_DIR: join(dir, 'files'), NUXT_INCOMING_DIR: join(dir, 'incoming'), NUXT_API_TOKEN: token, NUXT_MCP_TOKEN: token } })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-8000); appendFileSync('/tmp/ningbo-spec98/ticket-105/server.log', chunk) })
  service = { baseUrl: `http://127.0.0.1:${port}`, stop: () => stopOwnedChild(child) }
  try { await waitForHttp(`${service.baseUrl}/api/health`, { timeoutMs: 60000, child }) }
  catch (error) { await service.stop(); throw new Error(`${error}\n${output}`) }
}
beforeAll(startService, 90000)
afterAll(async () => { if (service) await service.stop(); db.$client.close(); rmSync(dir, { recursive: true, force: true }) })

it('replaces agent segments by stable file ID and reads identical state through REST and MCP', async () => {
  const f = file()
  const before = await state(f.id)
  expect(before).toMatchObject({ fileId: f.id, parseState: 'unparsed', parts: [] })
  const saved = await http(f.id, 'PUT', write(before.version, 'replace-first', { parts: [part] }))
  expect(saved.status).toBe(200)
  const result = await saved.json()
  expect(result.state).toMatchObject({ fileId: f.id, parseState: 'parsed', parts: [{ ...part, attachment: '附件1', origin: 'agent', hasConflict: false }] })
  expect(result.state.version).not.toBe(before.version)
  expect(await state(f.id)).toEqual(result.state)
  expect(await call('get_file_parse_result', { fileId: f.id })).toEqual(result.state)
})

it('state-only PATCH preserves segments while empty replacement restores derived conflicts without side effects', async () => {
  const f = file()
  const enterprise = db.insert(schema.enterprise).values({ name: '解析边界企业105', nameNorm: '解析边界企业105' }).returning().get()
  const record = db.insert(schema.record).values({ enterpriseId: enterprise.id, source: 'jxj', titleCode: 'specialized_sme' }).returning().get()
  const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2024, batchSeq: 2 }).returning().get()
  const review = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'review', year: 2021, batchSeq: 2 }).returning().get()
  db.insert(schema.recordEvidence).values([
    { recordEventId: event.id, sourceFile: f.relPath, attachment: '附件1', page: 1 },
    { recordEventId: review.id, sourceFile: f.relPath, attachment: '附件2', page: 2 },
  ]).run()
  db.insert(schema.ocrResult).values({ fileId: f.id, pageNo: 1, markdown: '原始 OCR 正文105', raw: { preserved: true }, channel: 'upload' }).run()
  const fileBefore = await call('get_file', { fileId: f.id })
  const ocrBefore = await call('get_ocr_result', { fileId: f.id })
  const detailUrl = `${service.baseUrl}/api/roster/enterprises/${enterprise.id}`
  const enterpriseBeforeResponse = await fetch(detailUrl)
  expect(enterpriseBeforeResponse.status).toBe(200)
  const enterpriseBefore = await enterpriseBeforeResponse.json()
  const before = await state(f.id)
  const replaced = await call('save_parse_result', { fileId: f.id, ...write(before.version, 'derived-replace', { parts: [part] }) })
  expect(replaced.state.parts).toEqual([
    { ...part, attachment: '附件1', origin: 'agent', hasConflict: true },
    { ...part, eventKind: 'review', year: 2021, attachment: '附件2', rowCount: 1, origin: 'derived', hasConflict: false },
  ])
  const patchedResponse = await http(f.id, 'PATCH', write(replaced.state.version, 'status-failed', { parseState: 'failed' }))
  expect(patchedResponse.status).toBe(200)
  const patched = await patchedResponse.json()
  expect(patched.state.parseState).toBe('failed')
  expect(patched.state.parts).toEqual(replaced.state.parts)
  const clearedResponse = await http(f.id, 'PUT', write(patched.state.version, 'clear-agent', { parts: [] }))
  expect(clearedResponse.status).toBe(200)
  const cleared = await clearedResponse.json()
  expect(cleared.state).toMatchObject({ parseState: 'parsed', parts: [
    { ...part, attachment: '附件1', rowCount: 1, origin: 'derived', hasConflict: false },
    { ...part, eventKind: 'review', year: 2021, attachment: '附件2', rowCount: 1, origin: 'derived', hasConflict: false },
  ] })
  expect(await call('list_file_parts', { fileId: f.id })).toMatchObject({ parts: cleared.state.parts })
  const { parts: _beforeParts, parseState: _beforeState, ...metadataBefore } = fileBefore
  const { parts: _afterParts, parseState: _afterState, ...metadataAfter } = await call('get_file', { fileId: f.id })
  expect(metadataAfter).toEqual(metadataBefore)
  expect(await call('get_ocr_result', { fileId: f.id })).toEqual(ocrBefore)
  expect(await (await fetch(detailUrl)).json()).toEqual(enterpriseBefore)
  const reverted = await call('save_parse_result', { fileId: f.id, ...write(cleared.state.version, 'unparsed-again', { parseState: 'unparsed' }) })
  expect(reverted.state.parts).toEqual(cleared.state.parts)
  expect(reverted.state.parseState).toBe('unparsed')
})

it('rejects duplicate normalized coordinates and illegal batches atomically through both public transports', async () => {
  const f = file()
  const before = await state(f.id)
  const invalid = [
    { parts: [part, { ...part, attachment: '附件1' }] },
    { parts: [part, { ...part, eventKind: 'other' }] },
    { parts: [part], sha256: 'forbidden' },
    { parts: [part, { ...part, attachment: 7 }] },
    { parts: [part, { ...part, year: 1899 }] },
    { parts: [part, { ...part, year: 2101 }] },
    { parts: [part, { ...part, batch: 0 }] },
    { parts: [part, { ...part, rowCount: -1 }] },
    { parts: [part, { ...part, origin: 'derived' }] },
    { parts: null }, { parts: {} }, { parseState: null }, { parseState: 'verified' }, {},
    { parts: [part], actor: { ...actor, extra: true } },
    { parts: [part], expectedVersion: undefined },
    { parts: [part], idempotencyKey: '' },
  ]
  for (let i = 0; i < invalid.length; i++) {
    const body = write(before.version, `invalid-${i}`, invalid[i]!)
    const response = await http(f.id, !('parts' in body) ? 'PATCH' : 'PUT', body)
    expect(response.status, `REST invalid case ${i}`).toBe(400)
    const mcp = await rpc('tools/call', { name: 'save_parse_result', arguments: { fileId: f.id, ...body } })
    expect(mcp.status === 400 || mcp.body.result?.isError === true, `MCP invalid case ${i}`).toBe(true)
    expect(await state(f.id)).toEqual(before)
  }
  expect((await http(f.id, 'PATCH', write(before.version, 'patch-with-parts', { parts: [], parseState: 'failed' }))).status).toBe(400)
  expect((await http(f.id, 'PUT', write(before.version, 'put-without-parts', { parseState: 'failed' }))).status).toBe(400)
  const history = await (await http(f.id, 'GET', undefined, '/history')).json()
  expect(history).toEqual({ fileId: f.id, rows: [], nextAfterId: null })
  const accepted = await call('save_parse_result', { fileId: f.id, ...write(before.version, 'valid-null-boundaries', { parts: [
    { titleCode: 'little_giant', eventKind: 'maintain', year: 1900, batch: null, attachment: null },
    { titleCode: 'innovative_sme', eventKind: 'nurture', year: 2100, batch: 1, rowCount: 0 },
    { titleCode: 'specialized_sme', eventKind: 'review' },
  ], parseState: 'failed' }) })
  expect(accepted.state).toMatchObject({ parseState: 'failed', parts: [
    { titleCode: 'little_giant', year: 1900, batch: null, attachment: null, rowCount: 0 },
    { titleCode: 'specialized_sme', year: null, batch: null, attachment: null, rowCount: 0 },
    { titleCode: 'innovative_sme', year: 2100, batch: 1, attachment: null, rowCount: 0 },
  ] })
})

it('rejects stale parallel edits and recovers the original idempotent receipt without overwriting later state', async () => {
  const f = file()
  const before = await state(f.id)
  const body = write(before.version, 'once', { parts: [part] })
  const savedResponse = await http(f.id, 'PUT', body)
  expect(savedResponse.status).toBe(200)
  const saved = await savedResponse.json()
  const race = await Promise.all([
    http(f.id, 'PATCH', write(saved.state.version, 'race-a', { parseState: 'failed' })),
    http(f.id, 'PATCH', write(saved.state.version, 'race-b', { parseState: 'unparsed' })),
  ])
  expect(race.map(r => r.status).sort()).toEqual([200, 409])
  const current = await state(f.id)
  const replay = await call('save_parse_result', { fileId: f.id, ...body, parts: [{ ...part, attachment: '附件1' }] })
  expect(replay).toEqual({ ...saved, replayed: true })
  expect(await state(f.id)).toEqual(current)
  expect((await http(f.id, 'PUT', { ...body, parts: [] })).status).toBe(409)
  const staleMcp = await rpc('tools/call', { name: 'save_parse_result', arguments: { fileId: f.id, ...write(before.version, 'stale-mcp', { parts: [] }) } })
  expect(staleMcp.body.result.isError).toBe(true)
  expect(JSON.stringify(staleMcp.body)).toContain('版本冲突')
  const history = await (await http(f.id, 'GET', undefined, '/history')).json()
  expect(history.rows).toHaveLength(2)
  const restoredResponse = await http(f.id, 'PUT', write(current.version, 'restore-identical-content', { parts: [part] }))
  expect(restoredResponse.status).toBe(200)
  expect((await restoredResponse.json()).state.version).not.toBe(saved.state.version)
  expect((await http(f.id, 'PATCH', write(saved.state.version, 'aba-stale', { parseState: 'failed' }))).status).toBe(409)
})

it('rolls back segment and status writes when audit persistence fails and permits a clean retry', async () => {
  const f = file()
  const initial = await state(f.id)
  const seeded = await call('save_parse_result', { fileId: f.id, ...write(initial.version, 'before-storage-fault', { parts: [part] }) })
  const before = seeded.state
  const historyBefore = await call('get_file_parse_history', { fileId: f.id })
  // Storage fault injection at the boundary; all behavioral verification remains HTTP/MCP.
  db.$client.exec(`CREATE TRIGGER fail_parse_105 BEFORE INSERT ON file_parse_audit_105 WHEN NEW.file_id = ${f.id} BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END`)
  const body = write(before.version, 'retry-after-fault', { parts: [{ ...part, year: 2023, rowCount: 9 }], parseState: 'failed' })
  try {
    expect((await http(f.id, 'PUT', body)).status).toBe(500)
    expect(await state(f.id)).toEqual(before)
    expect(await call('get_file_parse_history', { fileId: f.id })).toEqual(historyBefore)
  } finally { db.$client.exec('DROP TRIGGER fail_parse_105') }
  const retryResponse = await http(f.id, 'PUT', body)
  expect(retryResponse.status).toBe(200)
  const retry = await retryResponse.json()
  expect(retry).toMatchObject({ replayed: false, state: { parseState: 'failed', parts: [{ year: 2023, rowCount: 9 }] } })
  expect(await call('save_parse_result', { fileId: f.id, ...body })).toEqual({ ...retry, replayed: true })
})

it('pages audit summaries without snapshots and point-reads immutable receipts with REST MCP parity', async () => {
  const f = file()
  let current = await state(f.id)
  const snapshots = []
  const receipts = []
  for (let i = 0; i < 3; i++) {
    snapshots.push(current)
    const response = await http(f.id, 'PUT', write(current.version, `history-${i}`, { parts: [{ ...part, rowCount: i }] }))
    expect(response.status).toBe(200)
    const result = await response.json()
    receipts.push(result.receiptId)
    current = result.state
  }
  const firstResponse = await http(f.id, 'GET', undefined, '/history?limit=2')
  expect(firstResponse.status).toBe(200)
  const first = await firstResponse.json()
  expect(first.rows.map((r: any) => r.receiptId)).toEqual(receipts.slice(0, 2))
  expect(first.nextAfterId).toBe(receipts[1])
  expect(JSON.stringify(first)).not.toContain('parts')
  expect(JSON.stringify(first)).not.toContain('before')
  expect(JSON.stringify(first)).not.toContain('requestHash')
  expect(await call('get_file_parse_history', { fileId: f.id, limit: 2 })).toEqual(first)
  const last = await call('get_file_parse_history', { fileId: f.id, afterId: first.nextAfterId, limit: 2 })
  expect(last).toMatchObject({ rows: [{ receiptId: receipts[2] }], nextAfterId: null })
  const exactResponse = await http(f.id, 'GET', undefined, `/history?receiptId=${receipts[0]}`)
  expect(exactResponse.status).toBe(200)
  const exact = await exactResponse.json()
  expect(exact).toMatchObject({ id: receipts[0], fileId: f.id, operation: 'replace', actor, reason: '纠正解析声明', before: snapshots[0], after: { parseState: 'parsed', parts: [{ rowCount: 0 }] } })
  expect(exact.after).toEqual(snapshots[1])
  expect(await call('get_file_parse_history', { fileId: f.id, receiptId: receipts[0] })).toEqual(exact)
  const other = file()
  expect((await http(other.id, 'GET', undefined, `/history?receiptId=${receipts[0]}`)).status).toBe(404)
  for (const suffix of ['/history?limit=0', '/history?limit=51', '/history?afterId=-1', '/history?receiptId=1&limit=1', '/history?raw=true', '?raw=true']) {
    expect((await http(f.id, 'GET', undefined, suffix)).status).toBe(400)
  }
})

it('enforces authentication stable IDs and removed-file writes while exposing discoverable contracts', async () => {
  const f = file()
  const before = await state(f.id)
  expect((await http(f.id, 'PUT', write(before.version, 'no-auth', { parts: [] }), '', false)).status).toBe(401)
  expect((await rpc('tools/call', { name: 'save_parse_result', arguments: { fileId: f.id, ...write(before.version, 'mcp-no-auth', { parts: [] }) } }, false)).status).toBe(401)
  expect(await state(f.id)).toEqual(before)
  for (const id of ['1x', '0', '-1', '1e2']) expect((await http(id)).status).toBe(400)
  expect((await http(999999999)).status).toBe(404)
  expect((await http(999999999, 'PUT', write(before.version, 'missing-file', { parts: [] }))).status).toBe(404)
  const removedResponse = await fetch(`${service.baseUrl}/api/files/${f.id}`, { method: 'DELETE' })
  expect(removedResponse.status).toBe(200)
  const removed = await state(f.id)
  expect(removed.removedAt).toBeTruthy()
  expect((await http(f.id, 'PUT', write(removed.version, 'removed-file', { parts: [] }))).status).toBe(409)
  const legacyRef = await rpc('tools/call', { name: 'save_parse_result', arguments: { relPath: f.relPath, ...write(removed.version, 'path-unsupported', { parts: [] }) } })
  expect(legacyRef.body.result.isError).toBe(true)
  expect(JSON.stringify(legacyRef.body)).toContain('已移出')
  const tools = (await rpc('tools/list', {})).body.result.tools
  for (const name of ['get_file_parse_result', 'get_file_parse_history']) expect(tools.find((t: any) => t.name === name)).toMatchObject({ annotations: { readOnlyHint: true } })
  const saveTool = tools.find((t: any) => t.name === 'save_parse_result')
  expect(saveTool.inputSchema.required).toEqual(expect.arrayContaining(['expectedVersion','idempotencyKey','actor','reason']))
  const anonymous = (await rpc('tools/list', {}, false)).body.result.tools
  expect(anonymous.some((t: any) => t.name === 'save_parse_result')).toBe(false)
  const specResponse = await fetch(`${service.baseUrl}/_openapi.json`)
  expect(specResponse.status).toBe(200)
  const spec = await specResponse.json()
  expect(spec.paths['/api/files/{id}/parse-result']).toHaveProperty('get')
  expect(spec.paths['/api/files/{id}/parse-result']).toHaveProperty('put')
  expect(spec.paths['/api/files/{id}/parse-result']).toHaveProperty('patch')
  expect(spec.paths['/api/files/{id}/parse-result/history']).toHaveProperty('get')
  expect(JSON.stringify(spec)).not.toContain(token)
})

it('recovers a committed receipt after an application restart without requiring the old version to remain current', async () => {
  const f = file()
  const initial = await state(f.id)
  const body = write(initial.version, 'durable-receipt', { parts: [part] })
  const response = await http(f.id, 'PUT', body)
  expect(response.status).toBe(200)
  const original = await response.json()
  const later = await call('save_parse_result', { fileId: f.id, ...write(original.state.version, 'later-status', { parseState: 'failed' }) })
  await service.stop()
  await startService()
  const replayResponse = await http(f.id, 'PUT', body)
  expect(replayResponse.status).toBe(200)
  expect(await replayResponse.json()).toEqual({ ...original, replayed: true })
  expect(await state(f.id)).toEqual(later.state)
  expect(await call('get_file_parse_history', { fileId: f.id, receiptId: original.receiptId })).toMatchObject({ before: initial, after: original.state })
}, 90000)

it('preserves the existing MCP exact path reference while binding concurrency and receipts to the stable file ID', async () => {
  const f = file()
  const before = await state(f.id)
  const body = write(before.version, 'path-compatible', { parts: [part] })
  const saved = await call('save_parse_result', { relPath: f.relPath, ...body })
  expect(saved.state.fileId).toBe(f.id)
  expect(await call('save_parse_result', { fileId: f.id, ...body })).toEqual({ ...saved, replayed: true })
  const ambiguous = await rpc('tools/call', { name: 'save_parse_result', arguments: { fileId: f.id, relPath: f.relPath, ...body } })
  expect(ambiguous.status).toBe(400)
  const missing = await rpc('tools/call', { name: 'save_parse_result', arguments: { relPath: 'missing.pdf', ...body } })
  expect(missing.body.result.isError).toBe(true)
  expect(JSON.stringify(missing.body)).toContain('文件不存在')
})

it('invalidates an edit version when source-derived coordinates change and refreshes the visible conflict', async () => {
  const f = file()
  const e = db.insert(schema.enterprise).values({ name: '来源并发105', nameNorm: '来源并发105' }).returning().get()
  const r = db.insert(schema.record).values({ enterpriseId: e.id, source: 'jxj', titleCode: 'specialized_sme' }).returning().get()
  const ev = db.insert(schema.recordEvent).values({ recordId: r.id, eventType: 'award', year: 2024, batchSeq: 2 }).returning().get()
  const initial = await state(f.id)
  const saved = await call('save_parse_result', { fileId: f.id, ...write(initial.version, 'source-concurrency-first', { parts: [part] }) })
  // An independent pipeline changes source facts, without rebuilding the stored derived cache.
  db.insert(schema.recordEvidence).values({ recordEventId: ev.id, sourceFile: f.relPath, attachment: '附件1' }).run()
  expect((await http(f.id, 'PUT', write(saved.state.version, 'stale-source', { parts: [] }))).status).toBe(409)
  const refreshed = await state(f.id)
  expect(refreshed.version).not.toBe(saved.state.version)
  const response = await http(f.id, 'PUT', write(refreshed.version, 'fresh-source', { parts: [part] }))
  expect(response.status).toBe(200)
  expect((await response.json()).state.parts).toMatchObject([{ origin: 'agent', hasConflict: true, rowCount: 3 }])
})

it('keeps fixed-ID reads and history pages unchanged as unrelated evidence OCR and receipts grow', async () => {
  const f = file()
  const unrelated = file()
  let current = await state(f.id)
  for (let i = 0; i < 3; i++) {
    const response = await http(f.id, 'PUT', write(current.version, `scale-target-${i}`, { parts: [part] }))
    expect(response.status).toBe(200)
    current = (await response.json()).state
  }
  const page = await (await http(f.id, 'GET', undefined, '/history?limit=2')).json()
  const e = db.insert(schema.enterprise).values({ name: '无关样本105', nameNorm: '无关样本105' }).returning().get()
  const r = db.insert(schema.record).values({ enterpriseId: e.id, source: 'jxj', titleCode: 'specialized_sme' }).returning().get()
  const ev = db.insert(schema.recordEvent).values({ recordId: r.id, eventType: 'award', year: 2023 }).returning().get()
  const evidenceInsert = db.$client.prepare('INSERT INTO record_evidence (record_event_id,source_file) VALUES (?,?)')
  const auditInsert = db.$client.prepare('INSERT INTO file_parse_audit_105 (file_id,idempotency_key,request_hash,operation,actor,reason,before,after,created_at) VALUES (?,?,?,\'replace\',?,\'unrelated fixture\',?,?,?)')
  const ocrInsert = db.$client.prepare('INSERT INTO ocr_result (file_id,page_no,markdown,raw,engine,channel,created_at) VALUES (?,?,?,?,\'synthetic\',\'upload\',?)')
  const raw = JSON.stringify({ privateUnrelatedRaw: 'X'.repeat(8192) })
  const samples = []
  let count = 0
  for (const target of [1000, 5000]) {
    db.$client.transaction(() => {
      while (count < target) {
        evidenceInsert.run(ev.id, `unrelated-${count}.pdf`)
        if (count % 10 === 0) {
          auditInsert.run(unrelated.id, `unrelated-${count}`, 'unused-fixture-hash', JSON.stringify(actor), raw, raw, '2026-10-19T00:00:00Z')
          ocrInsert.run(unrelated.id, count + 1, 'UNRELATED_OCR', raw, '2026-10-19T00:00:00Z')
        }
        count++
      }
    })()
    const elapsed = []
    for (let n = 0; n < 5; n++) {
      const start = performance.now()
      expect(await state(f.id)).toEqual(current)
      const response = await http(f.id, 'GET', undefined, '/history?limit=2')
      expect(response.status).toBe(200)
      const text = await response.text()
      expect(JSON.parse(text)).toEqual(page)
      expect(Buffer.byteLength(text)).toBeLessThan(256 * 1024)
      expect(text).not.toContain('privateUnrelatedRaw')
      elapsed.push(Number((performance.now() - start).toFixed(3)))
    }
    samples.push({ unrelatedEvidence: target, unrelatedReceipts: target / 10, unrelatedOcrPages: target / 10, combinedReadMs: elapsed })
    expect(await call('get_file_parse_result', { fileId: f.id })).toEqual(current)
    expect(await call('get_file_parse_history', { fileId: f.id, limit: 2 })).toEqual(page)
  }
  const plans = {
    derived: db.$client.prepare('EXPLAIN QUERY PLAN SELECT r.title_code,e.event_type,e.year,e.batch_seq,v.attachment FROM record_evidence v JOIN record_event e ON e.id=v.record_event_id JOIN record r ON r.id=e.record_id WHERE v.source_file=?').all(f.relPath),
    receiptPage: db.$client.prepare('EXPLAIN QUERY PLAN SELECT id,operation FROM file_parse_audit_105 WHERE file_id=? AND id>? ORDER BY id LIMIT 3').all(f.id, 0),
  }
  appendFileSync('/tmp/ningbo-spec98/ticket-105/boundedness.jsonl', JSON.stringify({ samples, plans }) + '\n')
})

it('accepts the complete segment limit and rejects over-limit replacements without truncation', async () => {
  const f = file()
  const before = await state(f.id)
  const parts = Array.from({ length: 1000 }, (_, i) => ({ ...part, batch: i + 1 }))
  const response = await http(f.id, 'PUT', write(before.version, 'limit-exact', { parts }))
  expect(response.status).toBe(200)
  const saved = await response.json()
  expect(saved.state.parts).toHaveLength(1000)
  expect(saved.state.parts.some((p: any) => p.batch === 1)).toBe(true)
  expect(saved.state.parts.some((p: any) => p.batch === 1000)).toBe(true)
  const oversized = write(saved.state.version, 'limit-over', { parts: [...parts, { ...part, batch: 1001 }] })
  expect((await http(f.id, 'PUT', oversized)).status).toBe(400)
  expect((await rpc('tools/call', { name: 'save_parse_result', arguments: { fileId: f.id, ...oversized } })).status).toBe(400)
  expect(await state(f.id)).toEqual(saved.state)
  const exact = await call('get_file_parse_history', { fileId: f.id, receiptId: saved.receiptId })
  expect(exact.after.parts).toHaveLength(1000)
})

it('coalesces simultaneous same-key retries into one durable parse receipt', async () => {
  const f = file()
  const before = await state(f.id)
  const body = write(before.version, 'simultaneous-retry', { parts: [part] })
  const responses = await Promise.all([http(f.id, 'PUT', body), http(f.id, 'PUT', body)])
  expect(responses.map(r => r.status)).toEqual([200, 200])
  const results = await Promise.all(responses.map(r => r.json()))
  expect(results.map(r => r.replayed).sort()).toEqual([false, true])
  expect(results[0].receiptId).toBe(results[1].receiptId)
  expect(results[0].state).toEqual(results[1].state)
  const history = await call('get_file_parse_history', { fileId: f.id })
  expect(history.rows.map((r: any) => r.receiptId)).toEqual([results[0].receiptId])
})
