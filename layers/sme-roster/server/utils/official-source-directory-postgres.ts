import { and, eq, inArray, min, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { record, recordEvent, recordEvidence } from '../../../../db/postgresql/ledger-tables'
import { sourceDocument } from '../../../../db/postgresql/official-evidence-tables'

export function postgresOfficialSourceDirectory(db: Pick<NodePgDatabase, 'select'>) {
  const paths = db.select({
    path: recordEvidence.sourceFile, evidenceId: min(recordEvidence.id).as('evidence_id'),
  }).from(recordEvidence).innerJoin(recordEvent, eq(recordEvent.id, recordEvidence.recordEventId))
    .innerJoin(record, eq(record.id, recordEvent.recordId))
    .where(and(eq(record.source, 'jxj'), inArray(recordEvent.eventType, ['award', 'review'])))
    .groupBy(recordEvidence.sourceFile).as('formal_paths')
  const doc = sourceDocument
  const first = db.select({ id: doc.id, title: doc.title, docNumber: doc.docNumber, issueDate: doc.issueDate })
    .from(doc).where(and(eq(doc.source, 'jxj'), eq(doc.path, paths.path))).orderBy(doc.id).limit(1).as('first_document')
  return db.select({
    id: sql`coalesce(${first.id}, -${paths.evidenceId})`.mapWith(Number).as('id'),
    source: sql<'jxj'>`'jxj'::text`.as('source'),
    title: first.title,
    docNumber: first.docNumber,
    issueDate: first.issueDate,
    path: paths.path,
  }).from(paths).leftJoinLateral(first, sql`true`).as('official_directory')
}
export interface OfficialSourceDocument {
  id: number; source: 'jxj'; title: string; docNumber: string | null; issueDate: string | null; path: string
}
