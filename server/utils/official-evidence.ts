import { sql, type SQL } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '../../db/schema'

/** Domain-only storage seam. Both a database and its caller-owned transaction satisfy this type. */
export type OfficialEvidenceExecutor = Pick<BetterSQLite3Database<typeof schema>, 'get' | 'all' | 'run'>
export type OfficialEvidenceCommand = { kind: 'import'; batchId: number } | { kind: 'evidence_correction'; batchKey: string }
export interface OfficialEvidenceSourceKey {
  sourceDocumentId: number
  sha256: string
  bytes: number
  /** null here explicitly means confirmed no attachment, never an unknown binding. */
  attachment: string | null
  sectionKey: string
  listNo: number
}
export interface OfficialEvidenceCapture {
  evidenceId: number; eventId: number
  capturedRecordId: number; capturedEnterpriseId: number
  nameRaw: string | null; usccRaw: string | null; districtRaw: string | null
  sourceDocumentId: number | null; storedFileId: number | null
  path: string | null; sha256: string | null; bytes: number | null
  attachment: string | null; sectionKey: string | null; listNo: number | null; page: number | null
  sourceBindingKnown: boolean
  actor: { type: 'user' | 'agent'; id: string }
  basis: string
  command: OfficialEvidenceCommand
}
export interface OfficialEvidenceCandidate {
  evidenceId: number; eventId: number; revision: number
  capturedRecordId: number; capturedEnterpriseId: number
  nameRaw: string | null; usccRaw: string | null; districtRaw: string | null
  currentOwner: { recordId: number; enterpriseId: number } | null
}
export interface OfficialEvidenceRow extends OfficialEvidenceCapture {
  formatVersion: 1; revision: number; createdAt: string
  currentOwner: OfficialEvidenceCandidate['currentOwner']
}
export interface OfficialEvidenceReadOptions { maxBytes?: number }
export interface OfficialEvidenceHistoryOptions extends OfficialEvidenceReadOptions { pageSize?: number; beforeRevision?: number }
export interface OfficialEvidenceEventOptions extends OfficialEvidenceReadOptions { pageSize?: number; afterEvidenceId?: number }
export class OfficialEvidenceError extends Error {
  constructor(readonly statusCode: number, readonly code: 'invalid_input' | 'field_limit' | 'input_limit' | 'revision_conflict' | 'reference_mismatch' | 'source_limit' | 'response_limit', message: string, cause?: unknown) { super(message, { cause }) }
}
const invalid = (message: string): never => { throw new OfficialEvidenceError(400, 'invalid_input', message) }
const rawFields = ['nameRaw', 'usccRaw', 'districtRaw'] as const
const textFields = [...rawFields, 'path', 'sha256', 'attachment', 'sectionKey', 'basis'] as const
function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid('Expected a plain object')
}
function keys(value: object, allowed: readonly string[]) {
  object(value)
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid('Unsupported input field')
}
function integer(value: unknown, name: string, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid(`${name} must be a safe integer between ${min} and ${max}`)
  return value as number
}
function text(value: unknown, name: string, nullable = false, statusCode = 400): void {
  if (nullable && value === null) return
  if (typeof value !== 'string') invalid(`${name} must be ${nullable ? 'null or ' : ''}text`)
  if ((value as string).length > 4000) throw new OfficialEvidenceError(statusCode, 'field_limit', `${name} exceeds 4000 UTF16 characters`)
  // SQLite binds well-formed Unicode. Reject lone surrogates instead of silently replacing original bytes.
  if (!(value as string).isWellFormed()) invalid(`${name} must be well-formed Unicode`)
}
const captureKeys = ['evidenceId', 'eventId', 'capturedRecordId', 'capturedEnterpriseId', ...textFields, 'sourceDocumentId', 'storedFileId', 'bytes', 'listNo', 'page', 'sourceBindingKnown', 'actor', 'command']
const keyFields = ['sourceDocumentId', 'sha256', 'bytes', 'attachment', 'sectionKey', 'listNo'] as const
function validateKey(key: OfficialEvidenceSourceKey) {
  keys(key, keyFields)
  integer(key.sourceDocumentId, 'sourceDocumentId'); integer(key.bytes, 'bytes', 0); integer(key.listNo, 'listNo')
  text(key.attachment, 'attachment', true); text(key.sectionKey, 'sectionKey'); text(key.sha256, 'sha256')
  if (!key.sectionKey.length || !/^[0-9a-f]{64}$/.test(key.sha256)) invalid('K requires a nonempty known section and lowercase SHA256')
}
function validateCapture(value: OfficialEvidenceCapture) {
  keys(value, captureKeys)
  for (const field of ['evidenceId', 'eventId', 'capturedRecordId', 'capturedEnterpriseId'] as const) integer(value[field], field)
  for (const field of ['sourceDocumentId', 'storedFileId', 'listNo', 'page', 'bytes'] as const) if (value[field] !== null) integer(value[field], field, field === 'bytes' ? 0 : 1)
  for (const field of textFields) text(value[field], field, field !== 'basis')
  if (value.sha256 !== null && !/^[0-9a-f]{64}$/.test(value.sha256)) invalid('sha256 must be lowercase SHA256 or null')
  if (typeof value.sourceBindingKnown !== 'boolean') invalid('sourceBindingKnown must be boolean')
  if (value.sourceBindingKnown) validateKey({ sourceDocumentId: value.sourceDocumentId!, sha256: value.sha256!, bytes: value.bytes!, attachment: value.attachment, sectionKey: value.sectionKey!, listNo: value.listNo! })
  keys(value.actor, ['type', 'id']); text(value.actor.id, 'actor.id')
  if (!['user', 'agent'].includes(value.actor.type) || !value.actor.id.length) invalid('Explicit actor required')
  keys(value.command, value.command?.kind === 'import' ? ['kind', 'batchId'] : ['kind', 'batchKey'])
  if (value.command.kind === 'import') integer(value.command.batchId, 'command.batchId')
  else if (value.command.kind === 'evidence_correction') { text(value.command.batchKey, 'command.batchKey'); if (!value.command.batchKey.length) invalid('command.batchKey must be nonempty') }
  else invalid('Unsupported command kind')
}
function options(value: OfficialEvidenceReadOptions, additional: readonly string[] = []) {
  keys(value, ['maxBytes', ...additional])
  return integer(value.maxBytes === undefined ? 16384 : value.maxBytes, 'maxBytes', 1, 65536)
}

