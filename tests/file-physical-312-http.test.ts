import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { useDb, schema } from '../db/client'
import { spawnOwnedChild as spawn, reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../scripts/lib/isolated-local-services.mjs'

const dir = mkdtempSync(join(tmpdir(), 'file-physical-312-'))
const root = join(dir, 'files')
const dbPath = join(dir, 'synthetic.db')
const db = useDb({ dbPath, migrationsFolder: join(process.cwd(), 'db/migrations') })
let service: { baseUrl: string; stop(): Promise<void>; crash(): Promise<void> }
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
async function startService() {
  const cwd = resolve(import.meta.dirname, '..')
  const port = await reserveLoopbackPort()
  const child = spawn(process.execPath, [join(cwd, 'node_modules/nuxt/bin/nuxt.mjs'), 'dev', '--host', '127.0.0.1', '--port', String(port)], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NUXT_BUILD_DIR: join(dir, 'nuxt-build'), NUXT_DB_PATH: dbPath, NUXT_API_TOKEN: 'synthetic-api-token', NUXT_MCP_TOKEN: 'synthetic-mcp-token', NUXT_FILES_DIR: root, NUXT_INCOMING_DIR: join(dir, 'incoming') } })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { serverOutput = (serverOutput + data).slice(-12000) })
  service = { baseUrl: `http://127.0.0.1:${port}`, stop: () => stopOwnedChild(child), crash: async () => { process.kill(-child.pid!, 'SIGKILL'); await stopOwnedChild(child) } }
  try { await waitForHttp(`${service.baseUrl}/api/health`, { timeoutMs: 60000, child }) } catch (error) { await service.stop(); throw new Error(`${String(error)}\n${serverOutput}`) }
}
beforeAll(startService, 90000)
afterAll(async () => {
  mkdirSync('/tmp/issue-312-stage', { recursive: true })
  writeFileSync('/tmp/issue-312-stage/http-server.log', serverOutput)
  if (service) await service.stop()
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('#312 recoverable physical command', () => {
  it('quarantines original bytes and replays across transports then recovers the same identity', async () => {
    const f = await file()
    const controls = await modernControls(f.id)
    const deleted = await rest(`${f.id}?deleteDisk=1`, 'DELETE', controls)
    expect(deleted.status).toBe(200)
    expect(deleted.body).toMatchObject({ removed: true, diskDeleted: false, diskQuarantined: true, intent: { state: 'quarantined', fileId: f.id } })
    expect(existsSync(join(root, f.relPath))).toBe(false)
    const replay = await rpc('quarantine_file', { fileId: f.id, ...controls })
    expect(replay.value).toEqual(deleted.body)
    const recovery = await modernControls(f.id)
    const restored = await rpc('recover_file', { fileId: f.id, intentId: deleted.body.intent.id, ...recovery })
    expect(restored.value).toMatchObject({ removed: false, intent: { state: 'recovered' } })
    expect(readFileSync(join(root, f.relPath), 'utf8')).toBe('original synthetic file bytes')
    expect((await rest(`${f.id}/maintenance`)).body).toMatchObject({ file: { id: f.id, relPath: f.relPath, sha256: f.sha256, bytes: f.bytes }, total: 2 })
    expect((await rest(`${f.id}/physical-recovery`, 'POST', { intentId: deleted.body.intent.id, ...recovery })).body).toEqual(restored.value)
    expect((await rest(`${f.id}?deleteDisk=1`, 'DELETE', controls)).body).toEqual(deleted.body)
    expect(existsSync(join(root, f.relPath))).toBe(true)
  })
  it('retains original bytes after quarantine rename and DB failure and explicitly recovers pending intent', async () => {
    const f = await file(), controls = await modernControls(f.id)
    const before = (await rest(`${f.id}/maintenance`)).body
    db.$client.exec(`CREATE TRIGGER fail312 BEFORE INSERT ON file_maintenance_audit WHEN NEW.file_id = ${f.id} BEGIN SELECT RAISE(ABORT, 'injected DB failure after rename'); END`)
    try {
      expect((await rest(`${f.id}?deleteDisk=1`, 'DELETE', controls)).status).toBe(500)
      expect(existsSync(join(root, f.relPath))).toBe(false)
      expect((await rest(`${f.id}/maintenance`)).body).toEqual(before)
      const pending = (await rest(`${f.id}/physical-recovery`)).body
      expect(pending.intent).toMatchObject({ state: 'pending', fileId: f.id })
      expect(readFileSync(join(root, '.physical-quarantine', pending.intent.id), 'utf8')).toBe('original synthetic file bytes')
    } finally { db.$client.exec('DROP TRIGGER fail312') }
    const pending = (await rest(`${f.id}/physical-recovery`)).body
    const recovered = await rest(`${f.id}/physical-recovery`, 'POST', { intentId: pending.intent.id, ...await modernControls(f.id) })
    expect(recovered.status).toBe(200)
    expect(recovered.body.intent.state).toBe('recovered')
    expect(readFileSync(join(root, f.relPath), 'utf8')).toBe('original synthetic file bytes')
    expect((await rest(`${f.id}/maintenance`)).body).toMatchObject({ revision: 1, file: { id: f.id, removedAt: null, relPath: f.relPath } })
  })
  it('resumes the same delete key after rename failure and replays the durable receipt after process exit', async () => {
    const f = await file(), controls = await modernControls(f.id)
    db.$client.exec(`CREATE TRIGGER fail312retry BEFORE INSERT ON file_maintenance_audit WHEN NEW.file_id = ${f.id} BEGIN SELECT RAISE(ABORT, 'injected rollback'); END`)
    try { expect((await rest(`${f.id}?deleteDisk=1`, 'DELETE', controls)).status).toBe(500) }
    finally { db.$client.exec('DROP TRIGGER fail312retry') }
    const completed = await rest(`${f.id}?deleteDisk=1`, 'DELETE', controls)
    expect(completed.status).toBe(200)
    await service.crash()
    await startService()
    expect((await rpc('quarantine_file', { fileId: f.id, ...controls })).value).toEqual(completed.body)
    expect((await rest(`${f.id}/maintenance`)).body).toMatchObject({ revision: 1, total: 1 })
    expect((await rest(`${f.id}?deleteDisk=1`, 'DELETE', { ...controls, basis: 'different request' })).status).toBe(409)
    const recovery = { ...await modernControls(f.id), intentId: completed.body.intent.id }
    db.$client.exec(`CREATE TRIGGER fail312restore BEFORE INSERT ON file_maintenance_audit WHEN NEW.file_id = ${f.id} BEGIN SELECT RAISE(ABORT, 'injected recovery rollback'); END`)
    try { expect((await rest(`${f.id}/physical-recovery`, 'POST', recovery)).status).toBe(500) }
    finally { db.$client.exec('DROP TRIGGER fail312restore') }
    expect(readFileSync(join(root, f.relPath), 'utf8')).toBe('original synthetic file bytes')
    expect((await rest(`${f.id}/physical-recovery`)).body.intent.state).toBe('recovering')
    expect((await rest(`${f.id}/maintenance`)).body.file.removedAt).not.toBeNull()
    expect((await rest(`${f.id}/physical-recovery`, 'POST', recovery)).status).toBe(200)
    expect((await rest(`${f.id}/maintenance`)).body).toMatchObject({ revision: 2, total: 2, file: { removedAt: null } })
  }, 90000)
  it('rejects changed SHA same-size bytes, changed size and occupied original paths during explicit recovery', async () => {
    for (const kind of ['same-size', 'size', 'occupied'] as const) {
      const f = await file()
      const deleted = await rest(`${f.id}?deleteDisk=1`, 'DELETE', await modernControls(f.id))
      expect(deleted.status).toBe(200)
      const quarantined = join(root, '.physical-quarantine', deleted.body.intent.id)
      if (kind === 'occupied') writeFileSync(join(root, f.relPath), 'do not overwrite me')
      else writeFileSync(quarantined, kind === 'size' ? 'short' : 'X'.repeat(f.bytes))
      const before = (await rest(`${f.id}/maintenance`)).body
      const controls = { ...await modernControls(f.id), intentId: deleted.body.intent.id }
      expect((await rest(`${f.id}/physical-recovery`, 'POST', controls)).status).toBe(409)
      expect((await rest(`${f.id}/maintenance`)).body).toEqual(before)
      expect(existsSync(quarantined)).toBe(true)
      if (kind === 'occupied') { expect(readFileSync(join(root, f.relPath), 'utf8')).toBe('do not overwrite me'); rmSync(join(root, f.relPath)) }
      writeFileSync(quarantined, 'original synthetic file bytes')
      expect((await rest(`${f.id}/physical-recovery`, 'POST', controls)).status).toBe(200)
    }
  })
  it('preserves default soft remove and official source pointers and rejects physical reference and root escapes', async () => {
    const f = await file()
    const enterprise = db.insert(schema.enterprise).values({ name: `引用企业${f.id}`, nameNorm: `引用企业${f.id}` }).returning().get()
    const record = db.insert(schema.record).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', source: 'jxj' }).returning().get()
    const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2024 }).returning().get()
    db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: f.relPath, attachment: '附件1', listNo: 1, page: 1 }).run()
    const sourceBefore = await (await fetch(`${service.baseUrl}/api/enterprises/${enterprise.id}`)).json()
    expect((await rest(`${f.id}?deleteDisk=1`, 'DELETE', await modernControls(f.id))).status).toBe(409)
    expect((await rest(`${f.id}/physical-recovery`)).status).toBe(404)
    expect((await rest(`${f.id}`, 'DELETE')).body).toEqual({ removed: true, diskDeleted: false, referenceCount: 1 })
    expect((await modernRest(`${f.id}/restore`, 'POST')).status).toBe(200)
    expect(await (await fetch(`${service.baseUrl}/api/enterprises/${enterprise.id}`)).json()).toEqual(sourceBefore)
    expect(await (await fetch(`${service.baseUrl}/api/files/${f.relPath}`)).text()).toBe('original synthetic file bytes')
    const outside = join(dir, 'outside.txt')
    writeFileSync(outside, 'outside untouched')
    for (const kind of ['relpath', 'symlink', 'parent-symlink'] as const) {
      const target = await file()
      if (kind === 'relpath') db.$client.prepare('UPDATE stored_file SET rel_path = ? WHERE id = ?').run('../outside.txt', target.id)
      else if (kind === 'symlink') { rmSync(join(root, target.relPath)); symlinkSync(outside, join(root, target.relPath)) }
      else { symlinkSync(dir, join(root, `escape-${target.id}`)); db.$client.prepare('UPDATE stored_file SET rel_path = ? WHERE id = ?').run(`escape-${target.id}/outside.txt`, target.id) }
      expect((await rest(`${target.id}?deleteDisk=1`, 'DELETE', await modernControls(target.id))).status).toBe(409)
      expect((await rest(`${target.id}/maintenance`)).body.total).toBe(0)
      expect(readFileSync(outside, 'utf8')).toBe('outside untouched')
    }
  })
  it('discovers guarded physical commands and requires independent transport tokens and complete controls', async () => {
    const f = await file()
    expect((await rest(`${f.id}?deleteDisk=1`, 'DELETE', await modernControls(f.id), false)).status).toBe(401)
    expect((await rest(`${f.id}?deleteDisk=1`, 'DELETE', {})).status).toBe(400)
    const publicTools = (await rpc('', {}, false, 'tools/list')).value.tools.map((t: any) => t.name)
    const privateTools = (await rpc('', {}, 'synthetic-mcp-token', 'tools/list')).value.tools.map((t: any) => t.name)
    for (const name of ['quarantine_file', 'recover_file']) {
      expect(publicTools).not.toContain(name)
      expect(privateTools).toContain(name)
      expect((await rpc(name, { fileId: f.id, ...await modernControls(f.id) }, false)).status).toBe(401)
    }
    const spec = await (await fetch(`${service.baseUrl}/_openapi.json`)).json() as any
    expect(spec.paths['/api/files/{id}/physical-recovery'].post.requestBody.content['application/json'].schema.required).toEqual(['intentId', 'expectedRevision', 'idempotencyKey', 'actor', 'basis'])
    expect((await rest(`${f.id}/maintenance`)).body).toMatchObject({ total: 0, file: { removedAt: null } })
  })

})
