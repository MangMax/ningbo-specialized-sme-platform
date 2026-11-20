import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from '../../../../db/schema'
import type { PlatformStoredQuery, PlatformStoredRelation } from '../../lib/platform/read'
import { sourceRelationFields } from '../../lib/platform/source-snapshot-fields'
import { snapshotSchema } from '../../lib/platform/target-evidence-read'
import { postgresRosterRow } from '../../lib/roster/postgres-rows'

type Db = Pick<NodePgDatabase, 'execute'>
type Cell = ReturnType<typeof snapshotSchema.parse>['fields'][number]

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

export async function readPostgresFingerprintQueries(db: Db, ids: readonly number[]) {
  if (!ids.length) return new Map<number, { query: PlatformStoredQuery; collection: typeof schema.platformCollection.$inferSelect }>()
  const { rows } = await db.execute<{
    id: number; collection: typeof schema.platformCollection.$inferSelect
    raw: Buffer | null
    coverage: Buffer | null
  }>(sql`
    SELECT q.old_id::float8 AS id, ${postgresRosterRow(schema.platformCollection, 'c')} AS collection,
      (SELECT v.bytes FROM platform_collection_archive_ref r JOIN platform_archive_value v ON v.id=r.archive_id
        WHERE r.owner_id=c.id AND r.field='rawResponse') AS raw,
      (SELECT v.bytes FROM platform_collection_archive_ref r JOIN platform_archive_value v ON v.id=r.archive_id
        WHERE r.owner_id=c.id AND r.field='collectionEvidence') AS coverage
    FROM platform_legacy_query_alias q JOIN platform_collection c ON c.id=q.collection_id
    WHERE q.old_id=ANY(${sql.param(ids)}::bigint[])`)
  return new Map(rows.map(row => {
    const c = row.collection
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

export async function readPostgresRelationFingerprints(db: Db, scope: { queryId: number } | { relationIds: readonly number[] }) {
  const where = 'queryId' in scope ? sql`q.old_id=${scope.queryId}` : sql`ra.old_id=ANY(${sql.param(scope.relationIds)}::bigint[])`
  const { rows } = await db.execute<{
    id: number; enterpriseId: number | null; queryId: number; observationId: number; sourceRdjb: string | null; originalUscc: string | null
    matchBasis: PlatformStoredRelation['matchBasis']; verificationStatus: PlatformStoredRelation['verificationStatus']
    snapshot: Buffer | null
  }>(sql`
    SELECT ra.old_id::float8 AS id, q.old_id::float8 AS "queryId", o.id::float8 AS "observationId",
      a.enterprise_id::float8 AS "enterpriseId", first.uscc_raw AS "originalUscc", page.rdjb AS "sourceRdjb",
      a.match_basis AS "matchBasis", a.verification_status AS "verificationStatus", v.bytes AS snapshot
    FROM platform_legacy_query_alias q
    JOIN platform_business_observation o ON o.collection_id=q.collection_id
    JOIN platform_legacy_relation_alias ra ON ra.observation_id=o.id
    JOIN LATERAL (
      SELECT enterprise_id,match_basis,verification_status FROM platform_observation_assignment
      WHERE observation_id=o.id ORDER BY revision DESC LIMIT 1
    ) a ON true
    JOIN platform_observation_assignment first ON first.observation_id=o.id AND first.revision=1
    LEFT JOIN LATERAL (
      SELECT rdjb FROM platform_collection_page WHERE collection_id=o.collection_id AND status='success'
        AND o.sequence_no BETWEEN sequence_start AND sequence_end ORDER BY ordinal LIMIT 1
    ) page ON true
    LEFT JOIN platform_observation_archive_ref r ON r.owner_id=o.id AND r.field='legacyRowSnapshot'
    LEFT JOIN platform_archive_value v ON v.id=r.archive_id
    WHERE ${where}
    ORDER BY ra.old_id`)
  return rows.map(({ id, enterpriseId, matchBasis, verificationStatus, snapshot, queryId, observationId, sourceRdjb, originalUscc }) => {
    if (!snapshot) throw new Error('Missing original correspondence fingerprint snapshot')
    const cells = new Map(snapshotSchema.parse(JSON.parse(snapshot.toString('utf8'))).fields.map(cell => [cell.name, cell]))
    const latest = { id, queryId, enterpriseId, matchBasis, verificationStatus }
    const relation = Object.fromEntries(Object.entries(sourceRelationFields).map(([key, column]) => {
      if (Object.hasOwn(latest, key)) return [key, latest[key as keyof typeof latest]]
      const cell = cells.get(column.name)
      if (!cell) throw new Error('Missing fingerprint cell ' + column.name)
      const value = originalValue(cell)
      return [key, column.dataType === 'json' && value !== null ? JSON.parse(String(value)) : value]
    })) as unknown as PlatformStoredRelation
    return { relation, observationId, sourceRdjb, originalUscc }
  })
}
