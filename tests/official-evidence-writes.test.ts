import { createRuntimeSchema } from '../db/create-runtime'
import { submitNativePlatformQuery } from './helpers/native-platform-fixture'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import * as schema from '../db/schema'
import { appendOfficialEvidenceRevision, readLatestOfficialEvidence } from '../server/utils/official-evidence'
import { preflightRosterImport, commitRosterImport, readImportBatchOutcome } from '../server/utils/roster-import'
import { handleRosterImportRequest } from '../server/utils/roster-import-http'
import { readExactEvidence } from '../server/utils/roster-evidence-correction'
import { handleEvidenceCorrectionRequest } from '../server/utils/roster-evidence-correction-api'
import { startHttpFixture } from './helpers/http-fixture'
import type { OfficialPublishedRow, RosterImportRequest } from '../lib/roster-import-client'

const closes: (() => Promise<void> | void)[] = []
const importAuditReference = z.object({ importBatchId: z.number().int().positive() }).passthrough()
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })
async function fixture() {
  const dir = mkdtempSync('/tmp/issue350-sqlite-'), filesDir = join(dir, 'files'); mkdirSync(filesDir)
  const text = 'synthetic official source\n', sha256 = createHash('sha256').update(text).digest('hex')
  for (const path of ['notice.txt', 'other.txt']) writeFileSync(join(filesDir, path), text)
  const sqlite = new Database(join(dir, 'synthetic.sqlite')); sqlite.pragma('foreign_keys=ON'); closes.push(() => { sqlite.close() })
  createRuntimeSchema(sqlite); const db = drizzle(sqlite, { schema })
  sqlite.exec(`
    INSERT INTO enterprise(id,name,name_norm,uscc_norm) VALUES(1,'Alpha','Alpha',NULL),(2,'Beta','Beta','91330211255994457P');
    INSERT INTO record(id,enterprise_id,title_code,source,name_raw) VALUES(1,1,'specialized_sme','jxj','container first'),(2,2,'specialized_sme','jxj','container beta');
    INSERT INTO record_event(id,record_id,event_type,year) VALUES(1,1,'award',2021),(2,2,'award',2024);
    INSERT INTO record_evidence(id,record_event_id,source_file,list_no) VALUES(1,1,'notice.txt',1),(2,2,'other.txt',2);
    INSERT INTO source_document(id,source,title,path) VALUES(1,'jxj','Declared publication','notice.txt');
    INSERT INTO stored_file(id,rel_path,filename,ext,source,kind,title_code,bytes,sha256,created_at) VALUES(1,'notice.txt','notice.txt','txt','jxj','announcement','specialized_sme',${Buffer.byteLength(text)},'${sha256}','synthetic'),(2,'other.txt','other.txt','txt','jxj','announcement','specialized_sme',${Buffer.byteLength(text)},'${sha256}','synthetic');
    INSERT INTO import_batch(id,idempotency_key,source_kind,source_identity,created_at) VALUES(1,'seed','announcement','synthetic','synthetic');`)
  const row = (over: Partial<OfficialPublishedRow> = {}): OfficialPublishedRow => ({ nameRaw: 'Published Alpha', usccRaw: null, districtRaw: 'Raw district', declaration: { kind: 'existing', sourceDocumentId: 1, basis: 'Verified actual declaration' }, storedFileId: 1, path: 'notice.txt', sha256, bytes: Buffer.byteLength(text), attachment: null, sectionKey: 'awards', listNo: 1, page: null, sourceBindingKnown: true, actor: { type: 'agent', id: 'synthetic' }, basis: 'Verified original row', ...over })
  const capture = (evidenceId = 1, eventId = 1, owner = 1, over: Partial<OfficialPublishedRow> = {}) => {
    const { declaration: _declaration, ...values } = row(over)
    appendOfficialEvidenceRevision(db, { ...values, sourceDocumentId: 1, evidenceId, eventId, capturedRecordId: owner, capturedEnterpriseId: owner, command: { kind: 'import', batchId: 1 } }, 0)
  }
  const request = (payload: RosterImportRequest['payload'], key = 'command'): RosterImportRequest => ({ idempotencyKey: key, sourceKind: 'announcement', sourceIdentity: 'synthetic-command', payload })
  const append = (eventId = 2, publishedRow = row()) => ({ eventId, recordId: eventId, enterpriseId: eventId, expectedVersion: 1, evidence: { sourceFile: 'notice.txt', attachment: null, listNo: 1, page: null, publishedRow } })
  const server = await startHttpFixture({ routes: {
    ...Object.fromEntries(['preflight', 'commit', 'replay'].map(action => ['/api/roster/import/' + action, (r: any) => handleRosterImportRequest(action as any, r, { db, apiToken: 'synthetic-token', filesDir, executeImport: async (database, a, req, errors, context) => a === 'preflight' ? preflightRosterImport(database, req, errors, { ...context, filesDir }) : commitRosterImport(database, req, errors, { ...context, filesDir }) })])),
    ...Object.fromEntries(['preflight', 'commit'].map(action => ['/api/roster/evidence/corrections/' + action, (r: any) => handleEvidenceCorrectionRequest({ action: action as any, ...r }, { db, apiToken: 'synthetic-token', filesDir })])),
  } })
  closes.push(server.close)
  const post = async (action: string, body: unknown) => { const response = await fetch(server.baseUrl + '/api/roster/import/' + action, { method: 'POST', headers: { authorization: 'Bearer synthetic-token', 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() } }
  const correction = (evidenceId: number, publishedRow: OfficialPublishedRow) => {
    const current = readExactEvidence(db, evidenceId)
    return { evidenceId, eventId: current.eventId, recordId: current.recordId, enterpriseId: current.enterpriseId, expectedVersion: current.version, expectedRowRevision: readLatestOfficialEvidence(db, evidenceId).row?.revision ?? 0, coordinate: { sourceFile: publishedRow.path!, attachment: publishedRow.attachment, listNo: publishedRow.listNo, page: publishedRow.page }, publishedRow }
  }
  const commit = async (input: RosterImportRequest) => {
    const plan = await post('preflight', input); expect(plan.status).toBe(200); expect(plan.body.preflight.conflicts).toEqual([])
    const bound = { ...input, payload: { ...input.payload, officialEvidencePlanHash: plan.body.preflight.officialEvidencePlanHash } }
    const result = await post('commit', bound); expect(result.status).toBe(200); expect(result.body.status, JSON.stringify(result.body)).toBe('committed')
    return { result: result.body, bound, plan: plan.body }
  }
  return { dir, filesDir, db, sqlite, row, capture, request, append, post, correction, commit }
}

it('rejects different owners claiming the same confirmed source row across events through public HTTP', async () => {
  const f = await fixture(); f.capture()
  const before = f.sqlite.prepare('SELECT * FROM official_evidence_row_revision').all()
  const request = f.request({ officialEvidenceAppends: [f.append()] })
  const plan = await f.post('preflight', request)
  expect(plan.status).toBe(200)
  expect(plan.body.preflight.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ error: expect.objectContaining({ code: 'source_row_conflict' }) })]))
  expect((await f.post('commit', request)).body.status).toBe('failed')
  expect(f.sqlite.prepare('SELECT * FROM official_evidence_row_revision').all()).toEqual(before)
  expect(f.sqlite.prepare('SELECT count(*) n FROM record_evidence').get()).toEqual({ n: 2 })
})

