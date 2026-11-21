import { and, between, desc, eq, getTableColumns, isNotNull, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { alias } from 'drizzle-orm/pg-core'
import * as schema from '../../../../db/schema'
import { platformArchiveValue, platformCollectionArchiveRef, platformObservationArchiveRef } from '../../../../db/postgresql/platform-archive-tables'
import {
  platformBusinessObservation, platformCollection, platformCollectionPage,
  platformLegacyQueryAlias, platformLegacyRelationAlias, platformObservationAssignment,
} from '../../../../db/postgresql/platform-tables'
import type { PlatformStoredQuery, PlatformStoredRelation } from '../../lib/platform/read'
import { legacyFingerprintRaw } from '../../lib/platform/legacy-fingerprint-raw'
import { sourceRelationFields } from '../../lib/platform/source-snapshot-fields'
import { snapshotSchema } from '../../lib/platform/target-evidence-read'
type Db = Pick<NodePgDatabase, 'select'>
type Cell = ReturnType<typeof snapshotSchema.parse>['fields'][number]
type Collection = typeof schema.platformCollection.$inferSelect

const pgCollectionColumns = getTableColumns(platformCollection)
// Preserve legacy collection field order for callers that fingerprint its projection.
const collectionColumns = Object.fromEntries(Object.keys(getTableColumns(schema.platformCollection))
  .map(key => [key, pgCollectionColumns[key as keyof Collection]])) as typeof pgCollectionColumns

function originalValue(cell: Cell) {
  const bytes = Buffer.from(cell.hex, 'hex')
  switch (cell.storageClass) {
    case 'null': return null
    case 'blob': return bytes
    case 'text': return bytes.toString('utf8')
    case 'integer': return Number(bytes.toString('utf8'))
    case 'real':
      if (!cell.real64be) throw new Error('Missing original REAL bits')
      return Buffer.from(cell.real64be, 'hex').readDoubleBE()
  }
}

export async function readPostgresFingerprintQueries(db: Db, ids: readonly number[], includeRaw = true) {
  if (!ids.length) return new Map<number, { query: PlatformStoredQuery; collection: Collection }>()
  const queryAlias = platformLegacyQueryAlias
  const coverageRef = alias(platformCollectionArchiveRef, 'coverage_ref')
  const rawRef = alias(platformCollectionArchiveRef, 'raw_ref')
  const coverageValue = alias(platformArchiveValue, 'coverage_value')
  const rawValue = alias(platformArchiveValue, 'raw_value')
  const select = db.select({
    id: queryAlias.oldId, collection: collectionColumns, coverage: coverageValue.bytes,
    ...(includeRaw ? { raw: rawValue.bytes } : {}),
  }).from(queryAlias)
    .innerJoin(platformCollection, eq(platformCollection.id, queryAlias.collectionId))
    .leftJoin(coverageRef, and(eq(coverageRef.ownerId, platformCollection.id), eq(coverageRef.field, 'collectionEvidence')))
    .leftJoin(coverageValue, eq(coverageValue.id, coverageRef.archiveId))
    // Drizzle has no scalar = ANY with a single bound array for unbounded ID scopes.
    .where(sql`${queryAlias.oldId} = ANY(${sql.param(ids)}::bigint[])`)
  const rows = await (includeRaw ? select
    .leftJoin(rawRef, and(eq(rawRef.ownerId, platformCollection.id), eq(rawRef.field, 'rawResponse')))
    .leftJoin(rawValue, eq(rawValue.id, rawRef.archiveId)) : select)
  return new Map(rows.map(row => {
    const c = row.collection as Collection
    const query: PlatformStoredQuery = {
      id: row.id, interface: c.interface, queryKey: c.queryKey, rdjb: c.rdjb, titleCode: c.titleCode,
      queriedAt: c.queriedAt, lastCollectedAt: c.lastCollectedAt, status: c.status, failureReason: c.failureReason,
      rawResponse: row.raw?.toString('utf8') ?? null,
      collectionEvidence: row.coverage === null ? null : JSON.parse(row.coverage.toString('utf8')),
      createdAt: c.createdAt,
    }
    return [row.id, { query, collection: c }] as const
  }))
}

export async function readPostgresFingerprintQuery(db: Db, id: number) {
  return (await readPostgresFingerprintQueries(db, [id])).get(id)
}

export async function readPostgresFingerprintRelations(db: Db, queryId: number) {
  return (await readPostgresRelationFingerprints(db, { queryId })).map(row => row.relation)
}

export async function readPostgresRelationFingerprints(db: Db, scope: { queryId: number; archiveReplay?: true } | { relationIds: readonly number[] }) {
  const query = platformLegacyQueryAlias
  const observation = platformBusinessObservation
  const relation = platformLegacyRelationAlias
  const assignment = platformObservationAssignment
  const original = alias(assignment, 'first_assignment')
  const page = platformCollectionPage
  const ref = platformObservationArchiveRef
  const latest = db.select({
    enterpriseId: assignment.enterpriseId, matchBasis: assignment.matchBasis, verificationStatus: assignment.verificationStatus,
  }).from(assignment).where(eq(assignment.observationId, observation.id))
    .orderBy(desc(assignment.revision)).limit(1).as('latest_assignment')
  const sourcePage = db.select({ rdjb: page.rdjb, sequenceStart: page.sequenceStart }).from(page)
    .where(and(eq(page.collectionId, observation.collectionId), eq(page.status, 'success'),
      between(observation.sequenceNo, page.sequenceStart, page.sequenceEnd)))
    .orderBy(page.ordinal).limit(1).as('source_page')
  const where = 'queryId' in scope ? eq(query.oldId, scope.queryId)
    // Keep one bound array for relation scopes that can exceed the bind limit.
    : sql`${relation.oldId} = ANY(${sql.param(scope.relationIds)}::bigint[])`
  const rows = await db.select({
    id: relation.oldId, queryId: query.oldId, observationId: observation.id,
    enterpriseId: latest.enterpriseId, matchBasis: latest.matchBasis, verificationStatus: latest.verificationStatus,
    originalUscc: original.usccRaw, originalName: original.nameRaw, sourceRdjb: sourcePage.rdjb, snapshot: platformArchiveValue.bytes,
  }).from(query)
    .innerJoin(observation, eq(observation.collectionId, query.collectionId))
    .innerJoin(relation, eq(relation.observationId, observation.id))
    .crossJoinLateral(latest)
    .innerJoin(original, and(eq(original.observationId, observation.id), eq(original.revision, 1)))
    .leftJoinLateral(sourcePage, isNotNull(sourcePage.sequenceStart))
    .leftJoin(ref, and(eq(ref.ownerId, observation.id), eq(ref.field, 'legacyRowSnapshot')))
    .leftJoin(platformArchiveValue, eq(platformArchiveValue.id, ref.archiveId))
    .where(where).orderBy(relation.oldId)
  return rows.map(({ id, enterpriseId, matchBasis, verificationStatus, snapshot, queryId, observationId, sourceRdjb, originalUscc, originalName }) => {
    if (!snapshot) throw new Error('Missing original correspondence fingerprint snapshot')
    const cells = new Map(snapshotSchema.parse(JSON.parse(snapshot.toString('utf8'))).fields.map(cell => [cell.name, cell]))
    const latest = { id, queryId, enterpriseId, matchBasis, verificationStatus }
    const relation = Object.fromEntries(Object.entries(sourceRelationFields).map(([key, column]) => {
      if (Object.hasOwn(latest, key)) return [key, latest[key as keyof typeof latest]]
      const cell = cells.get(column.name)
      if (!cell) throw new Error('Missing fingerprint cell ' + column.name)
      if ('archiveReplay' in scope && scope.archiveReplay && key === 'rawFields'
        && (cell.storageClass === 'null' || cell.storageClass === 'text' || cell.storageClass === 'blob')) {
        const bytes = cell.storageClass === 'null' ? null : Buffer.from(cell.hex, 'hex')
        return [key, legacyFingerprintRaw({ storageClass:cell.storageClass, bytes }).rawFields]
      }
      const value = originalValue(cell)
      return [key, column.dataType === 'json' && value !== null ? JSON.parse(String(value)) : value]
    })) as unknown as PlatformStoredRelation
    return { relation, observationId, sourceRdjb, originalUscc, originalName }
  })
}
