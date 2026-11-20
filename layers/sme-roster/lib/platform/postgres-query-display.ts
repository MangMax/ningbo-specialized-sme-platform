import { decodePostgresExactCell } from '../../../../db/postgresql/exact-cell'
import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { BUSINESS_STATUS_V1, BUSINESS_STATUS_V2 } from '../../../../db/business-status'
import { MAX_FULL_QUERY_BYTES, assertPlatformFullReadBudget } from './evidence-contract'
import { legacySourcePositionForSequence, type LegacyProvenanceDisplay } from './legacy-provenance'
import { legacyEnvelopeCollection, readPlatformArchiveBytes, type PostgresPlatformArchive } from './postgres-evidence-read'
import type { PlatformQueryRow } from './read'
import { sourcePositionForSequence } from './recognized-evidence'
import { snapshotSchema } from './target-evidence-read'
import type { RelationEvidenceDisplay } from './target-relation-display'
import { parsePlatformRelationDisplay } from './target-query-read'

type Reader = Pick<NodePgDatabase, 'execute'>
type Query = PlatformQueryRow['query']
type Observation = {
  collectionId: string; observationId: string; id: string; sequenceNo: string; relationKey: string | null;
  enterpriseId: string | null; matchedName: string | null; usccRaw: string | null; nameRaw: string | null;
  matchBasis: string | null; verificationStatus: string | null; hasOriginal: boolean;
}
type Owner = { collectionId: string; provenanceState: string; query: Query }
type CollectionArchive = PostgresPlatformArchive & { owner: string; field: string }
type RelationArchive = { owner: string; field: string; bytes: Buffer | null; sealed: boolean }
const projectionTables = {
  apply_list: 'platform_apply_projection',
  business_list: 'platform_business_projection',
  recognized_list: 'platform_recognized_projection',
} as const
const facts = [
  ['province', 'province'], ['status', 'status'], ['batch', 'batch'], ['declareKind', 'declare_kind'],
  ['appliedAt', 'applied_at'], ['awardBatchLabel', 'award_batch_label'], ['year', 'year'],
] as const
const byteBudgetCells = ['raw_fields', 'source_text', 'name_raw', 'alias_name_raw', 'uscc_raw',
  'relation_key', 'province', 'status', 'batch', 'declare_kind', 'applied_at', 'award_batch_label']

function factValue(row: Record<string, unknown>, field: string, key: string) {
  const data = row[key]
  if (field === 'status' && Buffer.isBuffer(data)) return decodePostgresExactCell(data, row[key + '_sqlite_storage'] as string | null)
  if (field === 'year' && data != null) return Number(data)
  return data
}

async function legacyDisplay(db: Reader, owner: Owner) {
  const { rows: [archive] } = await db.execute<PostgresPlatformArchive & Omit<LegacyProvenanceDisplay, 'kind' | 'collection' | 'queryId'> & {
    origin: 't04_envelope' | 'supplement'
  }>(sql`
    SELECT a.id, a.byte_length AS "byteLength", a.storage_class AS "storageClass", p.origin,
      p.source_identity AS "sourceIdentity", p.source_sha256 AS "sourceSha256", p.segment_index::double precision AS "segmentIndex",
      p.input_fingerprint AS "inputFingerprint", p.import_batch_id::double precision AS "importBatchId", p.created_at AS "createdAt",
      EXISTS (SELECT 1 FROM platform_collection_archive_ref r WHERE r.owner_id = p.collection_id
        AND r.field = 'legacyProvenance' AND r.archive_id = a.id AND r.sealed = 1) AS sealed
    FROM platform_collection_legacy_provenance p JOIN platform_archive_value a ON a.id = p.archive_id
    WHERE p.collection_id = ${owner.collectionId}`)
  if (!archive) {
    if (['legacy_supplement', 'conflict'].includes(owner.provenanceState)) throw new Error('Missing original legacy provenance')
    return undefined
  }
  const { id, storageClass, byteLength, origin, sealed, ...metadata } = archive
  if (byteLength === null || (origin === 't04_envelope' ? !sealed || storageClass !== 'blob' : storageClass !== 'text')) {
    throw new Error('Invalid legacy provenance archive')
  }
  const { start, size } = origin === 't04_envelope' ? await legacyEnvelopeCollection(db, archive, owner.query.id)
    : { start: 0, size: Number(byteLength) }
  if (size === null) return { display: { ...metadata, kind: 'legacy_pagination' as const, queryId: owner.query.id,
    collection: null as unknown as LegacyProvenanceDisplay['collection'] }, bytes: 0 }
  // Remove the legacy rows inside PostgreSQL before returning the bounded metadata.
  const { rows: [row] } = await db.execute<{ collection: LegacyProvenanceDisplay['collection'] | null; bytes: string }>(sql`
    WITH metadata AS MATERIALIZED (
      SELECT '{' || coalesce(string_agg(to_json(item.key)::text || ':' || item.value::text, ',' ORDER BY item.position),'') || '}' AS value
      FROM platform_archive_value a,
        LATERAL json_each(convert_from(substring(a.bytes FROM ${start + 1} FOR ${size}), 'UTF8')::json)
          WITH ORDINALITY item(key,value,position)
      WHERE a.id = ${id} AND item.key <> 'rows'
    )
    SELECT CASE WHEN octet_length(value) <= ${MAX_FULL_QUERY_BYTES} THEN value::json END AS collection,
      octet_length(value) AS bytes FROM metadata`)
  const metadataBytes = Number(row!.bytes)
  assertPlatformFullReadBudget([metadataBytes])
  const collection = row!.collection!
  return { display: { ...metadata, kind: 'legacy_pagination' as const, queryId: owner.query.id, collection },
    bytes: metadataBytes }
}

