import { randomUUID } from 'node:crypto'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { importBatch } from '../../../db/postgresql/import-tables'
import { writePostgresCollectionHeader } from '../../../layers/sme-roster/lib/platform/postgres-collection-write'
import { writePostgresObservation } from '../../../layers/sme-roster/lib/platform/postgres-observation-write'
import type { RosterImportPlatformQuery } from '../../../layers/sme-roster/lib/roster-import-client'

/** Seed captured evidence and its original assignment in an isolated PostgreSQL fixture. */
export async function seedPostgresPlatformQuery(db: Pick<NodePgDatabase, 'transaction'>, query: RosterImportPlatformQuery) {
  const createdAt = query.queriedAt
  return db.transaction(async tx => {
    const [batch] = await tx.insert(importBatch).values({
      idempotencyKey: randomUUID(), sourceKind: 'platform_archive', sourceIdentity: 'synthetic-platform-query', status: 'committed', createdAt,
    }).returning({ id: importBatch.id })
    const assignments = (query.relations ?? []).map(row => ({
      enterpriseId: row.enterpriseId ?? null, nameRaw: row.nameRaw ?? null, usccRaw: row.usccRaw ?? null,
      aliasNameRaw: row.aliasNameRaw ?? null, matchBasis: row.matchBasis ?? 'none',
      verificationStatus: row.verificationStatus ?? 'pending', origin: 'command' as const,
      actor: { type: 'agent' as const, id: 'postgres-test-fixture' }, basis: 'Synthetic source assignment', recordedAt: createdAt,
    }))
    const collection = await writePostgresCollectionHeader(tx, {
      queryText: JSON.stringify(query), evidenceText: query.collectionEvidence ? JSON.stringify(query.collectionEvidence) : null,
      createdAt, assignments, batchId: batch!.id,
    })
    const observations: Awaited<ReturnType<typeof writePostgresObservation>>['projection'][] = []
    for (const [index, row] of (collection.query.relations ?? []).entries()) {
      const { projection } = await writePostgresObservation(tx, collection, row, assignments[index]!, batch!.id)
      observations.push(projection)
    }
    return { queryId: collection.queryId, relationIds: observations.map(row => row.relationId), observations }
  })
}
