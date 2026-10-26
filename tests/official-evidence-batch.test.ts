import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, expect, it } from 'vitest'
import * as schema from '../db/schema'
import {
  listEventsOfficialEvidencePages as batch, listEventOfficialEvidence, OfficialEvidenceError,
  type OfficialEvidenceExecutor, type OfficialEvidenceRow,
} from '../server/utils/official-evidence'

// Independent fixtures and expected full rows: neither the old reader nor the writer
// supplies these oracles. All databases are small, synthetic and process-local.
const handles: Database.Database[] = []
afterEach(() => handles.splice(0).forEach(db => db.close()))
const fields = [
  ['nameRaw', 'name_raw'], ['usccRaw', 'uscc_raw'], ['districtRaw', 'district_raw'],
  ['path', 'path'], ['sha256', 'sha256'], ['attachment', 'attachment'],
  ['sectionKey', 'section_key'], ['basis', 'basis'], ['actorId', 'actor'],
  ['batchKey', 'correction_batch_key'], ['createdAt', 'created_at'],
] as const
function literalRow(evidenceId = 1, eventId = 1): OfficialEvidenceRow {
  return { formatVersion: 1, evidenceId, eventId, revision: 1,
    capturedRecordId: eventId, capturedEnterpriseId: eventId,
    nameRaw: '  旧名🙂\u0000é  ', usccRaw: '', districtRaw: null,
    sourceDocumentId: null, storedFileId: null, path: 'synthetic.pdf', sha256: null,
    bytes: null, attachment: null, sectionKey: null, listNo: null, page: null,
    sourceBindingKnown: false, actor: { type: 'agent', id: 'synthetic-agent' },
    basis: 'synthetic basis', command: { kind: 'import', batchId: 1 }, createdAt: 'synthetic',
    currentOwner: { recordId: eventId, enterpriseId: eventId } }
}
const page = (eventId: number, rows: OfficialEvidenceRow[] = [], nextAfterEvidenceId: number | null = null) =>
  ({ formatVersion: 1, eventId, rows, nextAfterEvidenceId })
const failure = (eventId: number, error: string) => ({ eventId, error })
function fixture() {
  const sqlite = new Database(':memory:'); handles.push(sqlite); sqlite.pragma('foreign_keys=ON')
  const statements: { sql: string; params: unknown[] }[] = []
  const db = drizzle(sqlite, { schema, logger: { logQuery(sql, params) { statements.push({ sql, params }) } } })
  migrate(db, { migrationsFolder: 'db/migrations' })
  sqlite.exec(`INSERT INTO title(code,name_zh,level,rank) VALUES('specialized_sme','synthetic','municipal',2);
    INSERT INTO import_batch(id,idempotency_key,source_kind,source_identity,created_at) VALUES(1,'synthetic','announcement','synthetic','synthetic');`)
  const event = (id: number) => {
    sqlite.prepare('INSERT INTO enterprise(id,name,name_norm) VALUES(?,?,?)').run(id, `synthetic-${id}`, `synthetic-${id}`)
    sqlite.prepare("INSERT INTO record(id,enterprise_id,title_code,source,name_raw) VALUES(?,?,'specialized_sme','jxj','container name')").run(id, id)
    sqlite.prepare("INSERT INTO record_event(id,record_id,event_type,year) VALUES(?,?,'award',2021)").run(id, id)
  }
  const evidence = (id: number, eventId = 1) => sqlite.prepare("INSERT INTO record_evidence(id,record_event_id,source_file) VALUES(?,?,'synthetic.pdf')").run(id, eventId)
  const seed = (id = 1, eventId = 1) => {
    evidence(id, eventId)
    sqlite.prepare(`INSERT INTO official_evidence_row_revision(
      evidence_id,revision,format_version,event_id,captured_record_id,captured_enterprise_id,
      name_raw,uscc_raw,district_raw,source_document_id,stored_file_id,path,sha256,bytes,
      attachment,section_key,list_no,page,source_binding_known,actor,basis,command_kind,
      import_batch_id,correction_batch_key,created_at)
      VALUES(?,1,1,?,?,?,?,'',NULL,NULL,NULL,'synthetic.pdf',NULL,NULL,NULL,NULL,NULL,NULL,0,
      '{"type":"agent","id":"synthetic-agent"}','synthetic basis','import',1,NULL,'synthetic')`)
      .run(id, eventId, eventId, eventId, '  旧名🙂\u0000é  ')
  }
  const update = (field: typeof fields[number][0], value: string, id = 1) => {
    const column = fields.find(([key]) => key === field)![1]
    if (field === 'batchKey') {
      sqlite.prepare("INSERT OR IGNORE INTO evidence_correction_batch(idempotency_key,request_hash,plan_hash,receipt,created_at) VALUES(?,'synthetic','synthetic','{}','synthetic')").run(value)
      sqlite.prepare("UPDATE official_evidence_row_revision SET command_kind='evidence_correction',import_batch_id=NULL,correction_batch_key=? WHERE evidence_id=?").run(value, id)
    } else sqlite.prepare(`UPDATE official_evidence_row_revision SET ${column}=? WHERE evidence_id=?`)
      .run(field === 'actorId' ? JSON.stringify({ type: 'agent', id: value }) : value, id)
  }
  const calls: unknown[][] = []
  const callStatements: (typeof statements)[] = []
  const executor: OfficialEvidenceExecutor = {
    all: ((query: Parameters<typeof db.all>[0]) => {
      const start = statements.length
      const rows = db.all(query)
      callStatements.push(statements.slice(start))
      calls.push(rows)
      return rows
    }) as typeof db.all,
    get: (() => { throw new Error('Unexpected per-event get') }) as typeof db.get,
    run: (() => { throw new Error('Unexpected write') }) as typeof db.run,
  }
  event(1); statements.length = 0
  return { sqlite, db, event, evidence, seed, update, executor, calls, callStatements, statements }
}
function invalid(run: () => unknown) {
  let caught: unknown
  try { run() } catch (error) { caught = error }
  expect(caught).toBeInstanceOf(OfficialEvidenceError)
  expect(caught).toMatchObject({ statusCode: 400, code: 'invalid_input' })
}
function materialization(f: ReturnType<typeof fixture>, count: number) {
  expect(f.calls).toHaveLength(1); expect(f.calls[0]).toHaveLength(count)
  expect(f.callStatements).toHaveLength(1)
  expect(f.callStatements[0]).toHaveLength(1)
  expect(f.callStatements[0]![0]!.params.length).toBeLessThanOrEqual(122)
  for (const gate of f.calls[0]!) expect(Buffer.byteLength(JSON.stringify(gate))).toBeLessThanOrEqual(65536 + 1024)
}

