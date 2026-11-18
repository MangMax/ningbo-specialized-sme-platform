import { readDevelopmentDiscovery } from '../../roster/current-export/fixtures/specialized-export'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { initializeDb, schema } from '../../../db/client'
import { spawnCompiledApp, reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../../support/owned-process.mjs'
import { minimalPdf } from '../../support/minimal-pdf'

const dir = mkdtempSync(join(tmpdir(), 'file-maintenance-104-'))
const root = join(dir, 'files')
const dbPath = join(dir, 'synthetic.db')
const db = initializeDb({ create: true, dbPath })
let service: { baseUrl: string; stop(): Promise<void> }
let serverOutput = ''
let seq = 0
async function rest(path: string, method = 'GET', body?: unknown, token: string | false = 'synthetic-api-token') {
  const res = await fetch(`${service.baseUrl}/api/files/${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const raw = await res.text()
  return { status: res.status, body: (() => { try { return JSON.parse(raw) } catch { return raw } })() as any }
}
async function rpc(name: string, args: unknown, token: string | false = 'synthetic-mcp-token', method = 'tools/call') {
  const res = await fetch(`${service.baseUrl}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params: method === 'tools/call' ? { name, arguments: args } : {} }) })
  const raw = await res.text()
  const body = JSON.parse(raw.startsWith('event:') ? raw.split('\n').find(line => line.startsWith('data: '))!.slice(6) : raw)
  return { status: res.status, body, value: body.result?.content?.[0]?.text ? (() => { try { return JSON.parse(body.result.content[0].text) } catch { return body.result.content[0].text } })() : body.result }
}
const fileIds = new Map<string, number>()
async function modernControls(id: number) {
  const state = await rest(`${id}/maintenance`)
  return { expectedRevision: state.body.revision ?? 0, idempotencyKey: `fixture-command-${++seq}`, actor: 'fixture-agent', basis: 'Synthetic public-seam fixture command' }
}
async function modernRest(path: string, method: string, body: Record<string, unknown> = {}, token: string | false = 'synthetic-api-token') {
  const id = Number(path.split('/')[0])
  return rest(path, method, { ...await modernControls(id), ...body }, token)
}
async function writeRpc(name: string, args: Record<string, unknown>, token: string | false = 'synthetic-mcp-token') {
  const id = Number(args.fileId ?? fileIds.get(String(args.relPath)))
  return rpc(name, { ...await modernControls(id), ...args }, token)
}
async function file() {
  const relPath = `jxj/announcement/2024/1/notice-${++seq}.txt`
  mkdirSync(join(root, 'jxj/announcement/2024/1'), { recursive: true })
  writeFileSync(join(root, relPath), 'original synthetic file bytes')
  const result = await rest('register', 'POST', { relPath, source: 'jxj', kind: 'announcement', year: 2024, batch: 1 })
  expect([200, 201]).toContain(result.status)
  fileIds.set(relPath, result.body.id)
  return result.body
}
let discovery: any
beforeAll(async () => {
  discovery = await readDevelopmentDiscovery()
  const cwd = resolve(import.meta.dirname, '../../..')
  const port = await reserveLoopbackPort()
  const child = spawnCompiledApp(port, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NUXT_BUILD_DIR: join(dir, 'nuxt-build'), NUXT_DB_PATH: dbPath, NUXT_API_TOKEN: 'synthetic-api-token', NUXT_MCP_TOKEN: 'synthetic-mcp-token', NUXT_FILES_DIR: root, NUXT_INCOMING_DIR: join(dir, 'incoming') } })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { serverOutput = (serverOutput + data).slice(-12000) })
  service = { baseUrl: `http://127.0.0.1:${port}`, stop: () => stopOwnedChild(child) }
  try { await waitForHttp(`${service.baseUrl}/api/health`, { timeoutMs: 60000, child }) } catch (error) { await service.stop(); throw new Error(`${String(error)}\n${serverOutput}`) }
}, 90000)
afterAll(async () => { if (service) await service.stop(); rmSync(dir, { recursive: true, force: true }) })