/** Atomic CAS even outside a transaction. B must use one IMMEDIATE transaction for its whole final plan.
 * New capture ownership is validated at insertion; no historical owner is subsequently required to exist.
 * No no-op/deduplication or cross-row business decision is performed here.
 */
export function appendOfficialEvidenceRevision(db: OfficialEvidenceExecutor, input: OfficialEvidenceCapture, expectedRevision: number) {
  validateCapture(input); integer(expectedRevision, 'expectedRevision', 0, Number.MAX_SAFE_INTEGER - 1)
  const revision = expectedRevision + 1, createdAt = new Date().toISOString()
  const row: OfficialEvidenceRow = { ...input, formatVersion: 1, revision, createdAt,
    // Reserve the largest owner IDs: a later legal merge may change the current owner.
    currentOwner: { recordId: Number.MAX_SAFE_INTEGER, enterpriseId: Number.MAX_SAFE_INTEGER } }
  if (Buffer.byteLength(JSON.stringify({ formatVersion: 1, row })) > 65536) throw new OfficialEvidenceError(400, 'input_limit', 'Complete single-row projection exceeds 64KiB')
  let result: ReturnType<OfficialEvidenceExecutor['run']>
  try { result = db.run(sql`
    INSERT INTO official_evidence_row_revision (
      evidence_id,revision,format_version,event_id,captured_record_id,captured_enterprise_id,
      name_raw,uscc_raw,district_raw,source_document_id,stored_file_id,path,sha256,bytes,
      attachment,section_key,list_no,page,source_binding_known,actor,basis,command_kind,import_batch_id,correction_batch_key,created_at
    ) SELECT ${input.evidenceId},${revision},1,${input.eventId},${input.capturedRecordId},${input.capturedEnterpriseId},
      ${input.nameRaw},${input.usccRaw},${input.districtRaw},${input.sourceDocumentId},${input.storedFileId},${input.path},${input.sha256},${input.bytes},
      ${input.attachment},${input.sectionKey},${input.listNo},${input.page},${Number(input.sourceBindingKnown)},${JSON.stringify(input.actor)},${input.basis},
      ${input.command.kind},${input.command.kind === 'import' ? input.command.batchId : null},${input.command.kind === 'evidence_correction' ? input.command.batchKey : null},${createdAt}
    FROM record_evidence ev JOIN record_event e ON e.id=ev.record_event_id JOIN record rec ON rec.id=e.record_id
    WHERE ev.id=${input.evidenceId} AND e.id=${input.eventId} AND rec.id=${input.capturedRecordId} AND rec.enterprise_id=${input.capturedEnterpriseId}
      AND (SELECT coalesce(max(revision),0) FROM official_evidence_row_revision WHERE evidence_id=${input.evidenceId})=${expectedRevision}`) }
  catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause
    if (cause?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY' || (error as { code?: string }).code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
      throw new OfficialEvidenceError(409, 'reference_mismatch', 'Referenced source, file or command does not exist', error)
    }
    throw error
  }
  if (!result.changes) {
    const reference = db.get(sql`SELECT ev.id FROM record_evidence ev JOIN record_event e ON e.id=ev.record_event_id JOIN record rec ON rec.id=e.record_id WHERE ev.id=${input.evidenceId} AND e.id=${input.eventId} AND rec.id=${input.capturedRecordId} AND rec.enterprise_id=${input.capturedEnterpriseId}`)
    throw new OfficialEvidenceError(409, reference ? 'revision_conflict' : 'reference_mismatch', reference ? 'Expected row revision is stale' : 'New capture does not match evidence/event/current owner')
  }
  return { formatVersion: 1 as const, evidenceId: input.evidenceId, eventId: input.eventId, revision }
}