it('returns an empty scope without any executor call', () => {
  const f = fixture()
  expect(batch(f.executor, [])).toEqual([])
  expect(f.calls).toEqual([]); expect(f.statements).toEqual([])
})

it.each([
  { id: 'not-array', requests: {} }, { id: 'null', requests: null },
  { id: 'forty-one', requests: Array.from({ length: 41 }, (_, i) => ({ eventId: i + 1 })) },
  { id: 'duplicate', requests: [{ eventId: 1 }, { eventId: 1, afterEvidenceId: 2 }] },
  { id: 'unknown-key', requests: [{ eventId: 1, evidenceId: 1 }] },
  { id: 'nested-array', requests: [[1]] }, { id: 'nonplain', requests: [new Date()] },
  { id: 'null-prototype', requests: [Object.assign(Object.create(null), { eventId: 1 })] },
  { id: 'missing-id', requests: [{}] }, { id: 'string-id', requests: [{ eventId: '1' }] },
  { id: 'zero-id', requests: [{ eventId: 0 }] }, { id: 'negative-id', requests: [{ eventId: -1 }] },
  { id: 'fraction-id', requests: [{ eventId: 1.5 }] }, { id: 'unsafe-id', requests: [{ eventId: 9007199254740992 }] },
  { id: 'nan-id', requests: [{ eventId: NaN }] }, { id: 'boolean-id', requests: [{ eventId: true }] },
  { id: 'null-cursor', requests: [{ eventId: 1, afterEvidenceId: null }] },
  { id: 'zero-cursor', requests: [{ eventId: 1, afterEvidenceId: 0 }] },
  { id: 'unsafe-cursor', requests: [{ eventId: 1, afterEvidenceId: 9007199254740992 }] },
  { id: 'fraction-cursor', requests: [{ eventId: 1, afterEvidenceId: 1.5 }] },
  { id: 'string-cursor', requests: [{ eventId: 1, afterEvidenceId: '1' }] },
])('rejects request $id before SQL', ({ requests }) => {
  const f = fixture(); invalid(() => batch(f.executor, requests as never))
  expect(f.calls).toEqual([]); expect(f.statements).toEqual([])
})