it('captures a raw-only correction with event CAS audit and a genuine same-key public receipt', async () => {
  const f = await fixture(); f.capture()
  const read = await handleEvidenceCorrectionRequest({ action: 'get', method: 'GET', id: 1 }, { db: f.db })
  const request = { idempotencyKey: 'raw-correction', actor: { type: 'agent', id: 'synthetic' }, basis: 'Corrected original row', operations: [{ evidenceId: 1, eventId: 1, recordId: 1, enterpriseId: 1, expectedVersion: (read.body as any).version, expectedRowRevision: 1, coordinate: { sourceFile: 'notice.txt', attachment: null, listNo: 1, page: null }, publishedRow: f.row({ nameRaw: '  corrected\u0000🙂  ' }) }] }
  const invoke = (action: 'preflight' | 'commit', body: unknown) => f.post('../evidence/corrections/' + action, body)
  const plan = await invoke('preflight', request); expect(plan.status).toBe(200)
  const first = await invoke('commit', { request, planHash: (plan.body as any).planHash }); expect(first.status).toBe(200)
  expect(await invoke('commit', { request, planHash: (plan.body as any).planHash })).toEqual(first)
  expect(readLatestOfficialEvidence(f.db, 1).row).toMatchObject({ revision: 2, nameRaw: '  corrected\u0000🙂  ' })
  expect(f.sqlite.prepare('SELECT revision FROM record_event WHERE id=1').get()).toEqual({ revision: 2 })
  expect(f.sqlite.prepare('SELECT count(*) n FROM evidence_correction_audit').get()).toEqual({ n: 1 })
})

it('rejects verbatim raw disagreement for the same current owner across events', async () => {
  const f = await fixture(); f.capture(); f.sqlite.exec('UPDATE record_event SET record_id=1 WHERE id=2')
  const op = { ...f.append(2, f.row({ nameRaw: 'Published Alpha ' })), recordId: 1, enterpriseId: 1 }
  const plan = await f.post('preflight', f.request({ officialEvidenceAppends: [op] }))
  expect(plan.body.preflight.conflicts[0].error.code).toBe('source_row_conflict')
  expect(readLatestOfficialEvidence(f.db, 2).row).toBeNull()
})

it('allows explicitly compatible multi-event linkage without filling unknown raw from canonical values', async () => {
  const f = await fixture(); f.capture(); f.sqlite.exec('UPDATE record_event SET record_id=1 WHERE id=2')
  const op = { ...f.append(2, f.row({ nameRaw: null, usccRaw: null, districtRaw: null })), recordId: 1, enterpriseId: 1 }
  const { result, bound } = await f.commit(f.request({ officialEvidenceAppends: [op] }))
  expect((await f.post('commit', bound)).body).toEqual(result)
  const id = result.items.find((item: any) => item.kind === 'official_evidence').detail.evidence[0].evidenceId
  expect(readLatestOfficialEvidence(f.db, id).row).toMatchObject({ nameRaw: null, usccRaw: null, districtRaw: null, eventId: 2 })
  expect(f.sqlite.prepare('SELECT name_raw FROM record WHERE id=1').get()).toEqual({ name_raw: 'container first' })
})

