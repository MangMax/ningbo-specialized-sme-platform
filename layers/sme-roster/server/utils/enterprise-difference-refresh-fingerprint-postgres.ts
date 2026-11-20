import { sql, type SQL } from 'drizzle-orm'
import { refreshMetadataKeys, refreshRelationFields, refreshSourceKeys } from '../../lib/platform/difference-hash-inputs'
import { snapshotSchema } from '../../lib/platform/target-evidence-read'
import { CURRENT_TITLES } from '../../lib/roster/current-titles'
import type { PostgresQualificationTransaction } from '../../lib/roster/current-qualification-postgres'
import { hashRefreshInputs, projectRefreshObservation, refreshProjectionColumns } from './enterprise-difference-refresh'

type Tx = PostgresQualificationTransaction
type Collection = Parameters<typeof projectRefreshObservation>[0]
type Material = Record<string, unknown>
type Enterprise = { name: string; name_norm: string; uscc_norm: string | null; city: string | null; district: string | null }
const ids = (values: readonly number[]) => sql`${sql.param(values)}::bigint[]`

// SQLite JSON paths take the first occurrence of a key. Keep JSON token
// values intact for the existing JS number, string and nested object handling.
function firstJsonFields(document: SQL, keys: readonly string[]) {
  return sql`
    SELECT DISTINCT ON (key COLLATE "C") key, value
    FROM json_each(CASE WHEN json_typeof(${document})='object' THEN ${document} ELSE '{}'::json END)
      WITH ORDINALITY fields(key, value, ordinal)
    WHERE key COLLATE "C"=ANY(${sql.param(keys)}::text[])
    ORDER BY key COLLATE "C", ordinal`
}

// json_each decodes strings as it scans, including fields we discard. Quote
// escapes PostgreSQL text cannot represent, along with literal backslashes
// that could be mistaken for the quoting, before projecting raw JSON tokens.
function jsonProjectionInput(raw: SQL) {
  const codeUnit = 'u(?:0000|[dD][89a-fA-F][0-9a-fA-F]{2})'
  const unsafeEscape = String.raw`\\${codeUnit}`
  const tokens = String.raw`\\\\|\\(${codeUnit})`
  const replacement = String.raw`\\\\|\1|`
  return sql`
    SELECT CASE WHEN ${raw} IS JSON THEN
      CASE WHEN ${raw} ~ ${unsafeEscape} THEN regexp_replace(${raw}, ${tokens}, ${replacement}, 'g')::json
        ELSE ${raw}::json END
      END AS document, ${raw} ~ ${unsafeEscape} AS quoted`
}

function restoreJsonEscapes(text: string, quoted: boolean | null) {
  return quoted ? text.replace(/\\\\\|(u[0-9a-fA-F]{4})?\|/g, (_, escape: string | undefined) => escape ? '\\' + escape : '\\\\') : text
}

function archiveJsonText(bytes: SQL) {
  return sql`CASE WHEN position(decode('00','hex') in ${bytes})>0 THEN '{' ELSE convert_from(${bytes},'UTF8') END`
}

function relationMaterial(snapshot: unknown, match_basis: string | null, verification_status: string, business: string | null, quoted: boolean | null) {
  const cells = new Map(snapshotSchema.parse(snapshot).fields.map(cell => [cell.name, cell]))
  const original = (name: string) => {
    const cell = cells.get(name)
    if (!cell || cell.storageClass === 'null') return null
    const value = Buffer.from(cell.hex, 'hex').toString('utf8')
    if (cell.storageClass === 'integer' || cell.storageClass === 'real') return Number(value)
    if (cell.storageClass === 'blob') throw new Error('Difference refresh cannot hash a binary relation field')
    return value
  }
  const fields = { ...Object.fromEntries(refreshRelationFields.map(name => [name, original(name)])), match_basis, verification_status }
  if (business === null) return fields
  if (business === '{') return { ...fields, sourceBusinessMalformed: true }
  return { ...fields, sourceBusiness: JSON.parse(restoreJsonEscapes(business, quoted)) }
}