it.each([
  { id: 'unknown', options: { afterEvidenceId: 1 } }, { id: 'null', options: null },
  { id: 'array', options: [] }, { id: 'page-zero', options: { pageSize: 0 } },
  { id: 'page-51', options: { pageSize: 51 } }, { id: 'page-fraction', options: { pageSize: 1.5 } },
  { id: 'page-string', options: { pageSize: '20' } }, { id: 'bytes-zero', options: { maxBytes: 0 } },
  { id: 'bytes-65537', options: { maxBytes: 65537 } }, { id: 'bytes-string', options: { maxBytes: '16384' } },
  { id: 'bytes-unsafe', options: { maxBytes: 9007199254740992 } },
])('rejects options $id even for empty scope', ({ options }) => {
  const f = fixture(); invalid(() => batch(f.executor, [], options as never))
  expect(f.calls).toEqual([]); expect(f.statements).toEqual([])
})

it('returns full literal pages in request order with one statement and exactly 122 binds for forty events', () => {
  const f = fixture(); f.seed()
  for (let id = 2; id <= 40; id++) { f.event(id); f.seed(id, id) }
  const ids = Array.from({ length: 40 }, (_, i) => 40 - i)
  expect(batch(f.executor, ids.map(eventId => ({ eventId })), { pageSize: 50, maxBytes: 65536 }))
    .toEqual(ids.map(eventId => ({ eventId, page: page(eventId, [literalRow(eventId, eventId)]) })))
  materialization(f, 40); expect(f.callStatements[0]![0]!.params).toHaveLength(122)
  expect(Buffer.byteLength(JSON.stringify(f.calls[0]))).toBeLessThanOrEqual(40 * 66560)
})

it('keeps null empty whitespace raw values and returns empty pages for legacy and absent events', () => {
  const f = fixture(); f.seed(); f.update('nameRaw', '   '); f.evidence(2)
  expect(batch(f.executor, [{ eventId: 1 }, { eventId: 9007199254740991, afterEvidenceId: 9007199254740991 }]))
    .toEqual([{ eventId: 1, page: page(1, [{ ...literalRow(), nameRaw: '   ' }]) },
      { eventId: 9007199254740991, page: page(9007199254740991) }])
  materialization(f, 2)
})

it('uses default twenty and strict cursors with fifty visible rows and an unprojected fifty-first probe', () => {
  const f = fixture()
  for (let id = 1; id <= 51; id++) f.seed(id)
  const first = batch(f.db, [{ eventId: 1 }], { maxBytes: 65536 })
  expect(first).toEqual([{ eventId: 1, page: page(1, Array.from({ length: 20 }, (_, i) => literalRow(i + 1)), 20) }])
  f.update('path', 'probe-only'.repeat(20000), 51)
  expect(batch(f.executor, [{ eventId: 1 }], { pageSize: 50, maxBytes: 65536 }))
    .toEqual([{ eventId: 1, page: page(1, Array.from({ length: 50 }, (_, i) => literalRow(i + 1)), 50) }])
  materialization(f, 1); expect(JSON.stringify(f.calls)).not.toContain('probe-only')
  expect(batch(f.db, [{ eventId: 1, afterEvidenceId: 50 }], { pageSize: 50, maxBytes: 65536 })).toEqual([failure(1, 'field_limit')])
  f.update('path', 'synthetic.pdf', 51)
  expect(batch(f.db, [{ eventId: 1, afterEvidenceId: 50 }], { pageSize: 50, maxBytes: 65536 }))
    .toEqual([{ eventId: 1, page: page(1, [literalRow(51)]) }])
  expect(batch(f.db, [{ eventId: 1, afterEvidenceId: 51 }])).toEqual([{ eventId: 1, page: page(1) }])
  expect(batch(f.db, [{ eventId: 1, afterEvidenceId: 1 }], { pageSize: 50, maxBytes: 65536 }))
    .toEqual([{ eventId: 1, page: page(1, Array.from({ length: 50 }, (_, i) => literalRow(i + 2))) }])
})

it.each([{ id: 'legacy', captured: false }, { id: 'mixed', captured: true }])('checks whole-event 300 and 301 $id entries after the cursor', ({ captured }) => {
  const f = fixture()
  if (captured) f.seed(); else f.evidence(1)
  for (let id = 2; id <= 300; id++) f.evidence(id)
  expect(batch(f.db, [{ eventId: 1, afterEvidenceId: 300 }])).toEqual([{ eventId: 1, page: page(1) }])
  f.evidence(301)
  expect(batch(f.executor, [{ eventId: 1, afterEvidenceId: 301 }], { maxBytes: 1 })).toEqual([failure(1, 'source_limit')])
  materialization(f, 1)
})

