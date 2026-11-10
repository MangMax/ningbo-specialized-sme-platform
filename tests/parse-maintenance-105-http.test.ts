import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'

import { afterAll, beforeAll, expect, it } from 'vitest'
import { useDb, schema } from '../db/client'
import { spawnOwnedChild as spawn, reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../scripts/lib/isolated-local-services.mjs'

const dir = mkdtempSync('/tmp/issue310-http-')
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
  writeFileSync(join(dir, 'empty.env'), '')
  const child = spawn(process.execPath, [join(cwd, 'node_modules/nuxt/bin/nuxt.mjs'), 'dev', '--host', '127.0.0.1', '--port', String(port), '--dotenv', join(dir, 'empty.env')], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NUXT_LOG_DIR: join(dir, 'logs'), NUXT_DB_PATH: dbPath, NUXT_FILES_DIR: join(dir, 'files'), NUXT_INCOMING_DIR: join(dir, 'incoming'), NUXT_API_TOKEN: token, NUXT_MCP_TOKEN: token } })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-8000) })
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
  // Qualification scope carries a per-read execution asOf and its digest; the
  // stored facts around it must be unchanged.
  const stableDetail = (detail: any) => { const copy = structuredClone(detail); delete copy.qualificationAssessment?.asOf; delete copy.qualificationAssessment?.snapshotId; return copy }
  expect(stableDetail(await (await fetch(detailUrl)).json())).toEqual(stableDetail(enterpriseBefore))
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
    const legacyFailure = await rpc('tools/call', { name: 'save_parse_result', arguments: { relPath: f.relPath, parts: [{ ...part, year: 2023 }], parseState: 'failed' } })
    expect(legacyFailure.body.result.isError).toBe(true)
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
  for (const field of ['expectedVersion','idempotencyKey','actor','reason']) expect(saveTool.inputSchema.properties).toHaveProperty(field)
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
    for (let n = 0; n < 5; n++) {
      expect(await state(f.id)).toEqual(current)
      const response = await http(f.id, 'GET', undefined, '/history?limit=2')
      expect(response.status).toBe(200)
      const text = await response.text()
      expect(JSON.parse(text)).toEqual(page)
      expect(Buffer.byteLength(text)).toBeLessThan(256 * 1024)
      expect(text).not.toContain('privateUnrelatedRaw')
    }
    expect(await call('get_file_parse_result', { fileId: f.id })).toEqual(current)
    expect(await call('get_file_parse_history', { fileId: f.id, limit: 2 })).toEqual(page)
  }
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

it('accepts exact baseline MCP payloads and returns the exact legacy envelope for ID path empty and status-only writes', async () => {
  const f = file()
  const initial = await state(f.id)
  const normalized = { ...part, attachment: '附件1' }
  const expectedFile = { ...f, displayName: f.filename, referenceCount: 0, parseState: 'parsed', parts: [{ ...normalized, origin: 'agent', hasConflict: false }] }
  // Exact baseline payload: no new envelope fields, and no modern response keys.
  const first = await call('save_parse_result', { fileId: f.id, parts: [part] })
  expect(first).toEqual({ file: expectedFile, parts: [normalized], parseState: 'parsed' })
  const afterFirst = await state(f.id)
  expect(afterFirst.version).not.toBe(initial.version)
  const statusOnly = await call('save_parse_result', { relPath: f.relPath, parseState: 'failed' })
  // Baseline top-level parts was the normalized submitted collection, hence [] on status-only.
  expect(statusOnly).toEqual({ file: { ...expectedFile, parseState: 'failed' }, parts: [], parseState: 'failed' })
  expect((await state(f.id)).version).not.toBe(afterFirst.version)
  expect((await http(f.id, 'PATCH', write(afterFirst.version, 'stale-after-legacy', { parseState: 'unparsed' }))).status).toBe(409)
  const cleared = await call('save_parse_result', { relPath: f.relPath, parts: [] })
  expect(cleared).toEqual({ file: { ...expectedFile, parts: [] }, parts: [], parseState: 'parsed' })
  const sameState = await state(f.id)
  await call('save_parse_result', { fileId: f.id, parts: [], parseState: 'parsed' })
  expect((await state(f.id)).version).not.toBe(sameState.version)
  const history = await call('get_file_parse_history', { fileId: f.id })
  expect(history.rows).toHaveLength(4)
  for (const row of history.rows) {
    expect(row.actor).toEqual({ type: 'agent', id: 'legacy-adapter:save_parse_result' })
    expect(row.reason).toBe('兼容旧 save_parse_result 盲写；客户端未提供版本、幂等键、操作者或确认依据')
    expect(row.idempotencyKey).toMatch(/^legacy-save-parse:/)
  }
})

