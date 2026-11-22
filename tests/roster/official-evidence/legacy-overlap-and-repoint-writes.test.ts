import { supplementPostgresAnnouncement } from '../../../layers/sme-roster/server/utils/announcement-supplement-postgres'
import { reviewPostgresFixtureRows } from '../imports/fixtures/reviewed-announcement-postgres'
import { completeInProcessPostgresIntake } from '../imports/fixtures/in-process-intake-postgres'
import { useIsolatedPostgresCases } from '../../support/isolated-postgres-cases'
import { postgresFixtureRows } from './fixtures/postgres-rows'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createApp, createRouter, toNodeListener, defineEventHandler } from 'h3'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { OfficialPublishedRow, RosterImportRecord, RosterImportPayload, RosterImportRequest } from '../../../layers/sme-roster/lib/roster-import-client'
import { readPostgresExactEvidence } from '../../../layers/sme-roster/server/utils/official-evidence-postgres'
import { writePostgresOfficialPublishedRow } from '../../../layers/sme-roster/server/utils/official-evidence-write-postgres'

const createDatabase = useIsolatedPostgresCases()
const closes: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })
const router = createRouter()
beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  router.post('/api/roster/import/preflight', (await import('../../../layers/sme-roster/server/api/roster/import/preflight.post')).default)
  router.post('/api/roster/import/commit', (await import('../../../layers/sme-roster/server/api/roster/import/commit.post')).default)
})
const stagedSchema = z.object({ status: z.literal('staged'), intakeId: z.number(), sourceDigest: z.string() })
const responseSchema = z.object({ status: z.string().optional(), batchId: z.number().optional(), preflight: z.object({ conflicts: z.array(z.object({ error: z.object({ code: z.string() }) })), officialEvidencePlanHash: z.string().optional() }).optional() }).passthrough()
const text = 'synthetic official source\n', padded = 'different padded file bytes'
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
async function fixture() {
  const dir = mkdtempSync('/tmp/legacy-overlap-pg-'), filesDir = join(dir, 'files'); mkdirSync(filesDir)
  for (const path of ['notice.txt', 'other.txt']) writeFileSync(join(filesDir, path), text)
  writeFileSync(join(filesDir, ' notice.txt '), padded)
  closes.push(() => rmSync(dir, { recursive: true, force: true }))
  const db = createDatabase(), client = db.$client
  const { readRows, readFirst } = postgresFixtureRows(client)
  await client.query(`INSERT INTO enterprise(id,name,name_norm,uscc_norm) VALUES(1,'Alpha','Alpha',NULL),(2,'Beta','Beta','91330211255994457P');
    INSERT INTO record(id,enterprise_id,title_code,source) VALUES(1,1,'specialized_sme','jxj'),(2,2,'specialized_sme','jxj');
    INSERT INTO record_event(id,record_id,event_type,year) VALUES(1,1,'award',2021),(2,2,'award',2024);
    INSERT INTO record_evidence(id,record_event_id,source_file,list_no) VALUES(1,1,'other.txt',1);
    INSERT INTO source_document(id,source,title,path) VALUES(1,'jxj','Declared publication','notice.txt');
    INSERT INTO stored_file(id,rel_path,filename,ext,bytes,sha256,created_at) VALUES(1,'notice.txt','notice.txt','txt',${Buffer.byteLength(text)},'${digest(text)}','synthetic');
    INSERT INTO roster_file_classification(file_id, source, kind, title_code) VALUES (1, 'jxj', 'announcement', 'specialized_sme');`)
  await client.query(`
    ALTER TABLE enterprise ALTER COLUMN id RESTART WITH 3;
    ALTER TABLE record ALTER COLUMN id RESTART WITH 3;
    ALTER TABLE record_event ALTER COLUMN id RESTART WITH 3;
    ALTER TABLE record_evidence ALTER COLUMN id RESTART WITH 2;
    ALTER TABLE source_document ALTER COLUMN id RESTART WITH 2;
    ALTER TABLE stored_file ALTER COLUMN id RESTART WITH 2;
  `)
  vi.stubGlobal('useRuntimeConfig', () => ({ apiToken: 'synthetic-r1', filesDir }))
  const server = createServer(toNodeListener(createApp().use(router)))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  closes.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected owned TCP listener')
  const row = (over: Partial<OfficialPublishedRow> = {}): OfficialPublishedRow => ({ nameRaw: 'Published Alpha', usccRaw: null, districtRaw: null, declaration: { kind: 'existing', sourceDocumentId: 1, basis: 'Verified declaration' }, storedFileId: 1, path: 'notice.txt', sha256: digest(text), bytes: Buffer.byteLength(text), attachment: null, sectionKey: 'awards', listNo: 10, page: null, sourceBindingKnown: true, actor: { type: 'agent', id: 'synthetic' }, basis: 'Verified row', ...over })
  const evidence = (publishedRow?: OfficialPublishedRow) => ({ sourceFile: publishedRow?.path ?? 'notice.txt', attachment: publishedRow?.attachment ?? null, listNo: publishedRow?.listNo ?? 10, page: publishedRow?.page ?? null, ...(publishedRow ? { publishedRow } : {}) })
  const record = (name: 'Alpha' | 'Beta', ev = evidence(), year = name === 'Alpha' ? 2022 : 2023): RosterImportRecord => ({ enterprise: { name, ...(name === 'Beta' ? { uscc: '91330211255994457P' } : {}) }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year, evidence: [ev] }] })
  const announcement = (records: RosterImportRecord[]): RosterImportPayload => ({ announcement: { sourceDocument: { source: 'jxj', title: 'Declared publication' }, records } })
  const request = (payload: RosterImportPayload, key = 'synthetic-r1'): RosterImportRequest => ({ idempotencyKey: key, sourceKind: 'announcement', sourceIdentity: 'synthetic-r1', payload })
  const post = async (action: 'preflight' | 'commit', body: RosterImportRequest, completeIntake = true) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/roster/import/${action}`, { method: 'POST', headers: { authorization: 'Bearer synthetic-r1', 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect(response.status).toBe(200)
    const result = await response.json()
    return responseSchema.parse(completeIntake ? await completeInProcessPostgresIntake(db, result, body, filesDir) : result)
  }
  const reviewedPreflight = async (input: RosterImportRequest) => {
    const stage = stagedSchema.parse(await post('commit', input, false))
    const review = await reviewPostgresFixtureRows(db, stage.sourceDigest, input)
    const result = await supplementPostgresAnnouncement(db, stage.intakeId, { ...review, preflight: true }, filesDir)
    if (result.status !== 'preflighted') throw new Error('Expected reviewed preflight')
    return result
  }
  const commit = async (input: RosterImportRequest) => {
    const plan = await post('preflight', input); expect(plan.preflight?.conflicts).toEqual([])
    const bound = plan.preflight?.officialEvidencePlanHash ? { ...input, payload: { ...input.payload, officialEvidencePlanHash: plan.preflight.officialEvidencePlanHash } } : input
    const result = await post('commit', bound); expect(result.status, JSON.stringify(result)).toBe('committed')
    expect(await post('commit', bound)).toEqual(result)
    return result
  }
  const append = (publishedRow = row()) => ({ eventId: 1, recordId: 1, enterpriseId: 1, expectedVersion: 1, evidence: { ...evidence(publishedRow), publishedRow } })
  const correction = async (publishedRow = row()) => {
    const { publishedRow: _row, ...coordinate } = evidence(publishedRow)
    return { actor: { type: 'agent' as const, id: 'synthetic' }, basis: 'Verified correction', operations: [{ evidenceId: 1, eventId: 1, recordId: 1, enterpriseId: 1, expectedVersion: (await readPostgresExactEvidence(db, 1)).version, expectedRowRevision: 0, coordinate, publishedRow }] }
  }
  const writeCapture = (publishedRow: OfficialPublishedRow, evidenceId: number) => db.transaction(tx =>
    writePostgresOfficialPublishedRow(tx, publishedRow, evidenceId, 0, { kind: 'import', batchId: 1 }, new Map()))
  const seedOldClaim = async (survivor: boolean) => {
    await client.query(`
      INSERT INTO import_batch(id,idempotency_key,source_kind,source_identity,created_at) VALUES(1,'seed','announcement','synthetic','synthetic');
      ALTER TABLE import_batch ALTER COLUMN id RESTART WITH 2;
      UPDATE record_evidence SET source_file='notice.txt',list_no=10 WHERE id=1;
    `)
    await writeCapture(row(), 1)
    if (survivor) {
      await client.query(`
        UPDATE record_event SET record_id=1 WHERE id=2;
        INSERT INTO record_evidence(id,record_event_id,source_file,list_no) VALUES(3,2,'notice.txt',10);
        ALTER TABLE record_evidence ALTER COLUMN id RESTART WITH 4;
      `)
      await writeCapture(row(), 3)
    }
  }
  return { client, readRows, readFirst, writeCapture, db, filesDir, row, evidence, record, announcement, request, post, reviewedPreflight, commit, append, correction, seedOldClaim }
}

for (const reverse of [false, true]) it(`R1 F1 mixed new typed and legacy cross-event overlap rejects in ${reverse ? 'reverse' : 'forward'} order`, async () => {
  const f = await fixture(), records = [f.record('Alpha', f.evidence(f.row())), f.record('Beta')]
  const input = f.request(f.announcement(reverse ? records.reverse() : records))
  const plan = await f.post('preflight', input), saved = await f.post('commit', input)
  expect(plan.preflight?.conflicts).toMatchObject([{ error: { code: 'ambiguity' } }])
  expect(saved.status).toBe('failed')
  expect(await f.readFirst('SELECT count(*) n FROM record_evidence')).toEqual({ n: 1 })
  expect(await f.readFirst('SELECT count(*) n FROM official_evidence_row_revision')).toEqual({ n: 0 })
})
it("F1 persisted legacy overlap has the same ambiguity as same-batch overlap", async () => {
  const f = await fixture(); await f.commit(f.request(f.announcement([f.record('Beta')]), 'legacy-first'))
  expect((await f.post('preflight', f.request(f.announcement([f.record('Alpha', f.evidence(f.row()))])))).preflight?.conflicts).toMatchObject([{ error: { code: 'ambiguity' } }])
})
for (const kind of ['append', 'correction'] as const) for (const overlap of [true, false]) it(`R1 F1 new legacy with ${kind} ${overlap ? 'overlap rejects' : 'different coordinate commits'}`, async () => {
  const f = await fixture(), legacy = f.record('Beta', { ...f.evidence(), listNo: overlap ? 10 : 20 })
  const payload = { ...f.announcement([legacy]), ...(kind === 'append' ? { officialEvidenceAppends: [f.append()] } : { officialEvidenceCorrections: await f.correction() }) }
  const input = f.request(payload)
  if (overlap) {
    expect((await f.reviewedPreflight(input)).conflicts).toMatchObject([{ error: { code: 'ambiguity' } }])
    expect((await f.post('commit', input)).status).toBe('failed')
    expect(await f.readFirst('SELECT count(*) n FROM official_evidence_row_revision')).toEqual({ n: 0 })
  } else {
    await f.commit(input)
    expect(await f.readFirst('SELECT count(*) n FROM official_evidence_row_revision')).toEqual({ n: 1 })
    expect(await f.readFirst('SELECT count(*) n FROM record_event WHERE year=2023')).toEqual({ n: 1 })
  }
})
it("F1 same-event grouped typed and distinct legacy coordinates commit without a fake legacy sidecar", async () => {
  const f = await fixture()
  await f.commit(f.request(f.announcement([f.record('Alpha', f.evidence(f.row())), f.record('Alpha', { ...f.evidence(), listNo: 20 })])))
  expect(await f.readRows('SELECT source_file,list_no FROM record_evidence WHERE record_event_id>2 ORDER BY list_no')).toEqual([{ source_file: 'notice.txt', list_no: 10 }, { source_file: 'notice.txt', list_no: 20 }])
  expect(await f.readFirst('SELECT count(*) n FROM official_evidence_row_revision')).toEqual({ n: 1 })
})
for (const binding of ['section', 'declaration', 'compatible'] as const) it(`R1 F1 confirmed ${binding} multi-event control commits`, async () => {
  const f = await fixture()
  const second = binding === 'section' ? f.row({ sectionKey: 'other-section' }) : binding === 'declaration' ? f.row({ declaration: { kind: 'independent', sourceDocument: { source: 'jxj', title: 'Declared publication', docNumber: null, issueDate: null, path: 'notice.txt' }, basis: 'Verified separate publication despite same metadata and bytes' } }) : f.row()
  await f.commit(f.request(f.announcement([f.record('Alpha', f.evidence(f.row())), f.record('Alpha', f.evidence(second), 2023)])))
  expect(await f.readFirst('SELECT count(*) n FROM official_evidence_row_revision')).toEqual({ n: 2 })
  expect(await f.readFirst('SELECT count(*) n FROM source_document')).toEqual({ n: binding === 'declaration' ? 2 : 1 })
})
it("F1 pure legacy cross-owner overlap keeps the old protocol", async () => {
  const f = await fixture(); await f.commit(f.request(f.announcement([f.record('Alpha'), f.record('Beta')])))
  expect(await f.readFirst('SELECT count(*) n FROM record_evidence')).toEqual({ n: 3 })
  expect(await f.readFirst('SELECT count(*) n FROM official_evidence_row_revision')).toEqual({ n: 0 })
})
for (const survivor of [true, false]) it(`R1 F1 replaced old K ${survivor ? 'with surviving claim rejects new unknown' : 'vacated completely allows legacy reuse'}`, async () => {
  const f = await fixture(); await f.seedOldClaim(survivor)
  const corrections = await f.correction(f.row({ listNo: 20 })), [operation] = corrections.operations
  if (!operation) throw new Error('Expected one synthetic correction')
  operation.expectedRowRevision = 1
  const input = f.request({ ...f.announcement([f.record('Beta')]), officialEvidenceCorrections: corrections })
  if (survivor) {
    expect((await f.reviewedPreflight(input)).conflicts).toMatchObject([{ error: { code: 'ambiguity' } }])
    expect((await f.post('commit', input)).status).toBe('failed')
    expect(await f.readFirst('SELECT list_no FROM record_evidence WHERE id=1')).toEqual({ list_no: 10 })
  } else {
    await f.commit(input)
    expect(await f.readFirst('SELECT list_no FROM record_evidence WHERE id=1')).toEqual({ list_no: 20 })
    expect(await f.readFirst('SELECT count(*) n FROM official_evidence_row_revision')).toEqual({ n: 2 })
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
  expect(await f.readRows('SELECT attachment FROM record_evidence WHERE list_no=10')).toEqual([{ attachment }])
  expect(await f.readRows('SELECT attachment FROM official_evidence_row_revision')).toEqual([{ attachment }])
})
for (const grouped of [false, true]) it(`R1 F2 padded real file path keeps verified distinct bytes ${grouped ? 'grouped' : 'single'}`, async () => {
  const f = await fixture(), published = f.row({ path: ' notice.txt ', storedFileId: null, sha256: digest(padded), bytes: Buffer.byteLength(padded) })
  const records = [f.record('Alpha', f.evidence(published))]
  if (grouped) records.push(f.record('Alpha', { ...f.evidence(), sourceFile: 'other.txt', listNo: 20 }))
  await f.commit(f.request(f.announcement(records)))
  expect(await f.readRows('SELECT source_file FROM record_evidence WHERE list_no=10')).toEqual([{ source_file: ' notice.txt ' }])
  expect(await f.readRows('SELECT path,sha256,bytes FROM official_evidence_row_revision')).toEqual([{ path: ' notice.txt ', sha256: digest(readFileSync(join(f.filesDir, ' notice.txt '))), bytes: Buffer.byteLength(padded) }])
  expect(digest(readFileSync(join(f.filesDir, ' notice.txt ')))).not.toBe(digest(readFileSync(join(f.filesDir, 'notice.txt'))))
})
it("F2 stable normal typed path and grouped legacy normalization remain compatible", async () => {
  const f = await fixture()
  await f.commit(f.request(f.announcement([f.record('Alpha', f.evidence(f.row())), f.record('Alpha', { ...f.evidence(), sourceFile: ' other.txt ', attachment: '', listNo: 20 })])))
  expect(await f.readRows('SELECT source_file,attachment FROM record_evidence WHERE list_no IN(10,20) ORDER BY list_no')).toEqual([{ source_file: 'notice.txt', attachment: null }, { source_file: 'other.txt', attachment: null }])
})
it("F2 two explicitly typed real files retain their own paths and hashes after grouping", async () => {
  const f = await fixture(), spaced = f.row({ path: ' notice.txt ', storedFileId: null, sha256: digest(padded), bytes: Buffer.byteLength(padded) })
  await f.commit(f.request(f.announcement([f.record('Alpha', f.evidence(spaced)), f.record('Alpha', f.evidence(f.row({ listNo: 20 })))])))
  expect(await f.readRows('SELECT source_file,list_no FROM record_evidence WHERE record_event_id>2 ORDER BY list_no')).toEqual([{ source_file: ' notice.txt ', list_no: 10 }, { source_file: 'notice.txt', list_no: 20 }])
  expect(await f.readRows('SELECT path,sha256 FROM official_evidence_row_revision ORDER BY list_no')).toEqual([{ path: ' notice.txt ', sha256: digest(padded) }, { path: 'notice.txt', sha256: digest(text) }])
})
for (const reverse of [false, true]) it(`R1 F2 typed and legacy duplicate normalized coordinate cannot discard raw ${reverse ? 'reverse' : 'forward'}`, async () => {
  const f = await fixture(), records = [f.record('Alpha', f.evidence(f.row())), f.record('Alpha', { ...f.evidence(), sourceFile: ' notice.txt ' })]
  const input = f.request(f.announcement(reverse ? records.reverse() : records))
  expect((await f.post('preflight', input)).preflight?.conflicts).toMatchObject([{ error: { code: 'ambiguous_target' } }])
  expect((await f.post('commit', input)).status).toBe('failed')
  expect(await f.readFirst('SELECT count(*) n FROM official_evidence_row_revision')).toEqual({ n: 0 })
})

type OfficialFixture = Awaited<ReturnType<typeof fixture>>
async function seedRepoint(f: OfficialFixture, from = 'other.txt', known?: 'section' | 'declaration') {
  await f.client.query("INSERT INTO stored_file(id,rel_path,filename,ext,bytes,sha256,created_at) VALUES(2,'other.txt','other.txt','txt',$1,$2,'synthetic')", [Buffer.byteLength(text), digest(text)])
  await f.client.query("INSERT INTO roster_file_classification(file_id, source, kind, title_code) VALUES (2, 'jxj', 'announcement', 'specialized_sme')")
  await f.client.query('INSERT INTO record_evidence(id,record_event_id,source_file,list_no) VALUES(2,2,$1,10)', [from])
  await f.client.query('ALTER TABLE record_evidence ALTER COLUMN id RESTART WITH 3; ALTER TABLE stored_file ALTER COLUMN id RESTART WITH 3')
  if (known) {
    await f.client.query(`
      INSERT INTO import_batch(id,idempotency_key,source_kind,source_identity,created_at) VALUES(1,'seed','announcement','synthetic','synthetic');
      ALTER TABLE import_batch ALTER COLUMN id RESTART WITH 2;
    `)
    if (known === 'declaration') await f.client.query(`
      INSERT INTO source_document(id,source,title,path) VALUES(2,'jxj','Explicit distinct publication','other.txt');
      ALTER TABLE source_document ALTER COLUMN id RESTART WITH 3;
    `)
    await f.writeCapture(f.row({
      nameRaw: 'Published Beta', path: from, storedFileId: 2,
      sectionKey: known === 'section' ? 'other-section' : 'awards',
      ...(known === 'declaration' ? { declaration: { kind: 'existing', sourceDocumentId: 2, basis: 'Verified declaration' } } : {}),
    }), 2)
  }
}
const repointCount = (body: unknown) => z.object({ summary: z.object({ evidenceRepointed: z.number().int() }) }).parse(body).summary.evidenceRepointed
async function businessSnapshot(f: OfficialFixture) {
  const order = {
    enterprise: 'id', record: 'id', record_event: 'id', record_evidence: 'id',
    official_evidence_row_revision: 'evidence_id,revision', evidence_correction_audit: 'id',
  }
  return Object.fromEntries(await Promise.all(Object.entries(order).map(async ([table, columns]) =>
    [table, await f.readRows(`SELECT * FROM ${table} ORDER BY ${columns}`)] as const)))
}
function legacyRepoint(f: OfficialFixture, to: string) { return f.announcement([f.record('Beta', { ...f.evidence(), sourceFile: to }, 2024)]) }
async function typedOperation(f: OfficialFixture, kind: 'capture' | 'append' | 'correction'): Promise<RosterImportPayload> {
  return kind === 'capture' ? f.announcement([f.record('Alpha', f.evidence(f.row()))]) : kind === 'append' ? { officialEvidenceAppends: [f.append()] } : { officialEvidenceCorrections: await f.correction() }
}
async function mixedRepoint(f: OfficialFixture, kind: 'capture' | 'append' | 'correction', to: string): Promise<RosterImportPayload> {
  const typed = await typedOperation(f, kind), legacy = legacyRepoint(f, to)
  if (kind !== 'capture') return { ...legacy, ...typed }
  return { announcement: { sourceDocument: { source: 'jxj', title: 'Declared publication' }, records: [...(legacy.announcement?.records ?? []), ...(typed.announcement?.records ?? [])] } }
}
async function submitRepoint(f: OfficialFixture, input: RosterImportRequest) {
  const conflicts = input.payload.announcement
    ? (await f.reviewedPreflight(input)).conflicts
    : (await f.post('preflight', input)).preflight?.conflicts
  return { conflicts, saved: await f.post('commit', input) }
}
for (const kind of ['capture', 'append', 'correction'] as const) {
  it(`R2 S1 incoming frozen legacy repoint with ${kind} rejects atomically`, async () => {
    const f = await fixture(); await seedRepoint(f); const before = await businessSnapshot(f)
    const { conflicts, saved } = await submitRepoint(f, f.request(await mixedRepoint(f, kind, 'notice.txt')))
    expect(conflicts).toMatchObject([{ error: { code: 'ambiguity' } }])
    expect(saved.status).toBe('failed'); expect(repointCount(saved)).toBe(0)
    expect(await businessSnapshot(f)).toEqual(before)
  })
  it(`R2 S1 sequential incoming legacy repoint then ${kind} has matching ambiguity`, async () => {
    const f = await fixture(); await seedRepoint(f)
    expect(repointCount(await f.commit(f.request(legacyRepoint(f, 'notice.txt'), 'legacy-first')))).toBe(1)
    const { conflicts, saved } = await submitRepoint(f, f.request(await typedOperation(f, kind), 'typed-after'))
    expect(conflicts).toMatchObject([{ error: { code: 'ambiguity' } }]); expect(saved.status).toBe('failed')
    expect(await f.readFirst('SELECT source_file FROM record_evidence WHERE id=2')).toEqual({ source_file: 'notice.txt' })
    expect(await f.readFirst('SELECT count(*) n FROM official_evidence_row_revision')).toEqual({ n: 0 })
  })
  it(`R2 S1 outgoing frozen legacy repoint vacates coordinate for ${kind}`, async () => {
    const f = await fixture(); await seedRepoint(f, 'notice.txt')
    const saved = await f.commit(f.request(await mixedRepoint(f, kind, 'other.txt')))
    expect(repointCount(saved)).toBe(1)
    expect(await f.readFirst('SELECT id,record_event_id,source_file,list_no FROM record_evidence WHERE id=2')).toEqual({ id: 2, record_event_id: 2, source_file: 'other.txt', list_no: 10 })
    expect(await f.readFirst('SELECT count(*) n FROM official_evidence_row_revision')).toEqual({ n: 1 })
  })
  it(`R2 S1 outgoing repoint with residual unknown still rejects ${kind}`, async () => {
    const f = await fixture(); await seedRepoint(f, 'notice.txt')
    await f.client.query("INSERT INTO record_event(id,record_id,event_type,year) VALUES(3,2,'award',2023); INSERT INTO record_evidence(id,record_event_id,source_file,list_no) VALUES(3,3,'notice.txt',10)")
    const before = await businessSnapshot(f), { conflicts, saved } = await submitRepoint(f, f.request(await mixedRepoint(f, kind, 'other.txt')))
    expect(conflicts).toMatchObject([{ error: { code: 'ambiguity' } }]); expect(saved.status).toBe('failed')
    expect(await businessSnapshot(f)).toEqual(before)
  })
}
it("S1 sequential outgoing convergence then append permits the same final state", async () => {
  const f = await fixture(); await seedRepoint(f, 'notice.txt')
  expect(repointCount(await f.commit(f.request(legacyRepoint(f, 'other.txt'), 'vacate-first')))).toBe(1)
  await f.commit(f.request({ officialEvidenceAppends: [f.append()] }, 'typed-after'))
  expect(await f.readFirst('SELECT source_file FROM record_evidence WHERE id=2')).toEqual({ source_file: 'other.txt' })
})
for (const reverse of [false, true]) it(`R2 S1 two frozen repoints swap final locators in ${reverse ? 'reverse' : 'forward'} order`, async () => {
  const f = await fixture(); await seedRepoint(f)
  await f.client.query("UPDATE record_evidence SET source_file='notice.txt',list_no=10 WHERE id=1")
  const records = [f.record('Alpha', { ...f.evidence(), sourceFile: 'other.txt' }, 2021), f.record('Beta', f.evidence(), 2024)]
  const saved = await f.commit(f.request({ ...f.announcement(reverse ? records.reverse() : records), officialEvidenceAppends: [f.append(f.row({ listNo: 30 }))] }))
  expect(repointCount(saved)).toBe(2)
  expect(await f.readRows('SELECT id,source_file,list_no FROM record_evidence ORDER BY id')).toEqual([{ id: 1, source_file: 'other.txt', list_no: 10 }, { id: 2, source_file: 'notice.txt', list_no: 10 }, { id: 3, source_file: 'notice.txt', list_no: 30 }])
  expect(await f.readRows('SELECT id,revision FROM record_event ORDER BY id')).toEqual([{ id: 1, revision: 2 }, { id: 2, revision: 1 }])
})
it("S1 repeated identical repoint uses the one original frozen target", async () => {
  const f = await fixture(); await seedRepoint(f)
  const record = f.record('Beta', f.evidence(), 2024)
  const saved = await f.commit(f.request({ ...f.announcement([record, structuredClone(record)]), officialEvidenceAppends: [f.append(f.row({ listNo: 30 }))] }))
  expect(repointCount(saved)).toBe(1)
  expect(await f.readFirst('SELECT count(*) n FROM record_evidence')).toEqual({ n: 3 })
  expect(await f.readFirst('SELECT revision FROM record_event WHERE id=2')).toEqual({ revision: 1 })
})
async function betaCorrection(f: OfficialFixture) {
  const before = await readPostgresExactEvidence(f.db, 2), publishedRow = f.row({ nameRaw: 'Published Beta' })
  return { actor: { type: 'agent' as const, id: 'synthetic' }, basis: 'Verified exact row', operations: [{ evidenceId: 2, eventId: 2, recordId: 2, enterpriseId: 2, expectedVersion: before.version, expectedRowRevision: 0, coordinate: { sourceFile: 'notice.txt', attachment: null, listNo: 10, page: null }, publishedRow }] }
}
it("S1 actual repoint and typed correction cannot change the same evidence twice", async () => {
  const f = await fixture(); await seedRepoint(f); const before = await businessSnapshot(f)
  const { conflicts, saved } = await submitRepoint(f, f.request({ ...legacyRepoint(f, 'notice.txt'), officialEvidenceCorrections: await betaCorrection(f) }))
  expect(conflicts).toMatchObject([{ error: { code: 'ambiguous_target' } }]); expect(saved.status).toBe('failed')
  expect(await businessSnapshot(f)).toEqual(before)
})
it("S1 same-path legacy noop does not falsely duplicate an exact correction target", async () => {
  const f = await fixture(); await seedRepoint(f)
  const saved = await f.commit(f.request({ ...legacyRepoint(f, 'other.txt'), officialEvidenceCorrections: await betaCorrection(f) }))
  expect(repointCount(saved)).toBe(0)
  expect(await f.readFirst('SELECT revision FROM record_event WHERE id=2')).toEqual({ revision: 2 })
})
for (const known of ['section', 'declaration'] as const) it(`R2 S1 repoint preserves known latest with an explicit different ${known}`, async () => {
  const f = await fixture(); await seedRepoint(f, 'other.txt', known)
  const before = await f.readRows('SELECT * FROM official_evidence_row_revision WHERE evidence_id=2')
  expect(repointCount(await f.commit(f.request(await mixedRepoint(f, 'append', 'notice.txt'))))).toBe(1)
  expect(await f.readRows('SELECT * FROM official_evidence_row_revision WHERE evidence_id=2')).toEqual(before)
  expect(await f.readFirst('SELECT source_file FROM record_evidence WHERE id=2')).toEqual({ source_file: 'notice.txt' })
})
it("S1 legal final merge cannot excuse an incoming unknown repoint", async () => {
  const f = await fixture(); await seedRepoint(f)
  const { conflicts, saved } = await submitRepoint(f, f.request({ ...await mixedRepoint(f, 'append', 'notice.txt'), merges: [{ fromEnterpriseId: 1, intoUscc: '91330211255994457P', note: 'Verified legal identity merge' }] }))
  expect(conflicts).toMatchObject([{ error: { code: 'ambiguity' } }]); expect(saved.status).toBe('failed')
  expect(await f.readFirst('SELECT count(*) n FROM enterprise')).toEqual({ n: 2 })
})
it("S1 current same owner cannot excuse an incoming unknown repoint", async () => {
  const f = await fixture(); await seedRepoint(f)
  await f.client.query('UPDATE record_evidence SET list_no=10 WHERE id=1')
  const { conflicts, saved } = await submitRepoint(f, f.request({ ...f.announcement([f.record('Alpha', f.evidence(), 2021)]), officialEvidenceAppends: [f.append()] }))
  expect(conflicts).toMatchObject([{ error: { code: 'ambiguity' } }]); expect(saved.status).toBe('failed')
})
it("S1 repoint locator drift after preflight invalidates the common locked plan hash", async () => {
  const f = await fixture(); await seedRepoint(f)
  const input = f.request({ ...legacyRepoint(f, 'notice.txt'), officialEvidenceAppends: [f.append(f.row({ listNo: 30 }))] })
  const stage = stagedSchema.parse(await f.post('commit', input, false))
  const review = await reviewPostgresFixtureRows(f.db, stage.sourceDigest, input)
  const plan = await supplementPostgresAnnouncement(f.db, stage.intakeId, { ...review, preflight: true }, f.filesDir)
  if (plan.status !== 'preflighted') throw new Error('Expected reviewed preflight')
  expect(plan.conflicts).toEqual([])
  expect(plan.officialEvidencePlanHash).toMatch(/^[a-f0-9]{64}$/)
  writeFileSync(join(f.filesDir, 'third.txt'), text)
  await f.client.query("INSERT INTO stored_file(id,rel_path,filename,ext,bytes,sha256,created_at) VALUES(3,'third.txt','third.txt','txt',$1,$2,'synthetic')", [Buffer.byteLength(text), digest(text)])
  await f.client.query("INSERT INTO roster_file_classification(file_id, source, kind, title_code) VALUES (3, 'jxj', 'announcement', 'specialized_sme')")
  await f.client.query("UPDATE record_evidence SET source_file='third.txt' WHERE id=2")
  const saved = await supplementPostgresAnnouncement(f.db, stage.intakeId, { ...review, officialEvidencePlanHash: plan.officialEvidencePlanHash }, f.filesDir)
  expect(saved.status).toBe('failed')
  expect(saved).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ error: expect.objectContaining({ code: 'plan_mismatch' }) })]) })
  expect(await f.readFirst('SELECT source_file FROM record_evidence WHERE id=2')).toEqual({ source_file: 'third.txt' })
  expect(await f.readFirst('SELECT count(*) n FROM official_evidence_row_revision')).toEqual({ n: 0 })
})
it("S1 later PostgreSQL failure rolls back an already executed legacy repoint", async () => {
  const f = await fixture(); await seedRepoint(f); const before = await businessSnapshot(f)
  const input = f.request({ ...legacyRepoint(f, 'notice.txt'), officialEvidenceAppends: [f.append(f.row({ listNo: 30 }))] })
  const stage = stagedSchema.parse(await f.post('commit', input, false))
  const review = await reviewPostgresFixtureRows(f.db, stage.sourceDigest, input)
  const plan = await supplementPostgresAnnouncement(f.db, stage.intakeId, { ...review, preflight: true }, f.filesDir)
  if (plan.status !== 'preflighted') throw new Error('Expected reviewed preflight')
  expect(plan.conflicts).toEqual([])
  expect(plan.officialEvidencePlanHash).toMatch(/^[a-f0-9]{64}$/)
  await f.client.query(`
    CREATE FUNCTION fail_evidence_insert() RETURNS trigger LANGUAGE plpgsql AS
    $$ BEGIN RAISE EXCEPTION 'synthetic repoint rollback'; END; $$;
    CREATE TRIGGER synthetic_failure BEFORE INSERT ON official_evidence_row_revision
    FOR EACH ROW EXECUTE FUNCTION fail_evidence_insert();
  `)
  const saved = await supplementPostgresAnnouncement(f.db, stage.intakeId, {
    ...review, officialEvidencePlanHash: plan.officialEvidencePlanHash,
  }, f.filesDir)
  expect(saved.status).toBe('failed')
  expect(await businessSnapshot(f)).toEqual(before)
})
it("S1 historical known capture hash stays intact during a live equal-content locator move", async () => {
  const f = await fixture(); await seedRepoint(f, 'other.txt', 'section')
  const before = await f.readRows('SELECT * FROM official_evidence_row_revision WHERE evidence_id=2')
  // Historical capture is immutable even when the live catalog now has other
  // bytes. This fixture exercises no replacement API or replacement protocol.
  const currentBytes = 'current equal-content files'
  for (const path of ['notice.txt', 'other.txt']) writeFileSync(join(f.filesDir, path), currentBytes)
  await f.client.query('UPDATE stored_file SET sha256=$1,bytes=$2 WHERE id IN(1,2)', [digest(currentBytes), Buffer.byteLength(currentBytes)])
  const published = f.row({ sha256: digest(currentBytes), bytes: Buffer.byteLength(currentBytes) })
  const saved = await f.commit(f.request({ ...legacyRepoint(f, 'notice.txt'), officialEvidenceAppends: [f.append(published)] }))
  expect(repointCount(saved)).toBe(1)
  expect(await f.readRows('SELECT * FROM official_evidence_row_revision WHERE evidence_id=2')).toEqual(before)
  expect(await f.readFirst('SELECT source_file FROM record_evidence WHERE id=2')).toEqual({ source_file: 'notice.txt' })
})