async function readDisplayRows(db: Reader, owners: Owner[], includeRaw: boolean, selection?: readonly number[]) {
  if (!owners.length) return []
  const ids = sql`${sql.param(owners.map(owner => owner.collectionId))}::bigint[]`
  const { rows: archiveRows } = await db.execute<CollectionArchive>(sql`
    SELECT r.owner_id AS owner,r.field,v.id,v.byte_length AS "byteLength",v.storage_class AS "storageClass",r.sealed = 1 AS sealed
    FROM platform_collection_archive_ref r JOIN platform_archive_value v ON v.id = r.archive_id
    WHERE r.owner_id = ANY(${ids}) AND (r.field = 'collectionEvidence' OR (${includeRaw} AND r.field = 'rawResponse'))`)
  const archives = Map.groupBy(archiveRows, ref => ref.owner)
  const { rows: relationBudget } = await db.execute<{ owner: string; bytes: string }>(sql`
    SELECT o.collection_id AS owner, sum(1024 + coalesce(octet_length(e.name),0) + coalesce(
      (SELECT sum(length(cell.value->>'hex')/2)
       FROM json_array_elements(convert_from(v.bytes,'UTF8')::json->'fields') AS cell(value)
       WHERE cell.value->>'name' = ANY(${sql.param(byteBudgetCells)}::text[])),0)) AS bytes
    FROM platform_business_observation o
    JOIN platform_observation_archive_ref r ON r.owner_id = o.id AND r.field = 'legacyRowSnapshot'
    JOIN platform_archive_value v ON v.id = r.archive_id
    JOIN LATERAL (SELECT enterprise_id FROM platform_observation_assignment
      WHERE observation_id = o.id ORDER BY revision DESC LIMIT 1) a ON TRUE
    LEFT JOIN enterprise e ON e.id = a.enterprise_id
    WHERE o.collection_id = ANY(${ids}) GROUP BY o.collection_id`)
  const byOwner = new Map(relationBudget.map(row => [row.owner, Number(row.bytes)]))
  const basic = owners.map(owner => (byOwner.get(owner.collectionId) ?? 0) +
    (archives.get(owner.collectionId) ?? []).reduce((sum, value) => sum + Number(value.byteLength), 0))
  assertPlatformFullReadBudget(basic)
  const legacy = new Map<string, LegacyProvenanceDisplay>()
  for (const [index, owner] of owners.entries()) {
    const value = await legacyDisplay(db, owner)
    if (value) {
      legacy.set(owner.collectionId, value.display)
      basic[index]! += value.bytes
      assertPlatformFullReadBudget(basic)
    }
  }

  const queryByOwner = new Map<string, Query>()
  for (const owner of owners) {
    const entries = archives.get(owner.collectionId) ?? []
    const content = entries.find(value => value.field === 'collectionEvidence')
    if (!content?.sealed) throw new Error('Missing sealed collection archive')
    const bytes = content.byteLength === null ? null : await readPlatformArchiveBytes(db, content.id, 0, Number(content.byteLength))
    const query: Query = { ...owner.query, collectionEvidence: bytes === null ? null : JSON.parse(bytes.toString('utf8')) }
    const provenance = legacy.get(owner.collectionId)
    if (provenance) query.legacyProvenance = provenance
    if (includeRaw) {
      const raw = entries.find(value => value.field === 'rawResponse')
      if (!raw?.sealed) throw new Error('Missing sealed collection archive')
      const response = raw.byteLength === null ? null : await readPlatformArchiveBytes(db, raw.id, 0, Number(raw.byteLength))
      query.rawResponse = raw.storageClass === 'blob' ? response as unknown as string : response?.toString('utf8') ?? null
    }
    queryByOwner.set(owner.collectionId, query)
  }
  const { rows: observations } = await db.execute<Observation>(sql`
    SELECT o.collection_id AS "collectionId",o.id AS "observationId",r.old_id AS id,o.sequence_no AS "sequenceNo",
      o.source_relation_key AS "relationKey",a.enterprise_id AS "enterpriseId",e.name AS "matchedName",
      original.uscc_raw AS "usccRaw",original.name_raw AS "nameRaw",original.observation_id IS NOT NULL AS "hasOriginal",
      a.match_basis AS "matchBasis",a.verification_status AS "verificationStatus"
    FROM platform_business_observation o JOIN platform_legacy_relation_alias r ON r.observation_id = o.id
    LEFT JOIN platform_observation_assignment original ON original.observation_id = o.id AND original.revision = 1
    LEFT JOIN LATERAL (SELECT enterprise_id,match_basis,verification_status FROM platform_observation_assignment
      WHERE observation_id = o.id ORDER BY revision DESC LIMIT 1) a ON TRUE
    LEFT JOIN enterprise e ON e.id = a.enterprise_id
    WHERE o.collection_id = ANY(${ids})
      ${selection === undefined ? sql.empty() : sql`AND r.old_id=ANY(${sql.param(selection)}::bigint[])`}
    ORDER BY o.collection_id,o.sequence_no`)
  const observationIds = sql`${sql.param(observations.map(row => row.observationId))}::bigint[]`
  const { rows: relationArchives } = await db.execute<RelationArchive>(sql`
    SELECT r.owner_id AS owner,r.field,r.sealed=1 AS sealed,
      CASE WHEN r.field IN ('rawFields','legacyRowSnapshot') THEN v.bytes END AS bytes
    FROM platform_observation_archive_ref r JOIN platform_archive_value v ON v.id = r.archive_id
    WHERE r.owner_id = ANY(${observationIds})`)
  const byObservation = Map.groupBy(relationArchives, ref => ref.owner)
  const projectionRows = new Map<string, Record<string, unknown>>()
  for (const [source, typed] of Map.groupBy(observations, row => queryByOwner.get(row.collectionId)!.interface)) {
    const name = projectionTables[source as keyof typeof projectionTables]
    if (!name) throw new Error('Unsupported observation type')
    const columns = sql.join(facts.flatMap(([, field]) => [
      sql.identifier('reconciled_' + field), sql.identifier(field + '_conflict'),
      sql.identifier('stored_' + field), sql.identifier('parsed_' + field),
    ]).map(value => sql`${value}`), sql`,`)
    const state = source === 'recognized_list' ? sql`exact_title_state` : sql`exact_stored_state`
    const statusTags = source === 'business_list' ? sql`, stored_status_sqlite_storage,reconciled_status_sqlite_storage` : sql.empty()
    const { rows } = await db.execute(sql`
      SELECT observation_id, ${state} AS capture_state, source_title_rule_version,${columns}${statusTags}
        ${selection === undefined ? sql.empty() : sql`,exact_title_raw,exact_title_raw_sqlite_storage`}
      FROM ${sql.identifier(name)} WHERE observation_id = ANY(${sql.param(typed.map(row => row.observationId))}::bigint[])`)
    for (const row of rows) projectionRows.set(String(row.observation_id), row)
  }
  const relations = Map.groupBy(observations, row => row.collectionId)
  return owners.map(({ collectionId }) => {
    const query = queryByOwner.get(collectionId)!
    return { query, relations: (relations.get(collectionId) ?? []).map(row => {
      const refs = byObservation.get(row.observationId) ?? []
      const snapshot = refs.find(ref => ref.field === 'legacyRowSnapshot')
      const raw = refs.find(ref => ref.field === 'rawFields')
      const projection = projectionRows.get(row.observationId)
      if (!snapshot?.sealed || !snapshot.bytes || !raw?.sealed || !refs.some(ref => ref.field === 'sourceText' && ref.sealed) ||
        !row.hasOriginal || row.matchBasis === null || !projection || projection.capture_state !== 'captured' ||
        !(projection.source_title_rule_version === BUSINESS_STATUS_V1 ||
          (query.interface === 'business_list' && projection.source_title_rule_version === BUSINESS_STATUS_V2))) {
        throw new Error('Missing required source display capture')
      }
      const original = new Map(snapshotSchema.parse(JSON.parse(snapshot.bytes.toString('utf8'))).fields.map(cell => [cell.name, cell]))
      const originalValue = (name: string) => {
        const cell = original.get(name)
        if (!cell) throw new Error('Missing original relation cell ' + name)
        const bytes = Buffer.from(cell.hex, 'hex')
        switch (cell.storageClass) {
          case 'null': return null
          case 'text': return bytes.toString('utf8')
          case 'blob': return bytes
          case 'integer': return Number(bytes.toString('utf8'))
          case 'real': return Buffer.from(cell.real64be!, 'hex').readDoubleBE()
        }
      }
      const sequenceNo = Number(row.sequenceNo)
      const normalizationConflicts = facts.flatMap(([field, column]) => {
        const storedValue = factValue(projection, field, 'stored_' + column)
        const rawValue = factValue(projection, field, 'parsed_' + column)
        return String(projection[column + '_conflict']) === '1' && storedValue != null && rawValue != null
          ? [{ field, storedValue, rawValue }] : []
      })
      const relation = {
        id: Number(row.id), queryId: query.id, sequenceNo, relationKey: row.relationKey,
        enterpriseId: row.enterpriseId === null ? null : Number(row.enterpriseId),
        usccRaw: row.usccRaw, nameRaw: row.nameRaw, aliasNameRaw: originalValue('alias_name_raw'), sourceText: originalValue('source_text'),
        rawFields: raw.bytes === null ? null : JSON.parse(raw.bytes.toString('utf8')),
        ...Object.fromEntries(facts.map(([field, column]) => [field, factValue(projection, field, 'reconciled_' + column)])),
        matchBasis: row.matchBasis, verificationStatus: row.verificationStatus, normalizationConflicts,
      }
      if (selection !== undefined) return { relation: { ...relation,
        titleRaw: decodePostgresExactCell(projection.exact_title_raw as Buffer | null, projection.exact_title_raw_sqlite_storage as string | null),
        createdAt: originalValue('created_at'),
        ...(query.legacyProvenance ? legacySourcePositionForSequence(query.legacyProvenance.collection, sequenceNo)
          : sourcePositionForSequence(query.collectionEvidence, sequenceNo)),
      }, matchedName: row.matchedName }
      return { relation: { ...relation, ...sourcePositionForSequence(query.legacyProvenance ? query.legacyProvenance.collection : query.collectionEvidence, sequenceNo) }, matchedName: row.matchedName }
    }) }
  })
}

