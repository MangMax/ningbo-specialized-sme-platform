import { createRuntimeSchema } from '../../../db/create-runtime'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createApp, createRouter, toNodeListener, defineEventHandler } from 'h3'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { z } from 'zod'
import * as schema from '../../../db/schema'
import type { OfficialPublishedRow, RosterImportPayload, RosterImportRequest, RosterImportRecord } from '../../../lib/roster-import-client'
import type { EvidenceCorrectionRequest } from '../../../server/utils/roster-evidence-correction'
import { commitRosterImport, preflightRosterImport } from '../../../server/utils/roster-import'

type Execute = typeof import('../../../server/utils/import-execution')['importExecutor']['execute']
const current = vi.hoisted((): { db?: BetterSQLite3Database<typeof schema>; filesDir: string } => ({ filesDir: '' }))
vi.mock('@db', () => ({ useDb: () => { if (!current.db) throw new Error('Synthetic database not initialized'); return current.db } }))
// Replace only process admission; real production routes/planners/writers run in H3/SQLite.
vi.mock('../../../server/utils/import-execution', () => ({ importExecutor: { execute: async (...[db, action, request, errors, context, source]: Parameters<Execute>) => action === 'preflight' ? preflightRosterImport(db, request, errors, { ...context, ...source }) : commitRosterImport(db, request, errors, { ...context, ...source }) } }))
const closes: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })
afterAll(() => { vi.unstubAllGlobals() })
const router = createRouter()
beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  vi.stubGlobal('useRuntimeConfig', () => ({ apiToken: 'synthetic-r3', filesDir: current.filesDir }))
  router.post('/api/roster/import/preflight', (await import('../../../server/api/roster/import/preflight.post')).default)
  router.post('/api/roster/import/commit', (await import('../../../server/api/roster/import/commit.post')).default)
  router.post('/api/roster/evidence/corrections/preflight', (await import('../../../server/api/roster/evidence/corrections/preflight.post')).default)
  router.post('/api/roster/evidence/corrections/commit', (await import('../../../server/api/roster/evidence/corrections/commit.post')).default)
  router.get('/api/roster/evidence/:id', (await import('../../../server/api/roster/evidence/[id].get')).default)
})
const importResult = z.object({ status: z.string().optional(), batchId: z.number().optional(), items: z.array(z.unknown()).optional(), preflight: z.object({ conflicts: z.array(z.object({ error: z.object({ code: z.string() }) })), officialEvidencePlanHash: z.string().optional() }).optional() }).passthrough()
const exactResult = z.object({ evidenceId: z.number(), eventId: z.number(), recordId: z.number(), enterpriseId: z.number(), version: z.string(), event: z.object({ revision: z.number() }), coordinate: z.object({ sourceFile: z.string(), attachment: z.string().nullable(), listNo: z.number().nullable(), page: z.number().nullable() }) })
const errorResult = z.object({ error: z.object({ code: z.string() }) })
const text = 'synthetic official row\n', sha256 = createHash('sha256').update(text).digest('hex')
const evidenceRow = z.object({ id: z.number(), record_event_id: z.number(), source_file: z.string(), list_no: z.number() })
async function fixture() {
  const dir = mkdtempSync('/tmp/issue350-r3-noop-'), filesDir = join(dir, 'files'); mkdirSync(filesDir)
  for (const path of ['notice.txt', 'other.txt']) writeFileSync(join(filesDir, path), text)
  const sqlite = new Database(join(dir, 'synthetic.sqlite')); sqlite.pragma('foreign_keys=ON')
  closes.push(() => { expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1); sqlite.close() })
  const db = drizzle(sqlite, { schema }); createRuntimeSchema(sqlite)
  // Infrastructure catalog only. All enterprise/record/event/evidence/declaration state below is public-command produced.
  for (const [id, path] of [[1, 'notice.txt'], [2, 'other.txt']] as const) {
    sqlite.prepare('INSERT INTO stored_file(id,rel_path,filename,ext,bytes,sha256,created_at) VALUES(?,?,?,\'txt\',?,?,\'synthetic\')').run(id, path, path, Buffer.byteLength(text), sha256)
    sqlite.prepare("INSERT INTO roster_file_classification(file_id, source, kind, title_code) VALUES (?, 'jxj', 'announcement', 'specialized_sme')").run(id)
  }
  current.db = db; current.filesDir = filesDir
  const server = createServer(toNodeListener(createApp().use(router)))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  closes.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected owned TCP listener')
  const trace: unknown[] = []
  closes.push(() => { writeFileSync(join(dir, 'public-commands.json'), JSON.stringify(trace, null, 2)) })
  const http = async (path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer synthetic-r3', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const output: unknown = await response.json(); trace.push({ path, body, status: response.status, output })
    return { status: response.status, body: output }
  }
  const post = async (action: 'preflight' | 'commit', body: RosterImportRequest) => {
    const response = await http(`/api/roster/import/${action}`, body); expect(response.status).toBe(200)
    return importResult.parse(response.body)
  }
  const request = (payload: RosterImportPayload, key: string): RosterImportRequest => ({ idempotencyKey: key, sourceKind: 'announcement', sourceIdentity: 'synthetic-r3', payload })
  const commit = async (input: RosterImportRequest) => {
    const plan = await post('preflight', input); expect(plan.preflight?.conflicts).toEqual([])
    const bound = plan.preflight?.officialEvidencePlanHash ? { ...input, payload: { ...input.payload, officialEvidencePlanHash: plan.preflight.officialEvidencePlanHash } } : input
    const result = await post('commit', bound); expect(result.status, JSON.stringify(result)).toBe('committed')
    expect(await post('commit', bound)).toEqual(result)
    return { result, bound }
  }
  const exact = async (id: number) => { const output = await http(`/api/roster/evidence/${id}`); expect(output.status).toBe(200); return exactResult.parse(output.body) }
  const row = (declaration: OfficialPublishedRow['declaration']): OfficialPublishedRow => ({ nameRaw: 'Alpha original', usccRaw: 'printed code', districtRaw: 'printed district', declaration, storedFileId: 1, path: 'notice.txt', sha256, bytes: Buffer.byteLength(text), attachment: null, sectionKey: 'awards', listNo: 10, page: null, sourceBindingKnown: true, actor: { type: 'agent', id: 'synthetic' }, basis: 'Verified row' })
  const evidence = (sourceFile: string, listNo: number, publishedRow?: OfficialPublishedRow) => ({ sourceFile, attachment: null, listNo, page: null, ...(publishedRow ? { publishedRow } : {}) })
  const record = (name: 'Alpha' | 'Beta', year: number, entries: NonNullable<RosterImportRecord['events']>[number]['evidence']): RosterImportRecord => ({ enterprise: { name, ...(name === 'Beta' ? { uscc: '91330211255994457P' } : {}) }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year, evidence: entries }] })
  const announcement = (records: RosterImportRecord[]): RosterImportPayload => ({ announcement: { sourceDocument: { source: 'jxj', title: 'Declared publication' }, records } })
  const snapshot = () => Object.fromEntries(['enterprise', 'record', 'record_event', 'record_evidence', 'source_document', 'official_evidence_row_revision', 'evidence_correction_audit', 'evidence_revision_113', 'evidence_revision_event_113'].map(table => [table, sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
  const rows = () => z.array(evidenceRow).parse(sqlite.prepare('SELECT * FROM record_evidence ORDER BY id').all())
  const setup = async (sameEvent: boolean, unknown: boolean) => {
    const initial = row({ kind: 'independent', sourceDocument: { source: 'jxj', title: 'Declared publication', docNumber: null, issueDate: null, path: 'notice.txt' }, basis: 'Explicit independently verified declaration' })
    await commit(request(announcement([record('Alpha', 2022, [evidence('notice.txt', 10, initial), ...(sameEvent ? [evidence('other.txt', 20)] : [])])]), 'seed-known'))
    const knownId = rows().find(r => r.list_no === 10)?.id; if (!knownId) throw new Error('Known capture missing')
    if (!sameEvent) await commit(request(announcement([record('Alpha', 2020, [evidence('other.txt', 20)])]), 'seed-target-other-event'))
    const targetId = rows().find(r => r.list_no === 20)?.id; if (!targetId) throw new Error('Correction target missing')
    await commit(request(announcement([record('Alpha', 2022, [evidence('other.txt', 10)])]), 'legacy-move-known'))
    expect(await exact(knownId)).toMatchObject({ coordinate: { sourceFile: 'other.txt', listNo: 10 } })
    const knownBefore = sqlite.prepare('SELECT * FROM official_evidence_row_revision WHERE evidence_id=?').all(knownId)
    expect(knownBefore).toMatchObject([{ revision: 1, path: 'notice.txt', name_raw: 'Alpha original', uscc_raw: 'printed code', district_raw: 'printed district' }])
    if (unknown) await commit(request(announcement([record('Beta', 2025, [evidence('notice.txt', 10)])]), 'legacy-unknown-beta'))
    const source = z.object({ source_document_id: z.number() }).parse(sqlite.prepare('SELECT source_document_id FROM official_evidence_row_revision WHERE evidence_id=?').get(knownId))
    const publishedRow = row({ kind: 'existing', sourceDocumentId: source.source_document_id, basis: 'Verified declaration' })
    const correction = async (key: string, revision = 0): Promise<EvidenceCorrectionRequest> => {
      const target = await exact(targetId)
      return { idempotencyKey: key, actor: { type: 'agent', id: 'synthetic' }, basis: 'Explicit original row correction', operations: [{ evidenceId: targetId, eventId: target.eventId, recordId: target.recordId, enterpriseId: target.enterpriseId, expectedVersion: target.version, coordinate: { sourceFile: 'notice.txt', attachment: null, listNo: 10, page: null }, publishedRow, expectedRowRevision: revision }] }
    }
    return { knownId, targetId, knownBefore, publishedRow, correction }
  }
  return { sqlite, http, post, request, commit, exact, snapshot, rows, setup }
}

for (const entry of ['import', 'standalone'] as const) for (const sameEvent of [true, false]) it(`R3 S1 ${entry} ${sameEvent ? 'same-event' : 'cross-event'} correction rejects Beta unknown atomically`, async () => {
  const f = await fixture(), state = await f.setup(sameEvent, true), correction = await state.correction('reject-unknown'), before = f.snapshot()
  if (entry === 'import') {
    const { idempotencyKey: key, ...command } = correction, input = f.request({ officialEvidenceCorrections: command }, key)
    const plan = await f.post('preflight', input)
    const bound = plan.preflight?.officialEvidencePlanHash ? { ...input, payload: { ...input.payload, officialEvidencePlanHash: plan.preflight.officialEvidencePlanHash } } : input
    const result = await f.post('commit', bound)
    expect(plan.preflight?.conflicts).toMatchObject([{ error: { code: 'ambiguity' } }]); expect(result.status).toBe('failed')
  } else {
    const plan = await f.http('/api/roster/evidence/corrections/preflight', correction)
    // A rejection has no hash; a successful (buggy) preflight must be committed with its real hash.
    const planHash = z.object({ planHash: z.string() }).safeParse(plan.body)
    const result = await f.http('/api/roster/evidence/corrections/commit', { request: correction, planHash: planHash.success ? planHash.data.planHash : '0'.repeat(64) })
    expect(plan.status).toBe(409); expect(errorResult.parse(plan.body).error.code).toBe('ambiguity')
    expect(result.status).toBe(409); expect(errorResult.parse(result.body).error.code).toBe('ambiguity')
    expect(f.sqlite.prepare('SELECT count(*) n FROM evidence_correction_batch').get()).toEqual({ n: 0 })
  }
  expect(f.snapshot()).toEqual(before)
  expect(await f.exact(state.targetId)).toMatchObject({ coordinate: { sourceFile: 'other.txt', listNo: 20 } })
})

const auditValue = z.object({ coordinate: z.object({ sourceFile: z.string(), listNo: z.number() }), row: z.null().optional(), rowRevision: z.number().optional(), publishedRow: z.object({ nameRaw: z.string(), usccRaw: z.string(), districtRaw: z.string() }).optional(), importBatchId: z.number().optional() })
for (const entry of ['import', 'standalone'] as const) for (const sameEvent of [true, false]) it(`R3 S1 ${entry} ${sameEvent ? 'same-event' : 'cross-event'} compatible correction keeps named ID raw audit CAS113 and receipt`, async () => {
  const f = await fixture(), state = await f.setup(sameEvent, false), correction = await state.correction('compatible'), prior = await f.exact(state.targetId)
  const revisions = f.sqlite.prepare('SELECT * FROM evidence_revision_113 ORDER BY id').all(), records = f.sqlite.prepare('SELECT * FROM record ORDER BY id').all()
  if (entry === 'import') {
    const { idempotencyKey: key, ...command } = correction
    const { result } = await f.commit(f.request({ officialEvidenceCorrections: command }, key))
    expect(result.items).toEqual(expect.arrayContaining([expect.objectContaining({ detail: expect.objectContaining({ evidence: expect.arrayContaining([expect.objectContaining({ evidenceId: state.targetId, revision: 1 })]) }) })]))
  } else {
    const plan = await f.http('/api/roster/evidence/corrections/preflight', correction); expect(plan.status).toBe(200)
    const hash = z.object({ planHash: z.string(), impact: z.object({ updated: z.literal(1), audit: z.literal(1) }) }).parse(plan.body).planHash
    const bound = { request: correction, planHash: hash }, result = await f.http('/api/roster/evidence/corrections/commit', bound)
    expect(result.status).toBe(200); expect(result.body).toMatchObject({ status: 'committed', evidenceIds: [state.targetId], impact: { updated: 1, audit: 1 } })
    expect(await f.http('/api/roster/evidence/corrections/commit', bound)).toEqual(result)
  }
  expect(f.rows()).toHaveLength(2)
  expect(await f.exact(state.targetId)).toMatchObject({ evidenceId: state.targetId, eventId: prior.eventId, coordinate: { sourceFile: 'notice.txt', listNo: 10 }, event: { revision: prior.event.revision + 1 } })
  expect(f.sqlite.prepare('SELECT * FROM official_evidence_row_revision WHERE evidence_id=?').all(state.knownId)).toEqual(state.knownBefore)
  expect(f.sqlite.prepare('SELECT * FROM record ORDER BY id').all()).toEqual(records)
  expect(f.sqlite.prepare('SELECT * FROM official_evidence_row_revision WHERE evidence_id=?').all(state.targetId)).toMatchObject([{ revision: 1, name_raw: 'Alpha original', uscc_raw: 'printed code', district_raw: 'printed district', path: 'notice.txt', list_no: 10 }])
  const audits = z.array(z.object({ evidence_id: z.number(), event_id: z.number(), batch_key: z.string().nullable(), before: z.string(), after: z.string() })).parse(f.sqlite.prepare('SELECT * FROM evidence_correction_audit ORDER BY id').all())
  expect(audits).toHaveLength(1)
  const audit = audits[0]; if (!audit) throw new Error('Expected correction audit')
  expect(audit).toMatchObject({ evidence_id: state.targetId, event_id: prior.eventId, batch_key: entry === 'import' ? null : 'compatible' })
  expect(auditValue.parse(JSON.parse(audit.before))).toMatchObject({ coordinate: { sourceFile: 'other.txt', listNo: 20 }, row: null })
  expect(auditValue.parse(JSON.parse(audit.after))).toMatchObject({ coordinate: { sourceFile: 'notice.txt', listNo: 10 }, rowRevision: 1, publishedRow: { nameRaw: 'Alpha original', usccRaw: 'printed code', districtRaw: 'printed district' } })
  expect(f.sqlite.prepare('SELECT * FROM evidence_revision_113 ORDER BY id').all()).toHaveLength(revisions.length + 1)
})

it("S1 genuine append no-op reuses known association without propagating historical locator or unknown state", async () => {
  const f = await fixture(), state = await f.setup(true, true), known = await f.exact(state.knownId), before = f.snapshot()
  const { result } = await f.commit(f.request({ officialEvidenceAppends: [{ eventId: known.eventId, recordId: known.recordId, enterpriseId: known.enterpriseId, expectedVersion: known.event.revision, evidence: { sourceFile: 'notice.txt', attachment: null, listNo: 10, page: null, publishedRow: state.publishedRow } }] }, 'append-noop'))
  expect(result.items).toEqual(expect.arrayContaining([expect.objectContaining({ detail: expect.objectContaining({ evidence: [{ evidenceId: state.knownId, eventId: known.eventId, unchanged: true }] }) })]))
  expect(f.snapshot()).toEqual(before)
  expect(await f.exact(state.knownId)).toEqual(known)
})

for (const entry of ['import', 'standalone'] as const) it(`R3 S1 ${entry} genuine unchanged correction creates no row revision audit or CAS113`, async () => {
  const f = await fixture(), state = await f.setup(true, false)
  const apply = async (correction: EvidenceCorrectionRequest) => {
    if (entry === 'import') { const { idempotencyKey: key, ...command } = correction; return f.commit(f.request({ officialEvidenceCorrections: command }, key)) }
    const plan = await f.http('/api/roster/evidence/corrections/preflight', correction); expect(plan.status).toBe(200)
    const { planHash } = z.object({ planHash: z.string() }).parse(plan.body), bound = { request: correction, planHash }
    const result = await f.http('/api/roster/evidence/corrections/commit', bound); expect(result.status).toBe(200)
    expect(await f.http('/api/roster/evidence/corrections/commit', bound)).toEqual(result)
    return result
  }
  await apply(await state.correction('first-change'))
  const before = f.snapshot(), exact = await f.exact(state.targetId)
  await apply(await state.correction('genuine-unchanged', 1))
  expect(f.snapshot()).toEqual(before); expect(await f.exact(state.targetId)).toEqual(exact)
})

type PublicFixture = Awaited<ReturnType<typeof fixture>>
type CorrectionOperation = EvidenceCorrectionRequest['operations'][number]
async function finalOperation(f: PublicFixture, id: number, publishedRow: OfficialPublishedRow): Promise<CorrectionOperation> {
  const target = await f.exact(id)
  const latest = f.sqlite.prepare('SELECT revision FROM official_evidence_row_revision WHERE evidence_id=? ORDER BY revision DESC LIMIT 1').get(id)
  if (publishedRow.path === null) throw new Error('Explicit synthetic path required')
  return { evidenceId: id, eventId: target.eventId, recordId: target.recordId, enterpriseId: target.enterpriseId, expectedVersion: target.version, expectedRowRevision: latest === undefined ? 0 : z.object({ revision: z.number() }).parse(latest).revision, coordinate: { sourceFile: publishedRow.path, attachment: publishedRow.attachment, listNo: publishedRow.listNo, page: publishedRow.page }, publishedRow }
}
async function submitFinalCorrections(f: PublicFixture, entry: 'import' | 'standalone', operations: CorrectionOperation[], key: string, rejected?: string) {
  const command = { actor: { type: 'agent' as const, id: 'synthetic' }, basis: 'Explicit verified final corrections', operations }, before = f.snapshot()
  if (entry === 'import') {
    const input = f.request({ officialEvidenceCorrections: command }, key)
    const plan = await f.post('preflight', input)
    const bound = plan.preflight?.officialEvidencePlanHash ? { ...input, payload: { ...input.payload, officialEvidencePlanHash: plan.preflight.officialEvidencePlanHash } } : input
    const result = await f.post('commit', bound)
    if (!rejected) {
      expect(plan.preflight?.conflicts).toEqual([]); expect(result.status, JSON.stringify(result)).toBe('committed')
      expect(await f.post('commit', bound)).toEqual(result)
      return result
    }
    expect(plan.preflight?.conflicts).toMatchObject([{ error: { code: rejected } }]); expect(result.status).toBe('failed')
  } else {
    const request = { idempotencyKey: key, ...command }, plan = await f.http('/api/roster/evidence/corrections/preflight', request)
    const parsed = z.object({ planHash: z.string() }).safeParse(plan.body)
    const bound = { request, planHash: parsed.success ? parsed.data.planHash : '0'.repeat(64) }
    const result = await f.http('/api/roster/evidence/corrections/commit', bound)
    if (!rejected) {
      expect(plan.status, JSON.stringify(plan.body)).toBe(200)
      expect(result.status).toBe(200)
      expect(result.body).toMatchObject({ status: 'committed', evidenceIds: operations.map(op => op.evidenceId) })
      expect(await f.http('/api/roster/evidence/corrections/commit', bound)).toEqual(result)
      return result
    }
    expect(plan.status).toBe(409); expect(errorResult.parse(plan.body).error.code).toBe(rejected)
    expect(result.status).toBe(409); expect(errorResult.parse(result.body).error.code).toBe(rejected)
  }
  expect(f.snapshot()).toEqual(before)
}
async function setupFinalClaims(entry: 'import' | 'standalone', secondKnown: boolean, sameEvent = true) {
  const f = await fixture(), state = await f.setup(sameEvent, false)
  if (secondKnown) await submitFinalCorrections(f, entry, [await finalOperation(f, state.targetId, state.publishedRow)], 'seed-second-known')
  // Restore the known live locator through an exact public command. Both r1
  // facts survive; the subsequent two-known request is genuinely raw-only.
  await submitFinalCorrections(f, entry, [await finalOperation(f, state.knownId, state.publishedRow)], 'restore-known-live')
  const next = { ...state.publishedRow, nameRaw: 'Alpha corrected' }
  return { f, state, next, ids: [state.knownId, state.targetId] }
}
const finalAudit = z.object({ coordinate: z.object({ sourceFile: z.string(), listNo: z.number() }), row: z.object({ nameRaw: z.string() }).nullable().optional(), rowRevision: z.number().optional(), publishedRow: z.object({ nameRaw: z.string() }).optional(), importBatchId: z.number().optional() })
for (const entry of ['import', 'standalone'] as const) for (const secondKnown of [true, false]) for (const reverse of [false, true]) it(`R4 S1 ${entry} ${secondKnown ? 'two-known raw-only' : 'known-plus-legacy'} final corrections commit in ${reverse ? 'reverse' : 'forward'} order`, async () => {
  const { f, state, next, ids } = await setupFinalClaims(entry, secondKnown), before = f.snapshot()
  const exactBefore = await Promise.all(ids.map(id => f.exact(id)))
  if (secondKnown) for (const t of exactBefore) expect(t.coordinate).toEqual({ sourceFile: 'notice.txt', attachment: null, listNo: 10, page: null })
  const auditsBefore = z.object({ n: z.number() }).parse(f.sqlite.prepare('SELECT count(*) n FROM evidence_correction_audit').get()).n
  const revisionsBefore = z.object({ n: z.number() }).parse(f.sqlite.prepare('SELECT count(*) n FROM evidence_revision_113').get()).n
  const history = ids.map(id => f.sqlite.prepare('SELECT * FROM official_evidence_row_revision WHERE evidence_id=? ORDER BY revision').all(id))
  const operations = await Promise.all(ids.map(id => finalOperation(f, id, next)))
  await submitFinalCorrections(f, entry, reverse ? operations.reverse() : operations, 'joint-final')
  expect(f.rows().map(row => row.id)).toEqual(ids)
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i], prior = exactBefore[i]; if (id === undefined || !prior) throw new Error('Expected exact target')
    expect(await f.exact(id)).toMatchObject({ evidenceId: id, eventId: prior.eventId, coordinate: { sourceFile: 'notice.txt', listNo: 10 }, event: { revision: prior.event.revision + 1 } })
    const facts = f.sqlite.prepare('SELECT * FROM official_evidence_row_revision WHERE evidence_id=? ORDER BY revision').all(id)
    expect(facts.slice(0, -1)).toEqual(history[i])
    expect(facts.at(-1)).toMatchObject({ revision: i === 0 || secondKnown ? 2 : 1, name_raw: 'Alpha corrected', uscc_raw: 'printed code', district_raw: 'printed district', path: 'notice.txt', list_no: 10 })
  }
  const audits = z.array(z.object({ evidence_id: z.number(), batch_key: z.string().nullable(), before: z.string(), after: z.string() })).parse(f.sqlite.prepare('SELECT * FROM evidence_correction_audit ORDER BY id').all()).slice(auditsBefore)
  expect(audits.map(a => a.evidence_id).sort((a, b) => a - b)).toEqual(ids)
  for (const a of audits) {
    const prior = finalAudit.parse(JSON.parse(a.before)), after = finalAudit.parse(JSON.parse(a.after))
    expect(prior.row?.nameRaw ?? null).toBe(a.evidence_id === state.knownId || secondKnown ? 'Alpha original' : null)
    expect(after).toMatchObject({ coordinate: { sourceFile: 'notice.txt', listNo: 10 }, publishedRow: { nameRaw: 'Alpha corrected' } })
    expect(a.batch_key).toBe(entry === 'import' ? null : 'joint-final')
    if (entry === 'import') { expect(after.importBatchId).toBeTypeOf('number'); expect(after.importBatchId).toBe(prior.importBatchId) }
  }
  expect(f.sqlite.prepare('SELECT count(*) n FROM evidence_revision_113').get()).toEqual({ n: revisionsBefore + 1 })
  const after = f.snapshot(); expect(after.record).toEqual(before.record); expect(after.enterprise).toEqual(before.enterprise)
})