it('protects exact baseline MCP calls with auth and rejects partial modern envelopes without legacy downgrade', async () => {
  const f = file()
  const before = await state(f.id)
  const baseline = { relPath: f.relPath, parts: [part] }
  expect((await rpc('tools/call', { name: 'save_parse_result', arguments: baseline }, false)).status).toBe(401)
  const complete = write(before.version, 'complete-modern-envelope', { parts: [part] })
  const names = ['expectedVersion', 'idempotencyKey', 'actor', 'reason'] as const
  for (const name of names) {
    const one = { ...baseline, [name]: complete[name] }
    expect((await rpc('tools/call', { name: 'save_parse_result', arguments: one })).status, `only ${name}`).toBe(400)
    const missing: Record<string, unknown> = { fileId: f.id, ...complete }
    delete missing[name]
    expect((await rpc('tools/call', { name: 'save_parse_result', arguments: missing })).status, `missing ${name}`).toBe(400)
  }
  expect(await state(f.id)).toEqual(before)
  expect(await call('get_file_parse_history', { fileId: f.id })).toEqual({ fileId: f.id, rows: [], nextAfterId: null })
  const modern = await call('save_parse_result', { fileId: f.id, ...complete })
  expect(Object.keys(modern).sort()).toEqual(['receiptId', 'replayed', 'state'])
  expect(modern.state).toEqual(await state(f.id))
})

it('rejects legacy capacity overflow explicitly without truncation or adapter audit and retains duplicate atomicity', async () => {
  const f = file()
  const before = await state(f.id)
  const tooMany = { fileId: f.id, parts: Array.from({ length: 1001 }, (_, i) => ({ ...part, batch: i + 1 })) }
  const longAttachment = { relPath: f.relPath, parts: [{ ...part, attachment: 'X'.repeat(501) }] }
  for (const [input, maximum] of [[tooMany, '1000'], [longAttachment, '500']] as const) {
    const rejected = await rpc('tools/call', { name: 'save_parse_result', arguments: input })
    expect(rejected.status).toBe(400)
    expect(rejected.body.error.message).toContain(maximum)
  }
  const duplicate = await rpc('tools/call', { name: 'save_parse_result', arguments: { fileId: f.id, parts: [part, { ...part, attachment: '附件1' }] } })
  expect(duplicate.body.result.isError).toBe(true)
  expect(JSON.stringify(duplicate.body)).toContain('重复')
  expect(await state(f.id)).toEqual(before)
  expect(await call('get_file_parse_history', { fileId: f.id })).toEqual({ fileId: f.id, rows: [], nextAfterId: null })
})

// #310: real bytes and public OCR writes; these fixtures never use the checkout store.
function inputFile310() {
  serial++
  const relPath = `input-310-${serial}.pdf`
  const bytes = Buffer.from('synthetic parse source 310')
  writeFileSync(join(dir, 'files', relPath), bytes)
  return db.insert(schema.storedFile).values({ relPath, filename: relPath, ext: 'pdf', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }).returning().get()
}
async function ocr310(id: number, text: string) {
  const result = await call('save_ocr_result', { fileId: id, markdown: `<!-- page: 1 -->\n${text}` })
  expect(result.written).toBe(1)
  const read = await call('get_ocr_result', { fileId: id, includeVersion: true })
  expect(read.markdown).toContain(text)
  return read.results.map((p: any) => ({ page: p.page, version: p.version }))
}