describe("file maintenance public transports", () => {
  it('keeps registration, classification, parsing, preview and soft removal on one uploaded file ID', async () => {
    const filename = 'classification-lifecycle.pdf'
    const pdf = minimalPdf({ pages: 2 })
    const meta = { filename, source: 'jxj', kind: 'announcement' }
    const metadata = Object.entries(meta).map(([key, value]) => `${key} ${Buffer.from(value).toString('base64')}`).join(',')
    const uploadHeaders = { 'Tus-Resumable': '1.0.0' }
    const created = await fetch(service.baseUrl + '/api/uploads', {
      method: 'POST',
      headers: { ...uploadHeaders, 'Upload-Length': String(pdf.length), 'Upload-Metadata': metadata },
    })
    expect(created.status).toBe(201)
    const landed = await fetch(new URL(created.headers.get('location')!, service.baseUrl), {
      method: 'PATCH',
      headers: { ...uploadHeaders, 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream' },
      body: Uint8Array.from(pdf),
    })
    expect(landed.status).toBe(204)
    const relPath = decodeURIComponent(landed.headers.get('x-upload-path')!)
    expect(relPath).toBe(`jxj/announcement/${filename}`)

    const registration = await rest('register', 'POST', { relPath, source: 'jxj', kind: 'announcement' })
    expect(registration.status).toBe(201)
    const { id } = registration.body
    expect(registration.body).toMatchObject({ relPath, categoryState: 'unset', year: null, parseState: 'unparsed' })
    const classified = await rest(String(id), 'PATCH', { year: 2024, batch: 1, titleCode: 'specialized_sme' })
    expect(classified).toMatchObject({ status: 200, body: { id, categoryState: 'set', year: 2024, batch: 1 } })
    const changed = await rpc('set_file_category', { fileId: id, year: 2025, batch: 2 })
    expect(changed.value.file).toMatchObject({ id, relPath, year: 2025, batch: 2, titleCode: 'specialized_sme' })

    const parse = await rest(`${id}/parse-result`, 'GET')
    const saved = await rest(`${id}/parse-result`, 'PUT', {
      expectedVersion: parse.body.version, idempotencyKey: 'uploaded-classification-parse',
      actor: { type: 'agent', id: 'fixture' }, reason: 'Synthetic announcement',
      parts: [{ titleCode: 'specialized_sme', eventKind: 'award', year: 2025, batch: 2, rowCount: 3 }],
    })
    expect(saved).toMatchObject({ status: 200, body: { state: { fileId: id, parseState: 'parsed', parts: [{ year: 2025, rowCount: 3 }] } } })
    const filtered = await fetch(service.baseUrl + `/api/files?source=jxj&categoryState=set&parseState=parsed&q=${filename}`)
    expect(await filtered.json()).toMatchObject({ total: 1, rows: [{ id, year: 2025, parseState: 'parsed' }] })

    const removed = await rest(String(id), 'DELETE')
    expect(removed).toMatchObject({ status: 200, body: { removed: true, diskDeleted: false } })
    const listing = await fetch(service.baseUrl + `/api/files?q=${filename}`)
    expect(await listing.json()).toEqual({ total: 0, rows: [] })
    const after = await rest(`${id}/parse-result`)
    expect(after.body).toMatchObject({ fileId: id, removedAt: expect.any(String), parseState: 'parsed' })
    const preview = await fetch(service.baseUrl + `/api/files/${id}`)
    expect(preview.status).toBe(200)
    expect(Buffer.from(await preview.arrayBuffer())).toEqual(Buffer.from(pdf))
  })

  it('accepts exact baseline REST and MCP payloads and invalidates modern revisions after legacy writes', async () => {
    const f = await file()
    expect((await rest(`${f.id}`, 'PATCH', { year: 2025 }, false)).status).toBe(200)
    expect((await rest(`${f.id}`, 'PATCH', { displayName: 'baseline display.txt' }, false)).status).toBe(200)
    expect((await rest(`${f.id}`, 'PATCH', {}, false)).status).toBe(200)
    const before = (await rest(`${f.id}/maintenance`)).body
    const legacy = await rpc('set_file_category', { fileId: f.id, year: 2026 })
    expect(legacy.value.file.year).toBe(2026)
    expect(Object.keys(legacy.value)).toEqual(['file'])
    expect(Object.keys(legacy.value.file)).not.toContain('revision')
    const after = (await rest(`${f.id}/maintenance`)).body
    expect(after.revision).toBe(before.revision + 1)
    expect(after.rows.at(-1)).toMatchObject({ mode: 'legacy', actor: null, basis: null })
    const registered = await rest('register', 'POST', { relPath: f.relPath, source: 'jxj', kind: 'announcement', year: '2024', batch: '1' }, false)
    expect(registered.status).toBe(200)
    expect(registered.body.id).toBe(f.id)
    expect((await rest(`${f.id}/maintenance`)).body.revision).toBe(after.revision + 1)
    const stale = await rest(`${f.id}`, 'PATCH', { year: 2027, expectedRevision: before.revision, idempotencyKey: `modern-stale-${f.id}`, actor: 'fixture-agent', basis: 'Synthetic test reviewed year' })
    expect(stale.status).toBe(409)
    const removed = await rest(`${f.id}`, 'DELETE', undefined, false)
    expect(removed.status).toBe(200)
    expect(Object.keys(removed.body).sort()).toEqual(['diskDeleted', 'referenceCount', 'removed'])
  })
  it('publishes the shared maintenance controls, restore operation and bounded history in OpenAPI', async () => {
    const spec = discovery
    const patch = spec.paths['/api/files/{id}'].patch.requestBody.content['application/json'].schema
    for (const variant of patch.oneOf) expect(variant.properties).toHaveProperty('expectedRevision')
    const restore = spec.paths['/api/files/{id}/restore'].post
    expect(restore.requestBody.content['application/json'].schema.additionalProperties).toBe(false)
    expect(restore.responses).toHaveProperty('409')
    expect(spec.paths['/api/files/{id}/maintenance'].get.parameters.find((p: any) => p.name === 'pageSize').schema.maximum).toBe(100)
  })
  it('rejects partial modern envelopes without downgrading to legacy blind writes', async () => {
    const f = await file()
    for (const part of [{ expectedRevision: 0 }, { idempotencyKey: 'partial' }, { actor: 'fixture' }, { basis: 'fixture' }]) {
      expect((await rest(`${f.id}`, 'PATCH', { year: 2025, ...part })).status).toBe(400)
      expect((await rest(`${f.id}`, 'DELETE', part)).status).toBe(400)
      expect((await rest(`${f.id}/restore`, 'POST', part)).status).toBe(400)
      expect((await rpc('update_file', { fileId: f.id, patch: { year: 2025 }, ...part })).body.result.isError).toBe(true)
      expect((await rpc('set_file_category', { fileId: f.id, year: 2025, ...part })).body.result.isError).toBe(true)
    }
    expect((await rest(`${f.id}/maintenance`)).body).toMatchObject({ revision: 0, total: 0 })
  })
  it('requires versioned quarantine, records soft removal and keeps normal restoration unavailable until explicit recovery', async () => {
    const f = await file()
    expect((await modernRest(`${f.id}?deleteDisk=1`, 'DELETE', {}, false)).status).toBe(401)
    expect(existsSync(join(root, f.relPath))).toBe(true)
    expect((await rest(`${f.id}?deleteDisk=1`, 'DELETE', {})).status).toBe(400)
    const result = await modernRest(`${f.id}?deleteDisk=1`, 'DELETE', {})
    expect(result.body).toMatchObject({ removed: true, diskDeleted: false, diskQuarantined: true, referenceCount: 0 })
    expect(existsSync(join(root, f.relPath))).toBe(false)
    expect((await rest(`${f.id}/maintenance`)).body).toMatchObject({ total: 1, revision: 1, rows: [{ action: 'remove' }] })
    expect((await modernRest(`${f.id}/restore`, 'POST', {})).status).toBe(409)
  })
  it('bounds history pages and preserves exact read size when unrelated audit and OCR data grow', async () => {
    const f = await file()
    for (let n = 0; n < 5; n++) expect((await rest(`${f.id}`, 'PATCH', { batch: n + 2 })).status).toBe(200)
    const before = await rest(`${f.id}/maintenance?pageSize=2`)
    const unrelated = await file()
    db.transaction(tx => {
      for (let n = 1; n <= 500; n++) tx.insert(schema.fileMaintenanceAudit).values({ fileId: unrelated.id, revision: n, action: 'update', mode: 'versioned', requestHash: 'synthetic', actor: 'noise-fixture', basis: 'N'.repeat(2000), before: {}, after: {} }).run()
      tx.insert(schema.ocrResult).values({ fileId: unrelated.id, pageNo: 1, markdown: 'unrelated raw OCR '.repeat(32768), channel: 'upload' }).run()
    })
    for (let n = 0; n < 10; n++) {
      const after = await rest(`${f.id}/maintenance?pageSize=2`)
      expect(after).toEqual(before)
      expect(Buffer.byteLength(JSON.stringify(after.body))).toBeLessThan(16000)
    }
    expect(before.body.rows).toHaveLength(2)
    expect((await rest(`${f.id}/maintenance?pageSize=2&page=3`)).body.rows.map((r: any) => r.revision)).toEqual([5])
    expect((await rest(`${f.id}/maintenance?pageSize=2&page=4`)).body.rows).toEqual([])
    for (const query of ['pageSize=101', 'page=0', 'page=1.5', 'pageSize=0', 'pageSize=x']) expect((await rest(`${f.id}/maintenance?${query}`)).status).toBe(400)
    const mcp = await rpc('get_file_maintenance', { fileId: f.id, pageSize: 2 })
    expect(mcp.value).toEqual(before.body)
  })
  it('rejects missing, modified, directory and symlink restore targets without changing removed state or audit', async () => {
    for (const kind of ['missing', 'modified', 'directory', 'symlink'] as const) {
      const f = await file()
      expect((await writeRpc('remove_file', { fileId: f.id })).value.removed).toBe(true)
      const before = (await rest(`${f.id}/maintenance`)).body
      const abs = join(root, f.relPath)
      if (kind === 'modified') writeFileSync(abs, 'different synthetic bytes!!!')
      else {
        rmSync(abs)
        if (kind === 'directory') mkdirSync(abs)
        if (kind === 'symlink') { const target = join(dir, `external-${f.id}.txt`); writeFileSync(target, 'original synthetic file bytes'); symlinkSync(target, abs) }
      }
      expect((await modernRest(`${f.id}/restore`, 'POST', { expectedRevision: 1 })).status).toBe(409)
      const mcp = await writeRpc('restore_file', { fileId: f.id, expectedRevision: 1 })
      expect(mcp.body.result.isError).toBe(true)
      expect((await rest(`${f.id}/maintenance`)).body).toEqual(before)
    }
  })
  it('rejects protected fields and invalid targets and rolls back display audit if maintenance audit fails', async () => {
    const f = await file()
    const before = (await rest(`${f.id}/maintenance`)).body
    for (const patch of [{ relPath: 'other' }, { sha256: 'x' }, { parseState: 'parsed' }, { bytes: 1 }, { displayName: 'x', year: 2025 }, { displayName: '' }, { year: ['2025'] }, { batch: true }]) {
      expect((await rest(`${f.id}`, 'PATCH', patch)).status).toBe(400)
      expect((await writeRpc('update_file', { fileId: f.id, patch })).body.result.isError).toBe(true)
    }
    expect((await rest('99999999', 'PATCH', { year: 2025 })).status).toBe(404)
    expect((await rest('not-an-id/restore', 'POST', {})).status).toBe(400)
    expect((await modernRest(`${f.id}/restore`, 'POST', { deleteDisk: true })).status).toBe(400)
    expect((await writeRpc('update_file', { fileId: f.id, relPath: f.relPath, patch: { year: 2025 } })).body.result.isError).toBe(true)
    db.$client.exec(`CREATE TRIGGER reject_file_maintenance_${f.id} BEFORE INSERT ON file_maintenance_audit WHEN NEW.file_id = ${f.id} BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END`)
    expect((await rest(`${f.id}`, 'PATCH', { displayName: 'must roll back' })).status).toBe(500)
    expect((await rest(`${f.id}/maintenance`)).body).toEqual(before)
    db.$client.exec(`DROP TRIGGER reject_file_maintenance_${f.id}`)
    expect((await rest(`${f.id}`, 'PATCH', { displayName: 'committed name' })).status).toBe(200)
    expect((await rest(`${f.id}/maintenance`)).body).toMatchObject({ revision: 1, total: 1, file: { displayName: 'committed name' } })
  })
  it('protects referenced disk bytes and preserves formal evidence, OCR and file parts across the lifecycle', async () => {
    const f = await file()
    const enterprise = db.insert(schema.enterprise).values({ name: `引用企业${f.id}`, nameNorm: `引用企业${f.id}` }).returning().get()
    const record = db.insert(schema.record).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', source: 'jxj' }).returning().get()
    const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2024 }).returning().get()
    db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: f.relPath, attachment: '附件1', listNo: 1, page: 1 }).run()
    db.insert(schema.ocrResult).values({ fileId: f.id, pageNo: 1, markdown: 'preserved original OCR', channel: 'upload' }).run()
    db.insert(schema.storedFilePart).values({ fileId: f.id, titleCode: 'specialized_sme', eventKind: 'award', year: 2024, batch: 1, attachment: '附件1', rowCount: 1, origin: 'agent' }).run()
    const publicJson = async (path: string) => (await fetch(`${service.baseUrl}${path}`)).json()
    const detailBefore = await publicJson(`/api/enterprises/${enterprise.id}`)
    const ocrBefore = await publicJson(`/api/ocr-results?fileId=${f.id}&markdown=1`)
    const before = (await rest(`${f.id}/maintenance`)).body.file
    expect((await modernRest(`${f.id}?deleteDisk=1`, 'DELETE')).status).toBe(409)
    expect(existsSync(join(root, f.relPath))).toBe(true)
    expect((await writeRpc('update_file', { fileId: f.id, patch: { displayName: '校正显示名称.txt' } })).value.file.referenceCount).toBe(1)
    expect((await writeRpc('remove_file', { fileId: f.id, deleteDisk: true })).value.diskDeleted).toBe(false)
    expect((await modernRest(`${f.id}/restore`, 'POST', {})).status).toBe(200)
    const after = (await rest(`${f.id}/maintenance`)).body.file
    expect(after).toMatchObject({ id: before.id, relPath: before.relPath, filename: before.filename, bytes: before.bytes, sha256: before.sha256, referenceCount: 1, parts: before.parts })
    expect(await publicJson(`/api/enterprises/${enterprise.id}`)).toEqual(detailBefore)
    expect(await publicJson(`/api/ocr-results?fileId=${f.id}&markdown=1`)).toEqual(ocrBefore)
    const preview = await fetch(`${service.baseUrl}/api/files/${f.relPath}`)
    expect(await preview.text()).toBe('original synthetic file bytes')
  })
  it('rejects unauthenticated external writes and keeps new MCP writes undiscoverable without its own token', async () => {
    const f = await file()
    for (const [method, path, body] of [['PATCH', `${f.id}`, { year: 2026 }], ['DELETE', `${f.id}`, {}], ['POST', `${f.id}/restore`, {}]] as const) {
      expect((await modernRest(path, method, body, false)).status).toBe(401)
      expect((await modernRest(path, method, body, 'synthetic-mcp-token')).status).toBe(401)
    }
    for (const name of ['update_file', 'remove_file', 'restore_file']) {
      expect((await rpc(name, { fileId: f.id, patch: { year: 2026 } }, false)).status).toBe(401)
      expect((await rpc(name, { fileId: f.id }, 'synthetic-api-token')).status).toBe(401)
    }
    const publicTools = (await rpc('', {}, false, 'tools/list')).value.tools.map((tool: any) => tool.name)
    const privateTools = (await rpc('', {}, 'synthetic-mcp-token', 'tools/list')).value.tools.map((tool: any) => tool.name)
    for (const name of ['update_file', 'remove_file', 'restore_file']) { expect(publicTools).not.toContain(name); expect(privateTools).toContain(name) }
    const before = await rest(`${f.id}/maintenance`)
    expect(before.body).toMatchObject({ revision: 0, total: 0, file: { year: 2024, removedAt: null } })
  })
  it('keeps remove and restore retries stable and reads their complete audit through either transport', async () => {
    const f = await file()
    const removed = await modernRest(`${f.id}`, 'DELETE', { expectedRevision: 0, idempotencyKey: `remove-${f.id}` })
    expect(removed.status).toBe(200)
    const first = await rest(`${f.id}/maintenance`)
    expect(first.body).toMatchObject({ revision: 1, total: 1, rows: [{ action: 'remove', before: { removedAt: null } }] })
    const timestamp = first.body.file.removedAt
    await rest(`${f.id}`, 'DELETE')
    expect((await rest(`${f.id}/maintenance`)).body.file.removedAt).toBe(timestamp)
    expect((await modernRest(`${f.id}`, 'PATCH', { year: 2026 })).status).toBe(409)
    const restored = await modernRest(`${f.id}/restore`, 'POST', { expectedRevision: 1, idempotencyKey: `restore-${f.id}`, actor: 'file-reviewer', basis: 'Original bytes verified' })
    expect(restored.status).toBe(200)
    const replay = await writeRpc('restore_file', { fileId: f.id, expectedRevision: 1, idempotencyKey: `restore-${f.id}`, actor: 'file-reviewer', basis: 'Original bytes verified' })
    expect(replay.value.file.removedAt).toBeNull()
    const history = await rpc('get_file_maintenance', { relPath: f.relPath, pageSize: 100 })
    expect(history.value).toEqual((await rest(`${f.id}/maintenance?pageSize=100`)).body)
    expect(history.value).toMatchObject({ revision: 2, total: 2, rows: [{ action: 'remove' }, { action: 'restore' }] })
  })
  it('serializes competing revisions and replays a cross-transport key without duplicate audit', async () => {
    const f = await file()
    expect((await rest(`${f.id}/maintenance`)).body.revision).toBe(0)
    const command = { year: 2025, expectedRevision: 0, idempotencyKey: `update-${f.id}`, actor: 'fixture-agent', basis: 'Checked original notice' }
    const first = await rest(`${f.id}`, 'PATCH', command)
    expect(first.status).toBe(200)
    const replay = await writeRpc('update_file', { fileId: f.id, patch: { year: 2025 }, ...Object.fromEntries(Object.entries(command).filter(([k]) => k !== 'year')) })
    expect(replay.value.file.year).toBe(2025)
    const conflict = await rest(`${f.id}`, 'PATCH', { ...command, year: 2026 })
    expect(conflict.status).toBe(409)
    const results = await Promise.all([2026, 2027].map(year => modernRest(`${f.id}`, 'PATCH', { year, expectedRevision: 1, actor: 'fixture-agent', basis: 'Checked year' })))
    expect(results.map(r => r.status).sort()).toEqual([200, 409])
    const readback = await rest(`${f.id}/maintenance?pageSize=1`)
    expect(readback.body).toMatchObject({ revision: 2, total: 2, page: 1, pageSize: 1 })
    expect(readback.body.rows).toHaveLength(1)
    expect(readback.body.rows[0]).toMatchObject({ action: 'update', actor: 'fixture-agent', basis: 'Checked original notice', before: { year: 2024 }, after: { year: 2025 }, revision: 1 })
    const secondPage = await rest(`${f.id}/maintenance?pageSize=1&page=2`)
    expect(secondPage.body.rows[0].revision).toBe(2)
  })
  it('updates display name and metadata and removes and restores through MCP with HTTP readback', async () => {
    const f = await file()
    const renamed = await writeRpc('update_file', { fileId: f.id, patch: { displayName: '代理显示名.txt' } })
    expect(renamed.body.result?.isError).not.toBe(true)
    expect(renamed.value.file).toMatchObject({ id: f.id, displayName: '代理显示名.txt', relPath: f.relPath, sha256: f.sha256 })
    const meta = await writeRpc('update_file', { relPath: f.relPath, patch: { year: 2025, batch: null } })
    expect(meta.value.file).toMatchObject({ year: 2025, batch: null })
    const removed = await writeRpc('remove_file', { fileId: f.id })
    expect(removed.value).toMatchObject({ removed: true, diskDeleted: false })
    expect(existsSync(join(root, f.relPath))).toBe(true)
    const restored = await writeRpc('restore_file', { relPath: f.relPath })
    expect(restored.value.file).toMatchObject({ id: f.id, removedAt: null, displayName: '代理显示名.txt', year: 2025 })
    const readback = await rest(`${f.id}/maintenance`)
    expect(readback.body.file).toMatchObject(restored.value.file)
  })
  it('restores the same file identity after soft removal without changing original bytes', async () => {
    const f = await file()
    expect((await rest(`${f.id}`, 'DELETE')).status).toBe(200)
    const restored = await modernRest(`${f.id}/restore`, 'POST', {})
    expect(restored.status).toBe(200)
    expect(restored.body).toMatchObject({ id: f.id, relPath: f.relPath, filename: f.filename, sha256: f.sha256, bytes: f.bytes, removedAt: null })
    expect(readFileSync(join(root, f.relPath), 'utf8')).toBe('original synthetic file bytes')
  })
})