it('uses a legal final merge owner and hides new private fold fields on first retry and outcome', async () => {
  const f = await fixture(); f.capture()
  const originalRecord = f.db.select().from(schema.record).all().find(row => row.id === 1)!
  const { result, bound } = await f.commit(f.request({ officialEvidenceAppends: [f.append()], merges: [{ fromEnterpriseId: 1, intoUscc: '91330211255994457P', note: 'Verified legal same entity merge' }] }))
  const privateBatch = f.db.select().from(schema.importBatch).all().find(row => row.id === result.batchId)!
  const privateItems = privateBatch.itemResults as any[]
  const fold = privateItems.find(item => item.kind === 'merge').detail.lineage.recordsFolded[0]
  expect(fold).toMatchObject({ fromRecordId: 1, intoRecordId: 2, fromRecordSnapshot: originalRecord, eventIds: [1] })
  const lineage = result.items.find((item: any) => item.kind === 'merge').detail.lineage
  expect(lineage.recordsFolded).toEqual([{ fromRecordId: 1, intoRecordId: 2 }])
  expect(lineage).toMatchObject({ fromEnterpriseId: 1, intoEnterpriseId: 2, eventsMoved: [1], evidenceMoved: [1], snapshotRef: { source: 'private_batch', batchId: result.batchId, itemIndex: privateItems.findIndex(item => item.kind === 'merge') } })
  expect((await f.post('commit', bound)).body).toEqual(result)
  const outcome = readImportBatchOutcome(f.db, bound.idempotencyKey)
  expect(outcome?.items).toEqual(result.items)
  expect(JSON.stringify(outcome)).not.toContain('fromRecordSnapshot')
  expect(JSON.stringify(outcome)).not.toContain('eventIds')
  expect(f.db.select().from(schema.importBatch).all().find(row => row.id === result.batchId)!.itemResults).toEqual(privateItems)
  expect(f.db.select().from(schema.importReceipt).all().filter(row => row.batchId === result.batchId).some(row => JSON.stringify(row.itemResults).includes('fromRecordSnapshot'))).toBe(false)
  expect(readLatestOfficialEvidence(f.db, 1).row).toMatchObject({ capturedRecordId: 1, capturedEnterpriseId: 1, currentOwner: { recordId: 2, enterpriseId: 2 } })
  expect(f.sqlite.pragma('foreign_key_check')).toEqual([])
})

it('rejects two same-batch appends claiming one K for different owners before any writes', async () => {
  const f = await fixture()
  const plan = await f.post('preflight', f.request({ officialEvidenceAppends: [f.append(1), f.append(2)] }))
  expect(plan.body.preflight.conflicts[0].error.code).toBe('source_row_conflict')
  expect(f.sqlite.prepare('SELECT count(*) n FROM official_evidence_row_revision').get()).toEqual({ n: 0 })
})

it('rejects a same-batch append and correction claiming the same final row', async () => {
  const f = await fixture(); f.capture()
  const moved = f.row({ listNo: 3 })
  const plan = await f.post('preflight', f.request({ officialEvidenceAppends: [{ ...f.append(2, moved), evidence: { ...f.append(2, moved).evidence, listNo: 3 } }], officialEvidenceCorrections: { actor: { type: 'agent', id: 'synthetic' }, basis: 'Final-set conflict', operations: [f.correction(1, moved)] } }))
  expect(plan.body.preflight.conflicts[0].error.code).toBe('source_row_conflict')
  expect(readLatestOfficialEvidence(f.db, 1).row?.revision).toBe(1)
})

it('allows a final-set swap and writes explicit import audit references with no correction-batch FK', async () => {
  const f = await fixture(); f.capture(); f.capture(2, 2, 2, { nameRaw: 'Published Beta', path: 'other.txt', storedFileId: 2, listNo: 2 })
  const operations = [f.correction(1, f.row({ path: 'other.txt', storedFileId: 2, listNo: 2 })), f.correction(2, f.row({ nameRaw: 'Published Beta' }))]
  const { result, bound } = await f.commit(f.request({ officialEvidenceCorrections: { actor: { type: 'agent', id: 'synthetic' }, basis: 'Verified swapped final coordinates', operations } }))
  expect(readLatestOfficialEvidence(f.db, 1).row).toMatchObject({ revision: 2, path: 'other.txt', listNo: 2, nameRaw: 'Published Alpha' })
  expect(readLatestOfficialEvidence(f.db, 2).row).toMatchObject({ revision: 2, path: 'notice.txt', listNo: 1, nameRaw: 'Published Beta' })
  expect((await f.post('commit', bound)).body).toEqual(result)
  const audits = f.db.select().from(schema.evidenceCorrectionAudit).all()
  expect(audits).toHaveLength(2)
  expect(audits.every(row => row.batchKey === null && importAuditReference.parse(row.before).importBatchId === result.batchId && importAuditReference.parse(row.after).importBatchId === result.batchId)).toBe(true)
  expect(f.sqlite.prepare('SELECT count(*) n FROM evidence_correction_batch').get()).toEqual({ n: 0 })
  expect(f.sqlite.pragma('foreign_key_check')).toEqual([])
})