it('310 freezes actual file and observed OCR inputs with HTTP MCP parity and preserves formal evidence on drift', async () => {
  const f = inputFile310()
  const pages = await ocr310(f.id, 'first OCR input')
  const e = db.insert(schema.enterprise).values({ name: '人工确认310', nameNorm: '人工确认310' }).returning().get()
  const r = db.insert(schema.record).values({ enterpriseId: e.id, source: 'jxj', titleCode: 'specialized_sme' }).returning().get()
  const ev = db.insert(schema.recordEvent).values({ recordId: r.id, eventType: 'award', year: 2024 }).returning().get()
  const evidence = db.insert(schema.recordEvidence).values({ recordEventId: ev.id, sourceFile: f.relPath, page: 7, attachment: '人工确认分节乙', listNo: 12 }).returning().get()
  const before = await state(f.id)
  const response = await http(f.id, 'POST', { kind: 'ocr', pages }, '/preflight')
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toContain('no-store')
  const plan = await response.json()
  expect(plan).toEqual({ expectedVersion: before.version, inputRef: { format: 1, fileId: f.id, relPath: f.relPath, sha256: f.sha256, kind: 'ocr', pages } })
  expect(await call('preflight_file_parse_result', { fileId: f.id, kind: 'ocr', pages })).toEqual(plan)
  const newerPages = await ocr310(f.id, 'second OCR input')
  expect(newerPages).not.toEqual(pages)
  expect((await state(f.id)).version).toBe(before.version)
  const body = { ...write(plan.expectedVersion, '310-stale-ocr', { parts: [part] }), inputRef: plan.inputRef }
  const rejected = await http(f.id, 'POST', body, '/commit')
  expect(rejected.status).toBe(409)
  expect(await rejected.text()).toContain('重新读取并预检')
  const mcp = await rpc('tools/call', { name: 'commit_file_parse_result', arguments: { fileId: f.id, ...body } })
  expect(mcp.body.result.isError).toBe(true)
  expect(JSON.stringify(mcp.body)).toContain('输入已变化')
  expect((await http(f.id, 'POST', { kind: 'ocr', pages }, '/preflight')).status).toBe(409)
  expect(await state(f.id)).toEqual(before)
  expect((await call('get_file_parse_history', { fileId: f.id })).rows).toEqual([])
  expect(db.select().from(schema.recordEvidence).all().find(row => row.id === evidence.id)).toEqual(evidence)
  expect(db.select().from(schema.recordEvent).all().find(row => row.id === ev.id)).toEqual(ev)
  const fresh = await call('preflight_file_parse_result', { fileId: f.id, kind: 'ocr', pages: newerPages })
  const freshBody = { ...write(fresh.expectedVersion, '310-fresh-ocr', { parts: [part] }), inputRef: fresh.inputRef }
  const accepted = await call('commit_file_parse_result', { fileId: f.id, ...freshBody })
  expect(accepted.state.inputLineage).toEqual({ status: 'bound', inputRef: fresh.inputRef })
  expect(await state(f.id)).toEqual(accepted.state)
  expect(db.select().from(schema.recordEvidence).all().find(row => row.id === evidence.id)).toEqual(evidence)
  expect(await call('get_file_parse_history', { fileId: f.id, receiptId: accepted.receiptId })).toMatchObject({ inputLineage: accepted.state.inputLineage, after: { inputLineage: accepted.state.inputLineage } })
  await ocr310(f.id, 'third OCR input after bound result')
  const audits = db.select().from(schema.fileParseAudit105).all().filter(row => row.fileId === f.id)
  const ocrRows = db.select().from(schema.ocrResult).all().filter(row => row.fileId === f.id)
  expect((await state(f.id)).version).toBe(accepted.state.version)
  for (const version of [plan.expectedVersion, accepted.state.version]) {
    const downgrade = write(version, `310-no-ref-${version}`, { parts: [] })
    const denied = await http(f.id, 'PUT', downgrade)
    expect(denied.status).toBe(409)
    expect(await denied.text()).toContain('重新读取')
    const modernMcp = await rpc('tools/call', { name: 'save_parse_result', arguments: { fileId: f.id, ...downgrade } })
    expect(modernMcp.body.result.isError).toBe(true)
  }
  const legacyMcp = await rpc('tools/call', { name: 'save_parse_result', arguments: { relPath: f.relPath, parts: [] } })
  expect(legacyMcp.body.result.isError).toBe(true)
  expect(JSON.stringify(legacyMcp.body)).toContain('预检')
  expect(await state(f.id)).toEqual(accepted.state)
  expect(db.select().from(schema.fileParseAudit105).all().filter(row => row.fileId === f.id)).toEqual(audits)
  expect(db.select().from(schema.ocrResult).all().filter(row => row.fileId === f.id)).toEqual(ocrRows)
  expect(db.select().from(schema.recordEvidence).all().find(row => row.id === evidence.id)).toEqual(evidence)
  const status = await http(f.id, 'PATCH', write(accepted.state.version, '310-bound-status', { parseState: 'failed' }))
  expect(status.status).toBe(200)
  const statusSaved = await status.json()
  expect(statusSaved.state.inputLineage).toEqual(accepted.state.inputLineage)
  expect(statusSaved.state.parts).toEqual(accepted.state.parts)
  expect(await call('commit_file_parse_result', { fileId: f.id, ...freshBody })).toEqual({ ...accepted, replayed: true })
  expect(await state(f.id)).toEqual(statusSaved.state)
})

