import { sql, type SQL } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from '../../../../db/schema'
import { computeTitleLifecycle } from '../../lib/roster/lifecycle'
import { postgresRosterRow, readPostgresRosterRowsById } from '../../lib/roster/postgres-rows'
import { projectExactEvidence } from './roster-evidence-correction'
import { checkOfficialEvidenceFields, OfficialEvidenceError, type OfficialEvidenceRow, type OfficialEvidenceSourceKey, type OfficialEvidenceCandidate, type OfficialEvidencePageRequest, type OfficialEvidencePageResult } from './official-evidence'
import { officialProjectionBudget, officialProjectionResponse, type EvidenceRead, type EventRead } from './official-evidence-read'
import { importPostgresReceiptRedactor } from './import-receipt-redaction'

type Db = Pick<NodePgDatabase, 'execute'>

function notFound(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 404, code: 'not_found' })
}

const evidenceFile = sql`json_build_object('id', f.id, 'relPath', f.rel_path, 'sha256', f.sha256,
  'bytes', f.bytes, 'removedAt', f.removed_at)`

export async function readPostgresExactEvidence(db: Db, id: number) {
  const { rows: [result] } = await db.execute<{
    row: Parameters<typeof projectExactEvidence>[0]; file: Parameters<typeof projectExactEvidence>[1]; revision: number
  }>(sql`
    SELECT json_build_object('evidence', ${postgresRosterRow(schema.recordEvidence, 'ev')},
        'event', ${postgresRosterRow(schema.recordEvent, 'e')},
        'recordId', r.id, 'enterpriseId', r.enterprise_id, 'titleCode', r.title_code, 'source', r.source) AS row,
      CASE WHEN c.file_id IS NOT NULL THEN
        json_build_object('id', f.id, 'relPath', f.rel_path, 'sha256', f.sha256, 'bytes', f.bytes, 'removedAt', f.removed_at,
          'source', c.source, 'kind', c.kind, 'titleCode', c.title_code) END AS file,
      coalesce((SELECT max(id) FROM evidence_correction_audit a WHERE a.evidence_id = ev.id),0)::float8 AS revision
    FROM record_evidence ev JOIN record_event e ON e.id = ev.record_event_id JOIN record r ON r.id = e.record_id
    LEFT JOIN stored_file f ON f.rel_path = ev.source_file LEFT JOIN roster_file_classification c ON c.file_id = f.id
    WHERE ev.id = ${id}`)
  if (!result) return notFound('Evidence not found')
  return projectExactEvidence(result.row, result.file, result.revision)
}

export async function readPostgresOfficialEvent(db: Db, id: number) {
  const { rows: [source] } = await db.execute<{
    event: typeof schema.recordEvent.$inferSelect; record: typeof schema.record.$inferSelect
  }>(sql`
    SELECT ${postgresRosterRow(schema.recordEvent, 'e')} AS event, ${postgresRosterRow(schema.record, 'r')} AS record
    FROM record_event e JOIN record r ON r.id = e.record_id WHERE e.id = ${id} AND r.source = 'jxj'`)
  if (!source) return notFound('Official jxj event not found')
  const { record } = source
  const evidence = await readPostgresRosterRowsById(db, schema.recordEvidence, sql`
    FROM (SELECT * FROM record_evidence WHERE record_event_id = ${id} ORDER BY id LIMIT 301) p`)
  if (evidence.length > 300) throw new OfficialEvidenceError(413, 'source_limit', 'Event has more than 300 evidence references; narrow source maintenance required')
  const paths = [...new Set(evidence.map(row => row.sourceFile))]
  const files = paths.length ? (await db.execute<{ file: { id: number; relPath: string; sha256: string; bytes: number; removedAt: string | null } }>(sql`
    SELECT ${evidenceFile} AS file FROM stored_file f WHERE rel_path = ANY(${sql.param(paths)}::text[]) ORDER BY id`)).rows.map(row => row.file) : []
  const events = await readPostgresRosterRowsById(db, schema.recordEvent, sql`
    FROM record_event p JOIN record r ON r.id = p.record_id
    WHERE r.enterprise_id = ${record.enterpriseId} AND r.title_code = ${record.titleCode} AND r.source = 'jxj'`)
  return { ...source, evidence, files, lifecycle: computeTitleLifecycle(events) }
}