export async function readPostgresQueryDisplays(db: Reader, owners: Owner[], includeRaw: boolean): Promise<PlatformQueryRow[]> {
  return (await readDisplayRows(db, owners, includeRaw)).map(({ query, relations }) => ({ query,
    relations: relations.map(({ relation, matchedName }) => ({ ...parsePlatformRelationDisplay(query.interface, relation), matchedName })),
  }))
}

export async function readPostgresRelationDisplays(db: Reader, selection: readonly number[]) {
  const result = new Map<number, RelationEvidenceDisplay>(selection.map(id => [id, null]))
  if (!selection.length) return result
  const { rows: owners } = await db.execute<Owner>(sql`
    SELECT DISTINCT c.id AS "collectionId", c.provenance_state AS "provenanceState",
      jsonb_build_object('id',q.old_id,'interface',c.interface,'queryKey',c.query_key,
        'rdjb',c.rdjb,'titleCode',c.title_code,'queriedAt',c.queried_at,'lastCollectedAt',c.last_collected_at,
        'status',c.status,'failureReason',c.failure_reason,'createdAt',c.created_at) AS query
    FROM platform_legacy_relation_alias a JOIN platform_business_observation o ON o.id=a.observation_id
    JOIN platform_collection c ON c.id=o.collection_id JOIN platform_legacy_query_alias q ON q.collection_id=c.id
    WHERE a.old_id=ANY(${sql.param(selection)}::bigint[])`)
  for (const { query, relations } of await readDisplayRows(db, owners, false, selection)) {
    for (const { relation } of relations) result.set(relation.id, { ...relation, query } as RelationEvidenceDisplay)
  }
  return result
}
