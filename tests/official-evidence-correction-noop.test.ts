import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createApp, createRouter, toNodeListener, defineEventHandler } from 'h3'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { z } from 'zod'
import * as schema from '../db/schema'
import type { OfficialPublishedRow, RosterImportPayload, RosterImportRequest, RosterImportRecord } from '../lib/roster-import-client'
import type { EvidenceCorrectionRequest } from '../server/utils/roster-evidence-correction'
import { commitRosterImport, preflightRosterImport } from '../server/utils/roster-import'

type Execute = typeof import('../server/utils/import-execution')['importExecutor']['execute']
const current = vi.hoisted((): { db?: BetterSQLite3Database<typeof schema>; filesDir: string } => ({ filesDir: '' }))
vi.mock('@db', () => ({ useDb: () => { if (!current.db) throw new Error('Synthetic database not initialized'); return current.db } }))
// Replace only process admission; real production routes/planners/writers run in H3/SQLite.
vi.mock('../server/utils/import-execution', () => ({ importExecutor: { execute: async (...[db, action, request, errors, context, source]: Parameters<Execute>) => action === 'preflight' ? preflightRosterImport(db, request, errors, { ...context, ...source }) : commitRosterImport(db, request, errors, { ...context, ...source }) } }))
const closes: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })
afterAll(() => { vi.unstubAllGlobals() })
const router = createRouter()
beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  vi.stubGlobal('useRuntimeConfig', () => ({ apiToken: 'synthetic-r3', filesDir: current.filesDir }))
  router.post('/api/roster/import/preflight', (await import('../server/api/roster/import/preflight.post')).default)
  router.post('/api/roster/import/commit', (await import('../server/api/roster/import/commit.post')).default)
  router.post('/api/roster/evidence/corrections/preflight', (await import('../server/api/roster/evidence/corrections/preflight.post')).default)
  router.post('/api/roster/evidence/corrections/commit', (await import('../server/api/roster/evidence/corrections/commit.post')).default)
  router.get('/api/roster/evidence/:id', (await import('../server/api/roster/evidence/[id].get')).default)
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
  const db = drizzle(sqlite, { schema }); migrate(db, { migrationsFolder: resolve('db/migrations') })
  // Infrastructure catalog only. All enterprise/record/event/evidence/declaration state below is public-command produced.
  sqlite.exec("INSERT INTO title(code,name_zh,level,rank) VALUES('specialized_sme','Synthetic','municipal',2)")
  for (const [id, path] of [[1, 'notice.txt'], [2, 'other.txt']] as const) sqlite.prepare('INSERT INTO stored_file(id,rel_path,filename,ext,source,kind,title_code,bytes,sha256,created_at) VALUES(?,?,?,\'txt\',\'jxj\',\'announcement\',\'specialized_sme\',?,?,\'synthetic\')').run(id, path, path, Buffer.byteLength(text), sha256)
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

it('R3 S1 genuine append no-op reuses known association without propagating historical locator or unknown state', async () => {
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