it('takes true latest across K binding and raw-only revisions without resurrecting old rows', () => {
  const f = fixture(); f.seed()
  f.sqlite.exec(`INSERT INTO source_document(id,source,title,path) VALUES(1,'jxj','synthetic','synthetic');
    UPDATE official_evidence_row_revision SET source_binding_known=1,source_document_id=1,
    sha256='${'a'.repeat(64)}',bytes=0,section_key='K-A',list_no=1;
    INSERT INTO official_evidence_row_revision SELECT evidence_id,2,format_version,event_id,captured_record_id,captured_enterprise_id,
    'new K','',NULL,1,NULL,path,sha256,0,NULL,'K-B',1,NULL,1,actor,basis,command_kind,import_batch_id,NULL,created_at FROM official_evidence_row_revision WHERE revision=1;`)
  const second = { ...literalRow(), revision: 2, nameRaw: 'new K', sourceBindingKnown: true, sourceDocumentId: 1, sha256: 'a'.repeat(64), bytes: 0, sectionKey: 'K-B', listNo: 1 }
  expect(batch(f.db, [{ eventId: 1 }])).toEqual([{ eventId: 1, page: page(1, [second]) }])
  f.sqlite.exec(`INSERT INTO official_evidence_row_revision SELECT evidence_id,3,format_version,event_id,captured_record_id,captured_enterprise_id,
    NULL,'',NULL,source_document_id,NULL,path,sha256,bytes,attachment,section_key,list_no,page,0,actor,basis,command_kind,import_batch_id,NULL,created_at FROM official_evidence_row_revision WHERE revision=2;`)
  const unknown = { ...second, revision: 3, nameRaw: null, sourceBindingKnown: false }
  expect(batch(f.db, [{ eventId: 1 }])).toEqual([{ eventId: 1, page: page(1, [unknown]) }])
  f.sqlite.exec(`INSERT INTO official_evidence_row_revision SELECT evidence_id,4,format_version,event_id,captured_record_id,captured_enterprise_id,
    'raw-only','',NULL,source_document_id,NULL,path,sha256,bytes,attachment,section_key,list_no,page,0,actor,basis,command_kind,import_batch_id,NULL,created_at FROM official_evidence_row_revision WHERE revision=3;`)
  expect(batch(f.db, [{ eventId: 1 }])).toEqual([{ eventId: 1, page: page(1, [{ ...unknown, revision: 4, nameRaw: 'raw-only' }]) }])
})

it.each(['event', 'record', 'enterprise'] as const)('keeps captured origin and explicit null owner for a missing %s link', link => {
  const f = fixture(); f.seed(); f.event(2)
  f.sqlite.exec('UPDATE record_event SET record_id=2 WHERE id=1; DELETE FROM record WHERE id=1; DELETE FROM enterprise WHERE id=1;')
  const merged = { ...literalRow(), currentOwner: { recordId: 2, enterpriseId: 2 } }
  expect(batch(f.db, [{ eventId: 1 }])).toEqual([{ eventId: 1, page: page(1, [merged]) }])
  f.sqlite.pragma('foreign_keys=OFF')
  f.sqlite.exec(`DELETE FROM ${link === 'event' ? 'record_event' : link} WHERE id=${link === 'event' ? 1 : 2}`)
  f.sqlite.pragma('foreign_keys=ON')
  expect(batch(f.db, [{ eventId: 1 }])).toEqual([{ eventId: 1, page: page(1, [{ ...merged, currentOwner: null }]) }])
})

