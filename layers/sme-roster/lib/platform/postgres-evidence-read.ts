import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { createError } from 'h3'
import { MAX_EVIDENCE_CHUNK_BYTES, PROVENANCE_CELL_NAMES, type PlatformEvidenceInput, type PlatformEvidenceResult } from './evidence-contract'
import { platformEvidenceInputSchema } from './evidence-read'
import { relationEvidenceColumns } from './relation-evidence-snapshot'
import { snapshotSchema } from './target-evidence-read'

type Reader = Pick<NodePgDatabase, 'execute'>
type Archive = { id: string; byteLength: string | null; storageClass: string; sealed: boolean }
type Cell = ReturnType<typeof snapshotSchema.parse>['fields'][number]
const empty = Buffer.alloc(0)
const envelopeHeader = Buffer.from('T04-PROVENANCE\n')

async function archiveBytes(db: Reader, archiveId: string, offset: number, length: number): Promise<Buffer> {
  if (length === 0) return empty
  const { rows: [archive] } = await db.execute<{ bytes: Buffer }>(sql`
    SELECT substring(bytes FROM ${offset + 1} FOR ${length}) AS bytes FROM platform_archive_value WHERE id = ${archiveId}`)
  return archive!.bytes
}

function byteResult(input: PlatformEvidenceInput, offset: number, total: number | null, bytes: Buffer): PlatformEvidenceResult {
  return {
    queryId: input.queryId, field: input.field,
    ...(input.field === 'relation' ? { relationId: input.relationId } : {}),
    encoding: 'base64', offset, byteLength: bytes.length, totalBytes: total ?? 0, isNull: total === null,
    hasMore: total !== null && offset + bytes.length < total, data: bytes.toString('base64'),
  }
}

async function archiveResult(db: Reader, archive: Archive, input: PlatformEvidenceInput, start = 0, size = archive.byteLength === null ? null : Number(archive.byteLength)) {
  const offset = input.offset ?? 0
  const length = size === null ? 0 : Math.min(input.length ?? MAX_EVIDENCE_CHUNK_BYTES, Math.max(size - offset, 0))
  const bytes = await archiveBytes(db, archive.id, start + offset, length)
  return byteResult(input, offset, size, bytes)
}

async function legacyEnvelopeCollection(db: Reader, archive: Archive, queryId: number) {
  const archiveSize = Number(archive.byteLength)
  const prefix = await archiveBytes(db, archive.id, 0, envelopeHeader.length)
  if (!prefix.equals(envelopeHeader)) throw new Error('Invalid original provenance envelope')
  let cursor = prefix.length
  let collection: { start: number; size: number | null } | undefined
  for (const field of PROVENANCE_CELL_NAMES) {
    const header = await archiveBytes(db, archive.id, cursor, 128)
    const match = /^(\w+) (null|text|blob|integer|real) (\d+)\n/.exec(header.toString('utf8'))
    if (!match || match[1] !== field) throw new Error('Invalid original provenance cell')
    const bytes = Number(match[3])
    const start = cursor + Buffer.byteLength(match[0])
    const tail = start + bytes
    if (!Number.isSafeInteger(bytes) || tail >= archiveSize || (match[2] === 'null' && bytes !== 0)
      || (await archiveBytes(db, archive.id, tail, 1))[0] !== 10) throw new Error('Truncated original provenance cell')
    if (field === 'query_id') {
      if (match[2] !== 'integer' || bytes > 16 || (await archiveBytes(db, archive.id, start, bytes)).toString() !== String(queryId))
        throw new Error('Original provenance query alias conflict')
    }
    if (field === 'collection') collection = { start, size: match[2] === 'null' ? null : bytes }
    cursor = tail + 1
  }
  if (cursor !== archiveSize) throw new Error('Trailing original provenance cells')
  return collection!
}

async function readLegacyEvidence(db: Reader, collectionId: string, provenanceState: string, input: PlatformEvidenceInput) {
  const { rows: [archive] } = await db.execute<Archive & { origin: 't04_envelope' | 'supplement' }>(sql`
    SELECT a.id, a.byte_length AS "byteLength", a.storage_class AS "storageClass", p.origin,
      EXISTS (SELECT 1 FROM platform_collection_archive_ref r WHERE r.owner_id = p.collection_id
        AND r.field = 'legacyProvenance' AND r.archive_id = a.id AND r.sealed = 1) AS sealed
    FROM platform_collection_legacy_provenance p
    JOIN platform_archive_value a ON a.id = p.archive_id WHERE p.collection_id = ${collectionId}`)
  if (!archive) {
    if (provenanceState === 'legacy_supplement' || provenanceState === 'conflict') throw new Error('Missing original legacy provenance')
    return byteResult(input, input.offset ?? 0, null, empty)
  }
  if (archive.origin === 'supplement') {
    if (archive.storageClass !== 'text') throw new Error('Invalid original supplement storage')
    return archiveResult(db, archive, input)
  }
  if (!archive.sealed || archive.storageClass !== 'blob') throw new Error('Missing sealed provenance envelope')
  const collection = await legacyEnvelopeCollection(db, archive, input.queryId)
  return archiveResult(db, archive, input, collection.start, collection.size)
}

