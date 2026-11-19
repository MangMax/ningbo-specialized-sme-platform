import { and,asc,count,eq,inArray,or,sql,type SQLWrapper } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../../db/schema'
import { normalizeUscc } from '../../lib/domain'
import { readCandidateTargetQueries,targetCandidateTables,targetCandidateTitle } from './candidate-target-sources'
import type { ReceiptRedactor } from './import-receipt-redaction'
import { CorrespondenceError } from './record-correspondence'
import { generateCandidates } from './record-correspondence-candidates'
import { eventSource,safeCollectionEvidence } from './record-correspondence-read'

export const EVENT_ARCHIVE_RULE_VERSION = 'event-archive-212-v1'
export interface EventArchiveInput { eventId: number; page: number; pageSize: number; queryPage: number; queryPageSize: number }
type Db = BetterSQLite3Database<typeof schema>
const offset = (page: number, size: number) => Math.min(Number.MAX_SAFE_INTEGER, (page - 1) * size)
/** Same whitespace set as domain.normalizeUscc, evaluated before the bounded select. */
export function normalizedUscc(column: SQLWrapper) {
  let value = sql`upper(coalesce(${column}, ''))`
  for (const character of '\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u200b\u200c\u200d\u2028\u2029\u202f\u205f\u3000\ufeff') value = sql`replace(${value}, ${character}, '')`
  return value
}
/** Row title follows the original successful page partition, never the latest state. */

/** Single-event read-only seam for REST, MCP and jobs. No network, persistence or automatic decisions.
 * Candidate and archive metadata pages are independent; only bounded selected relations are hydrated.
 */
export function discoverEventArchives(db: Db, input: EventArchiveInput, redactor?: ReceiptRedactor) {
  if (![input.eventId, input.page, input.pageSize, input.queryPage, input.queryPageSize].every(value => Number.isSafeInteger(value) && value > 0) || input.pageSize > 200 || input.queryPageSize > 200) throw new CorrespondenceError('invalid_endpoint_type', 'Invalid discovery pagination')
  return db.transaction(() => discoverSnapshot(db, input, redactor))
}
function discoverSnapshot(db: Db, input: EventArchiveInput, redactor?: ReceiptRedactor) {
  const event = db.select({ event: schema.recordEvent, record: schema.record, enterprise: schema.enterprise }).from(schema.recordEvent)
    .innerJoin(schema.record, eq(schema.recordEvent.recordId, schema.record.id)).innerJoin(schema.enterprise, eq(schema.record.enterpriseId, schema.enterprise.id))
    .where(eq(schema.recordEvent.id, input.eventId)).get()
  if (!event || event.record.source !== 'jxj' || !['award', 'review'].includes(event.event.eventType)) return null
  const owner = event.enterprise.id, identity = normalizeUscc(event.record.usccRaw ?? event.enterprise.usccNorm)

  const { q, r } = targetCandidateTables(db)
  const title = targetCandidateTitle(db)
  // Explicit verified owner supports aliases without inventing identity from a name.
  const rowIdentity = and(or(eq(r.enterpriseId, owner), sql`${r.enterpriseId} is null`),
    or(identity ? sql`${normalizedUscc(r.usccRaw)} = ${identity}` : undefined,
      and(eq(r.enterpriseId, owner), eq(r.verificationStatus, 'confirmed'), sql`${normalizedUscc(r.usccRaw)} = ''`)))!
  // Resolve the same related set through indexed keys/owners once per statement,
  // rather than testing correlated EXISTS for every archived query. UNION deduplicates
  // queries reached through multiple identities; IDs stay in SQLite, not in a JS array.
  const alias = schema.enterpriseAlias
  const relatedQueries = db.select({ id: q.id }).from(q)
    .where(inArray(q.queryKey, [...(identity ? [identity] : []), `name:${event.enterprise.nameNorm}`]))
    .union(db.select({ id: q.id }).from(q).where(inArray(q.queryKey,
      db.select({ key: sql<string>`'name:' || ${alias.nameNorm}` }).from(alias)
        .where(and(eq(alias.enterpriseId, owner), eq(alias.verificationStatus, 'confirmed'))))))
    .union(db.select({ id: r.queryId }).from(r).where(rowIdentity))
  const related = inArray(q.id, relatedQueries)
  const eligible = and(related, rowIdentity, inArray(q.status, ['success', 'partial']), eq(title, event.record.titleCode))!
  const total = db.select({ n: count() }).from(r).innerJoin(q, eq(sql<number>`${r.queryId}`, q.id)).where(eligible).get()!.n
  const selected = db.select({ id: r.id, queryId: r.queryId }).from(r).innerJoin(q, eq(sql<number>`${r.queryId}`, q.id)).where(eligible)
    .orderBy(asc(q.id), asc(r.sequenceNo), asc(sql<number>`${r.id}`)).limit(input.pageSize).offset(offset(input.page, input.pageSize)).all()
  const generated = generateCandidates(db, { eventId: input.eventId, queryIds: [...new Set(selected.map(row => row.queryId))], exportBatchIds: [], ruleVersion: EVENT_ARCHIVE_RULE_VERSION, page: 1, pageSize: input.pageSize }, { relationIds: selected.map(row => row.id), total })!
  const queryTotal = db.select({ n: count() }).from(q).where(related).get()!.n
  const selectedCoverage = db.select({ id: q.id,
    relationCount: sql<number>`(${db.select({ n: count() }).from(r).where(eq(sql<number>`${r.queryId}`, q.id))})`,
    candidateCount: sql<number>`(${db.select({ n: count() }).from(r).where(and(eq(sql<number>`${r.queryId}`, q.id), rowIdentity, eq(title, event.record.titleCode), inArray(q.status, ['success', 'partial'])))})`,
  }).from(q).where(related).orderBy(asc(q.id)).limit(input.queryPageSize).offset(offset(input.queryPage, input.queryPageSize)).all()
  const metadata = new Map(readCandidateTargetQueries(db, selectedCoverage.map(q => q.id)).map(q => [q.id, q]))
  const coverage = selectedCoverage.map(row => ({ ...metadata.get(row.id)!, ...row }))
  // Aggregate only small status counts; never hydrate all query metadata or archive bodies.
  const states = db.select({ interface: q.interface, status: q.status, count: count() }).from(q).where(related).groupBy(q.interface, q.status).all()
  return { event: eventSource(db, input.eventId, redactor), ruleVersion: EVENT_ARCHIVE_RULE_VERSION,
    rows: generated.rows, total, page: input.page, pageSize: input.pageSize,
    coverage: { rows: coverage.map(({ collectionEvidence, ...row }) => ({ ...row, outcome: row.status !== 'success' ? row.status : row.candidateCount > 0 ? 'candidates' : row.relationCount > 0 ? 'no_candidate' : 'empty_unproven', collectionEvidence: safeCollectionEvidence(collectionEvidence) })), total: queryTotal, page: input.queryPage, pageSize: input.queryPageSize },
    interfaces: (['business_list', 'apply_list', 'recognized_list'] as const).map(source => ({ interface: source, states: states.filter(row => row.interface === source).map(({ status, count }) => ({ status, count })), queried: states.some(row => row.interface === source && row.status !== 'not_queried') })),
  }
}
