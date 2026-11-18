import { createClassifiedFile } from '../../../server/utils/roster-file-classification'
import { spawnCompiledApp } from '../../support/owned-process.mjs'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { initializeDb, schema } from '../../../db/client'
import { createRosterImportClient, type RosterImportRequest } from '../../../lib/roster-import-client'
import { processEvidenceImpacts113, listEvidenceImpacts113, listImpactEvidence113, readEvidenceToken113, listRevisionEvents113 } from '../../../server/utils/evidence-impact-113'
import { recognizedResultToImport } from '../../../lib/platform/recognized-evidence'
import type { PlatformLiveQueryResult } from '../../../lib/platform/live-query'
import { minimalPdf } from '../../support/minimal-pdf'
import { reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../../support/owned-process.mjs'

const dir = mkdtempSync(join(tmpdir(), 'impact-113-'))
const dbPath = join(dir, 'synthetic.db'), db = initializeDb({ create: true,  dbPath })
let baseUrl: string, stop: () => Promise<void>, client: ReturnType<typeof createRosterImportClient>
const actor = { type: 'agent', id: 'synthetic-113' }
async function rpc(name: string, args: Record<string, unknown>) {
  const response = await fetch(baseUrl + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', authorization: 'Bearer synthetic-mcp' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
  const raw = await response.text(), payload = raw.startsWith('event:') ? raw.split('\n').find(line => line.startsWith('data: '))?.slice(6) : raw
  const body = JSON.parse(payload!)
  expect(response.status).toBe(200)
  expect(body.result?.isError, JSON.stringify(body)).not.toBe(true)
  return JSON.parse(body.result.content[0].text)
}
function seed(name: string, usccNorm: string | null = null) { return db.insert(schema.enterprise).values({ name, nameNorm: name, usccNorm }).returning().get() }
function decision(enterpriseId: number, titleCode = 'specialized_sme', direction: 'missing_in_miit' | 'extra_in_miit' = 'missing_in_miit', status: 'not_queried' | 'confirmed_no_diff' = 'not_queried') {
  return db.insert(schema.differenceReason).values({ enterpriseId, titleCode, direction, status, measureCode: status === 'not_queried' ? 'manual_review' : 'none', verificationStatus: status === 'not_queried' ? 'pending' : 'confirmed', recordedAt: '2026-10-01T00:00:00Z' }).returning().get()
}
const batch = (key: string, payload: any) => ({ idempotencyKey: key, sourceKind: 'alias_evidence' as const, sourceIdentity: 'synthetic/' + key, payload: { ...payload, ...(payload.platformQueries ? { platformQueries: payload.platformQueries.map((q: any) => q.reuseExisting || q.rawResponse != null || q.collectionEvidence != null ? q : { ...q, rawResponse: JSON.stringify({ synthetic: true, rows: q.relations ?? [] }) }) } : {}) } })
const backfill = (id: number) => ({ enterpriseId: id, uscc: '91330211255994457P', source: { url: 'https://example.com/official', title: '合成公开来源', checkedOn: '2026-10-19', basis: '同名及地区主体核验', name: '缺码补齐' } })
function drain(limit = 100) { let result; for (let i = 0; i < 100; i++) { result = processEvidenceImpacts113(db, { limit }); if (!result.unfinished) return result }; throw new Error('bounded processor did not finish') }
beforeAll(async () => {
  const cwd = resolve(import.meta.dirname, '../../..'), port = await reserveLoopbackPort()
  const child = spawnCompiledApp(port, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NUXT_BUILD_DIR: join(dir, 'build'), NUXT_DB_PATH: dbPath, NUXT_API_TOKEN: 'synthetic-api', NUXT_MCP_TOKEN: 'synthetic-mcp', NUXT_FILES_DIR: join(dir, 'files'), NUXT_INCOMING_DIR: join(dir, 'incoming') } })
  let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-8000) })
  baseUrl = `http://127.0.0.1:${port}`; stop = () => stopOwnedChild(child)
  try { await waitForHttp(baseUrl + '/api/roster/differences', { timeoutMs: 60000, child }) } catch (e) { await stop(); throw new Error(String(e) + output) }
  client = createRosterImportClient({ baseUrl, token: 'synthetic-api' })
}, 90000)
afterAll(async () => { if (stop) await stop(); rmSync(dir, { recursive: true, force: true }) })