function cellJson(cell: Cell, key: string) {
  const bytes = Buffer.from(cell.hex, 'hex')
  if (cell.storageClass === 'null') return 'null'
  if (cell.storageClass === 'integer') return BigInt(bytes.toString('utf8')).toString()
  if (cell.storageClass === 'real') {
    if (!cell.real64be) throw new Error('Missing original REAL bits')
    const number = Buffer.from(cell.real64be, 'hex').readDoubleBE()
    return Number.isFinite(number) ? JSON.stringify(number) : number < 0 ? '-9e999' : '9e999'
  }
  const text = bytes.toString('utf8')
  if (key === 'rawFields') {
    JSON.parse(text)
    return text
  }
  if (cell.storageClass === 'blob') throw new Error('JSON cannot hold BLOB values')
  return JSON.stringify(text)
}

async function readRelation(db: Reader, collectionId: string, input: PlatformEvidenceInput) {
  const { rows: [row] } = await db.execute<{
    bytes: Buffer | null; sealed: string | null; enterpriseId: string | null
    matchBasis: string | null; verificationStatus: string | null
  }>(sql`
    SELECT a.bytes, ref.sealed, owner.enterprise_id AS "enterpriseId", owner.match_basis AS "matchBasis",
      owner.verification_status AS "verificationStatus"
    FROM platform_legacy_relation_alias r
    JOIN platform_business_observation o ON o.id = r.observation_id
    LEFT JOIN platform_observation_archive_ref ref ON ref.owner_id = o.id AND ref.field = 'legacyRowSnapshot'
    LEFT JOIN platform_archive_value a ON a.id = ref.archive_id
    LEFT JOIN LATERAL (SELECT enterprise_id, match_basis, verification_status
      FROM platform_observation_assignment a WHERE a.observation_id = o.id ORDER BY revision DESC LIMIT 1) owner ON true
    WHERE r.old_id = ${input.relationId} AND o.collection_id = ${collectionId}`)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Platform evidence not found' })
  if (!row.bytes || row.sealed !== '1') throw new Error('Missing sealed original relation snapshot')
  if (row.matchBasis === null || row.verificationStatus === null) throw new Error('Missing observation assignment')
  const cells = new Map(snapshotSchema.parse(JSON.parse(row.bytes.toString('utf8'))).fields.map(cell => [cell.name, cell]))
  const overrides: Readonly<Record<string, string>> = {
    id: String(input.relationId), queryId: String(input.queryId), enterpriseId: row.enterpriseId ?? 'null',
    matchBasis: JSON.stringify(row.matchBasis), verificationStatus: JSON.stringify(row.verificationStatus),
  }
  const fields = relationEvidenceColumns.map(([key, name]) => {
    const override = overrides[key]
    if (override !== undefined) return `"${key}":${override}`
    const cell = cells.get(name)
    if (!cell) throw new Error(`Missing original relation cell: ${name}`)
    return `"${key}":${cellJson(cell, key)}`
  })
  const bytes = Buffer.from('{' + fields.join(',') + '}')
  const offset = input.offset ?? 0
  const length = input.length ?? MAX_EVIDENCE_CHUNK_BYTES
  return byteResult(input, offset, bytes.length, bytes.subarray(offset, offset + length))
}

export function readPostgresPlatformEvidence(db: NodePgDatabase, value: PlatformEvidenceInput): Promise<PlatformEvidenceResult> {
  const parsed = platformEvidenceInputSchema.safeParse(value)
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Invalid platform evidence parameters' })
  const input = parsed.data
  return db.transaction(async tx => {
    const { rows: [collection] } = await tx.execute<{ id: string; provenanceState: string }>(sql`
      SELECT c.id, c.provenance_state AS "provenanceState" FROM platform_legacy_query_alias q
      JOIN platform_collection c ON c.id = q.collection_id WHERE q.old_id = ${input.queryId}`)
    if (!collection) throw createError({ statusCode: 404, statusMessage: 'Platform evidence not found' })
    if (input.field === 'relations') {
      const page = input.page ?? 1
      const pageSize = input.pageSize ?? 100
      const offset = (BigInt(page) - 1n) * BigInt(pageSize)
      const { rows: [count] } = await tx.execute<{ total: string }>(sql`
        SELECT count(*) AS total FROM platform_business_observation WHERE collection_id = ${collection.id}`)
      const rows = offset >= BigInt(count!.total) ? [] : (await tx.execute<{ id: string | null; sequenceNo: string }>(sql`
        SELECT r.old_id AS id, o.sequence_no AS "sequenceNo" FROM platform_business_observation o
        LEFT JOIN platform_legacy_relation_alias r ON r.observation_id = o.id WHERE o.collection_id = ${collection.id}
        ORDER BY o.sequence_no LIMIT ${pageSize} OFFSET ${String(offset)}`)).rows
      return {
        queryId: input.queryId, field: input.field, total: Number(count!.total), page, pageSize,
        rows: rows.map(row => {
          if (row.id === null) throw new Error('Missing observation alias')
          return { id: Number(row.id), sequenceNo: Number(row.sequenceNo) }
        }),
      }
    }
    if (input.field === 'relation') return readRelation(tx, collection.id, input)
    if (input.field === 'legacyProvenance') return readLegacyEvidence(tx, collection.id, collection.provenanceState, input)
    const { rows: [archive] } = await tx.execute<Archive>(sql`
      SELECT a.id, a.byte_length AS "byteLength", a.storage_class AS "storageClass", r.sealed = 1 AS sealed
      FROM platform_collection_archive_ref r JOIN platform_archive_value a ON a.id = r.archive_id
      WHERE r.owner_id = ${collection.id} AND r.field = ${input.field}`)
    if (!archive?.sealed) throw new Error('Missing sealed collection archive')
    return archiveResult(tx, archive, input)
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}
