import { and, asc, count, eq, getTableColumns, inArray, or, sql, type SQLWrapper } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { normalizeUscc } from '../../lib/domain'
import { generateCandidates } from './record-correspondence-candidates'
import { CorrespondenceError } from './record-correspondence'
import { eventSource, safeCollectionEvidence } from './record-correspondence-read'

export const EVENT_ARCHIVE_RULE_VERSION = 'event-archive-212-v1'
export interface EventArchiveInput { eventId: number; page: number; pageSize: number; queryPage: number; queryPageSize: number }
type Db = BetterSQLite3Database<typeof schema>
const offset = (page: number, size: number) => Math.min(Number.MAX_SAFE_INTEGER, (page - 1) * size)
/** Same whitespace set as domain.normalizeUscc, evaluated before the bounded select. */
function normalizedUscc(column: SQLWrapper) {
  let value = sql`upper(coalesce(${column}, ''))`
  for (const character of '\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u200b\u200c\u200d\u2028\u2029\u202f\u205f\u3000\ufeff') value = sql`replace(${value}, ${character}, '')`
  return value
}
/** Row title follows the original successful page partition, never the latest state. */
function relationTitle() {
  const q = schema.platformQuery, r = schema.platformRelation
  return sql<string>`case when ${q.interface} = 'recognized_list' then coalesce((
    select case rdjb when '1' then 'innovative_sme' when '2' then 'specialized_sme' when '3' then 'little_giant' end
    from (select json_extract(value, '$.rdjb') rdjb,
      sum(json_extract(value, '$.fetchedCount')) over (order by cast(key as integer)) last_sequence
      from json_each(${q.collectionEvidence}, '$.pages') where json_extract(value, '$.status') = 'success')
    where last_sequence >= ${r.sequenceNo} limit 1), ${q.titleCode})
    else coalesce(${q.titleCode}, case ${q.rdjb} when '1' then 'innovative_sme' when '2' then 'specialized_sme' when '3' then 'little_giant' end) end`
}
/** Single-event read-only seam for REST, MCP and jobs. No network, persistence or automatic decisions.
 * Candidate and archive metadata pages are independent; only bounded selected relations are hydrated.
 */
export function discoverEventArchives(db: Db, input: EventArchiveInput) {
  if (![input.eventId, input.page, input.pageSize, input.queryPage, input.queryPageSize].every(value => Number.isSafeInteger(value) && value > 0) || input.pageSize > 200 || input.queryPageSize > 200) throw new CorrespondenceError('invalid_endpoint_type', 'Invalid discovery pagination')
  return db.transaction(() => discoverSnapshot(db, input))
}
function discoverSnapshot(db: Db, input: EventArchiveInput) {
  const event = db.select({ event: schema.recordEvent, record: schema.record, enterprise: schema.enterprise }).from(schema.recordEvent)
    .innerJoin(schema.record, eq(schema.recordEvent.recordId, schema.record.id)).innerJoin(schema.enterprise, eq(schema.record.enterpriseId, schema.enterprise.id))
    .where(eq(schema.recordEvent.id, input.eventId)).get()
  if (!event || event.record.source !== 'jxj' || !['award', 'review'].includes(event.event.eventType)) return null
  const owner = event.enterprise.id, identity = normalizeUscc(event.record.usccRaw ?? event.enterprise.usccNorm)
  const q = schema.platformQuery, r = schema.platformRelation
  // Explicit verified owner supports aliases without inventing identity from a name.
  const rowIdentity = and(or(eq(r.enterpriseId, owner), sql`${r.enterpriseId} is null`),
    or(identity ? sql`${normalizedUscc(r.usccRaw)} = ${identity}` : undefined,
      and(eq(r.enterpriseId, owner), eq(r.verificationStatus, 'confirmed'), sql`${normalizedUscc(r.usccRaw)} = ''`)))!
  const related = or(identity ? eq(q.queryKey, identity) : undefined,
    eq(q.queryKey, `name:${event.enterprise.nameNorm}`),
    sql`exists (select 1 from ${schema.enterpriseAlias} a where a.enterprise_id = ${owner} and a.verification_status = 'confirmed' and ${q.queryKey} = 'name:' || a.name_norm)`,
    sql`exists (select 1 from ${r} where ${r.queryId} = ${q.id} and ${rowIdentity})`)!
  const eligible = and(related, rowIdentity, inArray(q.status, ['success', 'partial']), eq(relationTitle(), event.record.titleCode))!
  const total = db.select({ n: count() }).from(r).innerJoin(q, eq(r.queryId, q.id)).where(eligible).get()!.n
  const selected = db.select({ id: r.id, queryId: r.queryId }).from(r).innerJoin(q, eq(r.queryId, q.id)).where(eligible)
    .orderBy(asc(q.id), asc(r.sequenceNo), asc(r.id)).limit(input.pageSize).offset(offset(input.page, input.pageSize)).all()
  const generated = generateCandidates(db, { eventId: input.eventId, queryIds: [...new Set(selected.map(row => row.queryId))], exportBatchIds: [], ruleVersion: EVENT_ARCHIVE_RULE_VERSION, page: 1, pageSize: input.pageSize }, { relationIds: selected.map(row => row.id), total })!
  const { rawResponse: _raw, collectionEvidence, ...columns } = getTableColumns(q)
  const queryTotal = db.select({ n: count() }).from(q).where(related).get()!.n
  const coverage = db.select({ ...columns, collectionEvidence: sql`json_remove(${collectionEvidence}, '$.rows')`.mapWith(collectionEvidence),
    relationCount: sql<number>`(select count(*) from ${r} where platform_relation.query_id = platform_query.id)`,
    candidateCount: sql<number>`(select count(*) from ${r} where platform_relation.query_id = platform_query.id and ${rowIdentity} and ${relationTitle()} = ${event.record.titleCode} and platform_query.status in ('success', 'partial'))`,
  }).from(q).where(related).orderBy(asc(q.id)).limit(input.queryPageSize).offset(offset(input.queryPage, input.queryPageSize)).all()
  // Aggregate only small status counts; never hydrate all query metadata or archive bodies.
  const states = db.select({ interface: q.interface, status: q.status, count: count() }).from(q).where(related).groupBy(q.interface, q.status).all()
  return { event: eventSource(db, input.eventId), ruleVersion: EVENT_ARCHIVE_RULE_VERSION,
    rows: generated.rows, total, page: input.page, pageSize: input.pageSize,
    coverage: { rows: coverage.map(({ collectionEvidence, ...row }) => ({ ...row, outcome: row.status !== 'success' ? row.status : row.candidateCount > 0 ? 'candidates' : row.relationCount > 0 ? 'no_candidate' : 'empty_unproven', collectionEvidence: safeCollectionEvidence(collectionEvidence) })), total: queryTotal, page: input.queryPage, pageSize: input.queryPageSize },
    interfaces: (['business_list', 'apply_list', 'recognized_list'] as const).map(source => ({ interface: source, states: states.filter(row => row.interface === source).map(({ status, count }) => ({ status, count })), queried: states.some(row => row.interface === source && row.status !== 'not_queried') })),
  }
}
