import { createRuntimeSchema } from '../../../db/create-runtime'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createApp, createRouter, toNodeListener, defineEventHandler } from 'h3'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { z } from 'zod'
import * as schema from '../../../db/schema'
import type { OfficialPublishedRow, RosterImportRecord, RosterImportPayload, RosterImportRequest } from '../../../layers/sme-roster/lib/roster-import-client'
import { commitRosterImport, preflightRosterImport } from '../../../layers/sme-roster/server/utils/roster-import'
import { readExactEvidence } from '../../../layers/sme-roster/server/utils/roster-evidence-correction'
import { appendOfficialEvidenceRevision } from '../../../layers/sme-roster/server/utils/official-evidence'

type Execute = typeof import('../../../layers/sme-roster/server/utils/import-execution')['importExecutor']['execute']
const current = vi.hoisted((): { db?: BetterSQLite3Database<typeof schema>; filesDir: string } => ({ filesDir: '' }))
vi.mock('@db', () => ({ useDb: () => { if (!current.db) throw new Error('Synthetic database not initialized'); return current.db } }))
// Only off-process admission is replaced. Actual H3 routes, validation, preflight,
// final-set planner and IMMEDIATE commit execute unchanged against real SQLite.
vi.mock('../../../layers/sme-roster/server/utils/import-execution', () => ({ importExecutor: { execute: async (...[db, action, request, errors, context, source]: Parameters<Execute>) => action === 'preflight' ? preflightRosterImport(db, request, errors, { ...context, ...source }) : commitRosterImport(db, request, errors, { ...context, ...source }) } }))
const closes: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })
afterAll(() => { vi.unstubAllGlobals() })
const router = createRouter()
beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  vi.stubGlobal('useRuntimeConfig', () => ({ apiToken: 'synthetic-r1', filesDir: current.filesDir }))
  router.post('/api/roster/import/preflight', (await import('../../../server/api/roster/import/preflight.post')).default)
  router.post('/api/roster/import/commit', (await import('../../../server/api/roster/import/commit.post')).default)
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
  const db = drizzle(sqlite, { schema }); createRuntimeSchema(sqlite)
  sqlite.exec(`INSERT INTO enterprise(id,name,name_norm,uscc_norm) VALUES(1,'Alpha','Alpha',NULL),(2,'Beta','Beta','91330211255994457P');
    INSERT INTO record(id,enterprise_id,title_code,source) VALUES(1,1,'specialized_sme','jxj'),(2,2,'specialized_sme','jxj');
    INSERT INTO record_event(id,record_id,event_type,year) VALUES(1,1,'award',2021),(2,2,'award',2024);
    INSERT INTO record_evidence(id,record_event_id,source_file,list_no) VALUES(1,1,'other.txt',1);
    INSERT INTO source_document(id,source,title,path) VALUES(1,'jxj','Declared publication','notice.txt');
    INSERT INTO stored_file(id,rel_path,filename,ext,bytes,sha256,created_at) VALUES(1,'notice.txt','notice.txt','txt',${Buffer.byteLength(text)},'${digest(text)}','synthetic');
    INSERT INTO roster_file_classification(file_id, source, kind, title_code) VALUES (1, 'jxj', 'announcement', 'specialized_sme');`)
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
it("F1 persisted legacy overlap has the same ambiguity as same-batch overlap", async () => {
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
it("F1 same-event grouped typed and distinct legacy coordinates commit without a fake legacy sidecar", async () => {
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
it("F1 pure legacy cross-owner overlap keeps the old protocol", async () => {
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
it("F2 stable normal typed path and grouped legacy normalization remain compatible", async () => {
  const f = await fixture()
  await f.commit(f.request(f.announcement([f.record('Alpha', f.evidence(f.row())), f.record('Alpha', { ...f.evidence(), sourceFile: ' other.txt ', attachment: '', listNo: 20 })])))
  expect(f.sqlite.prepare('SELECT source_file,attachment FROM record_evidence WHERE list_no IN(10,20) ORDER BY list_no').all()).toEqual([{ source_file: 'notice.txt', attachment: null }, { source_file: 'other.txt', attachment: null }])
})
it("F2 two explicitly typed real files retain their own paths and hashes after grouping", async () => {
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

type OfficialFixture = Awaited<ReturnType<typeof fixture>>
function seedRepoint(f: OfficialFixture, from = 'other.txt', known?: 'section' | 'declaration') {
  f.sqlite.prepare("INSERT INTO stored_file(id,rel_path,filename,ext,bytes,sha256,created_at) VALUES(2,'other.txt','other.txt','txt',?,?,'synthetic')").run(Buffer.byteLength(text), digest(text))
  f.sqlite.exec("INSERT INTO roster_file_classification(file_id, source, kind, title_code) VALUES (2, 'jxj', 'announcement', 'specialized_sme')")
  f.sqlite.prepare('INSERT INTO record_evidence(id,record_event_id,source_file,list_no) VALUES(2,2,?,10)').run(from)
  if (known) {
    f.sqlite.exec("INSERT INTO import_batch(id,idempotency_key,source_kind,source_identity,created_at) VALUES(1,'seed','announcement','synthetic','synthetic')")
    if (known === 'declaration') f.sqlite.exec("INSERT INTO source_document(id,source,title,path) VALUES(2,'jxj','Explicit distinct publication','other.txt')")
    const { declaration: _declaration, ...row } = f.row({ nameRaw: 'Published Beta', path: from, storedFileId: 2, sectionKey: known === 'section' ? 'other-section' : 'awards' })
    appendOfficialEvidenceRevision(f.db, { ...row, sourceDocumentId: known === 'declaration' ? 2 : 1, evidenceId: 2, eventId: 2, capturedRecordId: 2, capturedEnterpriseId: 2, command: { kind: 'import', batchId: 1 } }, 0)
  }
}
const repointCount = (body: unknown) => z.object({ summary: z.object({ evidenceRepointed: z.number().int() }) }).parse(body).summary.evidenceRepointed
const businessSnapshot = (f: OfficialFixture) => Object.fromEntries(['enterprise', 'record', 'record_event', 'record_evidence', 'official_evidence_row_revision', 'evidence_correction_audit'].map(table => [table, f.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
function legacyRepoint(f: OfficialFixture, to: string) { return f.announcement([f.record('Beta', { ...f.evidence(), sourceFile: to }, 2024)]) }
function typedOperation(f: OfficialFixture, kind: 'capture' | 'append' | 'correction'): RosterImportPayload {
  return kind === 'capture' ? f.announcement([f.record('Alpha', f.evidence(f.row()))]) : kind === 'append' ? { officialEvidenceAppends: [f.append()] } : { officialEvidenceCorrections: f.correction() }
}
function mixedRepoint(f: OfficialFixture, kind: 'capture' | 'append' | 'correction', to: string): RosterImportPayload {
  const typed = typedOperation(f, kind), legacy = legacyRepoint(f, to)
  if (kind !== 'capture') return { ...legacy, ...typed }
  return { announcement: { sourceDocument: { source: 'jxj', title: 'Declared publication' }, records: [...(legacy.announcement?.records ?? []), ...(typed.announcement?.records ?? [])] } }
}
async function submitRepoint(f: OfficialFixture, input: RosterImportRequest) {
  const plan = await f.post('preflight', input), bound = { ...input, payload: { ...input.payload, ...(plan.preflight?.officialEvidencePlanHash ? { officialEvidencePlanHash: plan.preflight.officialEvidencePlanHash } : {}) } }
  return { plan, saved: await f.post('commit', bound) }
}
for (const kind of ['capture', 'append', 'correction'] as const) {
  it(`R2 S1 incoming frozen legacy repoint with ${kind} rejects atomically`, async () => {
    const f = await fixture(); seedRepoint(f); const before = businessSnapshot(f)
    const { plan, saved } = await submitRepoint(f, f.request(mixedRepoint(f, kind, 'notice.txt')))
    expect(plan.preflight?.conflicts).toMatchObject([{ error: { code: 'ambiguity' } }])
    expect(saved.status).toBe('failed'); expect(repointCount(saved)).toBe(0)
    expect(businessSnapshot(f)).toEqual(before)
  })
  it(`R2 S1 sequential incoming legacy repoint then ${kind} has matching ambiguity`, async () => {
    const f = await fixture(); seedRepoint(f)
    expect(repointCount(await f.commit(f.request(legacyRepoint(f, 'notice.txt'), 'legacy-first')))).toBe(1)
    const { plan, saved } = await submitRepoint(f, f.request(typedOperation(f, kind), 'typed-after'))
    expect(plan.preflight?.conflicts).toMatchObject([{ error: { code: 'ambiguity' } }]); expect(saved.status).toBe('failed')
    expect(f.sqlite.prepare('SELECT source_file FROM record_evidence WHERE id=2').get()).toEqual({ source_file: 'notice.txt' })
    expect(f.sqlite.prepare('SELECT count(*) n FROM official_evidence_row_revision').get()).toEqual({ n: 0 })
  })
  it(`R2 S1 outgoing frozen legacy repoint vacates coordinate for ${kind}`, async () => {
    const f = await fixture(); seedRepoint(f, 'notice.txt')
    const saved = await f.commit(f.request(mixedRepoint(f, kind, 'other.txt')))
    expect(repointCount(saved)).toBe(1)
    expect(f.sqlite.prepare('SELECT id,record_event_id,source_file,list_no FROM record_evidence WHERE id=2').get()).toEqual({ id: 2, record_event_id: 2, source_file: 'other.txt', list_no: 10 })
    expect(f.sqlite.prepare('SELECT count(*) n FROM official_evidence_row_revision').get()).toEqual({ n: 1 })
  })
  it(`R2 S1 outgoing repoint with residual unknown still rejects ${kind}`, async () => {
    const f = await fixture(); seedRepoint(f, 'notice.txt')
    f.sqlite.exec("INSERT INTO record_event(id,record_id,event_type,year) VALUES(3,2,'award',2023); INSERT INTO record_evidence(id,record_event_id,source_file,list_no) VALUES(3,3,'notice.txt',10)")
    const before = businessSnapshot(f), { plan, saved } = await submitRepoint(f, f.request(mixedRepoint(f, kind, 'other.txt')))
    expect(plan.preflight?.conflicts).toMatchObject([{ error: { code: 'ambiguity' } }]); expect(saved.status).toBe('failed')
    expect(businessSnapshot(f)).toEqual(before)
  })
}
it("S1 sequential outgoing convergence then append permits the same final state", async () => {
  const f = await fixture(); seedRepoint(f, 'notice.txt')
  expect(repointCount(await f.commit(f.request(legacyRepoint(f, 'other.txt'), 'vacate-first')))).toBe(1)
  await f.commit(f.request({ officialEvidenceAppends: [f.append()] }, 'typed-after'))
  expect(f.sqlite.prepare('SELECT source_file FROM record_evidence WHERE id=2').get()).toEqual({ source_file: 'other.txt' })
})
for (const reverse of [false, true]) it(`R2 S1 two frozen repoints swap final locators in ${reverse ? 'reverse' : 'forward'} order`, async () => {
  const f = await fixture(); seedRepoint(f)
  f.sqlite.exec("UPDATE record_evidence SET source_file='notice.txt',list_no=10 WHERE id=1")
  const records = [f.record('Alpha', { ...f.evidence(), sourceFile: 'other.txt' }, 2021), f.record('Beta', f.evidence(), 2024)]
  const saved = await f.commit(f.request({ ...f.announcement(reverse ? records.reverse() : records), officialEvidenceAppends: [f.append(f.row({ listNo: 30 }))] }))
  expect(repointCount(saved)).toBe(2)
  expect(f.sqlite.prepare('SELECT id,source_file,list_no FROM record_evidence ORDER BY id').all()).toEqual([{ id: 1, source_file: 'other.txt', list_no: 10 }, { id: 2, source_file: 'notice.txt', list_no: 10 }, { id: 3, source_file: 'notice.txt', list_no: 30 }])
  expect(f.sqlite.prepare('SELECT id,revision FROM record_event ORDER BY id').all()).toEqual([{ id: 1, revision: 2 }, { id: 2, revision: 1 }])
})
it("S1 repeated identical repoint uses the one original frozen target", async () => {
  const f = await fixture(); seedRepoint(f)
  const record = f.record('Beta', f.evidence(), 2024)
  const saved = await f.commit(f.request({ ...f.announcement([record, structuredClone(record)]), officialEvidenceAppends: [f.append(f.row({ listNo: 30 }))] }))
  expect(repointCount(saved)).toBe(1)
  expect(f.sqlite.prepare('SELECT count(*) n FROM record_evidence').get()).toEqual({ n: 3 })
  expect(f.sqlite.prepare('SELECT revision FROM record_event WHERE id=2').get()).toEqual({ revision: 1 })
})
function betaCorrection(f: OfficialFixture) {
  const before = readExactEvidence(f.db, 2), publishedRow = f.row({ nameRaw: 'Published Beta' })
  return { actor: { type: 'agent' as const, id: 'synthetic' }, basis: 'Verified exact row', operations: [{ evidenceId: 2, eventId: 2, recordId: 2, enterpriseId: 2, expectedVersion: before.version, expectedRowRevision: 0, coordinate: { sourceFile: 'notice.txt', attachment: null, listNo: 10, page: null }, publishedRow }] }
}
it("S1 actual repoint and typed correction cannot change the same evidence twice", async () => {
  const f = await fixture(); seedRepoint(f); const before = businessSnapshot(f)
  const { plan, saved } = await submitRepoint(f, f.request({ ...legacyRepoint(f, 'notice.txt'), officialEvidenceCorrections: betaCorrection(f) }))
  expect(plan.preflight?.conflicts).toMatchObject([{ error: { code: 'ambiguous_target' } }]); expect(saved.status).toBe('failed')
  expect(businessSnapshot(f)).toEqual(before)
})
it("S1 same-path legacy noop does not falsely duplicate an exact correction target", async () => {
  const f = await fixture(); seedRepoint(f)
  const saved = await f.commit(f.request({ ...legacyRepoint(f, 'other.txt'), officialEvidenceCorrections: betaCorrection(f) }))
  expect(repointCount(saved)).toBe(0)
  expect(f.sqlite.prepare('SELECT revision FROM record_event WHERE id=2').get()).toEqual({ revision: 2 })
})
for (const known of ['section', 'declaration'] as const) it(`R2 S1 repoint preserves known latest with an explicit different ${known}`, async () => {
  const f = await fixture(); seedRepoint(f, 'other.txt', known)
  const before = f.sqlite.prepare('SELECT * FROM official_evidence_row_revision WHERE evidence_id=2').all()
  expect(repointCount(await f.commit(f.request(mixedRepoint(f, 'append', 'notice.txt'))))).toBe(1)
  expect(f.sqlite.prepare('SELECT * FROM official_evidence_row_revision WHERE evidence_id=2').all()).toEqual(before)
  expect(f.sqlite.prepare('SELECT source_file FROM record_evidence WHERE id=2').get()).toEqual({ source_file: 'notice.txt' })
})
it("S1 legal final merge cannot excuse an incoming unknown repoint", async () => {
  const f = await fixture(); seedRepoint(f)
  const { plan, saved } = await submitRepoint(f, f.request({ ...mixedRepoint(f, 'append', 'notice.txt'), merges: [{ fromEnterpriseId: 1, intoUscc: '91330211255994457P', note: 'Verified legal identity merge' }] }))
  expect(plan.preflight?.conflicts).toMatchObject([{ error: { code: 'ambiguity' } }]); expect(saved.status).toBe('failed')
  expect(f.sqlite.prepare('SELECT count(*) n FROM enterprise').get()).toEqual({ n: 2 })
})
it("S1 current same owner cannot excuse an incoming unknown repoint", async () => {
  const f = await fixture(); seedRepoint(f)
  f.sqlite.exec('UPDATE record_evidence SET list_no=10 WHERE id=1')
  const { plan, saved } = await submitRepoint(f, f.request({ ...f.announcement([f.record('Alpha', f.evidence(), 2021)]), officialEvidenceAppends: [f.append()] }))
  expect(plan.preflight?.conflicts).toMatchObject([{ error: { code: 'ambiguity' } }]); expect(saved.status).toBe('failed')
})
it("S1 repoint locator drift after preflight invalidates the common locked plan hash", async () => {
  const f = await fixture(); seedRepoint(f)
  const input = f.request({ ...legacyRepoint(f, 'notice.txt'), officialEvidenceAppends: [f.append(f.row({ listNo: 30 }))] })
  const plan = await f.post('preflight', input); expect(plan.preflight?.conflicts).toEqual([])
  writeFileSync(join(f.filesDir, 'third.txt'), text)
  f.sqlite.prepare("INSERT INTO stored_file(id,rel_path,filename,ext,bytes,sha256,created_at) VALUES(3,'third.txt','third.txt','txt',?,?,'synthetic')").run(Buffer.byteLength(text), digest(text))
  f.sqlite.exec("INSERT INTO roster_file_classification(file_id, source, kind, title_code) VALUES (3, 'jxj', 'announcement', 'specialized_sme')")
  f.sqlite.exec("UPDATE record_evidence SET source_file='third.txt' WHERE id=2")
  const saved = await f.post('commit', { ...input, payload: { ...input.payload, officialEvidencePlanHash: plan.preflight?.officialEvidencePlanHash } })
  expect(saved.status).toBe('failed')
  expect(saved).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ error: expect.objectContaining({ code: 'plan_mismatch' }) })]) })
  expect(f.sqlite.prepare('SELECT source_file FROM record_evidence WHERE id=2').get()).toEqual({ source_file: 'third.txt' })
  expect(f.sqlite.prepare('SELECT count(*) n FROM official_evidence_row_revision').get()).toEqual({ n: 0 })
})
it("S1 later SQLite failure rolls back an already executed legacy repoint", async () => {
  const f = await fixture(); seedRepoint(f); const before = businessSnapshot(f)
  const input = f.request({ ...legacyRepoint(f, 'notice.txt'), officialEvidenceAppends: [f.append(f.row({ listNo: 30 }))] })
  const plan = await f.post('preflight', input); expect(plan.preflight?.conflicts).toEqual([])
  f.sqlite.exec("CREATE TRIGGER synthetic_failure BEFORE INSERT ON official_evidence_row_revision BEGIN SELECT RAISE(ABORT,'synthetic repoint rollback'); END")
  const saved = await f.post('commit', { ...input, payload: { ...input.payload, officialEvidencePlanHash: plan.preflight?.officialEvidencePlanHash } })
  expect(saved.status).toBe('failed'); expect(businessSnapshot(f)).toEqual(before)
})
it("S1 historical known capture hash stays intact during a live equal-content locator move", async () => {
  const f = await fixture(); seedRepoint(f, 'other.txt', 'section')
  const before = f.sqlite.prepare('SELECT * FROM official_evidence_row_revision WHERE evidence_id=2').all()
  // Historical capture is immutable even when the live catalog now has other
  // bytes. This fixture exercises no replacement API or replacement protocol.
  const currentBytes = 'current equal-content files'
  for (const path of ['notice.txt', 'other.txt']) writeFileSync(join(f.filesDir, path), currentBytes)
  f.sqlite.prepare('UPDATE stored_file SET sha256=?,bytes=? WHERE id IN(1,2)').run(digest(currentBytes), Buffer.byteLength(currentBytes))
  const published = f.row({ sha256: digest(currentBytes), bytes: Buffer.byteLength(currentBytes) })
  const saved = await f.commit(f.request({ ...legacyRepoint(f, 'notice.txt'), officialEvidenceAppends: [f.append(published)] }))
  expect(repointCount(saved)).toBe(1)
  expect(f.sqlite.prepare('SELECT * FROM official_evidence_row_revision WHERE evidence_id=2').all()).toEqual(before)
  expect(f.sqlite.prepare('SELECT source_file FROM record_evidence WHERE id=2').get()).toEqual({ source_file: 'notice.txt' })
})
