import { sql } from 'drizzle-orm'
import { snapshotSchema } from '../../lib/platform/target-evidence-read'
import { CURRENT_TITLES } from '../../lib/roster/current-titles'
import type { PostgresQualificationTransaction } from '../../lib/roster/current-qualification-postgres'
import { hashRefreshInputs, projectRefreshObservation, refreshProjectionColumns } from './enterprise-difference-refresh'

type Tx = PostgresQualificationTransaction
type Collection = Parameters<typeof projectRefreshObservation>[0]
type Material = Record<string, unknown>
type Enterprise = { name: string; name_norm: string; uscc_norm: string | null; city: string | null; district: string | null }
const ids = (values: readonly number[]) => sql`${sql.param(values)}::bigint[]`

// These columns reproduce the legacy fingerprint. Structured ownership selects
// the sources before sealed archive cells are decoded for hash compatibility.
const relationFields = ['relation_key','uscc_raw','name_raw','alias_name_raw','province','status','batch','declare_kind','applied_at','award_batch_label','year']
const sourceFields = ['id','rdjb','rddqrq','whpcyear','whpc','cszt','year','sqsj','sblx','personuuid','szsfmc','szq','rdxx','qymc','tyshxydm']

function relationMaterial(snapshot: Buffer, match_basis: string | null, verification_status: string) {
  const cells = new Map(snapshotSchema.parse(JSON.parse(snapshot.toString('utf8'))).fields.map(cell => [cell.name, cell]))
  const original = (name: string) => {
    const cell = cells.get(name)
    if (!cell || cell.storageClass === 'null') return null
    const value = Buffer.from(cell.hex, 'hex').toString('utf8')
    if (cell.storageClass === 'integer' || cell.storageClass === 'real') return Number(value)
    if (cell.storageClass === 'blob') throw new Error('Difference refresh cannot hash a binary relation field')
    return value
  }
  const fields = { ...Object.fromEntries(relationFields.map(name => [name, original(name)])), match_basis, verification_status }
  const raw = cells.get('raw_fields')
  if (!raw || raw.storageClass === 'null') return fields
  try {
    const value = JSON.parse(Buffer.from(raw.hex, 'hex').toString('utf8'))
    return { ...fields, sourceBusiness: Object.fromEntries(sourceFields.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])) }
  } catch { return { ...fields, sourceBusinessMalformed: true } }
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
  const { rows: sources } = await tx.execute<{ collectionId: number; snapshot: Buffer; match_basis: string | null; verification_status: string }>(sql`
    SELECT o.collection_id::float8 AS "collectionId", v.bytes AS snapshot, a.match_basis, a.verification_status
    FROM platform_business_observation o JOIN platform_legacy_relation_alias r ON r.observation_id=o.id
    JOIN platform_observation_archive_ref ref ON ref.owner_id=o.id AND ref.field='legacyRowSnapshot'
    JOIN platform_archive_value v ON v.id=ref.archive_id
    JOIN LATERAL (SELECT match_basis,verification_status FROM platform_observation_assignment
      WHERE observation_id=o.id ORDER BY revision DESC LIMIT 1) a ON true
    WHERE o.collection_id=ANY(${selected})`)
  const relations = Map.groupBy(sources.map(row => ({
    collectionId: row.collectionId, material: relationMaterial(row.snapshot, row.match_basis, row.verification_status),
  })), row => row.collectionId)
  const { rows: metadataRows } = await tx.execute<{ collectionId: number; metadata: Buffer | null }>(sql`
    SELECT ref.owner_id::float8 AS "collectionId", v.bytes AS metadata
    FROM platform_collection_archive_ref ref JOIN platform_archive_value v ON v.id=ref.archive_id
    WHERE ref.owner_id=ANY(${selected}) AND ref.field='collectionEvidence'`)
  const metadata = new Map(metadataRows.map(row => [row.collectionId, row.metadata === null ? null : row.metadata.toString('utf8') || '{']))
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
