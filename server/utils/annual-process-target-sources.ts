import { and, eq, inArray, max, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as s from '../../db/schema'
import { targetSchema } from '../../layers/sme-roster/lib/platform/target-schema'
import { normalizeUscc } from '../../layers/sme-roster/lib/domain'
import { identityFunctions } from '../../layers/sme-roster/lib/roster/enterprise-read-snapshot'
import type { AnnualEventScope, AnnualSourceRows } from './event-annual-process-read'
import { readTargetDeclarationFacts } from '../../layers/sme-roster/server/utils/platform-declarations-target'
import { readTargetBusinessProcessFacts } from '../../layers/sme-roster/server/utils/platform-business-processes-target'

type Db = BetterSQLite3Database<typeof s>
const { platformBusinessObservation: o, platformObservationAssignment: a, platformLegacyRelationAlias: ra } = targetSchema
const c = s.platformCollection, qa = s.platformLegacyQueryAlias
const original = alias(a, 'annual_original'), newer = alias(a, 'annual_newer')
const batches = <T>(items: T[]) => Array.from({ length: Math.ceil(items.length / 300) }, (_, i) => items.slice(i * 300, i * 300 + 300))
const queryTitle = (title: string | null, rdjb: string) => title ?? ({ '1': 'innovative_sme', '2': 'specialized_sme', '3': 'little_giant' }[rdjb] ?? null)
export const ANNUAL_COMPARISON_RAW_LIMIT = 4096

/** Annual membership and process facts come only from structured target owners.
 * Source text is a historical transcription annotation, not parsed business data. */
export function readTargetAnnualSources(db: Db, scopes: AnnualEventScope[], includeUnknownBusinessTitle = false): Map<number, AnnualSourceRows> {
  identityFunctions(db)
  if (!scopes.length) return new Map()
  const owners = [...new Set(scopes.map(s => s.owner))]
  const aliases = db.select().from(s.enterpriseAlias).where(and(inArray(s.enterpriseAlias.enterpriseId, owners), eq(s.enterpriseAlias.verificationStatus, 'confirmed'))).all()
  const keysFor = (scope: AnnualEventScope) => [scope.identity, `name:${scope.joined.enterprise.nameNorm}`, ...aliases.filter(a => a.enterpriseId === scope.owner).map(a => `name:${a.nameNorm}`)].filter((key): key is string => !!key)
  const current = and(eq(a.observationId, o.id), eq(a.revision, db.select({ n: max(newer.revision) }).from(newer).where(eq(newer.observationId, o.id))))
  const related = db.selectDistinct({ id: o.collectionId }).from(o).innerJoin(a, current).innerJoin(original, and(eq(original.observationId, o.id), eq(original.revision, 1)))
    .where(or(inArray(a.enterpriseId, owners), ...scopes.filter(scope => scope.identity).map(scope => sql`roster84_uscc(${original.usccRaw}) = ${scope.identity}`)))
  const collections = db.select({ collection: c, queryId: qa.oldId }).from(c).innerJoin(qa, eq(qa.collectionId, c.id))
    .where(and(inArray(c.interface, ['apply_list', 'business_list']), or(inArray(c.queryKey, [...new Set(scopes.flatMap(keysFor))]), inArray(c.id, related)))).orderBy(qa.oldId).all()
  const collectionIds = collections.map(r => r.collection.id)
  const sourceUscc = sql<string>`coalesce(roster84_uscc(${original.usccRaw}),'')`
  const matchingIdentity = or(...scopes.map(scope => and(
    or(eq(a.enterpriseId, scope.owner), sql`${a.enterpriseId} is null`),
    or(scope.identity ? eq(sourceUscc, scope.identity) : and(eq(a.enterpriseId, scope.owner), eq(a.verificationStatus, 'confirmed')),
      and(eq(sourceUscc, ''), or(eq(a.enterpriseId, scope.owner), inArray(c.queryKey, keysFor(scope))))),
  )))
  const rows = batches(collectionIds).flatMap(ids => db.select({
    id: ra.oldId, queryId: qa.oldId, sequenceNo: o.sequenceNo, relationKey: o.sourceRelationKey, collectionId: c.id,
    enterpriseId: a.enterpriseId, verificationStatus: a.verificationStatus, matchBasis: a.matchBasis,
    usccRaw: original.usccRaw, nameRaw: original.nameRaw,
    identityOnlySource: sql<number>`case when exists (select 1 from ${targetSchema.platformObservationArchiveRef} ref
      join ${s.platformArchiveValue} value on value.id=ref.archive_id where ref.owner_id=${o.id} and ref.field='sourceText'
      and cast(value.bytes as text) like '%platform-verify-aclass%' and cast(value.bytes as text) like '%转写%'
      and (cast(value.bytes as text) like '%名称%' or cast(value.bytes as text) like '%qymc%')) then 1 else 0 end`,
  }).from(o).innerJoin(c, eq(c.id, o.collectionId)).innerJoin(qa, eq(qa.collectionId, c.id)).innerJoin(ra, eq(ra.observationId, o.id))
    .innerJoin(a, current).innerJoin(original, and(eq(original.observationId, o.id), eq(original.revision, 1)))
    .where(and(inArray(c.id, ids), matchingIdentity)).orderBy(qa.oldId, o.sequenceNo, ra.oldId).all())
  const pages = batches(collectionIds).flatMap(ids => db.select().from(s.platformCollectionPage).where(inArray(s.platformCollectionPage.collectionId, ids)).orderBy(s.platformCollectionPage.ordinal).all())
  const byCollection = Map.groupBy(rows, row => row.collectionId)
  const selected = scopes.map(scope => {
    const keys = keysFor(scope)
    const related = collections.filter(({ collection: c }) => keys.includes(c.queryKey) || (byCollection.get(c.id) ?? []).some(r => r.enterpriseId === scope.owner || scope.identity && normalizeUscc(r.usccRaw) === scope.identity))
    const queries: AnnualSourceRows['queries'] = related.filter(({ collection: c }) => {
      const title = queryTitle(c.titleCode, c.rdjb)
      return title === scope.titleCode || title === null && (c.interface === 'apply_list' || includeUnknownBusinessTitle)
    }).map(({ collection: c, queryId }) => ({ queryId, interface: c.interface, queryKey: c.queryKey, rdjb: c.rdjb, titleCode: c.titleCode, queriedAt: c.queriedAt, status: c.status,
      completeness: c.completeness === 'unknown' ? null : c.completeness, fullRangeValue: c.fullRange }))
    const queryIds = new Set(queries.map(q => q.queryId))
    const matching = related.flatMap(({ collection: c, queryId }) => (byCollection.get(c.id) ?? []).filter(r => {
      if (r.enterpriseId !== null && r.enterpriseId !== scope.owner) return false
      const uscc = normalizeUscc(r.usccRaw)
      return (scope.identity ? uscc === scope.identity : r.enterpriseId === scope.owner && r.verificationStatus === 'confirmed') || !uscc && (r.enterpriseId === scope.owner || keys.includes(c.queryKey))
    }).map(r => ({ ...r, title: queryTitle(c.titleCode, c.rdjb), interface: c.interface, queryId })))
    return { scope, queries, matching, queryIds }
  })
  const needed = [...new Set(selected.flatMap(s => s.matching.filter(r => s.queryIds.has(r.queryId)).map(r => r.id)))]
  const applyIds = new Set(collections.filter(r => r.collection.interface === 'apply_list').map(r => r.queryId))
  const rowQueries = new Map(rows.map(r => [r.id, r.queryId]))
  const apply = needed.filter(id => applyIds.has(rowQueries.get(id)!)), process = needed.filter(id => !applyIds.has(rowQueries.get(id)!))
  const facts = new Map([...(apply.length ? readTargetDeclarationFacts(db, apply) : []),
    ...(process.length ? readTargetBusinessProcessFacts(db, process) : [])])
  if (includeUnknownBusinessTitle) for (const fact of facts.values()) {
    const f = fact.archiveProcessFacts ?? fact
    // The annual seam consumes these seven source facts. Unrelated archive
    // fields remain evidence and must not change annual input admission.
    if (Buffer.byteLength(JSON.stringify([f.province, f.status, f.batch, f.declareKind, f.appliedAt, f.awardBatchLabel, f.year])) > ANNUAL_COMPARISON_RAW_LIMIT) throw new Error('input_resource_limit')
  }
  const pagesByCollection = Map.groupBy(pages, p => p.collectionId)
  return new Map(selected.map(({ scope, queries, matching, queryIds }) => {
    const scopedRows: AnnualSourceRows['rows'] = matching.filter(r => queryIds.has(r.queryId)).map(r => {
      const f = facts.get(r.id)
      if (!f) throw new Error('annual_observation_fact_missing')
      const page = pagesByCollection.get(r.collectionId)?.find(p => p.status === 'success' && p.sequenceStart !== null && p.sequenceEnd !== null && r.sequenceNo >= p.sequenceStart && r.sequenceNo <= p.sequenceEnd)
      return { id: r.id, queryId: r.queryId, sequenceNo: r.sequenceNo, relationKey: r.relationKey, enterpriseId: r.enterpriseId, verificationStatus: r.verificationStatus, matchBasis: r.matchBasis,
        nameRaw: r.nameRaw, usccRaw: r.usccRaw, declareKind: f.declareKind, appliedAt: f.appliedAt, year: f.year, province: f.province, batch: f.batch, awardBatchLabel: f.awardBatchLabel, status: f.status,
        rawFields: null, sourcePage: page?.pageNo ?? null, sourceRdjb: page?.rdjb ?? null, identityOnlySource: r.identityOnlySource }
    })
    return [scope.event.id, { queries, rows: scopedRows, titles: matching.filter(r => r.interface === 'business_list').sort((a, b) => a.id - b.id).map(r => ({ relationId: r.id, queryId: r.queryId, relationKey: r.relationKey, usccRaw: r.usccRaw, titleCode: r.title })), facts }] as const
  }))
}

/** All observations of a verified business protect its decisions, including old years. */
export function readTargetAnnualHistory(db: Db, recordIds: number[]) {
  const history = new Map<number, number[]>()
  for (const ids of batches([...new Set(recordIds)])) for (const row of db.select({ recordId: o.recordId, relationId: ra.oldId }).from(o).innerJoin(ra, eq(ra.observationId, o.id)).where(inArray(o.recordId, ids)).orderBy(ra.oldId).all()) {
    const list = history.get(row.recordId!) ?? []
    list.push(row.relationId)
    history.set(row.recordId!, list)
  }
  return history
}