for (const entry of ['import', 'standalone'] as const) it(`R4 S1 ${entry} known-plus-legacy sequential control reaches the same final raw`, async () => {
  const { f, next, ids } = await setupFinalClaims(entry, false)
  for (const id of ids) await submitFinalCorrections(f, entry, [await finalOperation(f, id, next)], `sequential-${id}`)
  for (const id of ids) expect(f.sqlite.prepare('SELECT name_raw FROM official_evidence_row_revision WHERE evidence_id=? ORDER BY revision DESC LIMIT 1').get(id)).toEqual({ name_raw: 'Alpha corrected' })
})
for (const entry of ['import', 'standalone'] as const) it(`R4 S1 ${entry} cross-event compatible final corrections commit`, async () => {
  const { f, next, ids } = await setupFinalClaims(entry, true, false), prior = await Promise.all(ids.map(id => f.exact(id)))
  expect(new Set(prior.map(t => t.eventId)).size).toBe(2)
  await submitFinalCorrections(f, entry, await Promise.all(ids.map(id => finalOperation(f, id, next))), 'cross-event-final')
  for (let i = 0; i < ids.length; i++) { const id = ids[i], old = prior[i]; if (id === undefined || !old) throw new Error('Expected target'); expect(await f.exact(id)).toMatchObject({ event: { revision: old.event.revision + 1 } }) }
})
for (const entry of ['import', 'standalone'] as const) for (const variant of ['single-old-conflict', 'different-final-raw', 'unknown-final', 'different-full-row'] as const) it(`R4 S1 ${entry} ${variant} rejects without changing final state`, async () => {
  const { f, next, ids } = await setupFinalClaims(entry, true), a = ids[0], b = ids[1]; if (a === undefined || b === undefined) throw new Error('Expected two targets')
  const operations = [await finalOperation(f, a, next)]
  if (variant !== 'single-old-conflict') operations.push(await finalOperation(f, b, variant === 'different-final-raw' ? { ...next, nameRaw: 'Contradictory raw' } : variant === 'unknown-final' ? { ...next, sourceBindingKnown: false } : { ...next, path: 'other.txt', storedFileId: 2 }))
  await submitFinalCorrections(f, entry, operations, 'rejected-final', variant === 'single-old-conflict' || variant === 'different-final-raw' ? 'source_row_conflict' : 'ambiguity')
})