it('310 keeps frozen receipts stable after disk drift and rolls back parse and audit on failure', async () => {
  const f = inputFile310()
  const plan = await call('preflight_file_parse_result', { fileId: f.id, kind: 'file' })
  const before = await state(f.id)
  const body = { ...write(plan.expectedVersion, '310-fault-retry', { parts: [part] }), inputRef: plan.inputRef }
  db.$client.exec(`CREATE TRIGGER fail_parse310_http BEFORE INSERT ON file_parse_audit_105 WHEN NEW.file_id = ${f.id} BEGIN SELECT RAISE(ABORT, 'synthetic parse310 fault'); END`)
  try {
    expect((await http(f.id, 'POST', body, '/commit')).status).toBe(500)
    expect(await state(f.id)).toEqual(before)
    expect((await call('get_file_parse_history', { fileId: f.id })).rows).toEqual([])
  } finally { db.$client.exec('DROP TRIGGER fail_parse310_http') }
  const accepted = await http(f.id, 'POST', body, '/commit')
  expect(accepted.status).toBe(200)
  const saved = await accepted.json()
  writeFileSync(join(dir, 'files', f.relPath), 'replacement bytes not in registry')
  const retry = await call('commit_file_parse_result', { fileId: f.id, ...body })
  expect(retry).toEqual({ ...saved, replayed: true })
  expect((await http(f.id, 'PUT', write(saved.state.version, '310-disk-legacy-put', { parts: [] }))).status).toBe(409)
  const legacy = await rpc('tools/call', { name: 'save_parse_result', arguments: { fileId: f.id, parts: [] } })
  expect(legacy.body.result.isError).toBe(true)
  expect(JSON.stringify(legacy.body)).toContain('预检')
  expect((await http(f.id, 'POST', { ...body, idempotencyKey: '310-new-key-disk-drift', expectedVersion: saved.state.version }, '/commit')).status).toBe(409)
  expect((await http(f.id, 'POST', { kind: 'file' }, '/preflight')).status).toBe(409)
  expect(await state(f.id)).toEqual(saved.state)
  expect((await call('get_file_parse_history', { fileId: f.id })).rows.map((r: any) => r.receiptId)).toEqual([saved.receiptId])
  const wrongInput = { ...body, inputRef: { ...body.inputRef, sha256: 'a'.repeat(64) } }
  expect((await http(f.id, 'POST', wrongInput, '/commit')).status).toBe(409)
})

