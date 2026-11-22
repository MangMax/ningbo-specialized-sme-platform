import { expect, it } from 'vitest'
import { readPostgresOfficialEvidencePages as pages } from '../../../layers/sme-roster/server/utils/official-evidence-postgres'
import type { OfficialEvidenceRow } from '../../../layers/sme-roster/server/utils/official-evidence'
import { useIsolatedPostgresCases } from '../../support/isolated-postgres-cases'

const openCase = useIsolatedPostgresCases()
const originalName = '  旧名🙂\u0000é  '

function literalRow(evidenceId = 1, eventId = 1): OfficialEvidenceRow {
  return {
    formatVersion: 1, evidenceId, eventId, revision: 1, capturedRecordId: eventId, capturedEnterpriseId: eventId,
    nameRaw: originalName, usccRaw: '', districtRaw: null, sourceDocumentId: null, storedFileId: null,
    path: 'synthetic.pdf', sha256: null, bytes: null, attachment: null, sectionKey: null, listNo: null, page: null,
    sourceBindingKnown: false, actor: { type: 'agent', id: 'synthetic-agent' }, basis: 'synthetic basis',
    command: { kind: 'import', batchId: 1 }, createdAt: 'synthetic', currentOwner: { recordId: eventId, enterpriseId: eventId },
  }
}

function page(eventId: number, rows: OfficialEvidenceRow[], nextAfterEvidenceId: number | null = null) {
  return { eventId, page: { formatVersion: 1, eventId, rows, nextAfterEvidenceId } }
}

async function fixture() {
  const db = openCase()
  const query = (statement: string, values?: unknown[]) => db.$client.query(statement, values)
  await query(`
    INSERT INTO import_batch(id,idempotency_key,source_kind,source_identity,created_at)
      VALUES(1,'synthetic','announcement','synthetic','synthetic');
    INSERT INTO enterprise(id,name,name_norm)
      SELECT n, 'canonical-' || n, 'canonical-' || n FROM generate_series(1,40) AS n;
    INSERT INTO record(id,enterprise_id,title_code,source)
      SELECT n, n, 'specialized_sme', 'jxj' FROM generate_series(1,40) AS n;
    INSERT INTO record_event(id,record_id,event_type,year)
      SELECT n, n, 'award', 2021 FROM generate_series(1,40) AS n;
  `)
  const evidence = (eventId: number, first: number, last: number) => query(`
    INSERT INTO record_evidence(id,record_event_id,source_file)
      SELECT n, $1, 'synthetic.pdf' FROM generate_series($2::int,$3::int) AS n
  `, [eventId, first, last])
  const capture = (first: number, last: number, basis = 'synthetic basis', revision = 1) => query(`
    INSERT INTO official_evidence_row_revision(
      evidence_id,revision,event_id,captured_record_id,captured_enterprise_id,
      name_raw_json,uscc_raw,path,source_binding_known,actor,basis,command_kind,import_batch_id,created_at)
    SELECT id,$5,record_event_id,record_event_id,record_event_id,$3,'','synthetic.pdf',0,
      '{"type":"agent","id":"synthetic-agent"}',$4,'import',1,'synthetic'
    FROM record_evidence WHERE id BETWEEN $1 AND $2
  `, [first, last, JSON.stringify(originalName), basis, revision])
  return { db, query, evidence, capture }
}

it('returns literal captured facts in input order including repeated events, absent events and uncaptured legacy evidence', async () => {
  const f = await fixture()
  await f.query(`INSERT INTO record_evidence(id,record_event_id,source_file)
    SELECT n, n, 'synthetic.pdf' FROM generate_series(1,40) AS n`)
  await f.capture(1, 39)
  const ids = Array.from({ length: 40 }, (_, i) => 40 - i)
  expect(await pages(f.db, ids.map(eventId => ({ eventId })))).toEqual(ids.map(id => page(id, id === 40 ? [] : [literalRow(id, id)])))
  expect(await pages(f.db, [{ eventId: 8 }, { eventId: 8, afterEvidenceId: 8 }, { eventId: Number.MAX_SAFE_INTEGER }]))
    .toEqual([page(8, [literalRow(8, 8)]), page(8, []), page(Number.MAX_SAFE_INTEGER, [])])
})

