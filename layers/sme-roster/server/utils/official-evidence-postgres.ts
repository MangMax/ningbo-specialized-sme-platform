import { and, asc, count, desc, eq, gt, inArray, lte, notExists, sql, type SQL } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { alias } from 'drizzle-orm/pg-core'
import { enterprise } from '../../../../db/postgresql/enterprise-tables'
import { record, recordEvent, recordEvidence } from '../../../../db/postgresql/ledger-tables'
import { storedFile } from '../../../../db/postgresql/file-tables'
import { rosterFileClassification } from '../../../../db/postgresql/roster-file-tables'
import { evidenceCorrectionAudit, officialEvidenceRowRevision, postgresOfficialRawField } from '../../../../db/postgresql/official-evidence-tables'
import { computeTitleLifecycle } from '../../lib/roster/lifecycle'
import { projectExactEvidence } from './roster-evidence-correction-model'
import { checkOfficialEvidenceFields, OfficialEvidenceError, type OfficialEvidenceRow, type OfficialEvidenceSourceKey, type OfficialEvidenceCandidate, type OfficialEvidencePageRequest, type OfficialEvidencePageResult } from './official-evidence'
import { officialProjectionBudget, officialProjectionResponse, type EvidenceRead, type EventRead } from './official-evidence-read'
import { importPostgresReceiptRedactor } from './import-receipt-redaction'

type Db = Pick<NodePgDatabase, 'execute'>

function notFound(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 404, code: 'not_found' })
}

const evidenceFile = {
  id: storedFile.id, relPath: storedFile.relPath, sha256: storedFile.sha256, bytes: storedFile.bytes, removedAt: storedFile.removedAt,
}

// Exact evidence fingerprints include the JSON property order of the SQLite event projection.
function readEventFields({ revision, formalValidity, ...event }: typeof recordEvent.$inferSelect) {
  return { ...event, formalValidity: formalValidity === null ? null : JSON.parse(formalValidity), revision }
}

export async function readPostgresExactEvidence(db: Pick<NodePgDatabase, 'select'>, id: number) {
  const latestAudit = db.select({ id: evidenceCorrectionAudit.id, evidenceId: evidenceCorrectionAudit.evidenceId })
    .from(evidenceCorrectionAudit)
    .where(eq(evidenceCorrectionAudit.evidenceId, id)).orderBy(desc(evidenceCorrectionAudit.id)).limit(1).as('latest_audit')
  const [result] = await db.select({
    evidence: recordEvidence, event: recordEvent, recordId: record.id, enterpriseId: record.enterpriseId,
    titleCode: record.titleCode, source: record.source,
    file: evidenceFile, classification: {
      fileId: rosterFileClassification.fileId, source: rosterFileClassification.source,
      kind: rosterFileClassification.kind, titleCode: rosterFileClassification.titleCode,
    },
    revision: latestAudit.id,
  }).from(recordEvidence).innerJoin(recordEvent, eq(recordEvent.id, recordEvidence.recordEventId))
    .innerJoin(record, eq(record.id, recordEvent.recordId))
    .leftJoin(storedFile, eq(storedFile.relPath, recordEvidence.sourceFile))
    .leftJoin(rosterFileClassification, eq(rosterFileClassification.fileId, storedFile.id))
    .leftJoin(latestAudit, eq(latestAudit.evidenceId, recordEvidence.id)).where(eq(recordEvidence.id, id))
  if (!result) return notFound('Evidence not found')
  const { evidence, event, recordId, enterpriseId, titleCode, source, file, classification, revision } = result
  const identity = file && classification ? {
    ...file, bytes: Number(file.bytes), source: classification.source, kind: classification.kind, titleCode: classification.titleCode,
  } : null
  return projectExactEvidence({ evidence, event: readEventFields(event), recordId, enterpriseId, titleCode, source }, identity, revision ?? 0)
}