async function readPlatformMaterials(tx: Tx, enterpriseIds: readonly number[]) {
  const owners = ids(enterpriseIds)
  const { rows } = await tx.execute<{ owner: number; collection: Collection }>(sql`
    WITH keys AS (
      SELECT id AS owner, coalesce(uscc_norm,'') AS key FROM enterprise WHERE id=ANY(${owners})
      UNION ALL SELECT id, 'name:' || name_norm FROM enterprise WHERE id=ANY(${owners})
      UNION ALL SELECT enterprise_id, 'name:' || name_norm FROM enterprise_alias
        WHERE enterprise_id=ANY(${owners}) AND verification_status='confirmed'
    ), candidates AS (
      SELECT k.owner,c.id FROM keys k JOIN platform_collection c ON c.query_key=k.key
      UNION
      SELECT a.enterprise_id,o.collection_id FROM platform_observation_assignment a
        JOIN platform_business_observation o ON o.id=a.observation_id
        WHERE a.enterprise_id=ANY(${owners}) AND NOT EXISTS (
          SELECT 1 FROM platform_observation_assignment later WHERE later.observation_id=a.observation_id AND later.revision>a.revision)
    ), latest AS (
      SELECT c.id, x.owner, c.interface, c.query_key, c.rdjb, c.title_code, c.queried_at, c.status,
        rank() OVER (PARTITION BY x.owner,c.interface,c.query_key,c.rdjb,c.title_code ORDER BY c.queried_at COLLATE "C" DESC) AS rank
      FROM candidates x JOIN platform_collection c ON c.id=x.id JOIN platform_legacy_query_alias q ON q.collection_id=c.id
    )
    SELECT owner::float8 AS owner, json_build_object('id',id,'interface',interface,'queryKey',query_key,
      'rdjb',rdjb,'titleCode',title_code,'queriedAt',queried_at,'status',status) AS collection
    FROM latest WHERE rank=1`)
  const collectionIds = [...new Set(rows.map(row => row.collection.id))]
  if (!collectionIds.length) return new Map<number, { titleCode: string | null; material: Material }[]>()
  const selected = ids(collectionIds)
  const snapshot = sql`convert_from(v.bytes,'UTF8')::json`
  const { rows: sources } = await tx.execute<{ collectionId: number; snapshot: unknown; match_basis: string | null;
    verification_status: string; business: string | null; quoted: boolean | null }>(sql`
    SELECT o.collection_id::float8 AS "collectionId", a.match_basis, a.verification_status,
      json_build_object('encoding',${snapshot}->>'encoding','fields',coalesce(cells.selected,'[]'::json)) AS snapshot,
      CASE WHEN original.raw IS NULL THEN NULL WHEN input.document IS NULL OR json_typeof(input.document)='null' THEN '{'
        ELSE (SELECT coalesce(json_object_agg(key,value),'{}'::json)::text
          FROM (${firstJsonFields(sql`input.document`, refreshSourceKeys)}) fields)
      END AS business, input.quoted
    FROM platform_business_observation o JOIN platform_legacy_relation_alias r ON r.observation_id=o.id
    JOIN platform_observation_archive_ref ref ON ref.owner_id=o.id AND ref.field='legacyRowSnapshot'
    JOIN platform_archive_value v ON v.id=ref.archive_id
    JOIN LATERAL (SELECT match_basis,verification_status FROM platform_observation_assignment
      WHERE observation_id=o.id ORDER BY revision DESC LIMIT 1) a ON true
    CROSS JOIN LATERAL (
      SELECT json_agg(json_build_object('name',cell->>'name','storageClass',cell->>'storageClass','hex',cell->>'hex')
        ORDER BY ordinal) FILTER (WHERE cell->>'name'=ANY(${sql.param(refreshRelationFields)}::text[])) AS selected,
        decode(max(cell->>'hex') FILTER (WHERE cell->>'name'='raw_fields' AND cell->>'storageClass'<>'null'),'hex') AS raw
      FROM json_array_elements(${snapshot}->'fields') WITH ORDINALITY entries(cell, ordinal)
    ) cells
    CROSS JOIN LATERAL (SELECT ${archiveJsonText(sql`cells.raw`)} AS raw) original
    CROSS JOIN LATERAL (${jsonProjectionInput(sql`original.raw`)}) input
    WHERE o.collection_id=ANY(${selected})`)
  const relations = Map.groupBy(sources.map(row => ({
    collectionId: row.collectionId, material: relationMaterial(row.snapshot, row.match_basis, row.verification_status, row.business, row.quoted),
  })), row => row.collectionId)
  const { rows: metadataRows } = await tx.execute<{ collectionId: number; metadata: string | null; quoted: boolean | null }>(sql`
    SELECT ref.owner_id::float8 AS "collectionId", input.quoted,
      CASE WHEN v.storage_class='null' THEN NULL WHEN input.document IS NULL THEN '{' WHEN json_typeof(input.document)='null' THEN 'null'
        ELSE (SELECT coalesce(json_object_agg(key,
          CASE WHEN key='pages' THEN CASE WHEN json_typeof(value)='array' THEN
            (SELECT coalesce(json_agg(CASE WHEN json_typeof(page)='null' THEN page
              ELSE json_build_object('rdjb',page->'rdjb','status',page->'status','declaredTotal',page->'declaredTotal') END
              ORDER BY ordinal),'[]'::json) FROM json_array_elements(value) WITH ORDINALITY pages(page, ordinal))
          ELSE 'null'::json END ELSE value END),'{}'::json)::text
          FROM (${firstJsonFields(sql`input.document`, refreshMetadataKeys)}) fields)
      END AS metadata
    FROM platform_collection_archive_ref ref JOIN platform_archive_value v ON v.id=ref.archive_id
    CROSS JOIN LATERAL (${jsonProjectionInput(archiveJsonText(sql`v.bytes`))}) input
    WHERE ref.owner_id=ANY(${selected}) AND ref.field='collectionEvidence'`)
  const metadata = new Map(metadataRows.map(row => [row.collectionId,
    row.metadata === null ? null : restoreJsonEscapes(row.metadata, row.quoted)]))
  const typed = []
  for (const [table, columns] of Object.entries(refreshProjectionColumns)) {
    const fields = sql.join(columns.map(column => sql`p.${sql.identifier(column)}`), sql`,`)
    const { rows: projections } = await tx.execute<{ collectionId: number; material: Material }>(sql`
      SELECT o.collection_id::float8 AS "collectionId", (SELECT row_to_json(fields) FROM (SELECT ${fields}) fields) AS material
      FROM platform_business_observation o JOIN ${sql.identifier(table)} p ON p.version_id=o.version_id
      WHERE o.collection_id=ANY(${selected})`)
    typed.push(Map.groupBy(projections, row => row.collectionId))
  }
  const projections = new Map<number, Material>()
  for (const { collection } of rows) {
    if (projections.has(collection.id)) continue
    projections.set(collection.id, projectRefreshObservation(collection, {
      relations: (relations.get(collection.id) ?? []).map(row => row.material),
      typed: typed.map(kind => (kind.get(collection.id) ?? []).map(row => row.material)),
      metadata: metadata.get(collection.id) ?? null,
    }))
  }
  return new Map([...Map.groupBy(rows, row => row.owner)].map(([owner, collections]) =>
    [owner, collections.map(({ collection }) => ({ titleCode: collection.titleCode, material: projections.get(collection.id)! }))]))
}

