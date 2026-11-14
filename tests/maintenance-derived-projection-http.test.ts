import { submitNativePlatformQuery } from './helpers/native-platform-fixture'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { initializeDb, schema } from '../db/client'
import { minimalPdf } from './helpers/minimal-pdf'
import { spawnOwnedChild as spawn, reserveLoopbackPort, waitForHttp, stopOwnedChild } from './helpers/isolated-local-services.mjs'

const dir = mkdtempSync(join(tmpdir(), 'maintenance-derived-'))
const filesDir = join(dir, 'files'), dbPath = join(dir, 'synthetic.db')
mkdirSync(filesDir)
const db = initializeDb({ create: true,  dbPath })
const bytes = minimalPdf({ pages: 3 })
const sha256 = createHash('sha256').update(bytes).digest('hex')
let service: { baseUrl: string; stop: () => Promise<void> }
const headers = { 'content-type': 'application/json', authorization: 'Bearer synthetic-api-token' }
const read = async (path: string) => { const response = await fetch(service.baseUrl + path, { headers }); expect(response.status).toBe(200); return response.json() as Promise<any> }
const post = (path: string, body: unknown) => fetch(service.baseUrl + path, { method: 'POST', headers, body: JSON.stringify(body) })
async function successfulPost(path: string, body: unknown) { const response = await post(path, body); const result = await response.json(); expect({ status: response.status, body: result }).toMatchObject({ status: 200 }); return result as any }
async function rpc(name: string, args: unknown) {
  const response = await fetch(service.baseUrl + '/mcp', { method: 'POST', headers: { ...headers, accept: 'application/json, text/event-stream', authorization: 'Bearer synthetic-mcp-token' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
  const raw = await response.text()
  const result = JSON.parse(raw.startsWith('event:') ? raw.split('\n').find(line => line.startsWith('data: '))!.slice(6) : raw)
  expect(response.status).toBe(200)
  expect(result.result.isError).not.toBe(true)
  return JSON.parse(result.result.content[0].text)
}
const parsePath = (id: number) => '/api/files/' + id + '/parse-result'
const evidencePath = (id: number) => '/api/roster/evidence/' + id
const eventPath = (id: number) => '/api/roster/events/' + id
const corrections = '/api/roster/evidence/corrections/'
const eventCorrections = '/api/roster/events/corrections/'
function fixture(name: string) {
  const sourceFile = name + '.pdf'
  writeFileSync(join(filesDir, sourceFile), bytes)
  const file = db.insert(schema.storedFile).values({ relPath: sourceFile, filename: sourceFile, ext: 'pdf', bytes: bytes.length, sha256, source: 'jxj', kind: 'announcement' }).returning().get()
  const enterprise = db.insert(schema.enterprise).values({ name, nameNorm: name }).returning().get()
  const record = db.insert(schema.record).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', source: 'jxj' }).returning().get()
  const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2021, decidedYear: 2021, batchSeq: 1, sortKey: 2021 }).returning().get()
  const evidence = db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile, attachment: '附件1', listNo: 1, page: 1 }).returning().get()
  // Existing persisted derived state, not an independent attachment declaration.
  db.insert(schema.storedFilePart).values({ fileId: file.id, titleCode: 'specialized_sme', eventKind: 'award', year: 2021, batch: 1, attachment: '附件1', rowCount: 1, origin: 'derived' }).run()
  return { file, enterprise, record, event, evidence }
}
async function evidenceRequest(key: string, evidenceId: number, coordinate: Record<string, unknown>) {
  const row = await read(evidencePath(evidenceId))
  return { idempotencyKey: key, actor: { type: 'agent', id: 'integration-fixer' }, basis: '核对原公布文件的指定事件与名单坐标', operations: [{ evidenceId, eventId: row.eventId, recordId: row.recordId, enterpriseId: row.enterpriseId, expectedVersion: row.version, coordinate: { ...row.coordinate, ...coordinate } }] }
}
beforeAll(async () => {
  const cwd = resolve(import.meta.dirname, '..'), port = await reserveLoopbackPort()
  const child = spawn(process.execPath, [join(cwd, 'node_modules/nuxt/bin/nuxt.mjs'), 'dev', '--host', '127.0.0.1', '--port', String(port)], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NUXT_BUILD_DIR: join(dir, 'build'), NUXT_DB_PATH: dbPath, NUXT_API_TOKEN: 'synthetic-api-token', NUXT_MCP_TOKEN: 'synthetic-mcp-token', NUXT_FILES_DIR: filesDir, NUXT_INCOMING_DIR: join(dir, 'incoming') } })
  let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-8000) })
  service = { baseUrl: `http://127.0.0.1:${port}`, stop: () => stopOwnedChild(child) }
  try { await waitForHttp(service.baseUrl + '/api/stats', { timeoutMs: 60000, child }) } catch (error) { await service.stop(); throw new Error(String(error) + output) }
}, 90000)
afterAll(async () => { if (service) await service.stop(); db.$client.close(); rmSync(dir, { recursive: true, force: true }) })

