/** Bounded, byte-exact archive access. No JSON archive is decoded just to return a slice. */
import { eq, getTableColumns, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { readTargetPlatformEvidence } from './target-evidence-read'
import { queryHistoryTarget } from './query-history-target'
import { MAX_EVIDENCE_CHUNK_BYTES, type PlatformEvidenceInput, type PlatformEvidenceResult } from './evidence-contract'
export { MAX_EVIDENCE_CHUNK_BYTES, type PlatformEvidenceInput } from './evidence-contract'

type Db = BetterSQLite3Database<typeof schema>
export const platformEvidenceInputSchema = z.object({
  queryId: z.number().int().positive(), field: z.enum(['rawResponse', 'collectionEvidence', 'legacyProvenance', 'relations', 'relation']),
  relationId: z.number().int().positive().optional(), offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - MAX_EVIDENCE_CHUNK_BYTES).optional(),
  length: z.number().int().min(1).max(MAX_EVIDENCE_CHUNK_BYTES).optional(), page: z.number().int().positive().optional(), pageSize: z.number().int().min(1).max(200).optional(),
}).strict().refine(input => input.field !== 'relation' || input.relationId != null)
function invalid(): never { throw Object.assign(new Error('Invalid platform evidence parameters'), { statusCode: 400, statusMessage: 'Invalid platform evidence parameters' }) }
function integer(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = value ?? fallback
  if (!Number.isSafeInteger(n) || n < min || n > max) invalid()
  return n
}
function missing(): never { throw Object.assign(new Error('Platform evidence not found'), { statusCode: 404, statusMessage: 'Platform evidence not found' }) }
export function readPlatformQueryEvidence(db: Db, input: PlatformEvidenceInput): PlatformEvidenceResult {
  if (queryHistoryTarget(db)) return readTargetPlatformEvidence(db, input)
  return db.transaction(tx => readEvidenceSnapshot(tx, input))
}
function readEvidenceSnapshot(db: Pick<Db, 'select'>, input: PlatformEvidenceInput) {
  const queryId = integer(input.queryId, 0, 1, Number.MAX_SAFE_INTEGER)
  const offset = integer(input.offset, 0, 0, Number.MAX_SAFE_INTEGER - MAX_EVIDENCE_CHUNK_BYTES)
  const length = integer(input.length, MAX_EVIDENCE_CHUNK_BYTES, 1, MAX_EVIDENCE_CHUNK_BYTES)
  const page = integer(input.page, 1, 1, Number.MAX_SAFE_INTEGER)
  const pageSize = integer(input.pageSize, 100, 1, 200)
  if (!['rawResponse', 'collectionEvidence', 'legacyProvenance', 'relations', 'relation'].includes(input.field)) invalid()
  const q = schema.platformQuery
  if (input.field === 'relations') {
    if (!db.select({ id: q.id }).from(q).where(eq(q.id, queryId)).get()) missing()
    const r = schema.platformRelation
    const total = db.select({ n: sql<number>`count(*)` }).from(r).where(eq(r.queryId, queryId)).get()!.n
    const rows = db.select({ id: r.id, sequenceNo: r.sequenceNo }).from(r).where(eq(r.queryId, queryId)).orderBy(r.sequenceNo).limit(pageSize).offset(Math.min(Number.MAX_SAFE_INTEGER, (page - 1) * pageSize)).all()
    return { queryId, field: input.field, total, page, pageSize, rows }
  }
  // Explicit BLOB conversion makes offsets UTF-8 bytes, including slices inside multibyte codepoints.
  // Decode base64 chunks only after concatenating them; null and empty remain different.
  const expression = input.field === 'relation'
    ? sql`json_object(${sql.join(Object.entries(getTableColumns(schema.platformRelation)).flatMap(([name, column]) => [sql`${name}`, name === 'rawFields' ? sql`json(${column})` : sql`${column}`]), sql`, `)})`
    : input.field === 'legacyProvenance' ? sql`(select collection from platform_query_legacy_provenance where query_id = platform_query.id)`
      : input.field === 'rawResponse' ? sql`${q.rawResponse}` : sql`${q.collectionEvidence}`
  const projection = {
    data: sql<Buffer | null>`substr(cast(${expression} as blob), ${offset + 1}, ${length})`,
    totalBytes: sql<number | null>`length(cast(${expression} as blob))`,
  }
  let found
  if (input.field === 'relation') {
    const relationId = integer(input.relationId, 0, 1, Number.MAX_SAFE_INTEGER)
    const r = schema.platformRelation
    found = db.select(projection).from(r).where(sql`${r.id} = ${relationId} and ${r.queryId} = ${queryId}`).get()
  } else found = db.select(projection).from(q).where(eq(q.id, queryId)).get()
  if (!found) missing()
  const bytes = found.data ?? Buffer.alloc(0)
  return { queryId, field: input.field, ...(input.field === 'relation' ? { relationId: input.relationId } : {}), encoding: 'base64' as const, offset, byteLength: bytes.length, totalBytes: found.totalBytes ?? 0, isNull: found.totalBytes === null, hasMore: offset + bytes.length < (found.totalBytes ?? 0), data: bytes.toString('base64') }
}