it('uses one original event version and advances CAS once for multiple raw-only changes in one event', async () => {
  const f = await fixture(); f.capture()
  f.sqlite.exec("INSERT INTO record_evidence(id,record_event_id,source_file,list_no) VALUES(3,1,'other.txt',3)")
  f.capture(3, 1, 1, { path: 'other.txt', storedFileId: 2, listNo: 3 })
  const operations = [f.correction(1, f.row({ nameRaw: 'Raw correction one' })), f.correction(3, f.row({ path: 'other.txt', storedFileId: 2, listNo: 3, nameRaw: 'Raw correction three' }))]
  await f.commit(f.request({ officialEvidenceCorrections: { actor: { type: 'agent', id: 'synthetic' }, basis: 'Two verified rows', operations } }))
  expect(f.sqlite.prepare('SELECT revision FROM record_event WHERE id=1').get()).toEqual({ revision: 2 })
  expect(f.sqlite.prepare('SELECT count(*) n FROM evidence_correction_audit').get()).toEqual({ n: 2 })
  expect(readLatestOfficialEvidence(f.db, 1).row?.revision).toBe(2)
  expect(readLatestOfficialEvidence(f.db, 3).row?.revision).toBe(2)
})

it('keeps an unchanged explicit row and true same-key receipt free of new audit revisions', async () => {
  const f = await fixture(); f.capture()
  const { result, bound } = await f.commit(f.request({ officialEvidenceCorrections: { actor: { type: 'agent', id: 'synthetic' }, basis: 'Rechecked unchanged', operations: [f.correction(1, f.row())] } }))
  expect((await f.post('commit', bound)).body).toEqual(result)
  expect(f.sqlite.prepare('SELECT revision FROM record_event WHERE id=1').get()).toEqual({ revision: 1 })
  expect(readLatestOfficialEvidence(f.db, 1).row?.revision).toBe(1)
  expect(f.sqlite.prepare('SELECT count(*) n FROM evidence_correction_audit').get()).toEqual({ n: 0 })
})

it('preserves unknown current ownership as ambiguity instead of accepting captured historical owner', async () => {
  const f = await fixture(); f.capture()
  f.sqlite.pragma('foreign_keys=OFF'); f.sqlite.exec('DELETE FROM enterprise WHERE id=1'); f.sqlite.pragma('foreign_keys=ON')
  const plan = await f.post('preflight', f.request({ officialEvidenceAppends: [f.append()] }))
  expect(plan.body.preflight.conflicts[0].error.code).toBe('ambiguity')
  expect(readLatestOfficialEvidence(f.db, 1).row?.currentOwner).toBeNull()
})

it('rejects unknown legacy overlap and contradictory explicit coordinate or registered file binding', async () => {
  const f = await fixture()
  const unknown = await f.post('preflight', f.request({ officialEvidenceAppends: [f.append()] }, 'unknown'))
  expect(unknown.body.preflight.conflicts[0].error.code).toBe('ambiguity')
  for (const row of [f.row({ listNo: 2 }), f.row({ storedFileId: 2 })]) {
    const bad = await f.post('preflight', f.request({ officialEvidenceAppends: [f.append(2, row)] }, 'mismatch-' + row.storedFileId + row.listNo))
    expect(bad.body.preflight.conflicts[0].error.code).toBe('source_binding_conflict')
  }
})

it('creates an explicit independent declaration despite equal SHA metadata and shares it within the batch', async () => {
  const f = await fixture(); f.capture(); f.sqlite.exec('UPDATE record_event SET record_id=2 WHERE id=1')
  const independent = f.row({ nameRaw: 'Independent raw', usccRaw: 'published code', districtRaw: 'published district', declaration: { kind: 'independent', sourceDocument: { source: 'jxj', title: 'Declared publication', docNumber: null, issueDate: null, path: 'notice.txt' }, basis: 'Verified separate official publication; not inferred from equal bytes' } })
  const { result, bound } = await f.commit(f.request({ officialEvidenceAppends: [{ ...f.append(1, independent), recordId: 2, enterpriseId: 2 }, f.append(2, independent)] }))
  const ids = result.items.find((item: any) => item.kind === 'official_evidence').detail.evidence.map((row: any) => row.evidenceId)
  expect(ids.map((id: number) => readLatestOfficialEvidence(f.db, id).row?.sourceDocumentId)).toEqual([2, 2])
  expect(f.sqlite.prepare('SELECT count(*) n FROM source_document').get()).toEqual({ n: 2 })
  expect((await f.post('commit', bound)).body).toEqual(result)
  expect(f.sqlite.prepare('SELECT count(*) n FROM source_document').get()).toEqual({ n: 2 })
})