// The newer anti-join intentionally has no source/binding/owner predicate.
const latest = sql`NOT EXISTS (SELECT 1 FROM official_evidence_row_revision newer WHERE newer.evidence_id=r.evidence_id AND newer.revision>r.revision)`
const owners = sql`LEFT JOIN record_event e ON e.id=r.event_id LEFT JOIN record rec ON rec.id=e.record_id LEFT JOIN enterprise ent ON ent.id=rec.enterprise_id`
const currentOwner = sql`CASE WHEN ent.id IS NOT NULL THEN json_object('recordId',rec.id,'enterpriseId',ent.id) ELSE NULL END`
const candidateShape = sql`json_object('evidenceId',r.evidence_id,'eventId',r.event_id,'revision',r.revision,
  'capturedRecordId',r.captured_record_id,'capturedEnterpriseId',r.captured_enterprise_id,
  'nameRaw',r.name_raw,'usccRaw',r.uscc_raw,'districtRaw',r.district_raw,'currentOwner',${currentOwner})`
const rowShape = sql`json_object('formatVersion',r.format_version,'evidenceId',r.evidence_id,'eventId',r.event_id,'revision',r.revision,
  'capturedRecordId',r.captured_record_id,'capturedEnterpriseId',r.captured_enterprise_id,
  'nameRaw',r.name_raw,'usccRaw',r.uscc_raw,'districtRaw',r.district_raw,
  'sourceDocumentId',r.source_document_id,'storedFileId',r.stored_file_id,'path',r.path,'sha256',r.sha256,'bytes',r.bytes,
  'attachment',r.attachment,'sectionKey',r.section_key,'listNo',r.list_no,'page',r.page,'sourceBindingKnown',json(CASE r.source_binding_known WHEN 1 THEN 'true' ELSE 'false' END),
  'actor',json(r.actor),'basis',r.basis,'command',json(CASE r.command_kind WHEN 'import' THEN json_object('kind','import','batchId',r.import_batch_id) ELSE json_object('kind','evidence_correction','batchKey',r.correction_batch_key) END),
  'createdAt',r.created_at,'currentOwner',${currentOwner})`