export async function readPostgresOfficialEvent(db: Pick<NodePgDatabase, 'select'>, id: number) {
  const [source] = await db.select({ event: recordEvent, record }).from(recordEvent)
    .innerJoin(record, eq(record.id, recordEvent.recordId)).where(and(eq(recordEvent.id, id), eq(record.source, 'jxj')))
  if (!source) return notFound('Official jxj event not found')
  const evidence = await db.select().from(recordEvidence).where(eq(recordEvidence.recordEventId, id))
    .orderBy(asc(recordEvidence.id)).limit(301)
  if (evidence.length > 300) throw new OfficialEvidenceError(413, 'source_limit', 'Event has more than 300 evidence references; narrow source maintenance required')
  const paths = [...new Set(evidence.map(row => row.sourceFile))]
  const files = paths.length ? await db.select(evidenceFile).from(storedFile)
    .where(inArray(storedFile.relPath, paths)).orderBy(asc(storedFile.id)) : []
  const events = await db.select({ event: recordEvent }).from(recordEvent)
    .innerJoin(record, eq(record.id, recordEvent.recordId)).where(and(
      eq(record.enterpriseId, source.record.enterpriseId), eq(record.titleCode, source.record.titleCode), eq(record.source, 'jxj'),
    )).orderBy(asc(recordEvent.id))
  const { qualityFlags } = source.record
  return {
    event: readEventFields(source.event), record: { ...source.record, qualityFlags: qualityFlags === null ? null : JSON.parse(qualityFlags) },
    evidence, files: files.map(file => ({ ...file, bytes: Number(file.bytes) })),
    lifecycle: computeTitleLifecycle(events.map(row => readEventFields(row.event))),
  }
}

const capturedShape = sql`json_build_object('formatVersion', r.format_version, 'evidenceId', r.evidence_id,
  'eventId', r.event_id, 'revision', r.revision, 'capturedRecordId', r.captured_record_id, 'capturedEnterpriseId', r.captured_enterprise_id,
  'nameRaw', ${postgresOfficialRawField('r', 'nameRaw')}, 'usccRaw', ${postgresOfficialRawField('r', 'usccRaw')},
  'districtRaw', ${postgresOfficialRawField('r', 'districtRaw')}, 'sourceDocumentId', r.source_document_id,
  'storedFileId', r.stored_file_id, 'path', r.path, 'sha256', r.sha256, 'bytes', r.bytes, 'attachment', r.attachment,
  'sectionKey', r.section_key, 'listNo', r.list_no, 'page', r.page, 'sourceBindingKnown', r.source_binding_known = 1,
  'actor', r.actor::json, 'basis', r.basis, 'command', CASE r.command_kind WHEN 'import' THEN
    json_build_object('kind', 'import', 'batchId', r.import_batch_id)
    ELSE json_build_object('kind', 'evidence_correction', 'batchKey', r.correction_batch_key) END,
  'createdAt', r.created_at, 'currentOwner', CASE WHEN owner.id IS NOT NULL THEN
    json_build_object('recordId', rec.id, 'enterpriseId', owner.id) END)`

// Replacing escaped NUL with another one-character control lets PostgreSQL
// measure retained text without decoding a U+0000 into its text type.
const capturedRawLength = sql`greatest(length(r.name_raw),length(r.uscc_raw),length(r.district_raw),
  length(replace(r.name_raw_json,chr(92)||'u0000',chr(92)||'u0001')::json #>> '{}'),
  length(replace(r.uscc_raw_json,chr(92)||'u0000',chr(92)||'u0001')::json #>> '{}'),
  length(replace(r.district_raw_json,chr(92)||'u0000',chr(92)||'u0001')::json #>> '{}'))`
const oversizedField = sql`greatest(${capturedRawLength},length(r.path),length(r.sha256),
  length(r.attachment),length(r.section_key),length(r.basis),length(r.actor::json ->> 'id'),
  length(r.correction_batch_key),length(r.created_at)) > 4000`