it("S1 true stored append no-op survives multiple planned mutations in the same batch", async () => {
  const { f, state, ids } = await setupFinalClaims('import', true), known = await f.exact(state.knownId)
  const row20 = { ...state.publishedRow, listNo: 20 }, row30 = { ...state.publishedRow, listNo: 30 }
  const mutation = await finalOperation(f, state.targetId, row20)
  const append = (publishedRow: OfficialPublishedRow) => ({ eventId: known.eventId, recordId: known.recordId, enterpriseId: known.enterpriseId, expectedVersion: known.event.revision, evidence: { sourceFile: 'notice.txt', attachment: null, listNo: publishedRow.listNo, page: null, publishedRow } })
  const original = f.sqlite.prepare('SELECT * FROM official_evidence_row_revision WHERE evidence_id=? ORDER BY revision').all(state.knownId)
  const { result } = await f.commit(f.request({ officialEvidenceCorrections: { actor: { type: 'agent', id: 'synthetic' }, basis: 'Explicit mutation', operations: [mutation] }, officialEvidenceAppends: [append(row30), append(state.publishedRow)] }, 'stored-noop-with-mutations'))
  expect(result.items).toEqual(expect.arrayContaining([expect.objectContaining({ detail: expect.objectContaining({ evidence: expect.arrayContaining([{ evidenceId: state.knownId, eventId: known.eventId, unchanged: true }]) }) })]))
  expect(f.rows()).toHaveLength(ids.length + 1)
  expect(f.sqlite.prepare('SELECT * FROM official_evidence_row_revision WHERE evidence_id=? ORDER BY revision').all(state.knownId)).toEqual(original)
  expect(await f.exact(state.knownId)).toMatchObject({ coordinate: known.coordinate, event: { revision: known.event.revision + 1 } })
})
it("S1 append reuses planned numeric final facts without reading old latest or swallowing correction", async () => {
  const { f, next, ids, state } = await setupFinalClaims('import', true), known = await f.exact(state.knownId)
  const operations = await Promise.all(ids.map(id => finalOperation(f, id, next)))
  const { result } = await f.commit(f.request({ officialEvidenceCorrections: { actor: { type: 'agent', id: 'synthetic' }, basis: 'Explicit final corrections', operations }, officialEvidenceAppends: [{ eventId: known.eventId, recordId: known.recordId, enterpriseId: known.enterpriseId, expectedVersion: known.event.revision, evidence: { sourceFile: 'notice.txt', attachment: null, listNo: 10, page: null, publishedRow: next } }] }, 'planned-is-not-stored'))
  expect(f.rows().map(row => row.id)).toEqual(ids)
  expect(result.items).toEqual(expect.arrayContaining([expect.objectContaining({ detail: expect.objectContaining({ evidence: expect.arrayContaining([expect.objectContaining({ evidenceId: state.knownId, unchanged: true })]) }) })]))
  for (const id of ids) expect(f.sqlite.prepare('SELECT revision,name_raw FROM official_evidence_row_revision WHERE evidence_id=? ORDER BY revision DESC LIMIT 1').get(id)).toEqual({ revision: 2, name_raw: 'Alpha corrected' })
})
it("S1 two new append proposals cannot supply each other with a stable association", async () => {
  const { f, state } = await setupFinalClaims('import', false), known = await f.exact(state.knownId), row = { ...state.publishedRow, listNo: 30 }
  const append = { eventId: known.eventId, recordId: known.recordId, enterpriseId: known.enterpriseId, expectedVersion: known.event.revision, evidence: { sourceFile: 'notice.txt', attachment: null, listNo: 30, page: null, publishedRow: row } }
  const before = f.snapshot(), input = f.request({ officialEvidenceAppends: [append, append] }, 'new-appends-are-not-stored')
  expect((await f.post('preflight', input)).preflight?.conflicts).toMatchObject([{ error: { code: 'ambiguity' } }])
  expect((await f.post('commit', input)).status).toBe('failed'); expect(f.snapshot()).toEqual(before)
})

