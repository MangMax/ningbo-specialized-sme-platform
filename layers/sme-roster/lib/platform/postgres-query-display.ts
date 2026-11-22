import { decodePostgresExactCell } from '../../../../db/postgresql/exact-cell'
import { and, asc, desc, eq, exists, inArray, isNotNull, sql } from 'drizzle-orm'
import { alias, type PgColumn } from 'drizzle-orm/pg-core'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { enterprise } from '../../../../db/postgresql/enterprise-tables'
import {
  platformArchiveValue as archiveValue,
  platformCollectionArchiveRef as collectionRef,
  platformCollectionLegacyProvenance as legacyProvenance,
  platformObservationArchiveRef as observationRef,
} from '../../../../db/postgresql/platform-archive-tables'
import {
  platformApplyProjection as applyProjection,
  platformBusinessProjection as businessProjection,
  platformRecognizedProjection as recognizedProjection,
  platformBusinessObservation as observation,
  platformCollection as collection,
  platformLegacyQueryAlias as queryAlias,
  platformLegacyRelationAlias as relationAlias,
  platformObservationAssignment as assignment,
} from '../../../../db/postgresql/platform-tables'
import { BUSINESS_STATUS_V1, BUSINESS_STATUS_V2 } from '../../../../db/business-status-contract'
import { MAX_FULL_QUERY_BYTES, assertPlatformFullReadBudget } from './evidence-contract'
import { legacySourcePositionForSequence, type LegacyProvenanceDisplay } from './legacy-provenance'
import { legacyEnvelopeCollection, readPlatformArchiveBytes } from './postgres-evidence-read'
import { postgresObservationSnapshot } from './postgres-observation-snapshot'
import type { PlatformQueryRow } from './read'
import { sourcePositionForSequence } from './recognized-evidence'
import { snapshotSchema } from './evidence-snapshot-model'
import type { RelationEvidenceDisplay } from './target-relation-display'
import { parsePlatformRelationDisplay } from './query-relation-display-schema'