type FactRead = { id: number } | { key: OfficialEvidenceSourceKey }
export async function readPostgresOfficialPlanFacts(db: Db, input: { id: number }): Promise<OfficialEvidenceRow | null>
export async function readPostgresOfficialPlanFacts(db: Db, input: { key: OfficialEvidenceSourceKey }): Promise<OfficialEvidenceCandidate[]>
export async function readPostgresOfficialPlanFacts(db: Db, input: FactRead) {
  const key = 'key' in input ? input.key : null
  let select: SQL, shape: SQL, guard: SQL
  if ('key' in input) {
    const key = input.key
    select = sql`SELECT r.* FROM official_evidence_row_revision r WHERE r.source_binding_known=1
      AND r.source_document_id=${key.sourceDocumentId} AND r.sha256=${key.sha256} AND r.bytes=${key.bytes}
      AND r.attachment IS NOT DISTINCT FROM ${key.attachment} AND r.section_key=${key.sectionKey} AND r.list_no=${key.listNo}
      AND NOT EXISTS(SELECT 1 FROM official_evidence_row_revision newer WHERE newer.evidence_id=r.evidence_id AND newer.revision>r.revision)
      ORDER BY r.evidence_id LIMIT 101`
    shape = sql`json_build_object('evidenceId',r.evidence_id,'eventId',r.event_id,'revision',r.revision,
      'capturedRecordId',r.captured_record_id,'capturedEnterpriseId',r.captured_enterprise_id,
      'nameRaw',${postgresOfficialRawField('r', 'nameRaw')}, 'usccRaw',${postgresOfficialRawField('r', 'usccRaw')},
      'districtRaw',${postgresOfficialRawField('r', 'districtRaw')},'currentOwner',
      CASE WHEN owner.id IS NOT NULL THEN json_build_object('recordId',rec.id,'enterpriseId',owner.id) END)`
    guard = sql`${capturedRawLength}>4000`
  } else {
    select = sql`SELECT * FROM official_evidence_row_revision WHERE evidence_id=${input.id} ORDER BY revision DESC LIMIT 1`
    shape = capturedShape
    guard = oversizedField
  }
  const { rows: [result] } = await db.execute<{ count: number; fieldLimit: boolean; facts: (OfficialEvidenceRow | OfficialEvidenceCandidate)[] | null }>(sql`
    WITH selected AS (${select}), projected AS (
      SELECT r.evidence_id,${shape} AS body,${guard} AS field_limit
      FROM selected r LEFT JOIN record_event e ON e.id=r.event_id
      LEFT JOIN record rec ON rec.id=e.record_id LEFT JOIN enterprise owner ON owner.id=rec.enterprise_id
    )
    SELECT count(*)::int AS count,coalesce(bool_or(field_limit),false) AS "fieldLimit",
      CASE WHEN count(*)<=100 AND NOT coalesce(bool_or(field_limit),false)
        AND coalesce(sum(octet_length(body::text)),0)<=65536+count(*)*160
        THEN coalesce(json_agg(body ORDER BY evidence_id),'[]'::json) END AS facts
    FROM projected`)
  if (result!.count > 100) throw new OfficialEvidenceError(413, 'source_limit', 'Source scope exceeds the supported limit')
  if (result!.fieldLimit) throw new OfficialEvidenceError(413, 'field_limit', 'Stored field exceeds the read limit')
  const facts = result!.facts
  const projection = key ? { formatVersion: 1, key, candidates: facts } : { formatVersion: 1, row: facts?.[0] ?? null }
  if (!facts || Buffer.byteLength(JSON.stringify(projection)) > 65536) throw new OfficialEvidenceError(413, 'response_limit', 'Projection exceeds maxBytes')
  checkOfficialEvidenceFields(facts)
  return key ? facts : facts[0] ?? null
}

