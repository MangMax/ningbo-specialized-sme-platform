import { createHash } from 'node:crypto'
import { eq, max, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import {
  platformArchiveValue, platformCollectionArchiveRef, platformObservationArchiveRef, platformVersionArchiveRef,
} from '../../../../db/postgresql/platform-archive-tables'
import { platformLegacyAliasSequence, platformLegacyQueryAlias, platformLegacyRelationAlias } from '../../../../db/postgresql/platform-tables'
import type { ArchiveField, ArchiveOwner } from './immutable-archive'

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
const references = {
  collection: platformCollectionArchiveRef,
  observation: platformObservationArchiveRef,
  version: platformVersionArchiveRef,
} as const

export async function writePostgresArchiveValue(tx: Tx, text: string | Buffer | null, createdAt: string | null) {
  const bytes = text === null ? null : Buffer.from(text)
  const storageClass = text === null ? 'null' : Buffer.isBuffer(text) ? 'blob' : 'text'
  const sha256 = bytes === null ? null : createHash('sha256').update(bytes).digest('hex')
  const [row] = await tx.insert(platformArchiveValue).values({
    storageClass, bytes, byteLength: bytes?.length ?? null, sha256, createdAt,
  }).returning({ id: platformArchiveValue.id })
  return { id: Number(row!.id), sha256 }
}

export async function bindPostgresArchive(tx: Tx, field: ArchiveField, archiveId: number) {
  await tx.insert(references[field.kind]).values({ ownerId: field.ownerId, field: field.field, archiveId: BigInt(archiveId) })
}

export async function sealPostgresArchive(tx: Tx, owner: ArchiveOwner) {
  const table = references[owner.kind]
  await tx.update(table).set({ sealed: 1 }).where(eq(table.ownerId, owner.ownerId))
}

export async function allocatePostgresPlatformAlias(tx: Tx, namespace: 'query' | 'relation', owner: number) {
  const table = namespace === 'query' ? platformLegacyQueryAlias : platformLegacyRelationAlias
  const maxAlias = tx.select({ oldId: max(table.oldId) }).from(table)
  // Drizzle has no greatest/coalesce or numeric increment operators for column expressions.
  const [next] = await tx.update(platformLegacyAliasSequence)
    .set({ highWater: sql`greatest(${platformLegacyAliasSequence.highWater}, coalesce((${maxAlias}), 0)) + 1` })
    .where(eq(platformLegacyAliasSequence.namespace, namespace))
    .returning({ oldId: platformLegacyAliasSequence.highWater })
  if (!next) throw new Error('Platform legacy alias sequence is missing')
  if (namespace === 'query') await tx.insert(platformLegacyQueryAlias).values({ oldId: next.oldId, collectionId: owner })
  else await tx.insert(platformLegacyRelationAlias).values({ oldId: next.oldId, observationId: owner })
  return next.oldId
}
