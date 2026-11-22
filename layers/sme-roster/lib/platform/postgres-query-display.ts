import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
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
import { assertPlatformFullReadBudget } from './evidence-contract'
import type { PlatformQueryRow } from './read'
import { sourcePositionForSequence } from './recognized-evidence'
import type { RelationEvidenceDisplay } from './target-relation-display'
import { parsePlatformRelationDisplay } from './query-relation-display-schema'
import { platformObservationComparison, platformObservationSourceValue } from './postgres-observation-facts'

type Reader = Pick<NodePgDatabase, 'execute' | 'select' | 'selectDistinct'>
type Query = PlatformQueryRow['query']
type DisplayQuery = Omit<Query, 'relationCount'> & Partial<Pick<Query, 'relationCount'>>
export type PostgresDisplayOwner<T extends DisplayQuery = Query> = { collectionId: string; provenanceState: string; query: T }
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
    collectionId: observation.collectionId, id: observation.publicId, sequenceNo: observation.sequenceNo,
    relationKey: observation.sourceRelationKey, businessFields: observation.businessFields,
    sourceValues: observation.sourceValues, sourceCreatedAt: observation.sourceCreatedAt,
    versionId: observation.versionId, versionBusinessFields: version.businessFields,
    enterpriseId: current.enterpriseId, matchedName: enterprise.name,
    usccRaw: original.usccRaw, nameRaw: original.nameRaw, aliasNameRaw: original.aliasNameRaw,
    hasOriginal: isNotNull(original.observationId).mapWith(Boolean),
    matchBasis: current.matchBasis, verificationStatus: current.verificationStatus,
    applyDefaults: {
      titleRaw: applyProjection.titleRaw, status: applyProjection.status, declareKind: applyProjection.declareKind,
      appliedAt: applyProjection.appliedAt, year: applyProjection.declarationYear,
    },
    processDefaults: {
      titleRaw: businessProjection.titleRaw, status: businessProjection.status, declareKind: businessProjection.declareKind,
      appliedAt: businessProjection.appliedAt, year: businessProjection.businessYear, batch: businessProjection.batch,
      awardBatchLabel: businessProjection.awardBatchLabel, province: businessProjection.province,
    },
    recognizedDefaults: { titleRaw: recognizedProjection.titleRaw },
  }).from(observation)
    .leftJoin(version, eq(version.id, observation.versionId))
    .leftJoin(applyProjection, eq(applyProjection.versionId, observation.versionId))
    .leftJoin(businessProjection, eq(businessProjection.versionId, observation.versionId))
    .leftJoin(recognizedProjection, eq(recognizedProjection.versionId, observation.versionId))
    .leftJoin(original, and(eq(original.observationId, observation.id), eq(original.revision, 1)))
    .leftJoinLateral(current, eq(observation.id, observation.id)).leftJoin(enterprise, eq(enterprise.id, current.enterpriseId))
    .where(and(inArray(observation.collectionId, collectionIds), selection === undefined ? undefined : inArray(observation.publicId, selection)))
    .orderBy(asc(observation.collectionId), asc(observation.sequenceNo))
  const observations = observationRows.map(row => ({
    ...row, collectionId: String(row.collectionId),
    businessFields: row.versionId === null ? row.businessFields : row.versionBusinessFields,
  }))
  assertPlatformFullReadBudget([
    ...coverage.map(row => Buffer.byteLength(JSON.stringify(row.evidence))),
    ...observations.map(row => 768 + Buffer.byteLength(JSON.stringify([
      row.sourceValues, row.businessFields, row.matchedName,
      row.relationKey, row.nameRaw, row.aliasNameRaw, row.usccRaw, row.sourceCreatedAt,
    ]))),
  ])
  const relations = Map.groupBy(observations, row => row.collectionId)
  return owners.map(({ collectionId }) => {
    const query = queryByOwner.get(collectionId)!
    return { query, relations: (relations.get(collectionId) ?? []).map(row => {
      if (query.interface !== 'apply_list' && query.interface !== 'business_list' && query.interface !== 'recognized_list') {
        throw new Error('Unsupported observation type')
      }
      if (!row.hasOriginal || row.matchBasis === null || row.sourceValues === null) {
        throw new Error('Missing source display facts')
      }
      const defaults = ({
        apply_list: row.applyDefaults, business_list: row.processDefaults, recognized_list: row.recognizedDefaults,
      })[query.interface] ?? {}
      const sequenceNo = Number(row.sequenceNo)
      const { normalized, normalizationConflicts } = platformObservationComparison(
        query.interface, row.sourceValues, defaults, row.businessFields,
      )
      const relation = {
        id: Number(row.id), queryId: query.id, sequenceNo, relationKey: row.relationKey,
        enterpriseId: row.enterpriseId === null ? null : Number(row.enterpriseId),
        usccRaw: row.usccRaw, nameRaw: row.nameRaw, aliasNameRaw: row.aliasNameRaw, sourceText: null,
        rawFields: row.businessFields,
        ...normalized,
        matchBasis: row.matchBasis, verificationStatus: row.verificationStatus, normalizationConflicts,
      }
      if (selection !== undefined) return { relation: { ...relation,
        titleRaw: platformObservationSourceValue(row.sourceValues, defaults, 'titleRaw'),
        createdAt: row.sourceCreatedAt,
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
