import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { OfficialDeclaration, OfficialPublishedRow } from '../../lib/roster-import-client'
import { officialPlanJson, officialFactFailure } from './official-evidence-plan'
import { OfficialEvidenceError, prepareOfficialEvidenceRevision, type OfficialEvidenceCapture, type OfficialEvidenceCommand } from './official-evidence'

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]

export async function resolvePostgresOfficialDeclaration(tx: Tx, declaration: OfficialDeclaration, cache: Map<string, number>) {
  if (declaration.kind === 'existing') {
    const reference = await tx.execute(sql`SELECT id FROM source_document WHERE id=${declaration.sourceDocumentId} AND source='jxj'`)
    if (!reference.rows.length) return officialFactFailure('source_binding_conflict', 'Explicit existing official declaration not found', 409)
    return declaration.sourceDocumentId
  }
  const key = officialPlanJson(declaration)
  const saved = cache.get(key)
  if (saved !== undefined) return saved
  const document = declaration.sourceDocument
  const { rows: [created] } = await tx.execute<{ id: number }>(sql`
    INSERT INTO source_document(source,title,doc_number,issue_date,path)
    VALUES(${document.source},${document.title},${document.docNumber},${document.issueDate},${document.path}) RETURNING id::float8 AS id`)
  cache.set(key, created!.id)
  return created!.id
}

async function appendPostgresOfficialEvidence(tx: Tx, capture: OfficialEvidenceCapture, expectedRevision: number) {
  const { insert, reference, revision } = prepareOfficialEvidenceRevision(capture, expectedRevision)
  let written
  try { written = await tx.execute(insert) } catch (error) {
    const cause = error as { code?: string; cause?: { code?: string } }
    const code = cause.code ?? cause.cause?.code
    if (code === '23503') throw new OfficialEvidenceError(409, 'reference_mismatch', 'Referenced source, file or command does not exist', error)
    if (code === '23505') throw new OfficialEvidenceError(409, 'revision_conflict', 'Expected row revision is stale', error)
    throw error
  }
  if (!written.rowCount) {
    const { rows } = await tx.execute(reference)
    throw new OfficialEvidenceError(409, rows.length ? 'revision_conflict' : 'reference_mismatch',
      rows.length ? 'Expected row revision is stale' : 'New capture does not match evidence/event/current owner')
  }
  return { formatVersion: 1 as const, evidenceId: capture.evidenceId, eventId: capture.eventId, revision }
}

export async function writePostgresOfficialPublishedRow(tx: Tx, row: OfficialPublishedRow, evidenceId: number, expectedRevision: number,
  command: OfficialEvidenceCommand, declarations: Map<string, number>,
) {
  const { rows: [owner] } = await tx.execute<{ eventId: number; capturedRecordId: number; capturedEnterpriseId: number }>(sql`
    SELECT e.id::float8 AS "eventId",r.id::float8 AS "capturedRecordId",r.enterprise_id::float8 AS "capturedEnterpriseId"
    FROM record_evidence v JOIN record_event e ON e.id=v.record_event_id JOIN record r ON r.id=e.record_id
    JOIN enterprise ent ON ent.id=r.enterprise_id WHERE v.id=${evidenceId}`)
  if (!owner) return officialFactFailure('reference_mismatch', 'Current real evidence owner required', 409)
  const { declaration, ...capture } = row
  const sourceDocumentId = await resolvePostgresOfficialDeclaration(tx, declaration, declarations)
  return appendPostgresOfficialEvidence(tx, { ...capture, ...owner, sourceDocumentId, evidenceId, command }, expectedRevision)
}
