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
export interface OfficialEvidencePageRequest { eventId: number; afterEvidenceId?: number }
export interface OfficialEvidenceEventPage {
  formatVersion: 1; eventId: number; rows: OfficialEvidenceRow[]; nextAfterEvidenceId: number | null
}
export type OfficialEvidencePageLimit = 'source_limit' | 'field_limit' | 'response_limit'
/** Internal domain values, not a public DTO. Consumers must retain event/page error order. */
export type OfficialEvidencePageResult =
  | { eventId: number; page: OfficialEvidenceEventPage; error?: never }
  | { eventId: number; error: OfficialEvidencePageLimit; page?: never }
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

/** Atomic CAS even outside a transaction. B must use one IMMEDIATE transaction for its whole final plan.
 * New capture ownership is validated at insertion; no historical owner is subsequently required to exist.
 * No no-op/deduplication or cross-row business decision is performed here.
 */
export function validateOfficialEvidenceRevision(input: OfficialEvidenceCapture, expectedRevision: number) {
  validateCapture(input); integer(expectedRevision, 'expectedRevision', 0, Number.MAX_SAFE_INTEGER - 1)
  const revision = expectedRevision + 1, createdAt = new Date().toISOString()
  const row: OfficialEvidenceRow = { ...input, formatVersion: 1, revision, createdAt,
    // Reserve the largest owner IDs: a later legal merge may change the current owner.
    currentOwner: { recordId: Number.MAX_SAFE_INTEGER, enterpriseId: Number.MAX_SAFE_INTEGER } }
  if (Buffer.byteLength(JSON.stringify({ formatVersion: 1, row })) > 65536) throw new OfficialEvidenceError(400, 'input_limit', 'Complete single-row projection exceeds 64KiB')
  return { revision, createdAt }
}
export function checkOfficialEvidenceFields(rows: readonly Partial<OfficialEvidenceRow>[]) {
  for (const row of rows) {
    for (const field of textFields) if (field in row) text(row[field], field, field !== 'basis', 413)
    if (row.actor) text(row.actor.id, 'actor.id', false, 413)
    if (row.command?.kind === 'evidence_correction') text(row.command.batchKey, 'command.batchKey', false, 413)
  }
}
