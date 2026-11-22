import { and, between, desc, eq, getTableColumns, isNotNull, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { alias } from 'drizzle-orm/pg-core'
import {
  platformBusinessObservation, platformCollection, platformCollectionPage,
  platformObservationAssignment,
} from '../../../../db/postgresql/platform-tables'
import type { PlatformStoredQuery, PlatformStoredRelation } from '../../lib/platform/read'
type Db = Pick<NodePgDatabase, 'select'>
type Collection = Pick<typeof platformCollection.$inferSelect, typeof collectionFieldOrder[number]> & Pick<PlatformStoredQuery, 'interface' | 'status'>

const pgCollectionColumns = getTableColumns(platformCollection)
// Preserve legacy collection field order for callers that fingerprint its projection.
const collectionFieldOrder = [
  'id',
  'interface',
  'queryKey',
  'rdjb',
  'titleCode',
  'queriedAt',
  'createdAt',
  'lastCollectedAt',
  'status',
  'failureReason',
  'source',
  'evidenceStatus',
  'completedAt',
  'completeness',
  'fullRange',
  'fetchedCount',
  'declaredTotal',
  'scopeMode',
  'provenanceState',
  'parseState',
  'ruleVersion',
  'errorCode',
  'errorMessage',
  'maxRequests',
  'maxRows',
  'maxDurationMs',
  'pageSize',
  'witnessState',
  'witnessGate',
  'witnessRule',
  'witnessArchiveId',
  'witnessSha256',
  'witnessErrorName',
  'witnessError',
] as const satisfies readonly (keyof typeof pgCollectionColumns)[]
const collectionColumns = Object.fromEntries(collectionFieldOrder
  .map(key => [key, pgCollectionColumns[key]])) as Pick<typeof pgCollectionColumns, typeof collectionFieldOrder[number]> & Pick<PlatformStoredQuery, 'interface' | 'status'>

type Query = PlatformStoredQuery & { rawResponseSha256: string | null }

export async function readPostgresFingerprintQueries(db: Db, ids: readonly number[]) {
  if (!ids.length) return new Map<number, { query: Query; collection: Collection }>()

  const rows = await db.select({
    id: platformCollection.publicId, collection: collectionColumns, coverage: platformCollection.sourceCoverage,
    rawResponseSha256: platformCollection.rawResponseSha256,
  }).from(platformCollection)
    .where(sql`${platformCollection.publicId} = ANY(${sql.param(ids)}::bigint[])`)
  return new Map(rows.map(row => {
    const c = row.collection as Collection
    const query: Query = {
      id: row.id, interface: c.interface, queryKey: c.queryKey, rdjb: c.rdjb, titleCode: c.titleCode,
      queriedAt: c.queriedAt, lastCollectedAt: c.lastCollectedAt, status: c.status, failureReason: c.failureReason,
      rawResponse: null, rawResponseSha256: row.rawResponseSha256,
      collectionEvidence: row.coverage as Query['collectionEvidence'], createdAt: c.createdAt,
    }
    return [row.id, { query, collection: c }] as const
  }))
}

export async function readPostgresFingerprintRelations(db: Db, queryId: number) {
  return (await readPostgresRelationFingerprints(db, { queryId })).map(row => row.relation)
}

export async function readPostgresRelationFingerprints(db: Db, scope: { queryId: number } | { relationIds: readonly number[] }) {

  const observation = platformBusinessObservation

  const assignment = platformObservationAssignment
  const original = alias(assignment, 'first_assignment')
  const page = platformCollectionPage
  const latest = db.select({
    enterpriseId: assignment.enterpriseId, matchBasis: assignment.matchBasis, verificationStatus: assignment.verificationStatus,
  }).from(assignment).where(eq(assignment.observationId, observation.id))
    .orderBy(desc(assignment.revision)).limit(1).as('latest_assignment')
  const sourcePage = db.select({ rdjb: page.rdjb, sequenceStart: page.sequenceStart }).from(page)
    .where(and(eq(page.collectionId, observation.collectionId), eq(page.status, 'success'),
      between(observation.sequenceNo, page.sequenceStart, page.sequenceEnd)))
    .orderBy(page.ordinal).limit(1).as('source_page')
  const where = 'queryId' in scope ? eq(platformCollection.publicId, scope.queryId)
    : sql`${observation.publicId} = ANY(${sql.param(scope.relationIds)}::bigint[])`
  const rows = await db.select({
    id: observation.publicId, queryId: platformCollection.publicId, observationId: observation.id,
    enterpriseId: latest.enterpriseId, matchBasis: latest.matchBasis, verificationStatus: latest.verificationStatus,
    originalUscc: original.usccRaw, originalName: original.nameRaw, sourceRdjb: sourcePage.rdjb,
    source: observation.relationFacts,
  }).from(platformCollection)
    .innerJoin(observation, eq(observation.collectionId, platformCollection.id))
    .crossJoinLateral(latest)
    .innerJoin(original, and(eq(original.observationId, observation.id), eq(original.revision, 1)))
    .leftJoinLateral(sourcePage, isNotNull(sourcePage.sequenceStart))
    .where(where).orderBy(observation.publicId)
  return rows.map(({ id, enterpriseId, matchBasis, verificationStatus, source, queryId, observationId, sourceRdjb, originalUscc, originalName }) => {
    if (source === null) throw new Error('Missing captured correspondence source facts')
    const { status } = source
    const relation: PlatformStoredRelation = {
      ...(source as Omit<PlatformStoredRelation, 'rawFields' | 'sourceText'>),
      id, queryId, enterpriseId,
      matchBasis: matchBasis as PlatformStoredRelation['matchBasis'],
      verificationStatus: verificationStatus as PlatformStoredRelation['verificationStatus'],
      rawFields: null, sourceText: null,
      status: status !== null && typeof status === 'object' && 'base64' in status && typeof status.base64 === 'string'
        ? Buffer.from(status.base64, 'base64') : status as PlatformStoredRelation['status'],
    }
    return { relation, observationId, sourceRdjb, originalUscc, originalName }
  })
}
