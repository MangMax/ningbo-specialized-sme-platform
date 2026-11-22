import { decodePostgresExactCell } from '../../../../db/postgresql/exact-cell'
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { alias, type PgColumn } from 'drizzle-orm/pg-core'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { enterprise } from '../../../../db/postgresql/enterprise-tables'
import {
  platformApplyProjection as applyProjection,
  platformBusinessProjection as businessProjection,
  platformRecognizedProjection as recognizedProjection,
  platformBusinessObservation as observation,
  platformBusinessRecordVersion as version,
  platformCollection as collection,
  platformObservationAssignment as assignment,
} from '../../../../db/postgresql/platform-tables'
import { BUSINESS_STATUS_V1, BUSINESS_STATUS_V2 } from '../../../../db/business-status-contract'
import { assertPlatformFullReadBudget } from './evidence-contract'
import type { PlatformQueryRow } from './read'
import { sourcePositionForSequence } from './recognized-evidence'
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
function factValue(row: Record<string, unknown>, field: string, key: string) {
  const data = row[key]
  if (field === 'status' && Buffer.isBuffer(data)) return decodePostgresExactCell(data, row[key + '_sqlite_storage'] as string | null)
  if (field === 'year' && data != null) return Number(data)
  return data
}

export async function readPostgresDisplayRows<T extends DisplayQuery>(db: Reader, owners: PostgresDisplayOwner<T>[], selection?: readonly number[]) {
  if (!owners.length) return []
  const collectionIds = owners.map(owner => Number(owner.collectionId))
  const coverage = await db.select({ id: collection.id, evidence: collection.sourceCoverage }).from(collection)
    .where(inArray(collection.id, collectionIds))
  const coverageById = new Map(coverage.map(row => [String(row.id), row.evidence]))
  const queryByOwner = new Map(owners.map(owner => [owner.collectionId, {
    ...owner.query, collectionEvidence: coverageById.get(owner.collectionId) ?? null,
  }]))
  const original = alias(assignment, 'original')
  const current = db.select({
    enterpriseId: assignment.enterpriseId, matchBasis: assignment.matchBasis, verificationStatus: assignment.verificationStatus,
  }).from(assignment).where(eq(assignment.observationId, observation.id)).orderBy(desc(assignment.revision)).limit(1).as('current_owner')
  const observationRows = await db.select({
    collectionId: observation.collectionId, observationId: observation.id, id: observation.publicId, sequenceNo: observation.sequenceNo,
    relationKey: observation.sourceRelationKey, relationFacts: observation.relationFacts, businessFields: observation.businessFields,
    versionId: observation.versionId, versionBusinessFields: version.businessFields,
    enterpriseId: current.enterpriseId, matchedName: enterprise.name,
    usccRaw: original.usccRaw, nameRaw: original.nameRaw, hasOriginal: isNotNull(original.observationId).mapWith(Boolean),
    matchBasis: current.matchBasis, verificationStatus: current.verificationStatus,
  }).from(observation)
    .leftJoin(version, eq(version.id, observation.versionId))
    .leftJoin(original, and(eq(original.observationId, observation.id), eq(original.revision, 1)))
    .leftJoinLateral(current, eq(observation.id, observation.id)).leftJoin(enterprise, eq(enterprise.id, current.enterpriseId))
    .where(and(inArray(observation.collectionId, collectionIds), selection === undefined ? undefined : inArray(observation.publicId, selection)))
    .orderBy(asc(observation.collectionId), asc(observation.sequenceNo))
  const observations = observationRows.map(row => ({
    ...row, collectionId: String(row.collectionId), observationId: String(row.observationId),
    businessFields: row.versionId === null ? row.businessFields : row.versionBusinessFields,
  }))
  assertPlatformFullReadBudget([
    ...coverage.map(row => Buffer.byteLength(JSON.stringify(row.evidence))),
    ...observations.map(row => 768 + Buffer.byteLength(JSON.stringify([row.relationFacts,row.businessFields,row.matchedName]))),
  ])
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
      const projection = projectionRows.get(row.observationId)
      if (!row.hasOriginal || row.matchBasis === null || !projection || projection.capture_state !== 'captured' ||
        !(projection.source_title_rule_version === BUSINESS_STATUS_V1 ||
          (query.interface === 'business_list' && projection.source_title_rule_version === BUSINESS_STATUS_V2))) {
        throw new Error('Missing source display facts')
      }
      const originalText = (key: string) => {
        const value = row.relationFacts?.[key]
        return typeof value === 'string' ? value : null
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
        usccRaw: row.usccRaw, nameRaw: row.nameRaw, aliasNameRaw: originalText('aliasNameRaw'), sourceText: null,
        rawFields: row.businessFields,
        ...Object.fromEntries(facts.map(([field, column]) => [field, factValue(projection, field, 'reconciled_' + column)])),
        matchBasis: row.matchBasis, verificationStatus: row.verificationStatus, normalizationConflicts,
      }
      if (selection !== undefined) return { relation: { ...relation,
        titleRaw: decodePostgresExactCell(projection.exact_title_raw as Buffer | null, projection.exact_title_raw_sqlite_storage as string | null),
        createdAt: originalText('createdAt'),
        ...sourcePositionForSequence(query.collectionEvidence, sequenceNo),
      }, matchedName: row.matchedName }
      return { relation: { ...relation, ...sourcePositionForSequence(query.collectionEvidence, sequenceNo) }, matchedName: row.matchedName }
    }) }
  })
}

export async function readPostgresQueryDisplays(db: Reader, owners: PostgresDisplayOwner[]): Promise<PlatformQueryRow[]> {
  return (await readPostgresDisplayRows(db, owners)).map(({ query, relations }) => ({ query,
    relations: relations.map(({ relation, matchedName }) => ({ ...parsePlatformRelationDisplay(query.interface, relation), matchedName })),
  }))
}

export async function readPostgresRelationDisplays(db: Reader, selection: readonly number[]) {
  const result = new Map<number, RelationEvidenceDisplay>(selection.map(id => [id, null]))
  if (!selection.length) return result
  const rows = await db.selectDistinct({
    collectionId: collection.id, provenanceState: collection.provenanceState,
    id: collection.publicId, interface: collection.interface, queryKey: collection.queryKey, rdjb: collection.rdjb,
    titleCode: collection.titleCode, queriedAt: collection.queriedAt, lastCollectedAt: collection.lastCollectedAt,
    status: collection.status, failureReason: collection.failureReason, createdAt: collection.createdAt,
  }).from(observation)
    .innerJoin(collection, eq(collection.id, observation.collectionId)).where(inArray(observation.publicId, selection))
  const owners = rows.map(({ collectionId, provenanceState, ...query }) => ({
    collectionId: String(collectionId), provenanceState, query,
  }))
  for (const { query, relations } of await readPostgresDisplayRows(db, owners, selection)) {
    for (const { relation } of relations) result.set(relation.id, { ...relation, query } as RelationEvidenceDisplay)
  }
  return result
}
