import { getTableColumns, sql, type SQL, type SQLWrapper } from 'drizzle-orm'
import { platformBusinessRecordVersion, platformQuery, platformRelation } from '../../db/schema'
import { bodyOwnerDefinition, bodyOwnerDefinitions, type PlatformBodyOwner } from './body-store'

const ownerTables = { relation: platformRelation, query: platformQuery, version: platformBusinessRecordVersion }
type Kind = PlatformBodyOwner['kind']
type Field<K extends Kind> = Extract<PlatformBodyOwner, { kind: K }>['field']
// An invalid JSON literal intentionally raises in SQLite; a missing/broken ref must
// never look like SQL NULL or fall back to an unrelated inline body.
const corrupt = sql`json_extract('platform_body_corrupt', '$')`

function reference<K extends Kind>(kind: K, field: Field<K>, ownerId: SQLWrapper) {
  const definition = bodyOwnerDefinition(kind, field)
  return sql`SELECT root_id FROM ${sql.identifier(definition.ref)} WHERE owner_id = ${ownerId} AND field = ${field}`
}

/** Native SQLite expression, composable with json_extract/json_type/json_valid and
 * multi-path projections. No JS hydration/UDF. Aggregates only the selected root.
 * A full JSON parse may still cost a full SQL root aggregation; summary queries
 * should omit this expression, and budget checks should use logicalByteLengthSql.
 * Pass the aliased owner ID/inline column explicitly when joining an alias.
 */
export function logicalTextSql<K extends Kind>(kind: K, field: Field<K>, ownerId: SQLWrapper, inline: SQLWrapper): SQL<string | null> {
  const ref = reference(kind, field, ownerId)
  // Keep the root restriction INSIDE the aggregation. A correlated predicate on
  // an aggregate VIEW can materialize every root before filtering in SQLite.
  const pooled = sql`SELECT CASE WHEN _body_root.sealed = 1 AND _body_root.encoding = 'utf8-v1'
    AND count(_body_part.leaf_id) BETWEEN 1 AND 64 AND count(_body_leaf.id) = count(_body_part.leaf_id)
    AND min(_body_part.logical_start) = 0
    AND max(_body_part.logical_start + _body_part.byte_length) = _body_root.byte_length
    AND sum(_body_part.byte_length) = _body_root.byte_length
    AND min(CASE WHEN typeof(_body_leaf.bytes) = 'blob' AND _body_leaf.encoding = 'utf8-v1'
      AND length(_body_leaf.bytes) = _body_leaf.byte_length AND _body_leaf.byte_length = _body_part.byte_length
      AND (_body_part.byte_length > 0 OR _body_root.byte_length = 0)
      AND _body_part.logical_start = COALESCE((SELECT max(_body_prev.logical_start + _body_prev.byte_length)
        FROM platform_body_part _body_prev WHERE _body_prev.root_id = _body_root.id
        AND _body_prev.logical_start < _body_part.logical_start), 0)
      THEN 1 ELSE 0 END) = 1
    THEN group_concat(CAST(_body_leaf.bytes AS TEXT), '' ORDER BY _body_part.logical_start)
    ELSE ${corrupt} END
    FROM platform_body_root _body_root
    LEFT JOIN platform_body_part _body_part ON _body_part.root_id = _body_root.id
    LEFT JOIN platform_body_leaf _body_leaf ON _body_leaf.id = _body_part.leaf_id
    WHERE _body_root.id = (${ref}) GROUP BY _body_root.id`
  return sql`CASE WHEN (SELECT encoding FROM pragma_encoding) <> 'UTF-8' THEN ${corrupt} WHEN EXISTS (${ref}) THEN
    COALESCE((${pooled}), ${corrupt})
    ELSE CASE WHEN ${inline} IS NULL OR typeof(${inline}) = 'text' THEN ${inline} ELSE ${corrupt} END END`
}

/** UTF-8 byte budget metadata; never aggregates pooled bodies or charges pointer
 * size. Sealed immutable root length was verified at write; no on-read hash scan.
 */
export function logicalByteLengthSql<K extends Kind>(kind: K, field: Field<K>, ownerId: SQLWrapper, inline: SQLWrapper): SQL<number | null> {
  const ref = reference(kind, field, ownerId)
  return sql`CASE WHEN (SELECT encoding FROM pragma_encoding) <> 'UTF-8' THEN ${corrupt} WHEN EXISTS (${ref}) THEN
    COALESCE((SELECT CASE WHEN sealed = 1 AND encoding = 'utf8-v1' AND typeof(byte_length) = 'integer' AND byte_length >= 0
      THEN byte_length ELSE ${corrupt} END FROM platform_body_root WHERE id = (${ref})), ${corrupt})
    ELSE CASE WHEN ${inline} IS NULL THEN NULL WHEN typeof(${inline}) = 'text' THEN length(CAST(${inline} AS BLOB)) ELSE ${corrupt} END END`
}

type Columns<K extends Kind> = typeof ownerTables[K]['_']['columns']
type LegacySelection<K extends Kind> = { [P in keyof Columns<K>]: Columns<K>[P] | SQL<Columns<K>[P] extends { _: { data: infer D } } ? D : never> }

/** Opt-in getTableColumns replacement. Preserve the original field insertion order
 * and each column's original Drizzle decoder (including JSON null/invalid JSON).
 * No private reference ID enters the legacy source object. Existing readers are
 * intentionally unchanged until their own pooled-fixture acceptance PRs.
 */
export function legacyBodySelection<K extends Kind>(kind: K): LegacySelection<K> {
  const table = ownerTables[kind]
  const columns = getTableColumns(table)
  const fields: readonly string[] = bodyOwnerDefinitions[kind].fields
  return Object.fromEntries(Object.entries(columns).map(([key, column]) => [key,
    fields.includes(key) ? logicalTextSql(kind, key as Field<K>, table.id, column).mapWith(column) : column,
  ])) as LegacySelection<K>
}
