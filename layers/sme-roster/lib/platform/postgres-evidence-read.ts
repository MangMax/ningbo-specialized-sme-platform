import { and, asc, count, desc, eq, exists, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { createError } from 'h3'
import {
  platformArchiveValue as valueArchive,
  platformCollectionArchiveRef as collectionRef,
  platformCollectionLegacyProvenance as legacy,
  platformObservationArchiveRef as observationRef,
} from '../../../../db/postgresql/platform-archive-tables'
import {
  platformBusinessObservation as observation,
  platformCollection as queryCollection,
  platformLegacyQueryAlias as queryAlias,
  platformLegacyRelationAlias as relationAlias,
  platformObservationAssignment as assignment,
} from '../../../../db/postgresql/platform-tables'
import { MAX_EVIDENCE_CHUNK_BYTES, PROVENANCE_CELL_NAMES, type PlatformEvidenceInput, type PlatformEvidenceResult } from './evidence-contract'
import { platformEvidenceInputSchema } from './evidence-read'
import { relationEvidenceColumns } from './relation-evidence-snapshot'
import { snapshotSchema } from './target-evidence-read'

type Reader = Pick<NodePgDatabase, 'select'>
export type PostgresPlatformArchive = { id: string; byteLength: string | null; storageClass: string; sealed: boolean }
type Archive = PostgresPlatformArchive
type Cell = ReturnType<typeof snapshotSchema.parse>['fields'][number]
const empty = Buffer.alloc(0)
const envelopeHeader = Buffer.from('T04-PROVENANCE\n')

export async function readPlatformArchiveBytes(db: Reader, archiveId: string, offset: number, length: number): Promise<Buffer> {
  if (length === 0) return empty
  // Drizzle 0.45 has no bytea substring expression. Read only the requested bytes.
  const [archive] = await db.select({
    bytes: sql<Buffer>`substring(${valueArchive.bytes} FROM ${offset + 1} FOR ${length})`,
  }).from(valueArchive).where(eq(valueArchive.id, BigInt(archiveId)))
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
  const bytes = await readPlatformArchiveBytes(db, archive.id, start + offset, length)
  return byteResult(input, offset, size, bytes)
}

export async function legacyEnvelopeCollection(db: Reader, archive: Archive, queryId: number) {
  const archiveSize = Number(archive.byteLength)
  const prefix = await readPlatformArchiveBytes(db, archive.id, 0, envelopeHeader.length)
  if (!prefix.equals(envelopeHeader)) throw new Error('Invalid original provenance envelope')
  let cursor = prefix.length
  let collection: { start: number; size: number | null } | undefined
  for (const field of PROVENANCE_CELL_NAMES) {
    const header = await readPlatformArchiveBytes(db, archive.id, cursor, 128)
    const match = /^(\w+) (null|text|blob|integer|real) (\d+)\n/.exec(header.toString('utf8'))
    if (!match || match[1] !== field) throw new Error('Invalid original provenance cell')
    const bytes = Number(match[3])
    const start = cursor + Buffer.byteLength(match[0])
    const tail = start + bytes
    if (!Number.isSafeInteger(bytes) || tail >= archiveSize || (match[2] === 'null' && bytes !== 0)
      || (await readPlatformArchiveBytes(db, archive.id, tail, 1))[0] !== 10) throw new Error('Truncated original provenance cell')
    if (field === 'query_id') {
      if (match[2] !== 'integer' || bytes > 16 || (await readPlatformArchiveBytes(db, archive.id, start, bytes)).toString() !== String(queryId))
        throw new Error('Original provenance query alias conflict')
    }
    if (field === 'collection') collection = { start, size: match[2] === 'null' ? null : bytes }
    cursor = tail + 1
  }
  if (cursor !== archiveSize) throw new Error('Trailing original provenance cells')
  return collection!
}

async function readLegacyEvidence(db: Reader, collectionId: number, provenanceState: string, input: PlatformEvidenceInput) {
  const sealedRef = db.select({ ownerId: collectionRef.ownerId }).from(collectionRef).where(and(
    eq(collectionRef.ownerId, legacy.collectionId),
    eq(collectionRef.field, 'legacyProvenance'),
    eq(collectionRef.archiveId, valueArchive.id),
    eq(collectionRef.sealed, 1),
  ))
  const [row] = await db.select({
    id: valueArchive.id,
    byteLength: valueArchive.byteLength,
    storageClass: valueArchive.storageClass,
    origin: legacy.origin,
    sealed: exists(sealedRef).mapWith(Boolean),
  }).from(legacy).innerJoin(valueArchive, eq(valueArchive.id, legacy.archiveId)).where(eq(legacy.collectionId, collectionId))
  const archive = row && { ...row, id: String(row.id), byteLength: row.byteLength === null ? null : String(row.byteLength) }
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

async function readRelation(db: Reader, collectionId: number, input: PlatformEvidenceInput) {
  const owner = db.select({
    enterpriseId: assignment.enterpriseId,
    matchBasis: assignment.matchBasis,
    verificationStatus: assignment.verificationStatus,
  }).from(assignment).where(eq(assignment.observationId, observation.id)).orderBy(desc(assignment.revision)).limit(1).as('owner')
  const [row] = await db.select({
    bytes: valueArchive.bytes,
    sealed: observationRef.sealed,
    enterpriseId: owner.enterpriseId,
    matchBasis: owner.matchBasis,
    verificationStatus: owner.verificationStatus,
  }).from(relationAlias).innerJoin(observation, eq(observation.id, relationAlias.observationId))
    .leftJoin(observationRef, and(eq(observationRef.ownerId, observation.id), eq(observationRef.field, 'legacyRowSnapshot')))
    .leftJoin(valueArchive, eq(valueArchive.id, observationRef.archiveId))
    .leftJoinLateral(owner, eq(observation.id, observation.id))
    .where(and(eq(relationAlias.oldId, input.relationId!), eq(observation.collectionId, collectionId)))
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Platform evidence not found' })
  if (!row.bytes || row.sealed !== 1) throw new Error('Missing sealed original relation snapshot')
  if (row.matchBasis === null || row.verificationStatus === null) throw new Error('Missing observation assignment')
  const cells = new Map(snapshotSchema.parse(JSON.parse(row.bytes.toString('utf8'))).fields.map(cell => [cell.name, cell]))
  const overrides: Readonly<Record<string, string>> = {
    id: String(input.relationId), queryId: String(input.queryId), enterpriseId: row.enterpriseId === null ? 'null' : String(row.enterpriseId),
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
    const [collection] = await tx.select({ id: queryCollection.id, provenanceState: queryCollection.provenanceState }).from(queryAlias)
      .innerJoin(queryCollection, eq(queryCollection.id, queryAlias.collectionId)).where(eq(queryAlias.oldId, input.queryId))
    if (!collection) throw createError({ statusCode: 404, statusMessage: 'Platform evidence not found' })
    if (input.field === 'relations') {
      const page = input.page ?? 1
      const pageSize = input.pageSize ?? 100
      const offset = (BigInt(page) - BigInt(1)) * BigInt(pageSize)
      const [total] = await tx.select({ count: count() }).from(observation).where(eq(observation.collectionId, collection.id))
      const rows = offset >= BigInt(total!.count) ? [] : await tx.select({
        id: relationAlias.oldId,
        sequenceNo: observation.sequenceNo,
      }).from(observation).leftJoin(relationAlias, eq(relationAlias.observationId, observation.id))
        .where(eq(observation.collectionId, collection.id)).orderBy(asc(observation.sequenceNo)).limit(pageSize).offset(Number(offset))
      return {
        queryId: input.queryId, field: input.field, total: total!.count, page, pageSize,
        rows: rows.map(row => {
          if (row.id === null) throw new Error('Missing observation alias')
          return { id: row.id, sequenceNo: row.sequenceNo }
        }),
      }
    }
    if (input.field === 'relation') return readRelation(tx, collection.id, input)
    if (input.field === 'legacyProvenance') return readLegacyEvidence(tx, collection.id, collection.provenanceState, input)
    const [archive] = await tx.select({
      id: valueArchive.id,
      byteLength: valueArchive.byteLength,
      storageClass: valueArchive.storageClass,
      sealed: collectionRef.sealed,
    }).from(collectionRef).innerJoin(valueArchive, eq(valueArchive.id, collectionRef.archiveId))
      .where(and(eq(collectionRef.ownerId, collection.id), eq(collectionRef.field, input.field)))
    if (archive?.sealed !== 1) throw new Error('Missing sealed collection archive')
    return archiveResult(tx, {
      ...archive, id: String(archive.id), byteLength: archive.byteLength === null ? null : String(archive.byteLength), sealed: true,
    }, input)
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}
