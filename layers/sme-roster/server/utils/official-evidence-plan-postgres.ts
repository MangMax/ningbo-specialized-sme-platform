import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from '../../../../db/schema'
import { postgresRosterRow, readPostgresRosterRowsById } from '../../lib/roster/postgres-rows'
import { projectOfficialDeclaration, projectOfficialEvidenceChanges } from './official-evidence-plan'
import { readPostgresOfficialPlanFacts } from './official-evidence-postgres'

type Db = Pick<NodePgDatabase, 'execute'>
type ReadRequest = Exclude<ReturnType<ReturnType<typeof projectOfficialEvidenceChanges>['next']>, { done: true }>['value']

async function readOfficialPlanInput(db: Db, input: ReadRequest) {
  if (input.type === 'count') {
    const { rows: [row] } = await db.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM (SELECT id FROM record_evidence WHERE record_event_id=${input.eventId} LIMIT 301) evidence`)
    return row!.count
  }
  if (input.type === 'declaration') {
    const declaration = input.declaration
    const [document] = declaration.kind === 'existing' ? await readPostgresRosterRowsById(db, schema.sourceDocument, sql`
      FROM source_document p WHERE p.id=${declaration.sourceDocumentId}`) : []
    return projectOfficialDeclaration(declaration, document)
  }
  if (input.type === 'latest') return readPostgresOfficialPlanFacts(db, { id: input.id })
  if (input.type === 'candidates') return readPostgresOfficialPlanFacts(db, { key: input.key })
  if (input.type === 'file') {
    const { rows: [row] } = await db.execute(sql`
      SELECT f.id::float8 AS id,f.rel_path AS "relPath",f.bytes::float8 AS bytes,f.sha256,f.removed_at AS "removedAt",
        c.source,c.kind,c.title_code AS "titleCode"
      FROM stored_file f JOIN roster_file_classification c ON c.file_id=f.id WHERE f.id=${input.id}`)
    return row
  }
  if (input.type === 'repoint') {
    const { rows: [row] } = await db.execute(sql`
      SELECT ${postgresRosterRow(schema.recordEvidence,'v')} AS evidence,
        ${postgresRosterRow(schema.recordEvent,'e')} AS event,r.id::float8 AS "recordId",ent.id::float8 AS "enterpriseId"
      FROM record_evidence v JOIN record_event e ON e.id=v.record_event_id JOIN record r ON r.id=e.record_id
      LEFT JOIN enterprise ent ON ent.id=r.enterprise_id WHERE v.id=${input.id}`)
    return row
  }
  const c = input.coordinate
  return readPostgresRosterRowsById(db, schema.recordEvidence, sql`
    FROM (SELECT * FROM record_evidence WHERE source_file=${c.sourceFile} AND list_no=${c.listNo}
      AND attachment IS NOT DISTINCT FROM ${c.attachment} LIMIT 101) p`)
}

export async function planPostgresOfficialEvidenceChanges(db: Db, ...args: Parameters<typeof projectOfficialEvidenceChanges>) {
  const queries = projectOfficialEvidenceChanges(...args)
  let next = queries.next()
  while (!next.done) next = queries.next(await readOfficialPlanInput(db, next.value))
  return next.value
}