export async function readPostgresPublicOfficialEvidence(db: NodePgDatabase, kind: 'event' | 'evidence', args: EventRead | EvidenceRead) {
  const pageSize = args.official === 'history' || kind === 'event' ? args.pageSize ?? 20 : 1
  const { maxBytes, budget } = officialProjectionBudget(args)
  const event = kind === 'event' ? args as EventRead : undefined
  const evidence = kind === 'evidence' ? args as EvidenceRead : undefined
  const order = event ? sql`evidence_id ASC` : sql`revision DESC`
  const scope = event ? sql`r.event_id = ${event.eventId} AND r.evidence_id > ${event.afterEvidenceId ?? 0}
    AND NOT EXISTS (SELECT 1 FROM official_evidence_row_revision newer WHERE newer.evidence_id = r.evidence_id AND newer.revision > r.revision)`
    : sql`r.evidence_id = ${evidence!.id} ${evidence?.beforeRevision === undefined ? sql.empty() : sql`AND r.revision < ${evidence.beforeRevision}`}`
  const { rows: [selected] } = await db.execute<{ rows: OfficialEvidenceRow[] | null; extra: boolean; fieldLimit: boolean }>(sql`
    WITH selected AS (
      SELECT r.* FROM official_evidence_row_revision r WHERE ${scope} ORDER BY ${order}
      LIMIT ${pageSize + (event || args.official === 'history' ? 1 : 0)}
    ), projected AS (
      SELECT ${capturedShape} AS body,
        ${oversizedField} AS field_limit
      FROM (SELECT * FROM selected ORDER BY ${order} LIMIT ${pageSize}) r
      LEFT JOIN record_event e ON e.id = r.event_id LEFT JOIN record rec ON rec.id = e.record_id
      LEFT JOIN enterprise owner ON owner.id = rec.enterprise_id
      ORDER BY r.${order}
    )
    SELECT CASE WHEN NOT coalesce(bool_or(field_limit), false)
      AND coalesce(sum(octet_length(body::text)),0) <= ${budget + pageSize * 160}
      THEN coalesce(json_agg(body), '[]'::json) END AS rows,
      (SELECT count(*) FROM selected) > ${pageSize} AS extra, coalesce(bool_or(field_limit), false) AS "fieldLimit"
    FROM projected`)
  if (selected!.fieldLimit) throw new OfficialEvidenceError(413, 'field_limit', 'Stored field exceeds the read limit')
  if (!selected!.rows) throw new OfficialEvidenceError(413, 'response_limit', 'Projection exceeds maxBytes')
  const rows = selected!.rows
  const last = selected!.extra ? rows.at(-1) : undefined
  const result = event
    ? { formatVersion: 1, eventId: event.eventId, rows, nextAfterEvidenceId: last?.evidenceId ?? null }
    : evidence?.official === 'history'
      ? { formatVersion: 1, evidenceId: evidence.id, rows, nextBeforeRevision: last?.revision ?? null }
      : { formatVersion: 1, row: rows[0] ?? null }
  if (Buffer.byteLength(JSON.stringify(result)) > budget) throw new OfficialEvidenceError(413, 'response_limit', 'Projection exceeds maxBytes')
  checkOfficialEvidenceFields(rows)
  const availability = event ? 'captured_rows' : rows.length ? 'available' : evidence?.beforeRevision === undefined ? 'unknown_legacy' : 'empty_page'
  return officialProjectionResponse(result, availability, maxBytes, await importPostgresReceiptRedactor(db))
}