export async function readPostgresRefreshFingerprints(tx: Tx, enterpriseIds: readonly number[]) {
  const owners = ids(enterpriseIds)
  const { rows: enterprises } = await tx.execute<{ id: number; enterprise: Enterprise; aliases: Material[] }>(sql`
    SELECT e.id::float8 AS id, json_build_object('name',e.name,'name_norm',e.name_norm,'uscc_norm',e.uscc_norm,
      'city',e.city,'district',e.district) AS enterprise,
      coalesce((SELECT json_agg(json_build_object('name_norm',a.name_norm,'verification_status',a.verification_status))
        FROM enterprise_alias a WHERE a.enterprise_id=e.id AND a.verification_status='confirmed'),'[]'::json) AS aliases
    FROM enterprise e WHERE e.id=ANY(${owners}) ORDER BY e.id`)
  type MaterialRow = { owner: number; title: string; material: Material }
  const { rows: formal } = await tx.execute<MaterialRow>(sql`
    SELECT r.enterprise_id::float8 AS owner, r.title_code AS title,
      json_build_object('source',r.source,'title_code',r.title_code,'name_raw',r.name_raw,'uscc_raw',r.uscc_raw,
        'event_type',e.event_type,'year',e.year,'batch_seq',e.batch_seq,'decided_year',e.decided_year,
        'review_outcome',e.review_outcome,'formal_validity',e.formal_validity) AS material
    FROM record r LEFT JOIN record_event e ON e.record_id=r.id WHERE r.enterprise_id=ANY(${owners})`)
  const { rows: evidence } = await tx.execute<MaterialRow>(sql`
    SELECT r.enterprise_id::float8 AS owner, r.title_code AS title,
      json_build_object('source_file',v.source_file,'attachment',v.attachment,'list_no',v.list_no,'page',v.page,
        'event_type',e.event_type,'year',e.year,'batch_seq',e.batch_seq) AS material
    FROM record r JOIN record_event e ON e.record_id=r.id JOIN record_evidence v ON v.record_event_id=e.id
    WHERE r.enterprise_id=ANY(${owners})`)
  const { rows: correspondences } = await tx.execute<MaterialRow>(sql`
    SELECT c.enterprise_id::float8 AS owner, c.title_code AS title,
      json_build_object('type',c.type,'role',c.role,'status',c.status,'ended',(c.ended_at IS NOT NULL)::int,
        'relation_key',o.source_relation_key,'event_type',e.event_type,'year',e.year,'batch_seq',e.batch_seq,
        'decided_year',e.decided_year,'review_outcome',e.review_outcome,'predecessor_type',p.event_type,
        'predecessor_year',p.year,'predecessor_batch',p.batch_seq) AS material
    FROM record_correspondence c LEFT JOIN platform_business_observation o ON o.id=c.observation_id
    LEFT JOIN record_event e ON e.id=c.event_id LEFT JOIN record_event p ON p.id=c.predecessor_event_id
    WHERE c.enterprise_id=ANY(${owners})`)
  const group = (rows: MaterialRow[]) => Map.groupBy(rows, row => row.owner + ':' + row.title)
  const formalByTitle = group(formal), evidenceByTitle = group(evidence), correspondenceByTitle = group(correspondences)
  const platform = await readPlatformMaterials(tx, enterpriseIds)
  return enterprises.map(({ id, enterprise, aliases }) => ({
    subject: { id, ...enterprise },
    fingerprints: new Map(CURRENT_TITLES.map(title => {
      const key = id + ':' + title
      const fingerprint = hashRefreshInputs({ enterprise, aliases,
        formal: (formalByTitle.get(key) ?? []).map(row => row.material),
        evidence: (evidenceByTitle.get(key) ?? []).map(row => row.material),
        correspondences: (correspondenceByTitle.get(key) ?? []).map(row => row.material),
        observations: (platform.get(id) ?? []).filter(row => row.titleCode === null || row.titleCode === title).map(row => row.material),
      })
      return [title, fingerprint]
    })),
  }))
}