it('captures 2021 and 2024 published values separately and leaves historical evidence unknown', async () => {
  const f = await fixture(); f.sqlite.exec('DELETE FROM record_evidence WHERE id=2; DELETE FROM record_event WHERE id=2')
  const request = f.request({ announcement: { sourceDocument: { source: 'jxj', title: 'Declared publication' }, records: [
    { enterprise: { name: '2021 old identity label', uscc: '91330211255994457P' }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year: 2021, evidence: [{ sourceFile: 'notice.txt', attachment: null, listNo: 10, page: null, publishedRow: f.row({ listNo: 10, nameRaw: '2021 old published name', usccRaw: null }) }] }] },
    { enterprise: { name: '2024 current identity label', uscc: '91330211255994457P' }, titleCode: 'specialized_sme', events: [{ eventType: 'review', year: 2021, decidedYear: 2024, reviewOutcome: 'passed', evidence: [{ sourceFile: 'other.txt', attachment: null, listNo: 20, page: null, publishedRow: f.row({ path: 'other.txt', storedFileId: 2, listNo: 20, nameRaw: '2024 new published name', usccRaw: 'Original printed code' }) }] }] },
  ] } })
  const { result } = await f.commit(request)
  const evidence = result.items.filter((item: any) => item.kind === 'record_event').flatMap((item: any) => item.detail.evidence)
  expect(evidence.map((id: number) => readLatestOfficialEvidence(f.db, id).row?.nameRaw)).toEqual(['2021 old published name', '2024 new published name'])
  expect(readLatestOfficialEvidence(f.db, 1).row).toBeNull()
  expect(f.sqlite.prepare('SELECT name FROM enterprise WHERE id=2').get()).toEqual({ name: 'Beta' })
})

it('rechecks bytes and the opt-in plan under commit and never appends facts through replay', async () => {
  const f = await fixture(); f.capture(); f.sqlite.exec('UPDATE record_event SET record_id=1 WHERE id=2')
  const request = f.request({ officialEvidenceAppends: [{ ...f.append(), recordId: 1, enterpriseId: 1 }] })
  const plan = await f.post('preflight', request); expect(plan.body.preflight.conflicts).toEqual([])
  const bound = { ...request, payload: { ...request.payload, officialEvidencePlanHash: plan.body.preflight.officialEvidencePlanHash } }
  expect((await f.post('replay', bound)).status).toBe(400)
  f.sqlite.exec('UPDATE record_event SET revision=2 WHERE id=2')
  const stale = await f.post('commit', bound); expect(stale.body.status).toBe('failed'); expect(stale.body.items.some((item: any) => item.error?.code === 'stale_version')).toBe(true)
  f.sqlite.exec('UPDATE record_event SET revision=1 WHERE id=2')
  writeFileSync(join(f.filesDir, 'notice.txt'), 'changed source bytes')
  const changed = await f.post('commit', bound); expect(changed.body.status).toBe('failed'); expect(changed.body.items.some((item: any) => item.error?.code === 'file_changed')).toBe(true)
  expect(f.sqlite.prepare('SELECT count(*) n FROM record_evidence').get()).toEqual({ n: 2 })
})

it('rolls back new declaration evidence sidecar audit and event revision on a real SQLite abort', async () => {
  const f = await fixture(); f.capture(); f.sqlite.exec('UPDATE record_event SET record_id=1 WHERE id=2')
  const independent = f.row({ declaration: { kind: 'independent', sourceDocument: { source: 'jxj', title: 'New independent', docNumber: null, issueDate: null, path: 'notice.txt' }, basis: 'Explicit verified independent publication' } })
  const request = f.request({ officialEvidenceAppends: [{ ...f.append(2, independent), recordId: 1, enterpriseId: 1 }], officialEvidenceCorrections: { actor: { type: 'agent', id: 'synthetic' }, basis: 'Verified original correction', operations: [f.correction(1, f.row({ nameRaw: 'Changed original' }))] } })
  const plan = await f.post('preflight', request); expect(plan.body.preflight.conflicts).toEqual([])
  f.sqlite.exec("CREATE TRIGGER fail_official_row BEFORE INSERT ON official_evidence_row_revision WHEN NEW.revision=2 BEGIN SELECT RAISE(ABORT,'synthetic injection'); END")
  const result = await f.post('commit', { ...request, payload: { ...request.payload, officialEvidencePlanHash: plan.body.preflight.officialEvidencePlanHash } })
  expect(result.body.status).toBe('failed')
  expect(f.sqlite.prepare('SELECT count(*) n FROM source_document').get()).toEqual({ n: 1 })
  expect(f.sqlite.prepare('SELECT count(*) n FROM record_evidence').get()).toEqual({ n: 2 })
  expect(readLatestOfficialEvidence(f.db, 1).row?.revision).toBe(1)
  expect(f.sqlite.prepare('SELECT count(*) n FROM evidence_correction_audit').get()).toEqual({ n: 0 })
  expect(f.sqlite.prepare('SELECT revision FROM record_event ORDER BY id').all()).toEqual([{ revision: 1 }, { revision: 1 }])
})

