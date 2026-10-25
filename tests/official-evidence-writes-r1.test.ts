import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createApp, createRouter, toNodeListener, defineEventHandler } from 'h3'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { z } from 'zod'
import * as schema from '../db/schema'
import type { OfficialPublishedRow, RosterImportRecord, RosterImportPayload, RosterImportRequest } from '../lib/roster-import-client'
import { commitRosterImport, preflightRosterImport } from '../server/utils/roster-import'
import { readExactEvidence } from '../server/utils/roster-evidence-correction'
import { appendOfficialEvidenceRevision } from '../server/utils/official-evidence'

type Execute = typeof import('../server/utils/import-execution')['importExecutor']['execute']
const current = vi.hoisted((): { db?: BetterSQLite3Database<typeof schema>; filesDir: string } => ({ filesDir: '' }))
vi.mock('@db', () => ({ useDb: () => { if (!current.db) throw new Error('Synthetic database not initialized'); return current.db } }))
// Only off-process admission is replaced. Actual H3 routes, validation, preflight,
// final-set planner and IMMEDIATE commit execute unchanged against real SQLite.
vi.mock('../server/utils/import-execution', () => ({ importExecutor: { execute: async (...[db, action, request, errors, context, source]: Parameters<Execute>) => action === 'preflight' ? preflightRosterImport(db, request, errors, { ...context, ...source }) : commitRosterImport(db, request, errors, { ...context, ...source }) } }))
const closes: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })
afterAll(() => { vi.unstubAllGlobals() })
const router = createRouter()
beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  vi.stubGlobal('useRuntimeConfig', () => ({ apiToken: 'synthetic-r1', filesDir: current.filesDir }))
  router.post('/api/roster/import/preflight', (await import('../server/api/roster/import/preflight.post')).default)
  router.post('/api/roster/import/commit', (await import('../server/api/roster/import/commit.post')).default)
})
const responseSchema = z.object({ status: z.string().optional(), batchId: z.number().optional(), preflight: z.object({ conflicts: z.array(z.object({ error: z.object({ code: z.string() }) })), officialEvidencePlanHash: z.string().optional() }).optional() }).passthrough()
const text = 'synthetic official source\n', padded = 'different padded file bytes'
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
async function fixture() {
  const dir = mkdtempSync('/tmp/issue350-r1-sqlite-'), filesDir = join(dir, 'files'); mkdirSync(filesDir)
  for (const path of ['notice.txt', 'other.txt']) writeFileSync(join(filesDir, path), text)
  writeFileSync(join(filesDir, ' notice.txt '), padded)
  const sqlite = new Database(join(dir, 'synthetic.sqlite')); sqlite.pragma('foreign_keys=ON')
  closes.push(() => { sqlite.close() })
  const db = drizzle(sqlite, { schema }); migrate(db, { migrationsFolder: resolve('db/migrations') })
  sqlite.exec(`INSERT INTO title(code,name_zh,level,rank) VALUES('specialized_sme','Synthetic','municipal',2);
    INSERT INTO enterprise(id,name,name_norm,uscc_norm) VALUES(1,'Alpha','Alpha',NULL),(2,'Beta','Beta','91330211255994457P');
    INSERT INTO record(id,enterprise_id,title_code,source) VALUES(1,1,'specialized_sme','jxj'),(2,2,'specialized_sme','jxj');
    INSERT INTO record_event(id,record_id,event_type,year) VALUES(1,1,'award',2021),(2,2,'award',2024);
    INSERT INTO record_evidence(id,record_event_id,source_file,list_no) VALUES(1,1,'other.txt',1);
    INSERT INTO source_document(id,source,title,path) VALUES(1,'jxj','Declared publication','notice.txt');
    INSERT INTO stored_file(id,rel_path,filename,ext,source,kind,title_code,bytes,sha256,created_at) VALUES(1,'notice.txt','notice.txt','txt','jxj','announcement','specialized_sme',${Buffer.byteLength(text)},'${digest(text)}','synthetic');`)
  current.db = db; current.filesDir = filesDir
  const server = createServer(toNodeListener(createApp().use(router)))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  closes.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected owned TCP listener')
  const row = (over: Partial<OfficialPublishedRow> = {}): OfficialPublishedRow => ({ nameRaw: 'Published Alpha', usccRaw: null, districtRaw: null, declaration: { kind: 'existing', sourceDocumentId: 1, basis: 'Verified declaration' }, storedFileId: 1, path: 'notice.txt', sha256: digest(text), bytes: Buffer.byteLength(text), attachment: null, sectionKey: 'awards', listNo: 10, page: null, sourceBindingKnown: true, actor: { type: 'agent', id: 'synthetic' }, basis: 'Verified row', ...over })
  const evidence = (publishedRow?: OfficialPublishedRow) => ({ sourceFile: publishedRow?.path ?? 'notice.txt', attachment: publishedRow?.attachment ?? null, listNo: publishedRow?.listNo ?? 10, page: publishedRow?.page ?? null, ...(publishedRow ? { publishedRow } : {}) })
  const record = (name: 'Alpha' | 'Beta', ev = evidence(), year = name === 'Alpha' ? 2022 : 2023): RosterImportRecord => ({ enterprise: { name, ...(name === 'Beta' ? { uscc: '91330211255994457P' } : {}) }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year, evidence: [ev] }] })
  const announcement = (records: RosterImportRecord[]): RosterImportPayload => ({ announcement: { sourceDocument: { source: 'jxj', title: 'Declared publication' }, records } })
  const request = (payload: RosterImportPayload, key = 'synthetic-r1'): RosterImportRequest => ({ idempotencyKey: key, sourceKind: 'announcement', sourceIdentity: 'synthetic-r1', payload })
  const post = async (action: 'preflight' | 'commit', body: RosterImportRequest) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/roster/import/${action}`, { method: 'POST', headers: { authorization: 'Bearer synthetic-r1', 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect(response.status).toBe(200)
    return responseSchema.parse(await response.json())
  }
  const commit = async (input: RosterImportRequest) => {
    const plan = await post('preflight', input); expect(plan.preflight?.conflicts).toEqual([])
    const bound = plan.preflight?.officialEvidencePlanHash ? { ...input, payload: { ...input.payload, officialEvidencePlanHash: plan.preflight.officialEvidencePlanHash } } : input
    const result = await post('commit', bound); expect(result.status, JSON.stringify(result)).toBe('committed')
    expect(await post('commit', bound)).toEqual(result)
    return result
  }
  const append = (publishedRow = row()) => ({ eventId: 1, recordId: 1, enterpriseId: 1, expectedVersion: 1, evidence: { ...evidence(publishedRow), publishedRow } })
  const correction = (publishedRow = row()) => {
    const { publishedRow: _row, ...coordinate } = evidence(publishedRow)
    return { actor: { type: 'agent' as const, id: 'synthetic' }, basis: 'Verified correction', operations: [{ evidenceId: 1, eventId: 1, recordId: 1, enterpriseId: 1, expectedVersion: readExactEvidence(db, 1).version, expectedRowRevision: 0, coordinate, publishedRow }] }
  }
  const seedOldClaim = (survivor: boolean) => {
    sqlite.exec("INSERT INTO import_batch(id,idempotency_key,source_kind,source_identity,created_at) VALUES(1,'seed','announcement','synthetic','synthetic'); UPDATE record_evidence SET source_file='notice.txt',list_no=10 WHERE id=1")
    const { declaration: _declaration, ...values } = row()
    appendOfficialEvidenceRevision(db, { ...values, sourceDocumentId: 1, evidenceId: 1, eventId: 1, capturedRecordId: 1, capturedEnterpriseId: 1, command: { kind: 'import', batchId: 1 } }, 0)
    if (survivor) {
      sqlite.exec("UPDATE record_event SET record_id=1 WHERE id=2; INSERT INTO record_evidence(id,record_event_id,source_file,list_no) VALUES(3,2,'notice.txt',10)")
      appendOfficialEvidenceRevision(db, { ...values, sourceDocumentId: 1, evidenceId: 3, eventId: 2, capturedRecordId: 1, capturedEnterpriseId: 1, command: { kind: 'import', batchId: 1 } }, 0)
    }
  }
  return { sqlite, db, filesDir, row, evidence, record, announcement, request, post, commit, append, correction, seedOldClaim }
}

for (const reverse of [false, true]) it(`R1 F1 mixed new typed and legacy cross-event overlap rejects in ${reverse ? 'reverse' : 'forward'} order`, async () => {
  const f = await fixture(), records = [f.record('Alpha', f.evidence(f.row())), f.record('Beta')]
  const input = f.request(f.announcement(reverse ? records.reverse() : records))
  const plan = await f.post('preflight', input), saved = await f.post('commit', input)
  expect(plan.preflight?.conflicts).toMatchObject([{ error: { code: 'ambiguity' } }])
  expect(saved.status).toBe('failed')
  expect(f.sqlite.prepare('SELECT count(*) n FROM record_evidence').get()).toEqual({ n: 1 })
  expect(f.sqlite.prepare('SELECT count(*) n FROM official_evidence_row_revision').get()).toEqual({ n: 0 })
})
it('R1 F1 persisted legacy overlap has the same ambiguity as same-batch overlap', async () => {
  const f = await fixture(); await f.commit(f.request(f.announcement([f.record('Beta')]), 'legacy-first'))
  expect((await f.post('preflight', f.request(f.announcement([f.record('Alpha', f.evidence(f.row()))])))).preflight?.conflicts).toMatchObject([{ error: { code: 'ambiguity' } }])
})
for (const kind of ['append', 'correction'] as const) for (const overlap of [true, false]) it(`R1 F1 new legacy with ${kind} ${overlap ? 'overlap rejects' : 'different coordinate commits'}`, async () => {
  const f = await fixture(), legacy = f.record('Beta', { ...f.evidence(), listNo: overlap ? 10 : 20 })
  const payload = { ...f.announcement([legacy]), ...(kind === 'append' ? { officialEvidenceAppends: [f.append()] } : { officialEvidenceCorrections: f.correction() }) }
  const input = f.request(payload)
  if (overlap) {
    expect((await f.post('preflight', input)).preflight?.conflicts).toMatchObject([{ error: { code: 'ambiguity' } }])
    expect((await f.post('commit', input)).status).toBe('failed')
    expect(f.sqlite.prepare('SELECT count(*) n FROM official_evidence_row_revision').get()).toEqual({ n: 0 })
  } else {
    await f.commit(input)
    expect(f.sqlite.prepare('SELECT count(*) n FROM official_evidence_row_revision').get()).toEqual({ n: 1 })
    expect(f.sqlite.prepare('SELECT count(*) n FROM record_event WHERE year=2023').get()).toEqual({ n: 1 })
  }
})
it('R1 F1 same-event grouped typed and distinct legacy coordinates commit without a fake legacy sidecar', async () => {
  const f = await fixture()
  await f.commit(f.request(f.announcement([f.record('Alpha', f.evidence(f.row())), f.record('Alpha', { ...f.evidence(), listNo: 20 })])))
  expect(f.sqlite.prepare('SELECT source_file,list_no FROM record_evidence WHERE record_event_id>2 ORDER BY list_no').all()).toEqual([{ source_file: 'notice.txt', list_no: 10 }, { source_file: 'notice.txt', list_no: 20 }])
  expect(f.sqlite.prepare('SELECT count(*) n FROM official_evidence_row_revision').get()).toEqual({ n: 1 })
})
for (const binding of ['section', 'declaration', 'compatible'] as const) it(`R1 F1 confirmed ${binding} multi-event control commits`, async () => {
  const f = await fixture()
  const second = binding === 'section' ? f.row({ sectionKey: 'other-section' }) : binding === 'declaration' ? f.row({ declaration: { kind: 'independent', sourceDocument: { source: 'jxj', title: 'Declared publication', docNumber: null, issueDate: null, path: 'notice.txt' }, basis: 'Verified separate publication despite same metadata and bytes' } }) : f.row()
  await f.commit(f.request(f.announcement([f.record('Alpha', f.evidence(f.row())), f.record('Alpha', f.evidence(second), 2023)])))
  expect(f.sqlite.prepare('SELECT count(*) n FROM official_evidence_row_revision').get()).toEqual({ n: 2 })
  expect(f.sqlite.prepare('SELECT count(*) n FROM source_document').get()).toEqual({ n: binding === 'declaration' ? 2 : 1 })
})
it('R1 F1 pure legacy cross-owner overlap keeps the old protocol', async () => {
  const f = await fixture(); await f.commit(f.request(f.announcement([f.record('Alpha'), f.record('Beta')])))
  expect(f.sqlite.prepare('SELECT count(*) n FROM record_evidence').get()).toEqual({ n: 3 })
  expect(f.sqlite.prepare('SELECT count(*) n FROM official_evidence_row_revision').get()).toEqual({ n: 0 })
})
for (const survivor of [true, false]) it(`R1 F1 replaced old K ${survivor ? 'with surviving claim rejects new unknown' : 'vacated completely allows legacy reuse'}`, async () => {
  const f = await fixture(); f.seedOldClaim(survivor)
  const corrections = f.correction(f.row({ listNo: 20 })), [operation] = corrections.operations
  if (!operation) throw new Error('Expected one synthetic correction')
  operation.expectedRowRevision = 1
  const input = f.request({ ...f.announcement([f.record('Beta')]), officialEvidenceCorrections: corrections })
  if (survivor) {
    expect((await f.post('preflight', input)).preflight?.conflicts).toMatchObject([{ error: { code: 'ambiguity' } }])
    expect((await f.post('commit', input)).status).toBe('failed')
    expect(f.sqlite.prepare('SELECT list_no FROM record_evidence WHERE id=1').get()).toEqual({ list_no: 10 })
  } else {
    await f.commit(input)
    expect(f.sqlite.prepare('SELECT list_no FROM record_evidence WHERE id=1').get()).toEqual({ list_no: 20 })
    expect(f.sqlite.prepare('SELECT count(*) n FROM official_evidence_row_revision').get()).toEqual({ n: 2 })
  }
})
for (const owner of ['same', 'legal-merge'] as const) it(`R1 F1 unknown overlap cannot be excused by ${owner} final owner`, async () => {
  const f = await fixture(), records = [f.record('Alpha', f.evidence(f.row())), f.record(owner === 'same' ? 'Alpha' : 'Beta', f.evidence(), 2023)]
  const input = f.request({ ...f.announcement(records), ...(owner === 'legal-merge' ? { merges: [{ fromEnterpriseId: 1, intoUscc: '91330211255994457P', note: 'Verified legal identity merge' }] } : {}) })
  expect((await f.post('preflight', input)).preflight?.conflicts).toMatchObject([{ error: { code: 'ambiguity' } }])
})
for (const attachment of ['', null]) for (const grouped of [false, true]) it(`R1 F2 typed ${attachment === '' ? 'empty' : 'null'} attachment preserved ${grouped ? 'grouped' : 'single'}`, async () => {
  const f = await fixture(), records = [f.record('Alpha', f.evidence(f.row({ attachment })))]
  if (grouped) records.push(f.record('Alpha', { ...f.evidence(), listNo: 20 }))
  await f.commit(f.request(f.announcement(records)))
  expect(f.sqlite.prepare('SELECT attachment FROM record_evidence WHERE list_no=10').all()).toEqual([{ attachment }])
  expect(f.sqlite.prepare('SELECT attachment FROM official_evidence_row_revision').all()).toEqual([{ attachment }])
})
for (const grouped of [false, true]) it(`R1 F2 padded real file path keeps verified distinct bytes ${grouped ? 'grouped' : 'single'}`, async () => {
  const f = await fixture(), published = f.row({ path: ' notice.txt ', storedFileId: null, sha256: digest(padded), bytes: Buffer.byteLength(padded) })
  const records = [f.record('Alpha', f.evidence(published))]
  if (grouped) records.push(f.record('Alpha', { ...f.evidence(), sourceFile: 'other.txt', listNo: 20 }))
  await f.commit(f.request(f.announcement(records)))
  expect(f.sqlite.prepare('SELECT source_file FROM record_evidence WHERE list_no=10').all()).toEqual([{ source_file: ' notice.txt ' }])
  expect(f.sqlite.prepare('SELECT path,sha256,bytes FROM official_evidence_row_revision').all()).toEqual([{ path: ' notice.txt ', sha256: digest(readFileSync(join(f.filesDir, ' notice.txt '))), bytes: Buffer.byteLength(padded) }])
  expect(digest(readFileSync(join(f.filesDir, ' notice.txt ')))).not.toBe(digest(readFileSync(join(f.filesDir, 'notice.txt'))))
})
it('R1 F2 stable normal typed path and grouped legacy normalization remain compatible', async () => {
  const f = await fixture()
  await f.commit(f.request(f.announcement([f.record('Alpha', f.evidence(f.row())), f.record('Alpha', { ...f.evidence(), sourceFile: ' other.txt ', attachment: '', listNo: 20 })])))
  expect(f.sqlite.prepare('SELECT source_file,attachment FROM record_evidence WHERE list_no IN(10,20) ORDER BY list_no').all()).toEqual([{ source_file: 'notice.txt', attachment: null }, { source_file: 'other.txt', attachment: null }])
})
it('R1 F2 two explicitly typed real files retain their own paths and hashes after grouping', async () => {
  const f = await fixture(), spaced = f.row({ path: ' notice.txt ', storedFileId: null, sha256: digest(padded), bytes: Buffer.byteLength(padded) })
  await f.commit(f.request(f.announcement([f.record('Alpha', f.evidence(spaced)), f.record('Alpha', f.evidence(f.row({ listNo: 20 })))])))
  expect(f.sqlite.prepare('SELECT source_file,list_no FROM record_evidence WHERE record_event_id>2 ORDER BY list_no').all()).toEqual([{ source_file: ' notice.txt ', list_no: 10 }, { source_file: 'notice.txt', list_no: 20 }])
  expect(f.sqlite.prepare('SELECT path,sha256 FROM official_evidence_row_revision ORDER BY list_no').all()).toEqual([{ path: ' notice.txt ', sha256: digest(padded) }, { path: 'notice.txt', sha256: digest(text) }])
})
for (const reverse of [false, true]) it(`R1 F2 typed and legacy duplicate normalized coordinate cannot discard raw ${reverse ? 'reverse' : 'forward'}`, async () => {
  const f = await fixture(), records = [f.record('Alpha', f.evidence(f.row())), f.record('Alpha', { ...f.evidence(), sourceFile: ' notice.txt ' })]
  const input = f.request(f.announcement(reverse ? records.reverse() : records))
  expect((await f.post('preflight', input)).preflight?.conflicts).toMatchObject([{ error: { code: 'ambiguous_target' } }])
  expect((await f.post('commit', input)).status).toBe('failed')
  expect(f.sqlite.prepare('SELECT count(*) n FROM official_evidence_row_revision').get()).toEqual({ n: 0 })
})