export async function readPostgresOfficialEvidencePages(db: NodePgDatabase, requests: readonly OfficialEvidencePageRequest[]): Promise<OfficialEvidencePageResult[]> {
  if (!requests.length) return []
  // Drizzle can join lateral subqueries but cannot expose a table-valued UNNEST with
  // ordinality. The two bound arrays preserve request order and duplicate event IDs.
  const requested = sql`unnest(${sql.param(requests.map(page => page.eventId))}::bigint[],
    ${sql.param(requests.map(page => page.afterEvidenceId ?? 0))}::bigint[]) WITH ORDINALITY q(event_id, after_id, ordinal)`
  const eventId = sql<number>`q.event_id`.mapWith(Number)
  const afterId = sql<number>`q.after_id`
  const relevant = db.select({ id: recordEvidence.id }).from(recordEvidence)
    .where(eq(recordEvidence.recordEventId, eventId)).limit(301).as('relevant_evidence')
  const scope = db.select({ size: count().as('scope_size') }).from(relevant).as('source_scope')
  const revision = alias(officialEvidenceRowRevision, 'r')
  const newer = alias(officialEvidenceRowRevision, 'newer')
  const selected = db.$with('selected').as(db.select().from(revision).where(and(
    lte(scope.size, 300),
    eq(revision.eventId, eventId),
    gt(revision.evidenceId, afterId),
    notExists(db.select({ id: newer.evidenceId }).from(newer).where(and(
      eq(newer.evidenceId, revision.evidenceId), gt(newer.revision, revision.revision),
    ))),
  )).orderBy(revision.evidenceId).limit(51))
  const current = db.select().from(selected).orderBy(selected.evidenceId).limit(50).as('r')
  const event = alias(recordEvent, 'e')
  const currentRecord = alias(record, 'rec')
  const owner = alias(enterprise, 'owner')
  // Reuse the database JSON projection and field-size expression so aggregate
  // byte limits continue to measure the same representation before transfer.
  const projected = db.$with('projected').as(db.select({
    evidenceId: current.evidenceId,
    body: capturedShape.as('body'),
    fieldLimit: oversizedField.as('field_limit'),
  }).from(current).leftJoin(event, eq(event.id, current.eventId))
    .leftJoin(currentRecord, eq(currentRecord.id, event.recordId)).leftJoin(owner, eq(owner.id, currentRecord.enterpriseId)))
  const total = db.select({ count: count() }).from(selected)
  // Drizzle 0.45 has no ordered JSON aggregate or byte-length aggregate budget.
  const fieldLimit = sql<boolean>`coalesce(bool_or(${projected.fieldLimit}), false)`
  const body = sql<OfficialEvidenceRow[] | null>`CASE WHEN NOT ${fieldLimit}
    AND coalesce(sum(octet_length(${projected.body}::text)), 0) <= 73536
    THEN coalesce(json_agg(${projected.body} ORDER BY ${projected.evidenceId}), '[]'::json) END`
  const pageResult = db.with(selected, projected).select({
    extra: gt(total, 50).as('extra'),
    fieldLimit: fieldLimit.as('has_oversized_field'),
    rows: body.as('page_rows'),
  }).from(projected).as('page_result')
  const rows = await db.select({
    eventId, scopeSize: scope.size, extra: pageResult.extra, fieldLimit: pageResult.fieldLimit, rows: pageResult.rows,
  }).from(requested).crossJoinLateral(scope).crossJoinLateral(pageResult).orderBy(asc(sql`q.ordinal`))
  return rows.map(row => {
    const { eventId } = row
    if (row.scopeSize > 300) return { eventId, error: 'source_limit' }
    if (row.fieldLimit) return { eventId, error: 'field_limit' }
    if (!row.rows) return { eventId, error: 'response_limit' }
    const page = { formatVersion: 1 as const, eventId, rows: row.rows, nextAfterEvidenceId: row.extra ? row.rows.at(-1)!.evidenceId : null }
    if (Buffer.byteLength(JSON.stringify(page)) > 65536) return { eventId, error: 'response_limit' }
    try { checkOfficialEvidenceFields(row.rows) }
    catch (error) {
      if (error instanceof OfficialEvidenceError && error.code === 'field_limit') return { eventId, error: 'field_limit' }
      throw error
    }
    return { eventId, page }
  })
}