it('accepts exactly 100 operations and rejects the 101st without changing old large-batch rules', async () => {
  const f = await fixture()
  const appends = Array.from({ length: 100 }, (_, i) => {
    const publishedRow = f.row({ listNo: i + 10 })
    return { ...f.append(1, publishedRow), evidence: { ...f.append(1, publishedRow).evidence, listNo: i + 10 } }
  })
  const tooMany = await f.post('preflight', f.request({ officialEvidenceAppends: [...appends, appends[0]!] }, 'too-many'))
  expect(tooMany.body.preflight.conflicts[0].error.code).toBe('input_limit')
  const { result, bound } = await f.commit(f.request({ officialEvidenceAppends: appends }, 'at-limit'))
  expect(result.items.find((item: any) => item.kind === 'official_evidence').detail.evidence).toHaveLength(100)
  expect((await f.post('commit', bound)).body).toEqual(result)
  expect(f.sqlite.prepare('SELECT revision FROM record_event WHERE id=1').get()).toEqual({ revision: 2 })
})

it('rejects source candidate 101 and event evidence 301 instead of truncating conflict checks', async () => {
  const f = await fixture(); f.capture()
  for (let id = 3; id <= 102; id++) {
    f.sqlite.prepare("INSERT INTO record_evidence(id,record_event_id,source_file,list_no) VALUES(?,1,'notice.txt',?)").run(id, id)
    f.capture(id, 1, 1)
  }
  const source = await f.post('preflight', f.request({ officialEvidenceAppends: [f.append()] }, 'source-overflow'))
  expect(source.body.preflight.conflicts[0].error.code).toBe('source_limit')
  for (let id = 103; id <= 302; id++) f.sqlite.prepare("INSERT INTO record_evidence(id,record_event_id,source_file,list_no) VALUES(?,1,'notice.txt',?)").run(id, id)
  const publishedRow = f.row({ listNo: 999 })
  const event = await f.post('preflight', f.request({ officialEvidenceAppends: [{ ...f.append(1, publishedRow), evidence: { ...f.append(1, publishedRow).evidence, listNo: 999 } }] }, 'event-overflow'))
  expect(event.body.preflight.conflicts[0].error.code).toBe('source_limit')
  expect(f.sqlite.prepare('SELECT count(*) n FROM official_evidence_row_revision').get()).toEqual({ n: 101 })
})

it('does not create a duplicate known association or treat unknown values as no-op equivalence', async () => {
  const f = await fixture(); f.capture(1, 1, 1, { usccRaw: 'printed-code' })
  const { result } = await f.commit(f.request({ officialEvidenceAppends: [f.append(1, f.row({ usccRaw: 'printed-code' }))] }))
  expect(result.items.find((item: any) => item.kind === 'official_evidence').detail.evidence).toEqual([{ evidenceId: 1, eventId: 1, unchanged: true }])
  expect(f.sqlite.prepare('SELECT count(*) n FROM record_evidence').get()).toEqual({ n: 2 })
  const unknown = await f.post('preflight', f.request({ officialEvidenceAppends: [f.append(1)] }, 'unknown-equivalence'))
  expect(unknown.body.preflight.conflicts[0].error.code).toBe('ambiguity')
})

it('revalidates two SQLite handles competing for an initially empty K at public commit', async () => {
  const f = await fixture()
  const second = new Database(join(f.dir, 'synthetic.sqlite')); second.pragma('foreign_keys=ON'); closes.push(() => { second.close() })
  const other = drizzle(second, { schema })
  const make = (id: number, key: string) => {
    const row = f.row({ listNo: 30 })
    return f.request({ officialEvidenceAppends: [{ ...f.append(id, row), evidence: { ...f.append(id, row).evidence, listNo: 30 } }] }, key)
  }
  const first = make(1, 'race-alpha'), contender = make(2, 'race-beta')
  const a = await f.post('preflight', first)
  const b = preflightRosterImport(other, contender, [], { filesDir: f.filesDir })
  expect(a.body.preflight.conflicts).toEqual([]); expect(b.preflight.conflicts).toEqual([])
  const results = await Promise.all([
    f.post('commit', { ...first, payload: { ...first.payload, officialEvidencePlanHash: a.body.preflight.officialEvidencePlanHash } }),
    handleRosterImportRequest('commit', { method: 'POST', headers: { authorization: 'Bearer synthetic-token' }, body: { ...contender, payload: { ...contender.payload, officialEvidencePlanHash: b.preflight.officialEvidencePlanHash } } }, { db: other, apiToken: 'synthetic-token', filesDir: f.filesDir, executeImport: async (db, action, request, errors, context) => action === 'commit' ? commitRosterImport(db, request, errors, { ...context, filesDir: f.filesDir }) : preflightRosterImport(db, request, errors, { ...context, filesDir: f.filesDir }) }),
  ])
  expect(results.map(result => (result.body as any).status).sort()).toEqual(['committed', 'failed'])
  const failed = results.find(result => (result.body as any).status === 'failed')!.body as any
  expect(failed.items.some((item: any) => item.error?.code === 'source_row_conflict'), JSON.stringify(failed)).toBe(true)
  expect(f.sqlite.prepare('SELECT count(*) n FROM official_evidence_row_revision').get()).toEqual({ n: 1 })
  expect(f.sqlite.prepare('SELECT count(*) n FROM record_evidence').get()).toEqual({ n: 3 })
})