const encodings = [
  { id: 'ascii', at: 'x'.repeat(4000), over: 'x'.repeat(4001) },
  { id: 'nul', at: '\u0000'.repeat(4000), over: '\u0000'.repeat(4001) },
  { id: 'emoji', at: '🙂'.repeat(2000), over: '🙂'.repeat(2000) + 'x' },
]
it.each(fields.flatMap(([field]) => encodings.map(encoding => ({ field, ...encoding }))))
('checks $field $id at and beyond four thousand UTF16 units', ({ field, id, at, over }) => {
  const f = fixture(); f.seed(); f.update(field, at)
  const expected = literalRow()
  if (field === 'actorId') expected.actor.id = at
  else if (field === 'batchKey') expected.command = { kind: 'evidence_correction', batchKey: at }
  else expected[field] = at
  expect(batch(f.db, [{ eventId: 1 }], { pageSize: 1, maxBytes: 65536 })).toEqual([{ eventId: 1, page: page(1, [expected]) }])
  f.update(field, over)
  // createdAt intentionally retains the old SQL scalar/blob-only guard.
  if (field === 'createdAt' && id !== 'ascii') {
    expect(batch(f.executor, [{ eventId: 1 }], { pageSize: 1, maxBytes: 65536 }))
      .toEqual([{ eventId: 1, page: page(1, [{ ...expected, createdAt: over }]) }])
  } else expect(batch(f.executor, [{ eventId: 1 }], { pageSize: 1, maxBytes: 65536 })).toEqual([failure(1, 'field_limit')])
  materialization(f, 1)
})

it.each(fields.map(([field]) => ({ field })))('rejects huge stored $field before returning raw text to the driver', ({ field }) => {
  const f = fixture(); f.seed(); f.update(field, 'oversized-synthetic'.repeat(12000))
  expect(batch(f.executor, [{ eventId: 1 }], { maxBytes: 65536 })).toEqual([failure(1, 'field_limit')])
  materialization(f, 1); expect(JSON.stringify(f.calls)).not.toContain('oversized-synthetic')
})

// Fixed event1 fixture only: SQL budget text retains numeric eventId 1.0.
// The full JS expected page still contains the number 1 and every row field.
const fixedEventOneSQLBudgetText = (rows: readonly OfficialEvidenceRow[]) =>
  '{"formatVersion":1,"eventId":1.0,"rows":' + JSON.stringify(rows) + ',"nextAfterEvidenceId":null}'
function byteFixture(target: number) {
  const f = fixture(), rows = [literalRow(1), literalRow(2), literalRow(3)]
  const slots = ['nameRaw', 'usccRaw', 'districtRaw', 'path', 'sha256', 'attachment', 'sectionKey', 'basis'] as const
  rows.forEach((row, i) => { f.seed(i + 1); for (const field of slots) { row[field] = ''; f.update(field, '', i + 1) } })
  let remaining = target - Buffer.byteLength(fixedEventOneSQLBudgetText(rows))
  for (const row of rows) for (const field of slots) {
    const value = 'x'.repeat(Math.min(4000, remaining)); row[field] = value; f.update(field, value, row.evidenceId); remaining -= value.length
  }
  expect(remaining).toBe(0)
  expect(Buffer.byteLength(fixedEventOneSQLBudgetText(rows))).toBe(target)
  expect(Buffer.byteLength(JSON.stringify(page(1, rows)))).toBe(target - 2)
  return { ...f, expected: page(1, rows) }
}
function compareOldBudgetPage(f: ReturnType<typeof byteFixture>, bytes: number, readOptions: { maxBytes?: number }, succeeds: boolean) {
  const gates: unknown[] = []
  const oldExecutor: OfficialEvidenceExecutor = {
    get: ((query: Parameters<typeof f.db.get>[0]) => {
      const gate = f.db.get(query)
      gates.push(gate)
      return gate
    }) as typeof f.db.get,
    all: (() => { throw new Error('Unexpected legacy all') }) as typeof f.db.all,
    run: (() => { throw new Error('Unexpected legacy write') }) as typeof f.db.run,
  }
  let result: unknown, caught: unknown
  try { result = listEventOfficialEvidence(oldExecutor, 1, readOptions) } catch (error) { caught = error }
  if (succeeds) {
    expect(caught).toBeUndefined()
    expect(result).toEqual(f.expected)
  } else {
    expect(caught).toBeInstanceOf(OfficialEvidenceError)
    expect(caught).toMatchObject({ statusCode: 413, code: 'response_limit' })
  }
  expect(gates).toHaveLength(1)
  expect(gates[0]).toMatchObject({ scopeCount: 3, count: 3, fieldLimit: 0, requiredBytes: bytes })
  if (!succeeds) expect(gates[0]).toMatchObject({ projection: null })
}
it.each([65535, 65536, 65537])('gates the independent full page at %i UTF8 bytes without shrinking', bytes => {
  const f = byteFixture(bytes)
  compareOldBudgetPage(f, bytes, { maxBytes: 65536 }, bytes <= 65536)
  expect(batch(f.executor, [{ eventId: 1 }], { maxBytes: 65536 }))
    .toEqual(bytes <= 65536 ? [{ eventId: 1, page: f.expected }] : [failure(1, 'response_limit')])
  materialization(f, 1)
  const gate = JSON.parse((f.calls[0]![0] as { gate_json: string }).gate_json)
  expect(gate).toMatchObject({ scopeCount: 3, count: 3, fieldLimit: 0, requiredBytes: bytes })
  expect(gate.projection === null).toBe(bytes > 65536)
  if (bytes > 65536) expect(JSON.stringify(f.calls)).not.toContain('x'.repeat(100))
})
it.each([16384, 16385])('uses default sixteen KiB for an independent %i byte page', bytes => {
  const f = byteFixture(bytes)
  compareOldBudgetPage(f, bytes, {}, bytes === 16384)
  expect(batch(f.executor, [{ eventId: 1 }])).toEqual(bytes === 16384 ? [{ eventId: 1, page: f.expected }] : [failure(1, 'response_limit')])
  materialization(f, 1)
  const gate = JSON.parse((f.calls[0]![0] as { gate_json: string }).gate_json)
  expect(gate).toMatchObject({ scopeCount: 3, count: 3, fieldLimit: 0, requiredBytes: bytes })
  expect(gate.projection === null).toBe(bytes !== 16384)
})

