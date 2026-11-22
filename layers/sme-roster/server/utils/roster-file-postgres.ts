import { and, desc, eq, exists, getTableColumns, sql } from 'drizzle-orm'
import { QueryBuilder } from 'drizzle-orm/pg-core'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { storedFile } from '../../../../db/postgresql/file-tables'
import { record, recordEvent, recordEvidence } from '../../../../db/postgresql/ledger-tables'
import { fileDeclaration669 as declaration, fileParseAudit105 as audit, rosterFileClassification as classification, storedFilePart as part } from '../../../../db/postgresql/roster-file-tables'
import { aggregateParts, compareParts, partKey, type StoredFilePart } from '../../lib/file-parts'
import { normalizeAttachment } from '../../lib/attachment'
import { SOURCE_ORDER } from '../../lib/labels'
import type { FileQueryFilters } from '../../../core/server/utils/file-store'
import type { RosterFileFields } from '../modules/sme-roster/files'
import { registeredSummary681 } from './registered-declaration-summary'

type Lineage = NonNullable<RosterFileFields['partsBinding']>['inputLineage']
type Declaration = Parameters<typeof registeredSummary681>[0][number]

export async function completePostgresFileParts(db: NodePgDatabase, relPath: string, parts: readonly StoredFilePart[]) {
  const existing = new Set(parts.map(partKey))
  const missing = (await derivedPostgresFileParts(db, relPath))
    .filter(part => !existing.has(partKey(part)))
    .map(part => ({ ...part, origin: 'derived' as const, hasConflict: false }))
  return [...parts, ...missing].sort(compareParts)
}

export async function derivedPostgresFileParts(db: NodePgDatabase, relPath: string) {
  const rows = await db.select({
    titleCode: record.titleCode, eventKind: recordEvent.eventType,
    year: recordEvent.year, batch: recordEvent.batchSeq, attachment: recordEvidence.attachment,
  }).from(recordEvidence)
    .innerJoin(recordEvent, eq(recordEvent.id, recordEvidence.recordEventId))
    .innerJoin(record, eq(record.id, recordEvent.recordId))
    .where(eq(recordEvidence.sourceFile, relPath))
  return aggregateParts(rows.map(row => ({ ...row, attachment: normalizeAttachment(row.attachment) })))
}

const query = new QueryBuilder()
const fileJoin = eq(classification.fileId, storedFile.id)
export const rosterFileMembership = exists(query.select({ value: sql`1` }).from(classification).where(fileJoin))

const sourceRank = sql`CASE ${classification.source} ${sql.join(SOURCE_ORDER.map((source, index) => sql`WHEN ${source} THEN ${index}`), sql` `)}
  ELSE ${SOURCE_ORDER.length} END`
export const rosterFilePostgresOrder = [
  sql`(${query.select({ value: sourceRank }).from(classification).where(fileJoin)}) ASC NULLS FIRST`,
  sql`(${query.select({ value: classification.year }).from(classification).where(fileJoin)}) DESC NULLS LAST`,
  sql`(${query.select({ value: classification.batch }).from(classification).where(fileJoin)}) DESC NULLS LAST`,
]

export function rosterFilePostgresConstraint(filters: FileQueryFilters) {
  const predicates = []
  if (filters.source?.length) predicates.push(sql`${classification.source} = ANY(${sql.param(filters.source)}::text[])`)
  if (filters.categoryState?.length) predicates.push(sql`${classification.categoryState} = ANY(${sql.param(filters.categoryState)}::text[])`)
  if (filters.parseState?.length) predicates.push(sql`${classification.parseState} = ANY(${sql.param(filters.parseState)}::text[])`)
  if (predicates.length) return exists(query.select({ value: sql`1` }).from(classification).where(and(fileJoin, ...predicates)))
}

export async function readPostgresRosterFileFields(db: NodePgDatabase, ids: readonly number[]) {
  const { fileId, ...fields } = getTableColumns(classification)
  const partsQuery = db.select({ value: sql`json_agg(json_build_object(
    'titleCode', ${part.titleCode}, 'eventKind', ${part.eventKind}, 'year', ${part.year}, 'batch', ${part.batch},
    'attachment', ${part.attachment}, 'rowCount', ${part.rowCount}, 'origin', ${part.origin}, 'hasConflict', ${part.hasConflict} = 1
  ) ORDER BY ${part.id})` }).from(part).where(eq(part.fileId, fileId))
  const declarationsQuery = db.select({ value: sql`json_agg(json_build_object(
    'declarationId', ${declaration.declarationId}, 'displaySequence', ${declaration.displaySequence}, 'fileId', ${declaration.fileId},
    'revision', ${declaration.revision}, 'active', true, 'sha256', ${declaration.sha256}, 'contentVersion', ${declaration.contentVersion},
    'part', ${declaration.part}::json, 'pageRanges', ${declaration.pageRanges}::json
  ) ORDER BY ${declaration.displaySequence}, ${declaration.declarationId} COLLATE "C")` }).from(declaration)
    .where(and(eq(declaration.fileId, fileId), eq(declaration.active, 1)))
  const lineageQuery = db.select({ value: sql`${audit.after}::json->'inputLineage'` }).from(audit)
    .where(eq(audit.fileId, fileId)).orderBy(desc(audit.id)).limit(1)
  const rows = await db.select({
    id: fileId,
    classification: fields,
    parts: sql<StoredFilePart[]>`COALESCE((${partsQuery}), '[]'::json)`,
    declarations: sql<Declaration[]>`COALESCE((${declarationsQuery}), '[]'::json)`,
    lineage: sql<Lineage | null>`(${lineageQuery})`,
  }).from(classification).where(sql`${fileId} = ANY(${sql.param(ids)}::bigint[])`)
  return new Map(rows.map(({ id, classification, parts, declarations, lineage }) => [
    id, {
      ...classification,
      parts: parts.sort(compareParts),
      registeredSummary: registeredSummary681(declarations),
      partsBinding: { historical: 'unknown', inputLineage: lineage?.status === 'bound' ? lineage : { status: 'unknown' } },
    } satisfies Omit<RosterFileFields, 'referenceCount'>,
  ]))
}