it('preserves old observation raw hash proof decisions and audit while changing formal raw', async () => {
  const f = await fixture(); f.capture()
  const native = submitNativePlatformQuery(f.db, { interface: 'business_list', queryKey: 'synthetic', queriedAt: '2021-01-01', rawResponse: '  {"legacy":true}  ', relations: [{ sequenceNo: 1, enterpriseId: 1, rawFields: { n: 1, text: 'verbatim', unknown: null }, sourceText: '  legacy text  ' }] })
  const relationId = native.relationIds[0]!
  f.db.insert(schema.recordCorrespondence).values({ edgeKey: 'synthetic-old-edge', type: 'event_process', role: 'context_only', eventId: 1, observationId: native.observations[0]!.observationId, enterpriseId: 1, titleCode: 'specialized_sme', status: 'confirmed', revision: 7, targetIdentity: { old: true }, provenance: { relationId, observation: 'original' }, sourceFingerprint: 'original-hash-not-recomputed', ruleId: 'manual', ruleVersion: 'old', createdAt: '2021-01-01' }).run()
  f.db.insert(schema.comparisonScopeProof).values({ kind: 'official_coverage', evidence: { eventIds: [1], original: true }, sourceFingerprint: 'original-proof-hash', createdAt: '2021-01-01' }).run()
  const tables = ['platform_collection', 'platform_business_observation', 'platform_observation_assignment', 'platform_archive_value', 'platform_collection_archive_ref', 'platform_observation_archive_ref', 'record_correspondence', 'record_correspondence_audit', 'comparison_scope_proof', 'comparison_scope_proof_audit']
  const snapshot = () => Object.fromEntries(tables.map(table => [table, f.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
  const before = snapshot()
  await f.commit(f.request({ officialEvidenceCorrections: { actor: { type: 'agent', id: 'synthetic' }, basis: 'Verified original', operations: [f.correction(1, f.row({ nameRaw: 'Explicit corrected original' }))] } }))
  expect(snapshot()).toEqual(before)
  expect(f.sqlite.prepare('SELECT id,record_event_id FROM record_evidence WHERE id=1').get()).toEqual({ id: 1, record_event_id: 1 })
})

it('rejects mixed typed and legacy duplicate capture coordinates instead of losing the explicit raw row', async () => {
  const f = await fixture()
  const evidence = { sourceFile: 'notice.txt', attachment: null, listNo: 10, page: null }
  const record = { enterprise: { name: 'Beta', uscc: '91330211255994457P' }, titleCode: 'specialized_sme', events: [{ eventType: 'award' as const, year: 2022, evidence: [{ ...evidence, publishedRow: f.row({ listNo: 10 }) }] }] }
  const input = f.request({ announcement: { sourceDocument: { source: 'jxj', title: 'Declared publication' }, records: [record, { ...record, events: [{ ...record.events[0]!, evidence: [evidence] }] }] } })
  const plan = await f.post('preflight', input)
  expect(plan.body.preflight.conflicts.some((item: any) => item.error?.code === 'ambiguous_target')).toBe(true)
  expect(readLatestOfficialEvidence(f.db, 1).row).toBeNull()
})

it('clears unverified raw on an explicit cross-content binding instead of inheriting the old row', async () => {
  const f = await fixture(); f.capture()
  const old = f.sqlite.prepare('SELECT * FROM official_evidence_row_revision WHERE evidence_id=1').get()
  const bytes = 'new independent file content', sha256 = createHash('sha256').update(bytes).digest('hex')
  writeFileSync(join(f.filesDir, 'other.txt'), bytes)
  f.db.update(schema.storedFile).set({ sha256, bytes: Buffer.byteLength(bytes) }).where((await import('drizzle-orm')).eq(schema.storedFile.id, 2)).run()
  const row = f.row({ path: 'other.txt', storedFileId: 2, listNo: 10, sha256, bytes: Buffer.byteLength(bytes), nameRaw: null, usccRaw: null, districtRaw: null })
  await f.commit(f.request({ officialEvidenceCorrections: { actor: { type: 'agent', id: 'synthetic' }, basis: 'Verified new content; raw not yet verified', operations: [f.correction(1, row)] } }))
  expect(readLatestOfficialEvidence(f.db, 1).row).toMatchObject({ revision: 2, sha256, nameRaw: null, usccRaw: null, districtRaw: null })
  expect(f.sqlite.prepare('SELECT * FROM official_evidence_row_revision WHERE evidence_id=1 AND revision=1').get()).toEqual(old)
})

it('preserves ordinary duplicate announcements and large legacy batches without opting into fact writes', async () => {
  const f = await fixture()
  const sourceDocument = { source: 'jxj' as const, title: 'Declared publication' }
  const record = { enterprise: { name: 'Beta', uscc: '91330211255994457P' }, titleCode: 'specialized_sme' }
  const ordinary = f.request({ announcement: { sourceDocument, records: [{ ...record, events: [{ eventType: 'award', year: 2024, evidence: [{ sourceFile: 'other.txt', attachment: null, listNo: 2, page: null }] }] }] } }, 'legacy-duplicate')
  expect((await f.post('commit', ordinary)).body.status).toBe('committed')
  expect(readLatestOfficialEvidence(f.db, 2).row).toBeNull()
  const typed = structuredClone(ordinary); typed.idempotencyKey = 'typed-duplicate'
  typed.payload.announcement!.records[0]!.events![0]!.evidence![0]!.publishedRow = f.row({ path: 'other.txt', storedFileId: 2, listNo: 2 })
  const plan = await f.post('preflight', typed)
  expect(plan.body.preflight.conflicts[0].error.code).toBe('explicit_append_required')
  const large = f.request({ announcement: { sourceDocument, records: [{ ...record, events: Array.from({ length: 101 }, (_, i) => ({ eventType: 'award' as const, year: 1900 + i })) }] } }, 'legacy-large')
  expect((await f.post('commit', large)).body.status).toBe('committed')
  expect(f.sqlite.prepare('SELECT count(*) n FROM official_evidence_row_revision').get()).toEqual({ n: 0 })
})

it('rejects repeated correction targets and unknown final binding overlap without guessing row equality', async () => {
  const f = await fixture(); f.capture()
  const op = f.correction(1, f.row({ nameRaw: 'Checked' }))
  const duplicate = await f.post('preflight', f.request({ officialEvidenceCorrections: { actor: { type: 'agent', id: 'synthetic' }, basis: 'Checked row', operations: [op, op] } }, 'duplicate-target'))
  expect(duplicate.body.preflight.conflicts[0].error.code).toBe('ambiguous_target')
  const row = f.row({ listNo: 10, sectionKey: null, sourceBindingKnown: false })
  const overlap = await f.post('preflight', f.request({ officialEvidenceAppends: [1, 2].map(id => ({ ...f.append(id, row), evidence: { ...f.append(id, row).evidence, listNo: 10 } })) }, 'unknown-final'))
  expect(overlap.body.preflight.conflicts[0].error.code).toBe('ambiguity')
})

it('import correction requires an explicit published row even when a legacy coordinate-only command parses', async () => {
  const f = await fixture(); f.capture()
  const { publishedRow: _row, expectedRowRevision: _revision, ...operation } = f.correction(1, f.row({ listNo: 10 }))
  const before = f.sqlite.prepare('SELECT * FROM record_evidence ORDER BY id').all()
  const plan = await f.post('preflight', f.request({ officialEvidenceCorrections: { actor: { type: 'agent', id: 'synthetic' }, basis: 'Coordinate-only legacy correction', operations: [operation] } }, 'discovery-coordinate-only'))
  expect(plan.status).toBe(200)
  expect(plan.body.preflight.conflicts).toEqual([expect.objectContaining({ error: expect.objectContaining({ code: 'ambiguity', message: 'A mixed typed correction batch requires explicit publishedRow for every target' }) })])
  expect(f.sqlite.prepare('SELECT * FROM record_evidence ORDER BY id').all()).toEqual(before)
})

it('advances one event CAS for an opt-in append combined with legacy convergence losing a page', async () => {
  const f = await fixture()
  const bytes = 'synthetic official source\n'
  writeFileSync(join(f.filesDir, 'old.pdf'), bytes)
  f.db.insert(schema.storedFile).values({ id: 3, relPath: 'old.pdf', filename: 'old.pdf', ext: 'pdf', bytes: Buffer.byteLength(bytes), sha256: f.row().sha256!, source: 'jxj', kind: 'announcement', titleCode: 'specialized_sme' }).run()
  f.sqlite.exec("UPDATE record_evidence SET source_file='old.pdf',page=1 WHERE id=1")
  f.capture(1, 1, 1, { path: 'old.pdf', storedFileId: 3, page: 1 })
  const publishedRow = f.row({ listNo: 10 })
  await f.commit(f.request({ announcement: { sourceDocument: { source: 'jxj', title: 'Declared publication' }, records: [{ enterprise: { name: 'Alpha' }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year: 2021, evidence: [{ sourceFile: 'notice.txt', attachment: null, listNo: 1, page: null }] }] }] }, officialEvidenceAppends: [{ ...f.append(1, publishedRow), evidence: { ...f.append(1, publishedRow).evidence, listNo: 10 } }] }))
  expect(f.sqlite.prepare('SELECT revision FROM record_event WHERE id=1').get()).toEqual({ revision: 2 })
  expect(f.sqlite.prepare('SELECT source_file,page FROM record_evidence WHERE id=1').get()).toEqual({ source_file: 'notice.txt', page: null })
  expect(readLatestOfficialEvidence(f.db, 1).row).toMatchObject({ revision: 1, path: 'old.pdf', page: 1 })
})