it('310 exposes frozen contracts and cannot downgrade missing input while retaining explicit legacy unknown', async () => {
  const f = inputFile310()
  const before = await state(f.id)
  const body = write(before.version, '310-no-input', { parts: [part] })
  expect((await http(f.id, 'POST', body, '/commit')).status).toBe(400)
  const rejected = await rpc('tools/call', { name: 'commit_file_parse_result', arguments: { fileId: f.id, ...body } })
  expect(rejected.status).toBe(400)
  expect(await state(f.id)).toEqual(before)
  const plan = await call('preflight_file_parse_result', { fileId: f.id, kind: 'file' })
  const missingParts = { ...write(before.version, '310-no-parts', { parseState: 'parsed' }), inputRef: plan.inputRef }
  expect((await http(f.id, 'POST', missingParts, '/commit')).status).toBe(400)
  expect((await rpc('tools/call', { name: 'commit_file_parse_result', arguments: { fileId: f.id, ...missingParts } })).status).toBe(400)
  expect((await http(f.id, 'POST', { ...body, inputRef: plan.inputRef }, '/commit', false)).status).toBe(401)
  expect((await http(f.id, 'POST', { kind: 'file' }, '/preflight', false)).status).toBe(401)
  expect((await rpc('tools/call', { name: 'preflight_file_parse_result', arguments: { fileId: f.id, kind: 'file' } }, false)).status).toBe(401)
  expect((await rpc('tools/call', { name: 'commit_file_parse_result', arguments: { fileId: f.id, ...body, inputRef: plan.inputRef } }, false)).status).toBe(401)
  const tools = (await rpc('tools/list', {})).body.result.tools
  const commit = tools.find((t: any) => t.name === 'commit_file_parse_result')
  expect(commit.inputSchema.required).toEqual(expect.arrayContaining(['fileId','inputRef','parts','expectedVersion','idempotencyKey','actor','reason']))
  expect(tools.find((t: any) => t.name === 'preflight_file_parse_result').annotations.readOnlyHint).toBe(true)
  const anonymous = (await rpc('tools/list', {}, false)).body.result.tools
  expect(anonymous.some((t: any) => ['preflight_file_parse_result','commit_file_parse_result'].includes(t.name))).toBe(false)
  const spec = await (await fetch(`${service.baseUrl}/_openapi.json`)).json()
  expect(spec.paths['/api/files/{id}/parse-result/commit'].post.requestBody.content['application/json'].schema.required).toContain('inputRef')
  expect(spec.paths['/api/files/{id}/parse-result/preflight'].post).toBeTruthy()
  // Old clients still work and cannot be mistaken for a frozen-input receipt.
  const old = await call('save_parse_result', { fileId: f.id, ...body })
  expect(old.state.inputLineage).toEqual({ status: 'unknown' })
  const status = await call('save_parse_result', { fileId: f.id, ...write(old.state.version, '310-status-only', { parseState: 'failed' }) })
  expect(status.state.inputLineage).toEqual({ status: 'unknown' })
})