function publishedFixtureRow(sourceDocumentId?: number): OfficialPublishedRow {
  return { nameRaw: 'Alpha original', usccRaw: 'printed code', districtRaw: 'printed district', declaration: sourceDocumentId === undefined ? { kind: 'independent', sourceDocument: { source: 'jxj', title: 'Declared publication', docNumber: null, issueDate: null, path: 'notice.txt' }, basis: 'Explicit verified declaration' } : { kind: 'existing', sourceDocumentId, basis: 'Verified declaration' }, storedFileId: 1, path: 'notice.txt', sha256, bytes: Buffer.byteLength(text), attachment: null, sectionKey: 'awards', listNo: 10, page: null, sourceBindingKnown: true, actor: { type: 'agent', id: 'synthetic' }, basis: 'Verified row' }
}
function publicAnnouncement(name: 'Alpha' | 'Beta', year: number, evidence: NonNullable<RosterImportRecord['events']>[number]['evidence']): RosterImportPayload {
  return { announcement: { sourceDocument: { source: 'jxj', title: 'Declared publication' }, records: [{ enterprise: { name, ...(name === 'Beta' ? { uscc: '91330211255994457P' } : {}) }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year, evidence }] }] } }
}
const publicLocator = (sourceFile: string, listNo: number) => ({ sourceFile, attachment: null, listNo, page: null })
async function acceptedStoredPair(reverse: boolean, onlyOne = false, cross = false) {
  const f = await fixture(), initial = { ...publicLocator('notice.txt', 10), publishedRow: publishedFixtureRow() }, legacy = publicLocator('other.txt', 20)
  await f.commit(f.request(publicAnnouncement('Alpha', 2022, cross ? [initial] : reverse ? [legacy, initial] : [initial, legacy]), 'pair-capture'))
  if (cross) await f.commit(f.request(publicAnnouncement('Alpha', 2020, [legacy]), 'pair-other-event'))
  const known = f.rows().find(row => row.list_no === 10), target = f.rows().find(row => row.list_no === 20)
  if (!known || !target) throw new Error('Expected public-created pair')
  const source = z.object({ source_document_id: z.number() }).parse(f.sqlite.prepare('SELECT source_document_id FROM official_evidence_row_revision WHERE evidence_id=?').get(known.id))
  const row = publishedFixtureRow(source.source_document_id)
  await submitFinalCorrections(f, 'import', [await finalOperation(f, target.id, row)], 'pair-compatible')
  if (onlyOne) await submitFinalCorrections(f, 'import', [await finalOperation(f, target.id, { ...row, listNo: 40 })], 'pair-move-away')
  return { f, row, knownId: known.id, targetId: target.id }
}
const publicKinds = ['append', 'capture', 'import-correction', 'standalone-correction'] as const
async function commitStoredConsumer(f: PublicFixture, input: RosterImportRequest) {
  const plan = await f.post('preflight', input)
  const bound = plan.preflight?.officialEvidencePlanHash ? { ...input, payload: { ...input.payload, officialEvidencePlanHash: plan.preflight.officialEvidencePlanHash } } : input
  const result = await f.post('commit', bound)
  expect(plan.preflight?.conflicts).toEqual([]); expect(result.status, JSON.stringify(result)).toBe('committed')
  expect(await f.post('commit', bound)).toEqual(result)
  return { result, bound }
}
async function compatibleStoredConsumer(kind: typeof publicKinds[number], reverse: boolean, onlyOne: boolean) {
  const { f, row, knownId, targetId } = await acceptedStoredPair(reverse, onlyOne), owner = await f.exact(knownId)
  if (kind.endsWith('correction')) await f.commit(f.request(publicAnnouncement('Alpha', 2024, [publicLocator('other.txt', 30)]), 'third-legacy'))
  const before = f.snapshot(), oldEvidence = f.sqlite.prepare('SELECT * FROM record_evidence ORDER BY id').all(), oldFacts = f.sqlite.prepare('SELECT * FROM official_evidence_row_revision ORDER BY evidence_id,revision').all()
  if (kind === 'append') {
    const { result } = await commitStoredConsumer(f, f.request({ officialEvidenceAppends: [{ eventId: owner.eventId, recordId: owner.recordId, enterpriseId: owner.enterpriseId, expectedVersion: owner.event.revision, evidence: { ...publicLocator('notice.txt', 10), publishedRow: row } }] }, 'pair-exact-append'))
    const details = z.array(z.object({ kind: z.string(), detail: z.unknown().optional() }).passthrough()).parse(result.items)
    const detail = details.find(item => item.kind === 'official_evidence'); if (!detail) throw new Error('Expected official receipt')
    const receipt = z.object({ evidence: z.array(z.object({ evidenceId: z.number(), unchanged: z.literal(true) })) }).parse(detail.detail)
    expect(receipt.evidence).toHaveLength(1); expect([knownId, targetId]).toContain(receipt.evidence[0]?.evidenceId)
    expect(f.snapshot()).toEqual(before)
  } else if (kind === 'capture') {
    await commitStoredConsumer(f, f.request(publicAnnouncement('Alpha', 2024, [{ ...publicLocator('notice.txt', 10), publishedRow: row }]), 'pair-cross-capture'))
    expect(f.rows()).toHaveLength(3)
    expect(f.sqlite.prepare('SELECT * FROM record_evidence WHERE id IN (?,?) ORDER BY id').all(knownId, targetId)).toEqual(oldEvidence)
    expect(f.sqlite.prepare('SELECT * FROM official_evidence_row_revision WHERE evidence_id IN (?,?) ORDER BY evidence_id,revision').all(knownId, targetId)).toEqual(oldFacts)
  } else {
    const target = f.rows().find(r => r.list_no === 30); if (!target) throw new Error('Expected public legacy target')
    const exact = await f.exact(target.id), revisions = z.object({ n: z.number() }).parse(f.sqlite.prepare('SELECT count(*) n FROM evidence_revision_113').get()).n
    await submitFinalCorrections(f, kind === 'import-correction' ? 'import' : 'standalone', [await finalOperation(f, target.id, row)], 'pair-cross-correction')
    expect(await f.exact(target.id)).toMatchObject({ evidenceId: target.id, coordinate: { sourceFile: 'notice.txt', listNo: 10 }, event: { revision: exact.event.revision + 1 } })
    expect(f.sqlite.prepare('SELECT count(*) n FROM evidence_revision_113').get()).toEqual({ n: revisions + 1 })
    expect(f.sqlite.prepare('SELECT * FROM official_evidence_row_revision WHERE evidence_id IN (?,?) ORDER BY evidence_id,revision').all(knownId, targetId)).toEqual(oldFacts)
  }
}
for (const kind of publicKinds) for (const reverse of [false, true]) it(`R5 S1 compatible ${kind} with two accepted stored IDs in ${reverse ? 'reverse' : 'forward'} order`, async () => { await compatibleStoredConsumer(kind, reverse, false) })
for (const kind of publicKinds) it(`R5 S1 compatible ${kind} with only one stored claim control`, async () => { await compatibleStoredConsumer(kind, false, true) })
for (const entry of ['import', 'standalone'] as const) for (const reverse of [false, true]) it(`R5 S1 ${entry} unchanged correction preserves accepted stored pair in ${reverse ? 'reverse' : 'forward'} order`, async () => {
  const { f, row, knownId } = await acceptedStoredPair(reverse), before = f.snapshot()
  await submitFinalCorrections(f, entry, [await finalOperation(f, knownId, row)], 'pair-unchanged'); expect(f.snapshot()).toEqual(before)
})
for (const entry of ['import', 'standalone'] as const) for (const variant of ['raw-conflict', 'unknown-raw', 'unknown-binding', 'different-full-fields'] as const) it(`R5 S1 ${entry} stored pair ${variant} stays rejected atomically`, async () => {
  const { f, row, knownId } = await acceptedStoredPair(false)
  const next = variant === 'raw-conflict' ? { ...row, nameRaw: 'Different printed name' } : variant === 'unknown-raw' ? { ...row, usccRaw: null } : variant === 'unknown-binding' ? { ...row, sourceBindingKnown: false } : { ...row, path: 'other.txt', storedFileId: 2 }
  await submitFinalCorrections(f, entry, [await finalOperation(f, knownId, next)], 'pair-negative', variant === 'raw-conflict' ? 'source_row_conflict' : 'ambiguity')
})
it("S1 compatible append also preserves two accepted stored IDs across distinct events", async () => {
  const { f, row, knownId } = await acceptedStoredPair(false, false, true), owner = await f.exact(knownId), before = f.snapshot()
  await f.commit(f.request({ officialEvidenceAppends: [{ eventId: owner.eventId, recordId: owner.recordId, enterpriseId: owner.enterpriseId, expectedVersion: owner.event.revision, evidence: { ...publicLocator('notice.txt', 10), publishedRow: row } }] }, 'cross-stored-noop'))
  expect(f.snapshot()).toEqual(before)
})

