import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { compareParts, type StoredFilePart } from '../../lib/file-parts'
import { SOURCE_ORDER } from '../../lib/labels'
import type { FileQueryFilters } from '../../../core/server/utils/file-store'
import type { RosterFileFields } from '../modules/sme-roster/files'
import { registeredSummary681 } from './registered-declarations'

type Lineage = NonNullable<RosterFileFields['partsBinding']>['inputLineage']
type Declaration = Parameters<typeof registeredSummary681>[0][number]

export const rosterFileMembership = sql`EXISTS (
  SELECT 1 FROM roster_file_classification c WHERE c.file_id = stored_file.id)`

const byFile = sql`FROM roster_file_classification c WHERE c.file_id = stored_file.id`
export const rosterFilePostgresOrder = [
  sql`(SELECT CASE c.source ${sql.join(SOURCE_ORDER.map((source, i) => sql`WHEN ${source} THEN ${i}`), sql` `)}
    ELSE ${SOURCE_ORDER.length} END ${byFile}) ASC NULLS FIRST`,
  sql`(SELECT c.year ${byFile}) DESC NULLS LAST`,
  sql`(SELECT c.batch ${byFile}) DESC NULLS LAST`,
]

export function rosterFilePostgresConstraint(filters: FileQueryFilters) {
  const predicates = []
  if (filters.source?.length) predicates.push(sql`c.source = ANY(${sql.param(filters.source)}::text[])`)
  if (filters.categoryState?.length) predicates.push(sql`c.category_state = ANY(${sql.param(filters.categoryState)}::text[])`)
  if (filters.parseState?.length) predicates.push(sql`c.parse_state = ANY(${sql.param(filters.parseState)}::text[])`)
  if (predicates.length) return sql`EXISTS (SELECT 1 ${byFile} AND ${sql.join(predicates, sql` AND `)})`
}

type Classification = Pick<RosterFileFields, 'source' | 'kind' | 'year' | 'batch' | 'titleCode' | 'categoryState' | 'parseState'>
type ReadRow = {
  id: string
  classification: Classification
  parts: StoredFilePart[]
  declarations: Declaration[]
  lineage: Lineage | null
}

export async function readPostgresRosterFileFields(db: NodePgDatabase, ids: readonly number[]) {
  const { rows } = await db.execute<ReadRow>(sql`
    SELECT c.file_id AS id, json_build_object(
      'source', c.source, 'kind', c.kind, 'year', c.year, 'batch', c.batch, 'titleCode', c.title_code,
      'categoryState', c.category_state, 'parseState', c.parse_state
    ) AS classification,
    COALESCE((
      SELECT json_agg(json_build_object(
        'titleCode', p.title_code, 'eventKind', p.event_kind, 'year', p.year, 'batch', p.batch,
        'attachment', p.attachment, 'rowCount', p.row_count, 'origin', p.origin, 'hasConflict', p.has_conflict = 1
      ) ORDER BY p.id)
      FROM stored_file_part p WHERE p.file_id = c.file_id
    ), '[]'::json) AS parts,
    COALESCE((
      SELECT json_agg(json_build_object(
        'declarationId', d.declaration_id, 'displaySequence', d.display_sequence, 'fileId', d.file_id,
        'revision', d.revision, 'active', true, 'sha256', d.sha256, 'contentVersion', d.content_version,
        'part', d.part::json, 'pageRanges', d.page_ranges::json
      ) ORDER BY d.display_sequence, d.declaration_id COLLATE "C")
      FROM file_declaration_669 d WHERE d.file_id = c.file_id AND d.active = 1
    ), '[]'::json) AS declarations,
    (SELECT a.after::json->'inputLineage' FROM file_parse_audit_105 a
      WHERE a.file_id = c.file_id ORDER BY a.id DESC LIMIT 1) AS lineage
    FROM roster_file_classification c WHERE c.file_id = ANY(${sql.param(ids)}::bigint[])`)
  return new Map(rows.map(({ id, classification, parts, declarations, lineage }) => [
    Number(id), {
      ...classification,
      parts: parts.sort(compareParts),
      registeredSummary: registeredSummary681(declarations),
      partsBinding: { historical: 'unknown', inputLineage: lineage?.status === 'bound' ? lineage : { status: 'unknown' } },
    } satisfies Omit<RosterFileFields, 'referenceCount'>,
  ]))
}