// A controlled four-page PDF; no source documents are copied into this fixture.
function rangeFile669(ext = 'pdf') {
  serial++
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R 6 0 R] /Count 4 >>', ...Array.from({ length: 4 }, () => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>')]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 7\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  const relPath = `range-669-${serial}.${ext}`
  writeFileSync(join(dir, 'files', relPath), pdf)
  return db.insert(schema.storedFile).values({ relPath, filename: relPath, ext, bytes: Buffer.byteLength(pdf), sha256: createHash('sha256').update(pdf).digest('hex') }).returning().get()
}
async function rangePlan669(id: number) {
  const response = await http(id, 'POST', { kind: 'file', verifyPhysicalPages: true }, '/preflight')
  expect(response.status).toBe(200)
  return response.json()
}
it('669 persists normalized physical ranges with stable declaration identity and immutable replay', async () => {
  const f = rangeFile669()
  const plan = await rangePlan669(f.id)
  const body = { ...write(plan.expectedVersion, '669-create', { parts: [{ ...part, pageRanges: [{ start: 4, end: 4 }, { start: 1, end: 2 }, { start: 2, end: 2 }] }], parseState: 'unparsed' }), inputRef: plan.inputRef }
  const response = await http(f.id, 'POST', body, '/commit')
  expect(response.status).toBe(200)
  const saved = await response.json()
  expect(saved.state.parseState).toBe('unparsed')
  expect(saved.state.declarations).toEqual([expect.objectContaining({ declarationId: expect.any(String), revision: 1, sha256: f.sha256, pageRanges: [{ start: 1, end: 2 }, { start: 4, end: 4 }] })])
  expect(await state(f.id)).toEqual(saved.state)
  expect(await call('commit_file_parse_result', { fileId: f.id, ...body })).toEqual({ ...saved, replayed: true })
  expect((await call('get_file_parse_history', { fileId: f.id, receiptId: saved.receiptId })).after).toEqual(saved.state)
})

it('669 preserves omitted ranges across coordinate edits clears explicitly and invalidates ABA and withdrawal plans', async () => {
  const f = rangeFile669()
  async function commit(key: string, parts: object[], plan?: any) {
    plan ??= await rangePlan669(f.id)
    const response = await http(f.id, 'POST', { ...write(plan.expectedVersion, key, { parts, parseState: 'failed' }), inputRef: plan.inputRef }, '/commit')
    expect(response.status, await response.clone().text()).toBe(200)
    return response.json()
  }
  const first = await commit('669-identity-a', [{ ...part, pageRanges: [{ start: 1, end: 2 }] }])
  const declarationId = first.state.declarations[0].declarationId
  const frozen = await rangePlan669(f.id)
  const changed = await commit('669-identity-b', [{ ...part, year: 2025, declarationId }])
  expect(changed.state.declarations[0]).toMatchObject({ declarationId, revision: 2, pageRanges: [{ start: 1, end: 2 }], contentVersion: frozen.inputRef.physicalSource.contentVersion })
  const restored = await commit('669-identity-a2', [{ ...part, declarationId }])
  expect(restored.state.version).not.toBe(first.state.version)
  expect((await http(f.id, 'POST', { ...write(frozen.expectedVersion, '669-stale-aba', { parts: [] }), inputRef: frozen.inputRef }, '/commit')).status).toBe(409)
  const clear = await commit('669-clear', [{ ...part, declarationId, pageRanges: [] }])
  expect(clear.state.declarations[0].pageRanges).toEqual([])
  expect(clear.state.parseState).toBe('failed')
  const withdrawn = await commit('669-withdraw', [])
  expect(withdrawn.state.declarations).toEqual([])
  const plan = await rangePlan669(f.id)
  expect((await http(f.id, 'POST', { ...write(plan.expectedVersion, '669-resurrect', { parts: [{ ...part, declarationId }] }), inputRef: plan.inputRef }, '/commit')).status).toBe(409)
  expect((await call('get_file_parse_history', { fileId: f.id, receiptId: first.receiptId })).after).toEqual(first.state)
})