// Full six-order priority matrix lives in claim-priority.test.ts.
const claimOrders = [[0, 1, 2]] as const
for (const entry of ['import', 'standalone'] as const) for (const variant of ['owner', 'raw', 'only-unknown'] as const) it(`whole-K ${entry} ${variant} rejects unknown-first conflict-last atomically`, async () => {
  const f = await fixture()
  const alpha = publicAnnouncement('Alpha', 2022, [publicLocator('other.txt', 20), publicLocator('other.txt', 30)]).announcement
  const third = publicAnnouncement(variant === 'owner' ? 'Beta' : 'Alpha', 2025, [publicLocator('other.txt', 40)]).announcement
  if (!alpha || !third) throw new Error('Expected explicit announcements')
  await f.commit(f.request({ announcement: { sourceDocument: alpha.sourceDocument, records: [...alpha.records, ...third.records] } }, 'priority-legacy'))
  const source = z.object({ id: z.number() }).parse(f.sqlite.prepare('SELECT id FROM source_document ORDER BY id LIMIT 1').get()), row = publishedFixtureRow(source.id)
  const ids = [20, 30, 40].map(n => { const target = f.rows().find(r => r.list_no === n); if (!target) throw new Error('Expected public target'); return target.id })
  const facts = [{ ...row, usccRaw: null }, row, variant === 'raw' ? { ...row, nameRaw: 'Conflicting confirmed raw' } : row]
  const operations = await Promise.all(ids.map((id, i) => { const fact = facts[i]; if (!fact) throw new Error('Expected explicit fact'); return finalOperation(f, id, fact) }))
  for (const order of claimOrders) {
    const selected = order.map(i => { const op = operations[i]; if (!op) throw new Error('Expected operation'); return op })
    await submitFinalCorrections(f, entry, selected, 'whole-k-priority-' + order.join(''), variant === 'only-unknown' ? 'ambiguity' : 'source_row_conflict')
  }
})