const rawSqlFields = ['r.name_raw', 'r.uscc_raw', 'r.district_raw']
const allSqlFields = [...rawSqlFields, 'r.path', 'r.sha256', 'r.attachment', 'r.section_key', 'r.basis', "json_extract(r.actor,'$.id')", 'r.correction_batch_key', 'r.created_at']
function fieldGuard(candidate: boolean) {
  // SQL counts Unicode scalars, JS counts UTF16 code units. The <=16KB byte guard also
  // bounds NUL-containing text (SQLite length(TEXT) stops at NUL); exact UTF16 is checked
  // only after the entire small response has passed SQL byte guards.
  return sql.join((candidate ? rawSqlFields : allSqlFields).map(field => sql`(${sql.raw(field)} IS NULL OR (typeof(${sql.raw(field)})='text' AND length(${sql.raw(field)})<=4000 AND length(CAST(${sql.raw(field)} AS BLOB))<=16000))`), sql` AND `)
}
interface GuardedProjection { count: number; fieldLimit: number; requiredBytes: number; projection: string | null; scopeCount: number }
/** This helper is private to this one table. SQL sends only status/length on rejection. */
function project<T>(db: OfficialEvidenceExecutor, query: SQL, maxBytes: number, sourceMax: number): T {
  const result = db.get<GuardedProjection>(query)!
  if (result.count > sourceMax || result.scopeCount > 300) throw new OfficialEvidenceError(413, 'source_limit', 'Source scope exceeds the supported limit')
  if (result.fieldLimit) throw new OfficialEvidenceError(413, 'field_limit', 'Stored field exceeds the read limit')
  if (result.requiredBytes > maxBytes || result.projection === null) throw new OfficialEvidenceError(413, 'response_limit', 'Projection exceeds maxBytes')
  const parsed = JSON.parse(result.projection)
  const rows = parsed.row ? [parsed.row] : parsed.rows ?? parsed.candidates ?? []
  for (const row of rows) {
    for (const field of textFields) if (field in row) text(row[field], field, field !== 'basis', 413)
    if (row.actor) text(row.actor.id, 'actor.id', false, 413)
    if (row.command?.kind === 'evidence_correction') text(row.command.batchKey, 'command.batchKey', false, 413)
  }
  return parsed as T
}
function guardedQuery(selection: SQL, shape: SQL, envelope: SQL, maxBytes: number, candidate = false, pageSize = 101, scopeCount: SQL = sql`0`) {
  return sql`WITH selected AS (${selection}), projected AS (
    SELECT ${shape} AS body, CASE WHEN ${fieldGuard(candidate)} THEN 0 ELSE 1 END AS field_limit
    FROM (SELECT * FROM selected LIMIT ${pageSize}) r ${owners}
  ), response AS (SELECT ${envelope} AS body)
  SELECT (SELECT count(*) FROM selected) AS count, ${scopeCount} AS scopeCount,
    coalesce((SELECT max(field_limit) FROM projected),0) AS fieldLimit,
    length(CAST(body AS BLOB)) AS requiredBytes,
    CASE WHEN length(CAST(body AS BLOB))<=${maxBytes} AND coalesce((SELECT max(field_limit) FROM projected),0)=0 THEN body ELSE NULL END AS projection
  FROM response`
}
const rowArray = sql`(SELECT json_group_array(json(body)) FROM projected)`

export function readLatestOfficialEvidence(db: OfficialEvidenceExecutor, evidenceId: number, readOptions: OfficialEvidenceReadOptions = {}): { formatVersion: 1; row: OfficialEvidenceRow | null } {
  integer(evidenceId, 'evidenceId'); const maxBytes = options(readOptions)
  const query = guardedQuery(sql`SELECT * FROM official_evidence_row_revision WHERE evidence_id=${evidenceId} ORDER BY revision DESC LIMIT 1`, rowShape,
    sql`json_object('formatVersion',1,'row',json((SELECT body FROM projected)))`, maxBytes)
  return project(db, query, maxBytes, 1)
}