it('669 rejects invalid unverified cross-file and removed ranges atomically without inventing OCR lineage', async () => {
  const f = rangeFile669()
  const plan = await rangePlan669(f.id)
  expect(plan.inputRef).toMatchObject({ kind: 'file', pages: [], physicalSource: { pageCount: 4 } })
  const before = await state(f.id)
  for (const [i, pageRanges] of [[{ start: 0, end: 1 }], [{ start: 2, end: 1 }], [{ start: 1, end: 5 }], [{ start: 1.5, end: 2 }]].entries()) {
    const response = await http(f.id, 'POST', { ...write(plan.expectedVersion, `669-invalid-${i}`, { parts: [part, { ...part, year: 2025, pageRanges }] }), inputRef: plan.inputRef }, '/commit')
    expect(response.status).toBe(400)
    expect(await state(f.id)).toEqual(before)
  }
  const unverified = await (await http(f.id, 'POST', { kind: 'file' }, '/preflight')).json()
  expect((await http(f.id, 'POST', { ...write(unverified.expectedVersion, '669-no-count', { parts: [{ ...part, pageRanges: [{ start: 1, end: 1 }] }] }), inputRef: unverified.inputRef }, '/commit')).status).toBe(409)
  const body = { ...write(plan.expectedVersion, '669-source', { parts: [{ ...part, pageRanges: [{ start: 1, end: 1 }] }] }), inputRef: plan.inputRef }
  const saved = await (await http(f.id, 'POST', body, '/commit')).json()
  const other = rangeFile669()
  const otherPlan = await rangePlan669(other.id)
  const cross = { ...write(otherPlan.expectedVersion, '669-cross-file', { parts: [{ ...part, declarationId: saved.state.declarations[0].declarationId }] }), inputRef: otherPlan.inputRef }
  expect((await http(other.id, 'POST', cross, '/commit')).status).toBe(409)
  const office = rangeFile669('docx')
  const officeResponse = await http(office.id, 'POST', { kind: 'file', verifyPhysicalPages: true }, '/preflight')
  expect(officeResponse.status).toBe(409)
  expect(await officeResponse.text()).toContain('不支持页码定位')
  db.$client.prepare('UPDATE stored_file SET removed_at = ? WHERE id = ?').run('2026-11-09', other.id)
  expect((await http(other.id, 'POST', cross, '/commit')).status).toBe(409)
  expect((await call('get_file_parse_history', { fileId: other.id })).rows).toEqual([])
})

it('669 rejects physical content ABA and preserves frozen receipts after source replacement', async () => {
  const f = rangeFile669()
  const plan = await rangePlan669(f.id)
  const body = { ...write(plan.expectedVersion, '669-before-disk-aba', { parts: [{ ...part, pageRanges: [{ start: 1, end: 2 }] }] }), inputRef: plan.inputRef }
  const saved = await (await http(f.id, 'POST', body, '/commit')).json()
  const pending = await rangePlan669(f.id)
  const { readFileSync } = await import('node:fs')
  const path = join(dir, 'files', f.relPath)
  const original = readFileSync(path)
  writeFileSync(path, 'different content')
  expect((await http(f.id, 'POST', { ...body, expectedVersion: pending.expectedVersion, idempotencyKey: '669-disk-change' }, '/commit')).status).toBe(409)
  writeFileSync(path, original)
  expect((await http(f.id, 'POST', { ...body, expectedVersion: pending.expectedVersion, idempotencyKey: '669-disk-aba' }, '/commit')).status).toBe(409)
  expect(await call('commit_file_parse_result', { fileId: f.id, ...body })).toEqual({ ...saved, replayed: true })
  expect(await state(f.id)).toEqual(saved.state)
})