it('paginates with the strict cursor even when the next capture exceeds the field limit', async () => {
  const f = await fixture()
  await f.evidence(1, 1, 51)
  await f.capture(1, 50)
  await f.capture(51, 51, '🙂'.repeat(2000) + 'x')
  expect(await pages(f.db, [{ eventId: 1 }, { eventId: 2 }])).toEqual([
    page(1, Array.from({ length: 50 }, (_, i) => literalRow(i + 1)), 50), page(2, []),
  ])
  expect(await pages(f.db, [{ eventId: 1, afterEvidenceId: 50 }])).toEqual([{ eventId: 1, error: 'field_limit' }])
  await f.capture(51, 51, '🙂'.repeat(2000), 2)
  expect(await pages(f.db, [{ eventId: 1, afterEvidenceId: 50 }, { eventId: 1, afterEvidenceId: 51 }]))
    .toEqual([page(1, [{ ...literalRow(51), revision: 2, basis: '🙂'.repeat(2000) }]), page(1, [])])
})

it.each([false, true])('counts all event evidence before a cursor with captured rows present %s', async captured => {
  const f = await fixture()
  await f.evidence(1, 1, 300)
  if (captured) await f.capture(1, 1)
  expect(await pages(f.db, [{ eventId: 1, afterEvidenceId: 300 }])).toEqual([page(1, [])])
  await f.evidence(1, 301, 301)
  expect(await pages(f.db, [{ eventId: 1, afterEvidenceId: 301 }])).toEqual([{ eventId: 1, error: 'source_limit' }])
})

it('returns latest raw values after a legal record fold while retaining captured owner IDs', async () => {
  const f = await fixture()
  await f.evidence(1, 1, 1)
  await f.capture(1, 1)
  await f.query(`
    UPDATE record_event SET record_id=2 WHERE id=1;
    DELETE FROM record WHERE id=1;
    DELETE FROM enterprise WHERE id=1;
    INSERT INTO official_evidence_row_revision(
      evidence_id,revision,event_id,captured_record_id,captured_enterprise_id,name_raw,uscc_raw,
      path,source_binding_known,actor,basis,command_kind,import_batch_id,created_at)
    SELECT evidence_id,2,event_id,captured_record_id,captured_enterprise_id,'   ','',
      path,source_binding_known,actor,basis,command_kind,import_batch_id,created_at
    FROM official_evidence_row_revision WHERE evidence_id=1;
  `)
  expect(await pages(f.db, [{ eventId: 1 }])).toEqual([
    page(1, [{ ...literalRow(), revision: 2, nameRaw: '   ', currentOwner: { enterpriseId: 2, recordId: 2 } }]),
  ])
})

it.each([65536, 65537])('uses the full UTF-8 byte budget when the page occupies %i bytes', async bytes => {
  const f = await fixture()
  await f.evidence(1, 1, 20)
  const rows = Array.from({ length: 20 }, (_, i) => ({ ...literalRow(i + 1), basis: '' }))
  let remaining = bytes - Buffer.byteLength(JSON.stringify(page(1, rows).page))
  for (const row of rows) {
    row.basis = 'x'.repeat(Math.min(4000, remaining))
    remaining -= row.basis.length
    await f.capture(row.evidenceId, row.evidenceId, row.basis)
  }
  expect(remaining).toBe(0)
  expect(Buffer.byteLength(JSON.stringify(page(1, rows).page))).toBe(bytes)
  expect(await pages(f.db, [{ eventId: 1 }, { eventId: 2 }]))
    .toEqual([bytes === 65536 ? page(1, rows) : { eventId: 1, error: 'response_limit' }, page(2, [])])
})

it('sees uncommitted capture updates through the caller transaction', async () => {
  const f = await fixture()
  await f.evidence(1, 1, 1)
  await f.capture(1, 1)
  const failure = new Error('rollback caller')
  await expect(f.db.transaction(async tx => {
    await tx.execute(`
      INSERT INTO business.official_evidence_row_revision(
        evidence_id,revision,event_id,captured_record_id,captured_enterprise_id,name_raw_json,uscc_raw,
        path,source_binding_known,actor,basis,command_kind,import_batch_id,created_at)
      SELECT evidence_id,2,event_id,captured_record_id,captured_enterprise_id,name_raw_json,uscc_raw,
        path,source_binding_known,actor,'pending caller change',command_kind,import_batch_id,created_at
      FROM business.official_evidence_row_revision WHERE evidence_id=1
    `)
    expect(await pages(tx, [{ eventId: 1 }])).toEqual([page(1, [{ ...literalRow(), revision: 2, basis: 'pending caller change' }])])
    throw failure
  })).rejects.toBe(failure)
  expect(await pages(f.db, [{ eventId: 1 }])).toEqual([page(1, [literalRow()])])
})
