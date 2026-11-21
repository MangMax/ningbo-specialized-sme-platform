import { registeredFileAtLocator } from '../../../core/server/utils/file-read-identity'
import { and, eq, inArray, min, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { record, recordEvent, recordEvidence } from '../../../../db/postgresql/ledger-tables'
import { sourceDocument } from '../../../../db/postgresql/official-evidence-tables'
import type { useApplicationDb } from '../../../../db/client'
import { fileNameOf } from '../../../core/lib/preview'

/** Exact persisted paths, supported by formal events; never classify by filename.
 * Negative references reuse the first persisted evidence ID when no document
 * exists. They are read references, not source_document foreign keys or proofs.
 * No backfill, import, or evidence correction occurs on this read path. */
export const officialSourceDirectory = sql`(
  select coalesce(d.id, -p.evidence_id) as id, 'jxj' as source,
    d.title, d.doc_number as "docNumber", d.issue_date as "issueDate", p.path
  from (
    select v.source_file as path, min(v.id) as evidence_id
    from record_evidence v join record_event e on e.id = v.record_event_id
    join record r on r.id = e.record_id
    where r.source = 'jxj' and e.event_type in ('award', 'review')
    group by v.source_file
  ) p left join source_document d on d.id = (
    select min(s.id) from source_document s where s.source = 'jxj' and s.path = p.path
  )
)`

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
export function readOfficialSourceDocuments(db: ReturnType<typeof useApplicationDb>, ids: number[]) {
  if (!ids.length) return []
  // Existing persisted IDs remain valid for direct callers and stored proofs,
  // including documents which do not yet have a formal event.
  const rows = db.all<OfficialSourceDocument>(sql`
    select id, source, title, doc_number as docNumber, issue_date as issueDate, path
    from source_document where source = 'jxj' and id in (${sql.join(ids.map(id => sql`${id}`), sql`,`)})
    union all
    select * from ${officialSourceDirectory} where id < 0 and id in (${sql.join(ids.map(id => sql`${id}`), sql`,`)})
    order by id
  `)
  return rows.map(row => ({ ...row, title: row.title ?? fileNameOf(row.path), contentIdentity: { registered: registeredFileAtLocator(db, row.path), status: 'unknown' as const, historical: 'unknown' as const } }))
}