describe("ticket committed evidence impact substrate", () => {
  it('registers committed code supplementation across titles and directions without changing decisions', async () => {
    const e = seed('缺码补齐'), unchanged = seed('仍然缺码')
    const a = decision(e.id), b = decision(e.id, 'innovative_sme', 'extra_in_miit', 'confirmed_no_diff')
    decision(unchanged.id)
    const request = batch('code-supplement', { usccBackfills: [backfill(e.id)] })
    const receipt = await client.commit(request)
    expect(receipt.status, JSON.stringify(receipt)).toBe('committed')
    expect(drain().unfinished).toBe(false)
    const impacts = listEvidenceImpacts113(db, { enterpriseId: e.id })
    expect(impacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ enterpriseId: e.id, titleCode: 'specialized_sme', direction: 'missing_in_miit', decisionId: a.id, classification: 'evidence_changed' }),
      expect.objectContaining({ titleCode: 'innovative_sme', direction: 'extra_in_miit', decisionId: b.id, classification: 'evidence_changed' }),
    ]))
    expect(impacts).toHaveLength(2)
    expect(listEvidenceImpacts113(db, { enterpriseId: unchanged.id })).toEqual([])
    const before = impacts.map(i => i.latestRevisionId)
    expect((await client.commit(request)).status).toBe('committed'); drain()
    expect(listEvidenceImpacts113(db, { enterpriseId: e.id }).map(i => i.latestRevisionId)).toEqual(before)
    const current = await (await fetch(baseUrl + `/api/roster/decision-lifecycle/current?enterpriseId=${e.id}&titleCode=specialized_sme&direction=missing_in_miit`)).json()
    expect(current).toMatchObject({ versionId: a.id, current: { status: 'not_queried', measureCode: 'manual_review' } })
  })
  it('partitions archived evidence by exact enterprise and title, deduplicates semantic occurrences, and keeps coverage-only changes separate', async () => {
    const e = seed('精确归档主体', '91330206053825300H'), other = seed('不相关归档主体', 'OTHER-113')
    const a = decision(e.id), b = decision(e.id, 'specialized_sme', 'extra_in_miit', 'confirmed_no_diff')
    decision(e.id, 'innovative_sme'); decision(other.id)
    const q = { interface: 'business_list', queryKey: e.usccNorm, titleCode: 'specialized_sme', rdjb: '2', queriedAt: '2026-10-19T01:00:00Z', status: 'no_record', relations: [] }
    expect((await client.commit(batch('archive-empty', { platformQueries: [q] }))).status).toBe('committed')
    drain()
    expect(listEvidenceImpacts113(db, { enterpriseId: e.id })).toEqual([expect.objectContaining({ decisionId: a.id, classification: 'premise_invalid' })])
    const first = listEvidenceImpacts113(db, { enterpriseId: e.id })[0]!.latestRevisionId
    expect((await rpc('save_roster_batch', batch('archive-same-later', { platformQueries: [{ ...q, queriedAt: '2026-10-19T02:00:00Z', rawResponse: 'different envelope same facts' }] }))).status).toBe('committed')
    drain(); expect(listEvidenceImpacts113(db, { enterpriseId: e.id })[0]!.latestRevisionId).toBe(first)
    expect((await client.commit(batch('archive-record', { platformQueries: [{ ...q, queriedAt: '2026-10-19T03:00:00Z', status: 'success', relations: [{ sequenceNo: 1, usccRaw: e.usccNorm, nameRaw: e.name, status: '有效', year: 2024 }] }] }))).status).toBe('committed')
    drain()
    const rows = listEvidenceImpacts113(db, { enterpriseId: e.id })
    expect(rows).toHaveLength(2)
    expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ decisionId: b.id, classification: 'evidence_changed' })]))
    expect(listEvidenceImpacts113(db, { enterpriseId: other.id })).toEqual([])
    const record = db.insert(schema.record).values({ enterpriseId: e.id, titleCode: 'specialized_sme', source: 'jxj' }).returning().get()
    const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2024 }).returning().get()
    const source = db.get<{ id: number; observationId: number }>(sql`select a.old_id as id, a.observation_id as observationId from platform_legacy_relation_alias a join platform_observation_assignment s on s.observation_id=a.observation_id where s.enterprise_id=${e.id} order by a.old_id desc limit 1`)!
    db.insert(schema.recordCorrespondence).values({ edgeKey: 'archive-associated-event-113', type: 'event_process', role: 'award_origin', eventId: event.id, observationId: source.observationId, enterpriseId: e.id, titleCode: 'specialized_sme', status: 'confirmed', revision: 1, targetIdentity: {}, provenance: {}, sourceFingerprint: 'synthetic', ruleId: 'manual', ruleVersion: '1', createdAt: '2026-10-19' }).run()
    expect((await client.commit(batch('archive-linked-new', { platformQueries: [{ ...q, queriedAt: '2026-10-19T03:30:00Z', status: 'success', relations: [{ sequenceNo: 1, enterpriseId: e.id, status: '关联事件的新证据' }] }] }))).status).toBe('committed'); drain()
    const updated = listEvidenceImpacts113(db, { enterpriseId: e.id })
    expect(listRevisionEvents113(db, updated[0]!.latestRevisionId, { enterpriseId: e.id })).toEqual([expect.objectContaining({ eventId: event.id, titleCode: 'specialized_sme' })])
  })

  it('captures confirmed alias lifecycle and profile identity changes through MCP while ignoring notes and location-only edits', async () => {
    const e = seed('别名资料企业'), d = decision(e.id, 'specialized_sme', 'missing_in_miit', 'confirmed_no_diff')
    expect((await client.commit(batch('alias-pending', { aliases: [{ enterpriseName: e.name, name: '待确认旧名', sourceKind: 'manual', sourceRefId: 0, verificationStatus: 'pending' }] }))).status).toBe('committed')
    drain(); expect(listEvidenceImpacts113(db, { enterpriseId: e.id })).toEqual([])
    const aliases = await (await fetch(baseUrl + `/api/roster/enterprises/${e.id}/aliases`)).json() as any
    const alias = aliases.rows[0]
    const confirm = { enterpriseId: e.id, aliasId: alias.id, action: 'confirm', expectedVersion: 1, actor: 'synthetic-113', basis: '明确同主体证据', idempotencyKey: 'alias-confirm-113' }
    await rpc('maintain_enterprise_alias', confirm); drain()
    let state = listEvidenceImpacts113(db, { enterpriseId: e.id })[0]!
    expect(state).toMatchObject({ decisionId: d.id, classification: 'evidence_changed' })
    const first = state.latestRevisionId
    await rpc('maintain_enterprise_alias', confirm); drain()
    expect(listEvidenceImpacts113(db, { enterpriseId: e.id })[0]!.latestRevisionId).toBe(first)
    await rpc('maintain_enterprise_alias', { ...confirm, action: 'correct', expectedVersion: 2, idempotencyKey: 'alias-note-only', changes: { note: '审计说明变化' } }); drain()
    expect(listEvidenceImpacts113(db, { enterpriseId: e.id })[0]!.latestRevisionId).toBe(first)
    const profile = await rpc('get_enterprise_profile', { enterpriseId: e.id })
    const renamed = await rpc('patch_enterprise_profile', { enterpriseId: e.id, request: { idempotencyKey: 'profile-rename-113', expectedVersion: profile.version, changes: { name: '资料企业新名称' }, previousName: { name: e.name, sameSubject: true }, actor, basis: '明确改名证据' } }); drain()
    state = listEvidenceImpacts113(db, { enterpriseId: e.id })[0]!
    expect(state.latestRevisionId).toBeGreaterThan(first)
    const second = state.latestRevisionId
    await rpc('patch_enterprise_profile', { enterpriseId: e.id, request: { idempotencyKey: 'profile-city-113', expectedVersion: renamed.version, changes: { city: '宁波市' }, actor, basis: '地址资料更正' } }); drain()
    expect(listEvidenceImpacts113(db, { enterpriseId: e.id })[0]!.latestRevisionId).toBe(second)
    await rpc('maintain_enterprise_alias', { ...confirm, action: 'withdraw', expectedVersion: 3, idempotencyKey: 'alias-withdraw-113' }); drain()
    expect(listEvidenceImpacts113(db, { enterpriseId: e.id })[0]!.latestRevisionId).toBeGreaterThan(second)
  })

  it('tracks only effective snapshot selection and exact changed membership including negative evidence', async () => {
    const e = seed('快照增删主体', 'SNAPSHOT-EXACT-113'), unchanged = seed('快照稳定主体', 'SNAPSHOT-STABLE-113')
    const a = decision(e.id, 'specialized_sme', 'missing_in_miit', 'confirmed_no_diff')
    decision(e.id, 'specialized_sme', 'extra_in_miit', 'confirmed_no_diff'); decision(e.id, 'innovative_sme')
    decision(unchanged.id, 'specialized_sme', 'missing_in_miit', 'confirmed_no_diff')
    const stableRow = { sourceRowNo: 1, usccRaw: unchanged.usccNorm, nameRaw: unchanged.name, regStatus: '存续' }
    const snap = { titleCode: 'specialized_sme', year: 2025, collectedOn: '2026-10-19', originalFilename: 'synthetic.xlsx', sha256: 'snapshot-first', rows: [stableRow] }
    expect((await client.commit(batch('snapshot-first', { exportSnapshot: snap }))).status).toBe('committed'); drain()
    // The initial selected snapshot is evidence for both membership and absence.
    const before = listEvidenceImpacts113(db, { enterpriseId: e.id })
    expect(before).toHaveLength(2)
    const stableVersion = listEvidenceImpacts113(db, { enterpriseId: unchanged.id })[0]!.latestRevisionId
    const newSnapshot = { ...snap, sha256: 'snapshot-added', rows: [stableRow, { sourceRowNo: 2, usccRaw: e.usccNorm, nameRaw: e.name, regStatus: '存续' }] }
    expect((await rpc('save_roster_batch', batch('snapshot-added', { exportSnapshot: newSnapshot }))).status).toBe('committed'); drain(1)
    expect(listEvidenceImpacts113(db, { enterpriseId: e.id }).every(r => r.latestRevisionId > before[0]!.latestRevisionId)).toBe(true)
    expect(listEvidenceImpacts113(db, { enterpriseId: unchanged.id })[0]!.latestRevisionId).toBe(stableVersion)
    const after = listEvidenceImpacts113(db, { enterpriseId: e.id }).map(r => r.latestRevisionId)
    expect((await client.commit(batch('snapshot-same-content', { exportSnapshot: { ...newSnapshot, sha256: 'different-file-envelope' } }))).status).toBe('committed'); drain()
    expect(listEvidenceImpacts113(db, { enterpriseId: e.id }).map(r => r.latestRevisionId)).toEqual(after)
    expect((await client.commit(batch('snapshot-nonselected', { exportSnapshot: { ...snap, year: 2024, sha256: 'older-nonselected', rows: [] } }))).status).toBe('committed'); drain()
    expect(listEvidenceImpacts113(db, { enterpriseId: e.id }).map(r => r.latestRevisionId)).toEqual(after)
  })

  it('captures official event and evidence corrections with exact linked event scope across both directions', async () => {
    const e = seed('正式事件出处更正'), other = seed('另一正式主体')
    const a = decision(e.id, 'little_giant', 'missing_in_miit', 'confirmed_no_diff'), b = decision(e.id, 'little_giant', 'extra_in_miit', 'confirmed_no_diff')
    decision(e.id, 'specialized_sme'); decision(other.id, 'little_giant')
    const record = db.insert(schema.record).values({ enterpriseId: e.id, titleCode: 'little_giant', source: 'jxj' }).returning().get()
    const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2022 }).returning().get()
    const evidence = db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: 'synthetic-notice.pdf', page: 1, listNo: 1 }).returning().get()
    mkdirSync(join(dir, 'files'), { recursive: true }); const bytes = minimalPdf({ pages: 3 }); writeFileSync(join(dir, 'files/synthetic-notice.pdf'), bytes)
    const { createHash } = await import('node:crypto')
    createClassifiedFile(db, { relPath: 'synthetic-notice.pdf', filename: 'synthetic-notice.pdf', ext: 'pdf', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, { source: 'jxj', kind: 'announcement', titleCode: 'little_giant' })
    const request = { idempotencyKey: 'official-event-113', sourceIdentity: 'synthetic-notice.pdf', actor, basis: '核对正式年份', operations: [{ enterpriseId: e.id, recordId: record.id, eventId: event.id, expectedRevision: 1, patch: { year: 2023 } }] }
    const plan = await rpc('preflight_event_corrections', request)
    await rpc('commit_event_corrections', { request, planHash: plan.planHash }); drain()
    let rows = listEvidenceImpacts113(db, { enterpriseId: e.id })
    expect(rows.map(r => r.decisionId)).toEqual([a.id, b.id])
    expect(listImpactEvidence113(db, rows[0]!.id)).toEqual([expect.objectContaining({ eventId: event.id, sourceKind: 'official_event' })])
    expect(listEvidenceImpacts113(db, { enterpriseId: other.id })).toEqual([])
    const previous = rows[0]!.latestRevisionId
    const original = await rpc('get_roster_evidence', { id: evidence.id })
    const correction = { idempotencyKey: 'official-evidence-113', actor, basis: '核对出处页码', operations: [{ evidenceId: evidence.id, eventId: event.id, recordId: record.id, enterpriseId: e.id, expectedVersion: original.version, coordinate: { sourceFile: 'synthetic-notice.pdf', attachment: null, listNo: 1, page: 2 } }] }
    const preflight = await rpc('preflight_roster_evidence_corrections', correction)
    await rpc('commit_roster_evidence_corrections', { request: correction, planHash: preflight.planHash }); drain()
    rows = listEvidenceImpacts113(db, { enterpriseId: e.id })
    expect(rows.every(r => r.latestRevisionId > previous)).toBe(true)
    const token = readEvidenceToken113(db, { enterpriseId: e.id, titleCode: 'little_giant', direction: 'missing_in_miit' })
    expect(token).toMatchObject({ decisionId: a.id, latestRevisionId: rows[0]!.latestRevisionId, projectionReady: true })
  })

  it('rolls back evidence work with fact and projection failures and keeps committed replay stable', async () => {
    const e = seed('事务回滚主体', 'TX-113'); decision(e.id)
    const q = { interface: 'business_list', queryKey: e.usccNorm, titleCode: 'specialized_sme', rdjb: '2', queriedAt: '2026-10-19T05:00:00Z', status: 'success', relations: [{ sequenceNo: 1, enterpriseId: e.id, nameRaw: e.name }] }
    const scope = { enterpriseId: e.id, titleCode: 'specialized_sme', direction: 'missing_in_miit' as const }
    const before = readEvidenceToken113(db, scope)
    // This runs after query + evidence revision insertion, before the facts transaction finishes.
    db.run(sql`create trigger fail_alias_113 before insert on enterprise_alias when new.name='故障别名' begin select raise(abort,'synthetic transaction failure'); end`)
    const request = batch('atomic-failure-113', { platformQueries: [q], aliases: [{ enterpriseName: e.name, name: '故障别名', sourceKind: 'manual', sourceRefId: 0, verificationStatus: 'confirmed' }] })
    expect((await client.commit(request)).status).toBe('failed')
    drain(); expect(readEvidenceToken113(db, scope)).toEqual(before); expect(listEvidenceImpacts113(db, { enterpriseId: e.id })).toEqual([])
    db.run(sql`drop trigger fail_alias_113`)
    expect((await client.commit(request)).status).toBe('committed')
    const pending = readEvidenceToken113(db, scope)
    expect(pending.projectionReady).toBe(false)
    db.run(sql`create trigger fail_projection_113 before insert on evidence_impact_link_113 begin select raise(abort,'synthetic projection failure'); end`)
    expect(() => processEvidenceImpacts113(db, { limit: 1 })).toThrow('synthetic projection failure')
    expect(listEvidenceImpacts113(db, { enterpriseId: e.id })).toEqual([])
    expect(readEvidenceToken113(db, scope).projectionReady).toBe(false)
    db.run(sql`drop trigger fail_projection_113`)
    const one = processEvidenceImpacts113(db, { limit: 1 }); expect(one.processed).toBe(1)
    drain(); const state = listEvidenceImpacts113(db, { enterpriseId: e.id })
    expect(state).toHaveLength(1)
    const replay = await rpc('save_roster_batch', request); expect(replay.status).toBe('committed'); drain()
    expect(listEvidenceImpacts113(db, { enterpriseId: e.id })).toEqual(state)
  })

  it.each(['import_batch', 'import_receipt'] as const)('atomically rolls back facts and revisions on %s finalization failure and retries across HTTP and MCP', async table => {
    const e = seed(`收据回滚主体-${table}`, `RECEIPT-113-${table}`), d = decision(e.id)
    const scope = { enterpriseId: e.id, titleCode: 'specialized_sme', direction: 'missing_in_miit' as const }
    const query = { interface: 'business_list', queryKey: e.usccNorm, titleCode: 'specialized_sme', rdjb: '2', queriedAt: '2026-10-19T06:00:00Z', status: 'success', relations: [{ sequenceNo: 1, enterpriseId: e.id, status: '新的实质事实' }] }
    const request = batch(`receipt-atomic-113-${table}`, { platformQueries: [query] })
    const before = readEvidenceToken113(db, scope)
    const revisionCount = db.select().from(schema.evidenceRevision113).all().length
    const facts = () => db.get<{ n: number }>(sql`select count(*) n from platform_collection where query_key=${e.usccNorm}`)!.n
    const getReceipt = async (selector: string) => {
      const response = await fetch(baseUrl + '/api/roster/import/receipts?' + selector, { headers: { authorization: 'Bearer synthetic-api' } })
      expect(response.status).toBe(200)
      return response.json()
    }
    // The integrated #103 wrapper encloses the fact hooks and both terminal status writes.
    db.run(sql`create trigger fail_receipt_113 before update of status on ${sql.raw(table)} when new.status='committed' begin select raise(abort,'synthetic receipt failure'); end`)
    try {
      const response = await fetch(baseUrl + '/api/roster/import/commit', { method: 'POST', headers: { authorization: 'Bearer synthetic-api', 'content-type': 'application/json' }, body: JSON.stringify(request) })
      expect(response.status).toBe(500)
    } finally { db.run(sql`drop trigger fail_receipt_113`) }
    expect(facts()).toBe(0)
    expect(db.select().from(schema.evidenceRevision113).all()).toHaveLength(revisionCount)
    expect(readEvidenceToken113(db, scope)).toEqual(before)
    drain(); expect(listEvidenceImpacts113(db, { enterpriseId: e.id })).toEqual([])
    const failed = await getReceipt('idempotencyKey=' + request.idempotencyKey)
    expect(failed).toMatchObject({ status: 'failed', receiptId: expect.any(Number) })

    expect(await rpc('save_roster_batch', request)).toMatchObject({ status: 'committed', batchId: failed.batchId })
    expect(facts()).toBe(1)
    expect(readEvidenceToken113(db, scope).projectionReady).toBe(false)
    drain()
    const state = listEvidenceImpacts113(db, { enterpriseId: e.id })
    expect(state).toEqual([expect.objectContaining({ decisionId: d.id, classification: 'premise_invalid' })])
    expect(state[0]!.latestRevisionId).toBeGreaterThan(before.latestRevisionId)
    expect(await getReceipt('receiptId=' + failed.receiptId)).toEqual(failed)
    expect(await getReceipt('idempotencyKey=' + request.idempotencyKey)).toMatchObject({ status: 'committed' })
    expect((await client.commit(request)).status).toBe('committed'); drain()
    expect(facts()).toBe(1)
    expect(listEvidenceImpacts113(db, { enterpriseId: e.id })).toEqual(state)
  })

  it('captures merge survivor coordinates from both owners and keeps historical evidence identity', async () => {
    const into = seed('归并规范企业', '91330211316904639T'), from = seed('归并历史企业')
    const a = decision(from.id, 'innovative_sme', 'missing_in_miit', 'confirmed_no_diff'), b = decision(into.id, 'specialized_sme', 'extra_in_miit', 'confirmed_no_diff')
    const record = db.insert(schema.record).values({ enterpriseId: from.id, titleCode: 'innovative_sme', source: 'jxj' }).returning().get()
    const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2022 }).returning().get()
    const exportBatch = db.insert(schema.platformExportBatch).values({ titleCode: 'innovative_sme', year: 2024, collectedOn: '2026-10-19', originalFilename: 'linked-merge.xlsx', sha256: 'linked-merge', rowCount: 1, importStatus: 'imported' }).returning().get()
    const exportRow = db.insert(schema.platformExportRow).values({ batchId: exportBatch.id, sourceRowNo: 1, usccRaw: into.usccNorm }).returning().get()
    db.insert(schema.recordCorrespondence).values({ edgeKey: 'merge-associated-event-113', type: 'event_export_context', role: 'current_snapshot_context', eventId: event.id, exportRowId: exportRow.id, enterpriseId: from.id, titleCode: 'innovative_sme', status: 'confirmed', revision: 1, targetIdentity: {}, provenance: {}, sourceFingerprint: 'synthetic', ruleId: 'manual', ruleVersion: '1', createdAt: '2026-10-19' }).run()
    const result = await client.commit(batch('merge-113', { merges: [{ fromEnterpriseId: from.id, intoUscc: into.usccNorm, sourceKind: 'manual', sourceRefId: 0 }] }))
    expect(result.status, JSON.stringify(result)).toBe('committed'); drain()
    const rows = listEvidenceImpacts113(db, { enterpriseId: into.id })
    expect(rows.map(r => r.decisionId)).toEqual([a.id, b.id])
    expect(rows.every(r => r.classification === 'evidence_changed')).toBe(true)
    expect(listImpactEvidence113(db, rows[0]!.id)[0]!.metadata).toMatchObject({ fromEnterpriseId: from.id })
    const exact = await rpc('get_official_event', { eventId: event.id })
    expect(exact.record.enterpriseId).toBe(into.id)
    expect(exact.event.id).toBe(event.id)
    const revision = rows[0]!.latestRevisionId
    expect(listRevisionEvents113(db, revision, { enterpriseId: into.id })).toEqual([expect.objectContaining({ eventId: event.id, enterpriseId: into.id, titleCode: 'innovative_sme' })])
  })

  it('registers newly imported official events and ignores same-content announcement replay', async () => {
    const e = seed('新增正式事实主体'); const d = decision(e.id, 'innovative_sme', 'missing_in_miit', 'confirmed_no_diff')
    const req: RosterImportRequest = { idempotencyKey: 'official-import-113', sourceKind: 'announcement' as const, sourceIdentity: 'synthetic-new.docx', payload: { announcement: { sourceDocument: { source: 'jxj', title: '合成正式通知' }, records: [{ enterprise: { name: e.name }, titleCode: 'innovative_sme', events: [{ eventType: 'award', year: 2024, evidence: [{ sourceFile: 'synthetic-new.docx', listNo: 1 }] }] }] } } }
    const result = await client.commit(req)
    expect(result.status, JSON.stringify(result)).toBe('committed'); drain()
    const rows = listEvidenceImpacts113(db, { enterpriseId: e.id })
    expect(rows).toEqual([expect.objectContaining({ decisionId: d.id, classification: 'evidence_changed' })])
    expect((await client.commit({ ...req, idempotencyKey: 'official-import-same-content' })).status).toBe('committed'); drain()
    expect(listEvidenceImpacts113(db, { enterpriseId: e.id })).toEqual(rows)
  })

  it('does not infer unknown subjects or revive withdrawn decisions, and failed coverage does not replace substantive facts', async () => {
    const e = seed('未知主体边界', 'UNKNOWN-OWNER-113'), similar = seed('近似未知主体边界', 'SIMILAR-113')
    const d = decision(e.id, 'specialized_sme', 'missing_in_miit', 'confirmed_no_diff'); decision(similar.id)
    const q = { interface: 'business_list', queryKey: e.usccNorm, titleCode: 'specialized_sme', rdjb: '2', status: 'success', queriedAt: '2026-10-19T07:00:00Z', relations: [{ sequenceNo: 1, nameRaw: e.name, usccRaw: 'UNMATCHED-CODE-113', status: '未知主体事实' }] }
    expect((await client.commit(batch('unknown-subject-113', { platformQueries: [q] }))).status).toBe('committed'); drain()
    expect(listEvidenceImpacts113(db, { enterpriseId: e.id })).toEqual([])
    expect(listEvidenceImpacts113(db, { enterpriseId: similar.id })).toEqual([])
    expect((await client.commit(batch('known-subject-113', { platformQueries: [{ ...q, queriedAt: '2026-10-19T08:00:00Z', relations: [{ sequenceNo: 1, enterpriseId: e.id, status: '已确认事实' }] }] }))).status).toBe('committed'); drain()
    const before = listEvidenceImpacts113(db, { enterpriseId: e.id })
    expect(before).toEqual([expect.objectContaining({ decisionId: d.id, classification: 'evidence_changed' })])
    expect((await client.commit(batch('failed-coverage-113', { platformQueries: [{ ...q, queriedAt: '2026-10-19T09:00:00Z', status: 'failed', relations: [] }] }))).status).toBe('committed'); drain()
    expect(listEvidenceImpacts113(db, { enterpriseId: e.id })).toEqual(before)
    const withdrawal = await rpc('save_difference_decision', { enterpriseId: similar.id, titleCode: 'specialized_sme', direction: 'missing_in_miit', action: 'withdraw', expectedCurrentId: (await rpc('get_current_difference_decision', { enterpriseId: similar.id, titleCode: 'specialized_sme', direction: 'missing_in_miit' })).versionId, idempotencyKey: 'withdraw-impact-113', actor, basis: '明确撤回', ruleVersion: 'manual-113', effectiveAt: '2026-10-19T00:00:00Z' })
    expect((await client.commit(batch('withdrawn-evidence-113', { platformQueries: [{ ...q, queryKey: similar.usccNorm, queriedAt: '2026-10-19T10:00:00Z', relations: [{ sequenceNo: 1, enterpriseId: similar.id, status: '新事实' }] }] }))).status).toBe('committed'); drain()
    expect(listEvidenceImpacts113(db, { enterpriseId: similar.id })).toEqual([])
    expect(readEvidenceToken113(db, { enterpriseId: similar.id, titleCode: 'specialized_sme', direction: 'missing_in_miit' }).decisionId).toBe(withdrawal.versionId)
  })

  it('preserves multi-title page ownership and ignores another explicit condition partition of a bound decision', async () => {
    const e = seed('多称号原档主体', '913300000000000004')
    const a = decision(e.id, 'innovative_sme', 'missing_in_miit', 'confirmed_no_diff'), b = decision(e.id, 'specialized_sme', 'extra_in_miit', 'confirmed_no_diff')
    decision(e.id, 'little_giant', 'missing_in_miit', 'confirmed_no_diff')
    const result: PlatformLiveQueryResult = { source: 'queryBusList', status: 'success', effectiveConditions: { uscc: e.usccNorm!, combination: 'and', whpcyear: '2024' }, titleScope: { mode: 'selected', rdjb: ['1', '2'] }, queriedAt: '2026-10-19T11:00:00Z', completedAt: '2026-10-19T11:01:00Z', rows: [{ id: 'multi-1', tyshxydm: e.usccNorm!, qymc: e.name, whpcyear: '2024' }], pages: [
      { source: 'queryBusList', rdjb: '1', page: 1, status: 'success', fetchedCount: 1, declaredTotal: 1, maxPage: 1, error: null },
      { source: 'queryBusList', rdjb: '2', page: 1, status: 'success', fetchedCount: 0, declaredTotal: 0, maxPage: 1, error: null },
    ], fetchedCount: 1, declaredTotal: 1, completeness: 'complete', fullRange: true, unfinished: [], error: null, limits: { pageSize: 50, maxRows: 5000, maxRequests: 100, maxDurationMs: 60000 } }
    const imported = await client.commit(batch('multi-title-113', { platformQueries: [recognizedResultToImport(result)] }))
    expect(imported.status, JSON.stringify(imported)).toBe('committed'); drain()
    const rows = listEvidenceImpacts113(db, { enterpriseId: e.id })
    expect(rows.map(r => r.decisionId)).toEqual([a.id, b.id])
    const queryId = (imported.items.find(i => i.kind === 'platform_query')!.ref).split(':')[1]
    const replaced = await rpc('save_difference_decision', { enterpriseId: e.id, titleCode: 'innovative_sme', direction: 'missing_in_miit', action: 'replace', expectedCurrentId: a.id, idempotencyKey: 'bind-partition-113', actor, basis: '仅审2024明确范围', ruleVersion: 'manual-113', effectiveAt: '2026-10-19T00:00:00Z', decision: { status: 'confirmed_no_diff', measureCode: 'none', verificationStatus: 'confirmed', evidenceQueryId: Number(queryId) } })
    const different = { ...result, queriedAt: '2026-10-19T12:00:00Z', completedAt: '2026-10-19T12:01:00Z', effectiveConditions: { ...result.effectiveConditions, whpcyear: '2025' }, rows: [{ ...result.rows[0]!, whpcyear: '2025' }] }
    expect((await client.commit(batch('other-condition-113', { platformQueries: [recognizedResultToImport(different)] }))).status).toBe('committed'); drain()
    expect(listEvidenceImpacts113(db, { enterpriseId: e.id }).some(r => r.decisionId === replaced.versionId)).toBe(false)
  })

})