type Reader = Pick<NodePgDatabase, 'execute' | 'select' | 'selectDistinct'>
type Query = PlatformQueryRow['query']
type DisplayQuery = Omit<Query, 'relationCount'> & Partial<Pick<Query, 'relationCount'>>
export type PostgresDisplayOwner<T extends DisplayQuery = Query> = { collectionId: string; provenanceState: string; query: T }
const projectionTables = {
  apply_list: applyProjection,
  business_list: businessProjection,
  recognized_list: recognizedProjection,
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

async function legacyDisplay(db: Reader, owner: PostgresDisplayOwner<DisplayQuery>) {
  const sealedReference = db.select({ ownerId: collectionRef.ownerId }).from(collectionRef).where(and(
    eq(collectionRef.ownerId, legacyProvenance.collectionId), eq(collectionRef.field, 'legacyProvenance'),
    eq(collectionRef.archiveId, archiveValue.id), eq(collectionRef.sealed, 1),
  ))
  const [rowArchive] = await db.select({
    id: archiveValue.id, byteLength: archiveValue.byteLength, storageClass: archiveValue.storageClass,
    origin: legacyProvenance.origin, sourceIdentity: legacyProvenance.sourceIdentity,
    sourceSha256: legacyProvenance.sourceSha256, segmentIndex: legacyProvenance.segmentIndex,
    inputFingerprint: legacyProvenance.inputFingerprint, importBatchId: legacyProvenance.importBatchId, createdAt: legacyProvenance.createdAt,
    sealed: exists(sealedReference).mapWith(Boolean),
  }).from(legacyProvenance).innerJoin(archiveValue, eq(archiveValue.id, legacyProvenance.archiveId))
    .where(eq(legacyProvenance.collectionId, Number(owner.collectionId)))
  const archive = rowArchive && {
    ...rowArchive, id: String(rowArchive.id), byteLength: rowArchive.byteLength === null ? null : String(rowArchive.byteLength),
  }
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
  // Drizzle 0.45 cannot expand JSON with ordinality. Keep bounded metadata extraction in PostgreSQL.
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

export async function readPostgresDisplayRows<T extends DisplayQuery>(db: Reader, owners: PostgresDisplayOwner<T>[], includeRaw: boolean, selection?: readonly number[]) {
  if (!owners.length) return []
  const collectionIds = owners.map(owner => Number(owner.collectionId))
  const archiveRows = await db.select({
    owner: collectionRef.ownerId, field: collectionRef.field, id: archiveValue.id, byteLength: archiveValue.byteLength,
    storageClass: archiveValue.storageClass, sealed: collectionRef.sealed,
  }).from(collectionRef).innerJoin(archiveValue, eq(archiveValue.id, collectionRef.archiveId))
    .where(and(inArray(collectionRef.ownerId, collectionIds),
      inArray(collectionRef.field, includeRaw ? ['collectionEvidence', 'rawResponse'] : ['collectionEvidence'])))
  const archives = Map.groupBy(archiveRows, ref => String(ref.owner))
  const budgetOwner = db.select({ enterpriseId: assignment.enterpriseId }).from(assignment)
    .where(eq(assignment.observationId, observation.id)).orderBy(desc(assignment.revision)).limit(1).as('budget_owner')
  // Drizzle 0.45 cannot expand PostgreSQL JSON arrays. Budget the source cells in the database before fetching bytes.
  const relationBudget = await db.select({
    owner: observation.collectionId,
    bytes: sql<number>`sum(1024 + coalesce(octet_length(${enterprise.name}),0) + coalesce(
      (SELECT sum(length(cell.value->>'hex')/2)
       FROM json_array_elements(convert_from(${postgresObservationSnapshot(observation.id, archiveValue.bytes)},'UTF8')::json->'fields') AS cell(value)
       WHERE cell.value->>'name' = ANY(${sql.param(byteBudgetCells)}::text[])),0))`.mapWith(Number),
  }).from(observation)
    .innerJoin(observationRef, and(eq(observationRef.ownerId, observation.id), eq(observationRef.field, 'legacyRowSnapshot')))
    .innerJoin(archiveValue, eq(archiveValue.id, observationRef.archiveId))
    .innerJoinLateral(budgetOwner, eq(observation.id, observation.id))
    .leftJoin(enterprise, eq(enterprise.id, budgetOwner.enterpriseId))
    .where(inArray(observation.collectionId, collectionIds)).groupBy(observation.collectionId)
  const byOwner = new Map(relationBudget.map(row => [String(row.owner), row.bytes]))
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

  const queryByOwner = new Map<string, T & DisplayQuery>()
  for (const owner of owners) {
    const entries = archives.get(owner.collectionId) ?? []
    const content = entries.find(value => value.field === 'collectionEvidence')
    if (content?.sealed !== 1) throw new Error('Missing sealed collection archive')
    const bytes = content.byteLength === null ? null : await readPlatformArchiveBytes(db, String(content.id), 0, content.byteLength)
    const query: T & DisplayQuery = { ...owner.query, collectionEvidence: bytes === null ? null : JSON.parse(bytes.toString('utf8')) }
    const provenance = legacy.get(owner.collectionId)
    if (provenance) query.legacyProvenance = provenance
    if (includeRaw) {
      const raw = entries.find(value => value.field === 'rawResponse')
      if (raw?.sealed !== 1) throw new Error('Missing sealed collection archive')
      const response = raw.byteLength === null ? null : await readPlatformArchiveBytes(db, String(raw.id), 0, raw.byteLength)
      query.rawResponse = raw.storageClass === 'blob' ? response as unknown as string : response?.toString('utf8') ?? null
    }
    queryByOwner.set(owner.collectionId, query)
  }
  const original = alias(assignment, 'original')
  const current = db.select({
    enterpriseId: assignment.enterpriseId, matchBasis: assignment.matchBasis, verificationStatus: assignment.verificationStatus,
  }).from(assignment).where(eq(assignment.observationId, observation.id)).orderBy(desc(assignment.revision)).limit(1).as('current_owner')
  const observationRows = await db.select({
    collectionId: observation.collectionId, observationId: observation.id, id: relationAlias.oldId, sequenceNo: observation.sequenceNo,
    relationKey: observation.sourceRelationKey, enterpriseId: current.enterpriseId, matchedName: enterprise.name,
    usccRaw: original.usccRaw, nameRaw: original.nameRaw, hasOriginal: isNotNull(original.observationId).mapWith(Boolean),
    matchBasis: current.matchBasis, verificationStatus: current.verificationStatus,
  }).from(observation).innerJoin(relationAlias, eq(relationAlias.observationId, observation.id))
    .leftJoin(original, and(eq(original.observationId, observation.id), eq(original.revision, 1)))
    .leftJoinLateral(current, eq(observation.id, observation.id)).leftJoin(enterprise, eq(enterprise.id, current.enterpriseId))
    .where(and(inArray(observation.collectionId, collectionIds), selection === undefined ? undefined : inArray(relationAlias.oldId, selection)))
    .orderBy(asc(observation.collectionId), asc(observation.sequenceNo))
  const observations = observationRows.map(row => ({
    ...row, collectionId: String(row.collectionId), observationId: String(row.observationId),
  }))
  const relationArchives = await db.select({
    owner: observationRef.ownerId, field: observationRef.field, sealed: observationRef.sealed,
    // Drizzle 0.45 has no CASE expression. Transfer bytes only for the two fields consumed here.
    bytes: sql<Buffer | null>`CASE ${observationRef.field}
      WHEN 'rawFields' THEN ${archiveValue.bytes}
      WHEN 'legacyRowSnapshot' THEN ${postgresObservationSnapshot(observationRef.ownerId, archiveValue.bytes)} END`,
  }).from(observationRef).innerJoin(archiveValue, eq(archiveValue.id, observationRef.archiveId))
    .where(inArray(observationRef.ownerId, observationRows.map(row => row.observationId)))
  const byObservation = Map.groupBy(relationArchives, ref => String(ref.owner))
  const projectionRows = new Map<string, Record<string, unknown>>()
  for (const [source, typed] of Map.groupBy(observations, row => queryByOwner.get(row.collectionId)!.interface)) {
    const projection = projectionTables[source as keyof typeof projectionTables]
    if (!projection) throw new Error('Unsupported observation type')
    const fields: Record<string, PgColumn> = {
      observation_id: projection.observationId,
      capture_state: source === 'recognized_list' ? recognizedProjection.exactTitleState
        : source === 'apply_list' ? applyProjection.exactStoredState : businessProjection.exactStoredState,
      source_title_rule_version: projection.sourceTitleRuleVersion,
      reconciled_province: projection.reconciledProvince, province_conflict: projection.provinceConflict,
      stored_province: projection.storedProvince, parsed_province: projection.parsedProvince,
      reconciled_status: projection.reconciledStatus, status_conflict: projection.statusConflict,
      stored_status: projection.storedStatus, parsed_status: projection.parsedStatus,
      reconciled_batch: projection.reconciledBatch, batch_conflict: projection.batchConflict,
      stored_batch: projection.storedBatch, parsed_batch: projection.parsedBatch,
      reconciled_declare_kind: projection.reconciledDeclareKind, declare_kind_conflict: projection.declareKindConflict,
      stored_declare_kind: projection.storedDeclareKind, parsed_declare_kind: projection.parsedDeclareKind,
      reconciled_applied_at: projection.reconciledAppliedAt, applied_at_conflict: projection.appliedAtConflict,
      stored_applied_at: projection.storedAppliedAt, parsed_applied_at: projection.parsedAppliedAt,
      reconciled_award_batch_label: projection.reconciledAwardBatchLabel, award_batch_label_conflict: projection.awardBatchLabelConflict,
      stored_award_batch_label: projection.storedAwardBatchLabel, parsed_award_batch_label: projection.parsedAwardBatchLabel,
      reconciled_year: projection.reconciledYear, year_conflict: projection.yearConflict,
      stored_year: projection.storedYear, parsed_year: projection.parsedYear,
      ...(source === 'business_list' ? {
        stored_status_sqlite_storage: businessProjection.storedStatusSqliteStorage,
        reconciled_status_sqlite_storage: businessProjection.reconciledStatusSqliteStorage,
      } : {}),
      ...(selection === undefined ? {} : {
        exact_title_raw: projection.exactTitleRaw,
        exact_title_raw_sqlite_storage: projection.exactTitleRawSqliteStorage,
      }),
    }
    const rows = await db.select(fields).from(projection)
      .where(inArray(projection.observationId, typed.map(row => Number(row.observationId))))
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
      if (snapshot?.sealed !== 1 || !snapshot.bytes || raw?.sealed !== 1 || !refs.some(ref => ref.field === 'sourceText' && ref.sealed === 1) ||
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

export async function readPostgresQueryDisplays(db: Reader, owners: PostgresDisplayOwner[], includeRaw: boolean): Promise<PlatformQueryRow[]> {
  return (await readPostgresDisplayRows(db, owners, includeRaw)).map(({ query, relations }) => ({ query,
    relations: relations.map(({ relation, matchedName }) => ({ ...parsePlatformRelationDisplay(query.interface, relation), matchedName })),
  }))
}

export async function readPostgresRelationDisplays(db: Reader, selection: readonly number[]) {
  const result = new Map<number, RelationEvidenceDisplay>(selection.map(id => [id, null]))
  if (!selection.length) return result
  const rows = await db.selectDistinct({
    collectionId: collection.id, provenanceState: collection.provenanceState,
    id: queryAlias.oldId, interface: collection.interface, queryKey: collection.queryKey, rdjb: collection.rdjb,
    titleCode: collection.titleCode, queriedAt: collection.queriedAt, lastCollectedAt: collection.lastCollectedAt,
    status: collection.status, failureReason: collection.failureReason, createdAt: collection.createdAt,
  }).from(relationAlias).innerJoin(observation, eq(observation.id, relationAlias.observationId))
    .innerJoin(collection, eq(collection.id, observation.collectionId))
    .innerJoin(queryAlias, eq(queryAlias.collectionId, collection.id)).where(inArray(relationAlias.oldId, selection))
  const owners = rows.map(({ collectionId, provenanceState, ...query }) => ({
    collectionId: String(collectionId), provenanceState, query,
  }))
  for (const { query, relations } of await readPostgresDisplayRows(db, owners, false, selection)) {
    for (const { relation } of relations) result.set(relation.id, { ...relation, query } as RelationEvidenceDisplay)
  }
  return result
}