describe('cross-ticket event evidence and parse derived projections', () => {
  it('corrects a derived-only attachment through HTTP and MCP and preserves revision on replay and noop', async () => {
    const f = fixture('derived-attachment')
    const before = await read(parsePath(f.file.id))
    const request = await evidenceRequest('derived-attachment', f.evidence.id, { attachment: '附件2' })
    const plan = await successfulPost(corrections + 'preflight', request)
    expect(await rpc('preflight_roster_evidence_corrections', request)).toEqual(plan)
    const envelope = { request, planHash: plan.planHash }
    const receipt = await rpc('commit_roster_evidence_corrections', envelope)
    const after = await read(parsePath(f.file.id))
    expect(after.parts).toEqual([{ titleCode: 'specialized_sme', eventKind: 'award', year: 2021, batch: 1, attachment: '附件2', rowCount: 1, origin: 'derived', hasConflict: false }])
    expect(after.version).not.toBe(before.version)
    expect(await rpc('get_file_parse_result', { fileId: f.file.id })).toEqual(after)
    expect(await successfulPost(corrections + 'commit', envelope)).toEqual(receipt)
    expect((await read(eventPath(f.event.id))).event.revision).toBe(2)
    const noop = await evidenceRequest('derived-noop', f.evidence.id, {})
    const noopPlan = await successfulPost(corrections + 'preflight', noop)
    expect(noopPlan.impact).toMatchObject({ updated: 0, audit: 0 })
    await successfulPost(corrections + 'commit', { request: noop, planHash: noopPlan.planHash })
    expect((await read(eventPath(f.event.id))).event.revision).toBe(2)
    expect(await read(parsePath(f.file.id))).toEqual(after)
    expect((await read(evidencePath(f.evidence.id) + '/audit')).total).toBe(1)
  })

  it('refreshes the parse projection after an event year correction then accepts an exact evidence list number correction', async () => {
    const f = fixture('event-year-list-number')
    const before = await read(parsePath(f.file.id))
    const request = { idempotencyKey: 'event-year-list-number', sourceIdentity: 'synthetic/notice', actor: { type: 'agent', id: 'integration-fixer' }, basis: '原公布名单年份为2022', operations: [{ eventId: f.event.id, recordId: f.record.id, enterpriseId: f.enterprise.id, expectedRevision: 1, patch: { year: 2022, decidedYear: 2022 } }] }
    const plan = await rpc('preflight_event_corrections', request)
    const envelope = { request, planHash: plan.planHash }
    const receipt = await successfulPost(eventCorrections + 'commit', envelope)
    const afterEvent = await read(parsePath(f.file.id))
    expect(afterEvent.parts).toEqual([expect.objectContaining({ year: 2022, attachment: '附件1', origin: 'derived' })])
    expect(afterEvent.version).not.toBe(before.version)
    expect(await rpc('commit_event_corrections', envelope)).toEqual(receipt)
    const coordinates = await evidenceRequest('list-after-year', f.evidence.id, { listNo: 2 })
    const coordinatePlan = await successfulPost(corrections + 'preflight', coordinates)
    await rpc('commit_roster_evidence_corrections', { request: coordinates, planHash: coordinatePlan.planHash })
    expect(await rpc('get_file_parse_result', { fileId: f.file.id })).toEqual(afterEvent)
    expect(await read(evidencePath(f.evidence.id))).toMatchObject({ coordinate: { listNo: 2 }, event: { year: 2022, revision: 3 } })
  })

  it.each(['agent', 'legacy'] as const)('keeps an explicit %s attachment declaration authoritative', async (origin) => {
    const f = fixture('declared-' + origin)
    db.$client.prepare('UPDATE stored_file_part SET origin=? WHERE file_id=?').run(origin, f.file.id)
    const before = await read(parsePath(f.file.id))
    const request = await evidenceRequest('declared-conflict-' + origin, f.evidence.id, { attachment: '附件2' })
    const result = await post(corrections + 'preflight', request)
    expect(result.status).toBe(422)
    expect(await result.json()).toMatchObject({ error: { code: 'attachment_conflict' } })
    expect(await read(parsePath(f.file.id))).toEqual(before)
    expect((await read(evidencePath(f.evidence.id))).coordinate.attachment).toBe('附件1')
    expect((await read(eventPath(f.event.id))).event.revision).toBe(1)
  })

  it('refreshes both source files once per evidence batch and preserves agent and legacy row identities while recomputing conflicts', async () => {
    const f = fixture('move-old'), destination = fixture('move-new')
    const second = db.insert(schema.recordEvidence).values({ recordEventId: f.event.id, sourceFile: f.file.relPath, attachment: '附件1', listNo: 2, page: 1 }).returning().get()
    const declared = db.insert(schema.storedFilePart).values({ fileId: destination.file.id, titleCode: 'specialized_sme', eventKind: 'award', year: 2021, batch: 1, attachment: '附件2', rowCount: 3, origin: 'agent' }).returning().get()
    const legacy = db.insert(schema.storedFilePart).values({ fileId: f.file.id, titleCode: 'specialized_sme', eventKind: 'award', year: 2010, batch: 1, attachment: '附件9', rowCount: 1, origin: 'legacy', hasConflict: true }).returning().get()
    const firstRequest = await evidenceRequest('move-file-set', f.evidence.id, { sourceFile: destination.file.relPath, attachment: '附件2', listNo: 10 })
    const secondRequest = await evidenceRequest('unused', second.id, { sourceFile: destination.file.relPath, attachment: '附件2', listNo: 11 })
    const request = { ...firstRequest, operations: [...firstRequest.operations, ...secondRequest.operations] }
    const plan = await successfulPost(corrections + 'preflight', request)
    // Each affected file is rebuilt once; duplicate per-evidence refreshes would fail this trigger.
    db.$client.exec('CREATE TABLE refresh_seen(file_id INTEGER PRIMARY KEY); CREATE TRIGGER refresh_once BEFORE DELETE ON stored_file_part WHEN OLD.origin=\'derived\' BEGIN INSERT INTO refresh_seen VALUES(OLD.file_id); END')
    try { await successfulPost(corrections + 'commit', { request, planHash: plan.planHash }) }
    finally { db.$client.exec('DROP TRIGGER refresh_once; DROP TABLE refresh_seen') }
    const oldParts = await read(parsePath(f.file.id)), newParts = await read(parsePath(destination.file.id))
    expect(oldParts.parts).toEqual([expect.objectContaining({ origin: 'legacy', year: 2010, attachment: '附件9', rowCount: 1, hasConflict: false })])
    expect(newParts.parts).toEqual([
      expect.objectContaining({ origin: 'derived', attachment: '附件1', rowCount: 1, hasConflict: false }),
      expect.objectContaining({ origin: 'agent', attachment: '附件2', rowCount: 3, hasConflict: true }),
    ])
    expect(db.$client.prepare('SELECT id,origin,row_count FROM stored_file_part WHERE id=?').get(declared.id)).toEqual({ id: declared.id, origin: 'agent', row_count: 3 })
    expect(db.$client.prepare('SELECT id,origin,row_count FROM stored_file_part WHERE id=?').get(legacy.id)).toEqual({ id: legacy.id, origin: 'legacy', row_count: 1 })
    expect((await read(eventPath(f.event.id))).event.revision).toBe(2)
    expect((await read(evidencePath(second.id))).coordinate).toMatchObject({ sourceFile: destination.file.relPath, listNo: 11 })
  })

  it.each(['event', 'evidence', 'legacy'] as const)('rolls back %s changes audit receipt revision and projections when scoped refresh fails', async (entry) => {
    const f = fixture('refresh-failure-' + entry)
    const destination = entry === 'evidence' ? fixture('refresh-failure-destination') : null
    const destinationParts = destination ? await read(parsePath(destination.file.id)) : null
    const beforeEvidence = await read(evidencePath(f.evidence.id)), beforeEvent = await read(eventPath(f.event.id)), beforeParts = await read(parsePath(f.file.id))
    const key = 'refresh-failure-' + entry
    const request = entry === 'event'
      ? { idempotencyKey: key, sourceIdentity: 'synthetic/rollback', actor: { type: 'agent', id: 'fixer' }, basis: '已核对年份', operations: [{ eventId: f.event.id, recordId: f.record.id, enterpriseId: f.enterprise.id, expectedRevision: 1, patch: { year: 2022, decidedYear: 2022 } }] }
      : await evidenceRequest(key, f.evidence.id, destination ? { sourceFile: destination.file.relPath, attachment: '附件2', listNo: 7, page: 2 } : { page: 2 })
    const prefix = entry === 'event' ? eventCorrections : corrections
    const plan = entry === 'legacy' ? null : await successfulPost(prefix + 'preflight', request)
    db.$client.exec('CREATE TRIGGER fail_derived_refresh BEFORE DELETE ON stored_file_part WHEN OLD.file_id=' + (destination?.file.id ?? f.file.id) + " AND OLD.origin='derived' BEGIN SELECT RAISE(ABORT,'synthetic projection failure'); END")
    try {
      const result = await post(entry === 'legacy' ? '/api/roster/evidence/pages' : prefix + 'commit', entry === 'legacy'
        ? { entries: [{ sourceFile: f.file.relPath, listNo: 1, enterpriseId: f.enterprise.id, page: 2 }] }
        : { request, planHash: plan.planHash })
      if (entry === 'legacy') {
        expect(result.status).toBe(200)
        expect(await result.json()).toMatchObject({ summary: { written: 0, pending: 1 } })
      } else expect(result.status).toBe(500)
    } finally { db.$client.exec('DROP TRIGGER fail_derived_refresh') }
    expect(await read(evidencePath(f.evidence.id))).toEqual(beforeEvidence)
    expect(await read(eventPath(f.event.id))).toEqual(beforeEvent)
    expect(await read(parsePath(f.file.id))).toEqual(beforeParts)
    if (destination) expect(await read(parsePath(destination.file.id))).toEqual(destinationParts)
    expect((await read(evidencePath(f.evidence.id) + '/audit')).total).toBe(0)
    expect((await read(eventPath(f.event.id) + '/audit')).total).toBe(0)
    if (entry === 'evidence') expect((await fetch(service.baseUrl + corrections + 'batches/' + key, { headers })).status).toBe(404)
    if (entry === 'event') expect((await successfulPost(prefix + 'preflight', request)).batchStatus).toBe('preflight')
    if (entry !== 'legacy') await successfulPost(prefix + 'commit', { request, planHash: plan.planHash })
    else {
      const body = { entries: [{ sourceFile: f.file.relPath, listNo: 1, enterpriseId: f.enterprise.id, page: 2 }] }
      expect(await successfulPost('/api/roster/evidence/pages', { ...body, dryRun: true })).toMatchObject({ status: 'dry_run', summary: { written: 0 } })
      expect(await read(evidencePath(f.evidence.id))).toEqual(beforeEvidence)
      // A stale cache is repaired by the legacy writer, without a library backfill.
      db.$client.prepare('UPDATE stored_file_part SET row_count=0 WHERE file_id=?').run(f.file.id)
      expect(await successfulPost('/api/roster/evidence/pages', body)).toMatchObject({ summary: { written: 1 } })
      expect(await successfulPost('/api/roster/evidence/pages', body)).toMatchObject({ summary: { written: 0, unchanged: 1 } })
      expect((await read(parsePath(f.file.id))).parts).toEqual([expect.objectContaining({ rowCount: 1, origin: 'derived' })])
    }
    expect((await read(eventPath(f.event.id))).event.revision).toBe(2)
  })

  it('uses indexed affected-file projections and leaves unrelated raw evidence and file caches untouched', async () => {
    const f = fixture('scoped-refresh'), unrelated = fixture('unrelated-refresh')
    submitNativePlatformQuery(db, { interface: 'apply_list', queryKey: 'unrelated-refresh', rdjb: '2', queriedAt: '2026-10-19', status: 'success', rawResponse: 'UNRELATED_RAW'.repeat(100000) })
    const before = await read(parsePath(unrelated.file.id))
    db.$client.exec('CREATE TRIGGER forbid_unrelated_refresh BEFORE DELETE ON stored_file_part WHEN OLD.file_id=' + unrelated.file.id + " BEGIN SELECT RAISE(ABORT,'unrelated cache touched'); END")
    try {
      const request = await evidenceRequest('scoped-refresh', f.evidence.id, { attachment: '附件2' })
      const plan = await successfulPost(corrections + 'preflight', request)
      await successfulPost(corrections + 'commit', { request, planHash: plan.planHash })
    } finally { db.$client.exec('DROP TRIGGER forbid_unrelated_refresh') }
    expect(await read(parsePath(unrelated.file.id))).toEqual(before)
    const plan = db.$client.prepare('EXPLAIN QUERY PLAN SELECT e.source_file,r.title_code,v.event_type,v.year,v.batch_seq,e.attachment FROM record_evidence e JOIN record_event v ON v.id=e.record_event_id JOIN record r ON r.id=v.record_id WHERE e.source_file=?').all(f.file.relPath)
    expect(JSON.stringify(plan)).toMatch(/SEARCH e USING INDEX record_evidence_(source_file_105|coordinate)_idx/)
    expect(JSON.stringify(plan)).not.toContain('SCAN e')
    const output = await rpc('get_file_parse_result', { fileId: f.file.id })
    expect(output.parts).toEqual([expect.objectContaining({ attachment: '附件2' })])
    expect(JSON.stringify(output)).not.toContain('UNRELATED_RAW')
  })
})