it('checks nonselected evidence and SQL errors in source field response UTF16 order per event', () => {
  const f = fixture(); f.seed(); f.seed(2); f.event(2); f.seed(1000, 2); f.event(3); f.seed(2000, 3)
  f.update('path', 'x'.repeat(4001), 2)
  expect(batch(f.db, [{ eventId: 1, afterEvidenceId: 1 }], { maxBytes: 1 })).toEqual([failure(1, 'field_limit')])
  f.update('path', '🙂'.repeat(2000) + 'x', 2)
  expect(batch(f.db, [{ eventId: 1, afterEvidenceId: 1 }], { maxBytes: 1 })).toEqual([failure(1, 'response_limit')])
  expect(batch(f.db, [{ eventId: 1, afterEvidenceId: 1 }], { maxBytes: 65536 })).toEqual([failure(1, 'field_limit')])
  for (let id = 3; id <= 301; id++) f.evidence(id)
  f.update('path', 'x'.repeat(4001), 1000)
  expect(batch(f.executor, [{ eventId: 3 }, { eventId: 2 }, { eventId: 1 }], { maxBytes: 1 }))
    .toEqual([failure(3, 'response_limit'), failure(2, 'field_limit'), failure(1, 'source_limit')])
  materialization(f, 3)
  // A returns each event's status; it cannot let event2's first page hide event1's later page.
})

it('returns later-event status while retaining an earlier event cursor for its next-page error', () => {
  const f = fixture(); f.seed(); f.seed(2); f.update('basis', 'x'.repeat(4001), 2); f.event(2)
  for (let id = 1000; id <= 1300; id++) f.evidence(id, 2)
  expect(batch(f.db, [{ eventId: 1 }, { eventId: 2 }], { pageSize: 1, maxBytes: 65536 }))
    .toEqual([{ eventId: 1, page: page(1, [literalRow()], 1) }, failure(2, 'source_limit')])
  expect(batch(f.db, [{ eventId: 1, afterEvidenceId: 1 }], { pageSize: 1, maxBytes: 65536 })).toEqual([failure(1, 'field_limit')])
})

it('uses the caller transaction executor and retains all old-reader values as a secondary comparison', () => {
  const f = fixture(); f.seed()
  f.db.transaction(tx => {
    f.update('nameRaw', 'in caller snapshot')
    const expected = page(1, [{ ...literalRow(), nameRaw: 'in caller snapshot' }])
    expect(batch(tx, [{ eventId: 1 }])).toEqual([{ eventId: 1, page: expected }])
    expect(listEventOfficialEvidence(tx, 1)).toEqual(expected)
  })
})

it('propagates unknown SQL failures unchanged instead of returning legacy or partial pages', () => {
  const f = fixture(), sentinel = new Error('synthetic infrastructure failure')
  const executor = { ...f.executor, all: (() => { throw sentinel }) as typeof f.executor.all }
  expect(() => batch(executor, [{ eventId: 1 }, { eventId: 2 }])).toThrow(sentinel)
  expect(f.calls).toEqual([])
})