const capturedShape = sql`json_build_object('formatVersion', r.format_version, 'evidenceId', r.evidence_id,
  'eventId', r.event_id, 'revision', r.revision, 'capturedRecordId', r.captured_record_id, 'capturedEnterpriseId', r.captured_enterprise_id,
  'nameRaw', r.name_raw, 'usccRaw', r.uscc_raw, 'districtRaw', r.district_raw, 'sourceDocumentId', r.source_document_id,
  'storedFileId', r.stored_file_id, 'path', r.path, 'sha256', r.sha256, 'bytes', r.bytes, 'attachment', r.attachment,
  'sectionKey', r.section_key, 'listNo', r.list_no, 'page', r.page, 'sourceBindingKnown', r.source_binding_known = 1,
  'actor', r.actor::json, 'basis', r.basis, 'command', CASE r.command_kind WHEN 'import' THEN
    json_build_object('kind', 'import', 'batchId', r.import_batch_id)
    ELSE json_build_object('kind', 'evidence_correction', 'batchKey', r.correction_batch_key) END,
  'createdAt', r.created_at, 'currentOwner', CASE WHEN owner.id IS NOT NULL THEN
    json_build_object('recordId', rec.id, 'enterpriseId', owner.id) END)`

const oversizedField = sql`greatest(length(r.name_raw),length(r.uscc_raw),length(r.district_raw),length(r.path),length(r.sha256),
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
      'nameRaw',r.name_raw,'usccRaw',r.uscc_raw,'districtRaw',r.district_raw,'currentOwner',
      CASE WHEN owner.id IS NOT NULL THEN json_build_object('recordId',rec.id,'enterpriseId',owner.id) END)`
    guard = sql`greatest(length(r.name_raw),length(r.uscc_raw),length(r.district_raw))>4000`
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

export async function readPostgresOfficialEvidencePages(db: Db, requests: readonly OfficialEvidencePageRequest[]): Promise<OfficialEvidencePageResult[]> {
  const { rows } = await db.execute<{
    eventId: number; scopeSize: number; fieldLimit: boolean; extra: boolean; rows: OfficialEvidenceRow[] | null
  }>(sql`
    SELECT q.event_id::float8 AS "eventId", s.count::integer AS "scopeSize", p.*
    FROM unnest(${sql.param(requests.map(p => p.eventId))}::bigint[],
      ${sql.param(requests.map(p => p.afterEvidenceId ?? 0))}::bigint[]) WITH ORDINALITY q(event_id, after_id, ordinal)
    CROSS JOIN LATERAL (SELECT count(*) FROM (SELECT id FROM record_evidence WHERE record_event_id=q.event_id LIMIT 301) relevant) s
    CROSS JOIN LATERAL (
      WITH selected AS (
        SELECT r.* FROM official_evidence_row_revision r
        WHERE s.count <= 300 AND r.event_id = q.event_id AND r.evidence_id > q.after_id
          AND NOT EXISTS (SELECT 1 FROM official_evidence_row_revision newer WHERE newer.evidence_id=r.evidence_id AND newer.revision>r.revision)
        ORDER BY r.evidence_id LIMIT 51
      ), projected AS (
        SELECT r.evidence_id, ${capturedShape} AS body, ${oversizedField} AS field_limit
        FROM (SELECT * FROM selected ORDER BY evidence_id LIMIT 50) r
        LEFT JOIN record_event e ON e.id=r.event_id LEFT JOIN record rec ON rec.id=e.record_id
        LEFT JOIN enterprise owner ON owner.id=rec.enterprise_id
      )
      SELECT (SELECT count(*) FROM selected)>50 AS extra, coalesce(bool_or(field_limit),false) AS "fieldLimit",
        CASE WHEN NOT coalesce(bool_or(field_limit), false) AND coalesce(sum(octet_length(body::text)),0) <= 73536
          THEN coalesce(json_agg(body ORDER BY evidence_id),'[]'::json) END AS rows
      FROM projected
    ) p ORDER BY q.ordinal`)
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