/** Fact metadata only: no owner/raw equivalence, independence, conflict or qualification decision. */
export function readOfficialEvidenceCandidates(db: OfficialEvidenceExecutor, key: OfficialEvidenceSourceKey, readOptions: OfficialEvidenceReadOptions = {}): { formatVersion: 1; key: OfficialEvidenceSourceKey; candidates: OfficialEvidenceCandidate[] } {
  validateKey(key); const maxBytes = options(readOptions)
  const keyJson = JSON.stringify({ sourceDocumentId: key.sourceDocumentId, sha256: key.sha256, bytes: key.bytes, attachment: key.attachment, sectionKey: key.sectionKey, listNo: key.listNo })
  const query = guardedQuery(sql`SELECT r.* FROM official_evidence_row_revision r WHERE r.source_binding_known=1
    AND r.source_document_id=${key.sourceDocumentId} AND r.sha256=${key.sha256} AND r.bytes=${key.bytes}
    AND r.attachment IS ${key.attachment} AND r.section_key=${key.sectionKey} AND r.list_no=${key.listNo}
    AND ${latest} ORDER BY r.evidence_id LIMIT 101`, candidateShape,
  sql`json_object('formatVersion',1,'key',json(${keyJson}),'candidates',json(${rowArray}))`, maxBytes, true)
  return project(db, query, maxBytes, 100)
}

export function readOfficialEvidenceHistory(db: OfficialEvidenceExecutor, evidenceId: number, readOptions: OfficialEvidenceHistoryOptions = {}): { formatVersion: 1; evidenceId: number; rows: OfficialEvidenceRow[]; nextBeforeRevision: number | null } {
  integer(evidenceId, 'evidenceId'); const maxBytes = options(readOptions, ['pageSize', 'beforeRevision'])
  const pageSize = integer(readOptions.pageSize === undefined ? 20 : readOptions.pageSize, 'pageSize', 1, 50)
  if (readOptions.beforeRevision !== undefined) integer(readOptions.beforeRevision, 'beforeRevision')
  const query = guardedQuery(sql`SELECT * FROM official_evidence_row_revision WHERE evidence_id=${evidenceId}
    AND ${readOptions.beforeRevision === undefined ? sql`1` : sql`revision<${readOptions.beforeRevision}`} ORDER BY revision DESC LIMIT ${pageSize + 1}`, rowShape,
  sql`json_object('formatVersion',1,'evidenceId',${evidenceId},'rows',json(${rowArray}),'nextBeforeRevision',CASE WHEN (SELECT count(*) FROM selected)>${pageSize} THEN (SELECT revision FROM selected LIMIT 1 OFFSET ${pageSize - 1}) ELSE NULL END)`, maxBytes, false, pageSize)
  return project(db, query, maxBytes, pageSize + 1)
}

/** Lists only captured facts; a legacy evidence without a sidecar remains unknown, never backfilled. */
export function listEventOfficialEvidence(db: OfficialEvidenceExecutor, eventId: number, readOptions: OfficialEvidenceEventOptions = {}): { formatVersion: 1; eventId: number; rows: OfficialEvidenceRow[]; nextAfterEvidenceId: number | null } {
  integer(eventId, 'eventId'); const maxBytes = options(readOptions, ['pageSize', 'afterEvidenceId'])
  const pageSize = integer(readOptions.pageSize === undefined ? 20 : readOptions.pageSize, 'pageSize', 1, 50)
  if (readOptions.afterEvidenceId !== undefined) integer(readOptions.afterEvidenceId, 'afterEvidenceId')
  const query = guardedQuery(sql`SELECT r.* FROM official_evidence_row_revision r WHERE r.event_id=${eventId}
    AND ${readOptions.afterEvidenceId === undefined ? sql`1` : sql`r.evidence_id>${readOptions.afterEvidenceId}`} AND ${latest} ORDER BY r.evidence_id LIMIT ${pageSize + 1}`, rowShape,
  sql`json_object('formatVersion',1,'eventId',${eventId},'rows',json(${rowArray}),'nextAfterEvidenceId',CASE WHEN (SELECT count(*) FROM selected)>${pageSize} THEN (SELECT evidence_id FROM selected LIMIT 1 OFFSET ${pageSize - 1}) ELSE NULL END)`, maxBytes, false, pageSize,
  sql`(SELECT count(*) FROM (SELECT id FROM record_evidence WHERE record_event_id=${eventId} LIMIT 301))`)
  return project(db, query, maxBytes, pageSize + 1)
}
