import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { ArchiveField, ArchiveOwner } from './immutable-archive'

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
const references = {
  collection: 'platform_collection_archive_ref',
  observation: 'platform_observation_archive_ref',
  version: 'platform_version_archive_ref',
} as const

export async function writePostgresArchiveValue(tx: Tx, text: string | Buffer | null, createdAt: string | null) {
  const bytes = text === null ? null : Buffer.from(text)
  const storageClass = text === null ? 'null' : Buffer.isBuffer(text) ? 'blob' : 'text'
  const sha256 = bytes === null ? null : createHash('sha256').update(bytes).digest('hex')
  const { rows: [row] } = await tx.execute<{ id: number }>(sql`
    INSERT INTO platform_archive_value(storage_class,bytes,byte_length,sha256,created_at)
    VALUES(${storageClass},${bytes},${bytes?.length ?? null},${sha256},${createdAt})
    RETURNING id::float8 AS id`)
  return { id: row!.id, sha256 }
}

export async function bindPostgresArchive(tx: Tx, field: ArchiveField, archiveId: number) {
  await tx.execute(sql`INSERT INTO ${sql.identifier(references[field.kind])}(owner_id,field,archive_id)
    VALUES(${field.ownerId},${field.field},${archiveId})`)
}

export async function sealPostgresArchive(tx: Tx, owner: ArchiveOwner) {
  await tx.execute(sql`UPDATE ${sql.identifier(references[owner.kind])} SET sealed=1 WHERE owner_id=${owner.ownerId}`)
}

export async function allocatePostgresPlatformAlias(tx: Tx, namespace: 'query' | 'relation', owner: number) {
  const table = sql.identifier(namespace === 'query' ? 'platform_legacy_query_alias' : 'platform_legacy_relation_alias')
  const column = sql.identifier(namespace === 'query' ? 'collection_id' : 'observation_id')
  const { rows: [row] } = await tx.execute<{ id: number }>(sql`
    WITH next_alias AS (
      UPDATE platform_legacy_alias_sequence SET high_water=greatest(high_water,(SELECT coalesce(max(old_id),0) FROM ${table}))+1
      WHERE namespace=${namespace} RETURNING high_water
    )
    INSERT INTO ${table}(old_id,${column}) SELECT high_water,${owner} FROM next_alias RETURNING old_id::float8 AS id`)
  if (!row) throw new Error('Platform legacy alias sequence is missing')
  return row.id
}