it('669 verifies supplied counts edits ranges and keeps omission compatibility without false source rebinding', async () => {
  const f = rangeFile669()
  const plan = await rangePlan669(f.id)
  const fields = { parts: [{ ...part, pageRanges: [{ start: 1, end: 2 }] }], parseState: 'unparsed' }
  const forged = { ...write(plan.expectedVersion, '669-forged-count', fields), inputRef: { ...plan.inputRef, physicalSource: { ...plan.inputRef.physicalSource, pageCount: 999 } } }
  expect((await http(f.id, 'POST', forged, '/commit')).status).toBe(409)
  const created = await http(f.id, 'POST', { ...write(plan.expectedVersion, '669-edit-create', fields), inputRef: plan.inputRef }, '/commit')
  expect(created.status).toBe(200)
  const first = await created.json()
  const declarationId = first.state.declarations[0].declarationId
  const current = await rangePlan669(f.id)
  const edited = await http(f.id, 'POST', { ...write(current.expectedVersion, '669-edit-range', { parts: [{ ...part, declarationId, pageRanges: [{ start: 3, end: 4 }] }], parseState: 'unparsed' }), inputRef: current.inputRef }, '/commit')
  expect(edited.status).toBe(200)
  const second = await edited.json()
  expect(second.state.declarations[0]).toMatchObject({ declarationId, revision: 2, pageRanges: [{ start: 3, end: 4 }] })
  // Old-shaped modern call omits both new fields, using existing PUT input protection.
  const ordinaryPlan = await (await http(f.id, 'POST', { kind: 'file' }, '/preflight')).json()
  const omitted = await http(f.id, 'PUT', { ...write(ordinaryPlan.expectedVersion, '669-old-fields', { parts: [part], parseState: 'unparsed' }), inputRef: ordinaryPlan.inputRef })
  expect(omitted.status).toBe(200)
  const third = await omitted.json()
  expect(third.state.declarations[0]).toMatchObject({ declarationId, revision: 3, pageRanges: [{ start: 3, end: 4 }], contentVersion: first.state.declarations[0].contentVersion })
  const history = await call('get_file_parse_history', { fileId: f.id })
  expect(history.rows).toHaveLength(3)
  const spec = await (await fetch(`${service.baseUrl}/_openapi.json`)).json()
  expect(spec.paths['/api/files/{id}/parse-result'].put.requestBody.content['application/json'].schema.properties.parts.items.properties.pageRanges).toBeTruthy()
  const tools = (await rpc('tools/list', {})).body.result.tools
  expect(tools.find((t: any) => t.name === 'commit_file_parse_result').inputSchema.properties.parts.items.properties.pageRanges).toBeTruthy()
})

it('#681 list and expanded registered summaries agree without deriving declarations from 489 events', async () => {
  const f = file()
  // Explicit source facts fixture: an empty registration must stay empty.
  const e = db.insert(schema.enterprise).values({ name: 'controlled681', nameNorm: 'controlled681' }).returning().get()
  const r = db.insert(schema.record).values({ enterpriseId: e.id, source: 'jxj', titleCode: 'specialized_sme' }).returning().get()
  for (let i = 0; i < 489; i++) {
    const event = db.insert(schema.recordEvent).values({ recordId: r.id, eventType: 'award', year: i < 484 ? 2023 : null, batchSeq: i < 484 ? 1 : null }).returning().get()
    db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: f.relPath }).run()
  }
  const facts = () => [db.select().from(schema.storedFile).all(), db.select().from(schema.storedFilePart).all(), db.select().from(schema.fileDeclaration669).all(), db.select().from(schema.recordEvent).all(), db.select().from(schema.recordEvidence).all()]
  const before = facts()
  const expanded = await state(f.id)
  expect(expanded.declarations).toEqual([])
  expect(expanded.registeredSummary).toEqual({ count: 0, declarations: [] })
  const response = await fetch(`${service.baseUrl}/api/files?q=${f.filename}`, { headers: { authorization: `Bearer ${token}` } })
  expect(response.status).toBe(200)
  const list = await response.json()
  expect(list.rows.find((row: {id: number}) => row.id === f.id)).toMatchObject({ referenceCount: 489, registeredSummary: expanded.registeredSummary })
  expect(facts()).toEqual(before)
  const tools = (await rpc('tools/list', {})).body.result.tools
  expect(tools.find((t: {name: string}) => t.name === 'get_file_parse_result').description).toContain('displaySequence')
  const spec = await (await fetch(`${service.baseUrl}/_openapi.json`)).json()
  expect(spec.paths['/api/files/{id}/parse-result'].get.description).toContain('registeredSummary')
})
