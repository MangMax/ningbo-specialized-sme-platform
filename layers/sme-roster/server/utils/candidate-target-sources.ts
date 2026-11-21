import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
/** Candidate-specific structured selection. External query/relation IDs never stand for PKs. */
import { and,count,eq,inArray,max,or,sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { alias } from 'drizzle-orm/sqlite-core'
import * as s from '../../../../db/schema'
import type { PlatformFactInterface } from '../../lib/platform/observation-facts'
import { targetSchema as t } from '../../lib/platform/target-schema'
import { identityFunctions } from '../../lib/roster/enterprise-read-snapshot'
import { readTargetBusinessProcessFacts } from './platform-business-processes-target'
import { readTargetDeclarationFacts } from './platform-declarations-target'
import { readTargetRecognizedFacts } from './platform-recognized-target'

type Db = BetterSQLite3Database<typeof s>
const c = s.platformCollection, qa = s.platformLegacyQueryAlias
const o = t.platformBusinessObservation, ra = t.platformLegacyRelationAlias, a = t.platformObservationAssignment
const original = alias(a, 'candidate_original'), newer = alias(a, 'candidate_newer')
export function targetCandidateTables(db: Db) {
  const q = db.select({ id: qa.oldId, collectionId: c.id, interface: c.interface, queryKey: c.queryKey, rdjb: c.rdjb,
    titleCode: c.titleCode, queriedAt: c.queriedAt, lastCollectedAt: c.lastCollectedAt, status: c.status,
    failureReason: c.failureReason, createdAt: c.createdAt }).from(c).innerJoin(qa, eq(qa.collectionId, c.id)).as('candidate_query')
  const r = db.select({ id: sql<number>`${ra.oldId}`.as('relation_id'), queryId: sql<number>`${qa.oldId}`.as('query_id'), collectionId: o.collectionId, sequenceNo: o.sequenceNo,
    relationKey: o.sourceRelationKey, enterpriseId: a.enterpriseId, usccRaw: original.usccRaw, nameRaw: original.nameRaw,
    matchBasis: a.matchBasis, verificationStatus: a.verificationStatus })
    .from(o).innerJoin(ra, eq(ra.observationId, o.id)).innerJoin(qa, eq(qa.collectionId, o.collectionId))
    .innerJoin(a, and(eq(a.observationId, o.id), eq(a.revision, db.select({ n: max(newer.revision) }).from(newer).where(eq(newer.observationId, o.id)))))
    .innerJoin(original, and(eq(original.observationId, o.id), eq(original.revision, 1))).as('candidate_relation')
  return { q, r }
}
export function targetCandidateTitle(db: Db) {
  const { q, r } = targetCandidateTables(db), p = s.platformCollectionPage
  const pageTitle = db.select({ title: sql<string>`case ${p.rdjb} when '1' then 'innovative_sme' when '2' then 'specialized_sme' when '3' then 'little_giant' end` })
    .from(p).where(and(eq(p.collectionId, q.collectionId), eq(p.status, 'success'), sql`${p.sequenceEnd} >= ${r.sequenceNo}`)).orderBy(p.ordinal).limit(1)
  return sql<string>`case when ${q.interface} = 'recognized_list' then coalesce((${pageTitle}), ${q.titleCode})
    else coalesce(${q.titleCode}, case ${q.rdjb} when '1' then 'innovative_sme' when '2' then 'specialized_sme' when '3' then 'little_giant' end) end`
}
export function readCandidateTargetFacts(db: Db, source: PlatformFactInterface, ids: number[]) {
  switch (source) {
    case 'apply_list': return readTargetDeclarationFacts(db, ids)
    case 'business_list': return readTargetBusinessProcessFacts(db, ids, { scope: 'selected' })
    case 'recognized_list': return readTargetRecognizedFacts(db, ids)
  }
}
/** Original evidence is read only as display metadata after DB selection, never for membership. */
export function readCandidateTargetQueries(db: Db, ids: number[]) {
  const { q } = targetCandidateTables(db), ref = s.platformCollectionArchiveRef, v = s.platformArchiveValue
  return db.select({ id: q.id, interface: c.interface, queryKey: c.queryKey, rdjb: c.rdjb, titleCode: c.titleCode,
    queriedAt: c.queriedAt, lastCollectedAt: c.lastCollectedAt, status: c.status, failureReason: c.failureReason, createdAt: c.createdAt,
    collectionEvidence: sql`(select json_remove(cast(${v.bytes} as text), '$.rows') from ${ref} inner join ${v} on ${v.id}=${ref.archiveId}
      where ${ref.ownerId}=${c.id} and ${ref.field}='collectionEvidence')`.mapWith((value: string | null) => value === null ? null : JSON.parse(value)),
  }).from(q).innerJoin(c, eq(c.id, q.collectionId)).where(inArray(q.id, ids)).orderBy(q.id).all()
}
export function readCandidateTargetRelations(db: Db, ids: number[], selected?: number[]) {
  const { r } = targetCandidateTables(db)
  const ap = t.platformApplyProjection, bp = t.platformBusinessProjection
  const rows = db.select().from(r).where(and(inArray(r.queryId, ids), selected ? inArray(r.id, selected) : undefined)).orderBy(sql<number>`${r.queryId}`, r.sequenceNo).all()
  const titles = new Map([ap, bp].flatMap(p => db.select({ id: ra.oldId,
    value: sql<string | null>`case ${p.sourceTitleKind} when 'text' then ${p.sourceTitleText} when 'number' then ${p.sourceTitleNumberText} end`,
  }).from(ra).innerJoin(p, eq(p.observationId, ra.observationId)).where(inArray(ra.oldId, rows.map(r => r.id))).all()).map(row => [row.id, row.value]))
  return rows.map(row => ({ ...row, rowTitleRaw: titles.get(row.id) ?? null }))
}
export function readCandidateTargetPositions(db: Db, ids: number[]) {
  const { r } = targetCandidateTables(db), p = s.platformCollectionPage
  return new Map(db.select({ id: r.id, sourceRdjb: p.rdjb, sourcePage: p.pageNo }).from(r)
    .leftJoin(p, and(eq(p.collectionId, r.collectionId), eq(p.status, 'success'), sql`${r.sequenceNo} between ${p.sequenceStart} and ${p.sequenceEnd}`))
    .where(inArray(r.id, ids)).all().map(row => [row.id, { sourceRdjb: row.sourceRdjb, sourcePage: row.sourcePage }]))
}

/** Same three original byte owners as the historical envelope; no snapshot/request double charge. */
export function candidateTargetSourceBytes(db: Db, relationId: number) {
  const cr = s.platformCollectionArchiveRef, rr = t.platformObservationArchiveRef, v = s.platformArchiveValue
  const owner = db.select({ observationId: o.id, collectionId: o.collectionId }).from(ra).innerJoin(o, eq(o.id, ra.observationId)).where(eq(ra.oldId, relationId)).get()
  if (!owner) return undefined
  const collection = db.select({ n: sql<number>`coalesce(sum(${v.byteLength}),0)` }).from(cr).innerJoin(v, eq(v.id, cr.archiveId))
    .where(and(eq(cr.ownerId, owner.collectionId), inArray(cr.field, ['rawResponse', 'collectionEvidence']))).get()!.n
  const row = db.select({ n: sql<number>`coalesce(sum(${v.byteLength}),0)` }).from(rr).innerJoin(v, eq(v.id, rr.archiveId))
    .where(and(eq(rr.ownerId, owner.observationId), eq(rr.field, 'rawFields'))).get()!.n
  return collection + row
}

export async function readPostgresCandidateSourceBytes(db: Pick<NodePgDatabase, 'execute'>, relationId: number) {
  const { rows: [source] } = await db.execute<{ bytes: string }>(sql`
    SELECT (coalesce((SELECT sum(v.byte_length) FROM platform_collection_archive_ref r JOIN platform_archive_value v ON v.id=r.archive_id
          WHERE r.owner_id=o.collection_id AND r.field IN ('rawResponse','collectionEvidence')),0)
      + coalesce((SELECT sum(v.byte_length) FROM platform_observation_archive_ref r JOIN platform_archive_value v ON v.id=r.archive_id
          WHERE r.owner_id=o.id AND r.field='rawFields'),0)) AS bytes
    FROM platform_legacy_relation_alias a JOIN platform_business_observation o ON o.id=a.observation_id WHERE a.old_id=${relationId}`)
  return source ? Number(source.bytes) : undefined
}

/** Generic candidates group business versions, while event discovery pages observations.
 * Count and select the business groups in SQLite before hydrating their source facts. */
export function selectCandidateTargetPage(db: Db, input: { queryIds: number[]; enterpriseId: number; identity: string | null; titleCode: string; event: boolean; page: number; pageSize: number }) {
  identityFunctions(db)
  const { q, r } = targetCandidateTables(db), ap = t.platformApplyProjection, bp = t.platformBusinessProjection
  const page = s.platformCollectionPage
  const rawTitle = sql<string | null>`case coalesce(${ap.sourceTitleKind},${bp.sourceTitleKind})
    when 'text' then coalesce(${ap.sourceTitleText},${bp.sourceTitleText})
    when 'number' then coalesce(${ap.sourceTitleNumberText},${bp.sourceTitleNumberText}) end`
  const processTitle = sql<string>`coalesce(${q.titleCode}, case
    when trim(${q.rdjb}, ',') in ('1','2','3') then case trim(${q.rdjb}, ',') when '1' then 'innovative_sme' when '2' then 'specialized_sme' when '3' then 'little_giant' end
    when (replace(${q.rdjb},',','') = '' or instr(',' || ${q.rdjb} || ',', ',' || ${rawTitle} || ',') > 0)
    then case ${rawTitle} when '1' then 'innovative_sme' when '2' then 'specialized_sme' when '3' then 'little_giant' end end)`
  const recognizedTitle = sql<string>`coalesce((${db.select({ value: sql<string>`case ${page.rdjb} when '1' then 'innovative_sme' when '2' then 'specialized_sme' when '3' then 'little_giant' end` })
    .from(page).where(and(eq(page.collectionId, q.collectionId), eq(page.status, 'success'), sql`${page.sequenceEnd} >= ${r.sequenceNo}`)).orderBy(page.ordinal).limit(1)}),${q.titleCode})`
  const rowTitle = sql<string>`case when ${q.interface}='recognized_list' then ${recognizedTitle} else ${processTitle} end`
  const groupKey = sql<string>`case when ${o.identityState}='resolved' and ${o.contentState}='verified' and ${o.recordId} is not null and ${o.versionId} is not null
    then 'version:' || ${o.recordId} || ':' || ${o.versionId} else 'observation:' || ${o.id} end`.as('group_key')
  const eligible = db.$with('candidate_eligible').as(db.select({ id: r.id, groupKey,
    ordinal: sql<number>`row_number() over (order by ${q.id},${r.sequenceNo},${r.id})`.as('ordinal'),
  }).from(r).innerJoin(q, eq(q.id, r.queryId)).innerJoin(ra, eq(ra.oldId, r.id)).innerJoin(o, eq(o.id, ra.observationId))
    .leftJoin(ap, eq(ap.observationId, o.id)).leftJoin(bp, eq(bp.observationId, o.id))
    .where(and(inArray(q.id, input.queryIds), inArray(q.status, ['success', 'partial']),
      or(sql`${r.enterpriseId} is null`, eq(r.enterpriseId, input.enterpriseId)),
      input.identity ? sql`roster84_uscc(${r.usccRaw}) = ${input.identity}` : sql`0`,
      eq(rowTitle, input.titleCode), input.event ? undefined : sql`${q.interface} != 'recognized_list'`)))
  const groups = db.$with('candidate_groups').as(db.select({ key: eligible.groupKey, first: sql<number>`min(${eligible.ordinal})`.as('first_ordinal') }).from(eligible).groupBy(sql`${eligible.groupKey}`))
  const total = db.with(eligible, groups).select({ n: count() }).from(groups).get()!.n
  const selected = db.with(eligible, groups).select({ key: groups.key }).from(groups).orderBy(sql`${groups.first}`).limit(input.pageSize).offset((input.page - 1) * input.pageSize).all()
  const ids = selected.length ? db.with(eligible).select({ id: eligible.id }).from(eligible).where(inArray(eligible.groupKey, selected.map(r => r.key))).orderBy(sql`${eligible.ordinal}`).all().map(r => r.id) : []
  return { total, ids }
}
