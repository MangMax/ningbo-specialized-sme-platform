import { scopeAnnualEvent, prepareAnnualObservations, projectAnnualProcess, type Rows, type Titles, type Queries, unavailable, resource, comparisonCaps, admitAnnualComparison } from './event-annual-process-model'
import type Database from 'better-sqlite3'
import { and, eq, inArray, or, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { alias } from 'drizzle-orm/sqlite-core'
import * as schema from '../../../../db/schema'
import type { PlatformObservationFact } from '../../lib/platform/observation-facts'
import { targetSchema } from '../../lib/platform/target-schema'
import type { EventAnnualProcessRead } from '../../lib/roster/annual-process'
import { identityFunctions } from '../../lib/roster/enterprise-read-snapshot'
import { readTargetAnnualHistory, readTargetAnnualSources } from './annual-process-target-sources'
import { readPlatformBusinessGroups, readPlatformBusinessMetadata } from './platform-business-record-read'
import { correspondenceTable, externalRelationColumn } from './record-correspondence-store'
type Db = BetterSQLite3Database<typeof schema>
export type { AnnualProcessSourceRefs,EventAnnualProcessRead } from '../../lib/roster/annual-process'
/** Complete current archived event scope. No preflight, ledger writes, projection or network access.
 * Display pagination belongs to the public adapter, after this full-scope qualification.
 */
export function readEventAnnualProcess(db: Db, eventId: number): EventAnnualProcessRead | null {
  if (!Number.isSafeInteger(eventId) || eventId <= 0) throw new Error('Invalid event ID')
  return db.transaction(() => readSnapshot(db, eventId))
}
function eventScope(db: Db, eventId: number) {
  const joined = annualEventHeader(db, eventId).get()
  return joined ? scopeAnnualEvent(joined) : null
}
export function annualEventHeader(db: Db, eventId: number) {
  const v = schema.recordEvent, rec = schema.record, ent = schema.enterprise
  return db.select({ event: { id: v.id, recordId: v.recordId, eventType: v.eventType, year: v.year, batchSeq: v.batchSeq, sortKey: v.sortKey, reviewOutcome: v.reviewOutcome, decidedYear: v.decidedYear, revision: v.revision }, record: { id: rec.id, enterpriseId: rec.enterpriseId, titleCode: rec.titleCode, usccRaw: rec.usccRaw, source: rec.source }, enterprise: { nameNorm: ent.nameNorm, usccNorm: ent.usccNorm } })
    .from(v).innerJoin(rec, eq(v.recordId, rec.id)).innerJoin(ent, eq(rec.enterpriseId, ent.id)).where(eq(v.id, eventId))
}
function evidenceFields() {
  const e = schema.recordEvidence, file = schema.storedFile
  return { id: e.id, sourceFile: e.sourceFile, attachment: e.attachment, listNo: e.listNo, page: e.page, fileId: file.id, sha256: file.sha256, removedAt: file.removedAt }
}
function readSnapshot(db: Db, eventId: number): EventAnnualProcessRead | null {
  return readAnnualProcessBatch(db, [eventId]).get(eventId)?.read ?? null

}
/** One source context for a request, shared by events of the same enterprise/title.
 * No context survives the transaction or supplies facts to another request. */
export function readAnnualProcessBatch(db: Db, eventIds: readonly number[], includeUnknownBusinessTitle = false) {

  const scopes = [...new Set(eventIds)].flatMap(id => {
    const scope = eventScope(db, id)
    return scope ? [scope] : []
  })
  const sources = readTargetAnnualSources(db, scopes, includeUnknownBusinessTitle)
  const metadata = readPlatformBusinessMetadata(db, [...new Set([...sources.values()].flatMap(s => [...s.rows.map(r => r.id), ...s.titles.map(t => t.relationId)]))])
  const prepared = scopes.map(scope => {
    const source = sources.get(scope.event.id)!
    // The comparison seam historically reconciles stored/raw observation fields;
    // the annual read uses version facts. Preserve that existing distinction.
    const facts = includeUnknownBusinessTitle ? new Map([...source.facts].map(([id, f]) => [id, f.interface === 'business_list' ? { ...f, ...f.archiveProcessFacts } : { ...f, ...f.archiveProcessFacts }])) : source.facts
    return prepareAnnualObservations(scope, source.rows, source.titles, source.queries, metadata, facts)
  })
  const groups = readPlatformBusinessGroups(db, prepared.flatMap(p => p.observations), metadata)
  const e = schema.recordEvidence, file = schema.storedFile
  const evidence = eventIds.length ? db.select({ ...evidenceFields(), eventId: e.recordEventId }).from(e).leftJoin(file, eq(file.relPath, e.sourceFile)).where(inArray(e.recordEventId, [...eventIds])).orderBy(e.id).all() : []
  const byEvent = Map.groupBy(evidence, e => e.eventId)
  return new Map(prepared.map(p => [p.event.id, projectAnnualProcess(p, groups.filter(g => g.observationRefs[0]?.target.eventId === p.event.id),
    (byEvent.get(p.event.id) ?? []).map(({ eventId: _eventId, ...row }) => row))]))
}
export type AnnualSourceRows = { rows: Rows; titles: Titles; queries: Queries; facts: Map<number, PlatformObservationFact> }
/** ID-only internal seam. No external facts, normalizer, eligibility or loader. */
export function readAnnualComparisonBatch(sqlite: Database.Database, db: Db, request: { enterpriseId: number; titleCode: string; eventIds: readonly number[]; selectedQueryIds: readonly number[] }) {
  if (!sqlite.inTransaction) unavailable()
  return readTargetAnnualComparisonBatch(db, request)

}
/** Target annual-input seam only. General comparison discovery remains its own
 * consumer. Keep the existing annual row/source limits and explicit query closure. */
function readTargetAnnualComparisonBatch(db: Db, request: { enterpriseId: number; titleCode: string; eventIds: readonly number[]; selectedQueryIds: readonly number[] }) {
  identityFunctions(db)
  const ids = [...new Set(request.eventIds)], selected = new Set(request.selectedQueryIds)
  if (ids.length > 40 || selected.size > 50) resource()
  if ([...ids, ...selected].some(id => !Number.isSafeInteger(id) || id <= 0)) unavailable()
  const scopes = ids.map(id => eventScope(db, id))
  if (scopes.some(scope => !scope || scope.owner !== request.enterpriseId || scope.titleCode !== request.titleCode)) unavailable()
  const c = correspondenceTable(db), relation = externalRelationColumn(db)
  const decisions = db.select({ relationId: relation, eventId: c.eventId, predecessorEventId: c.predecessorEventId, enterpriseId: c.enterpriseId, titleCode: c.titleCode }).from(c).where(or(inArray(c.eventId, ids), inArray(c.predecessorEventId, ids), and(eq(c.enterpriseId, request.enterpriseId), eq(c.titleCode, request.titleCode)))).all()
  if (decisions.length > comparisonCaps.decisions) resource()
  const reads = readAnnualProcessBatch(db, ids, true)
  const entries = [...reads.values()]
  const refs = entries.flatMap(e => e.read.sourceRefs.observations)
  const titleRefs = entries.flatMap(e => e.read.sourceRefs.titleScopeRefs)
  const recordIds = [...new Set([...refs, ...titleRefs].flatMap(r => r.recordId === null ? [] : [r.recordId]))]
  const history = readTargetAnnualHistory(db, recordIds)
  const protectedIds = new Set([...refs.map(r => r.relationId), ...titleRefs.map(r => r.relationId), ...[...history.values()].flat()])
  if (decisions.some(d => d.relationId === null || !protectedIds.has(d.relationId))) unavailable()
  if (new Set(refs.map(r => r.relationId)).size > comparisonCaps.rows || new Set(titleRefs.map(r => r.relationId)).size > comparisonCaps.titles || [...history.values()].flat().length > comparisonCaps.history) resource()
  const ra = targetSchema.platformLegacyRelationAlias, o = targetSchema.platformBusinessObservation, qa = schema.platformLegacyQueryAlias
  const historicalQueries = protectedIds.size ? db.select({ recordId: o.recordId, relationId: ra.oldId, queryId: qa.oldId }).from(ra).innerJoin(o, eq(o.id, ra.observationId)).innerJoin(qa, eq(qa.collectionId, o.collectionId)).where(inArray(ra.oldId, [...protectedIds])).all() : []
  const requiredQueries = new Set([...entries.flatMap(e => e.read.sourceRefs.coverage.map(c => c.queryId)), ...titleRefs.map(r => r.queryId), ...historicalQueries.map(q => q.queryId)])
  const collection = schema.platformCollection
  const queryRows = requiredQueries.size ? db.select({ id: qa.oldId, collection }).from(qa).innerJoin(collection, eq(collection.id, qa.collectionId)).where(inArray(qa.oldId, [...requiredQueries])).all() : []
  const collectionIds = queryRows.map(q => q.collection.id)
  const pages = collectionIds.length ? db.select().from(schema.platformCollectionPage).where(inArray(schema.platformCollectionPage.collectionId, collectionIds)).all() : []
  const titleScope = targetSchema.platformQueryTitleScope
  const titleScopes = collectionIds.length ? db.select().from(titleScope).where(inArray(titleScope.collectionId, collectionIds)).all() : []
  return admitAnnualComparison({ request, entries, history, decisions, historicalQueries, queryRows, pages, titleScopes,
    metadata: readPlatformBusinessMetadata(db, [...protectedIds]), hasUnboundProcessCollection: () => {
      const owner = db.select().from(schema.enterprise).where(eq(schema.enterprise.id, request.enterpriseId)).get()
      if (!owner) return unavailable()
      const a = targetSchema.platformObservationAssignment, original = alias(a, 'annual_empty_original')
      const related = db.select({ id: o.collectionId }).from(o).innerJoin(a, eq(a.observationId, o.id)).innerJoin(original, and(eq(original.observationId, o.id), eq(original.revision, 1)))
        .where(or(eq(a.enterpriseId, request.enterpriseId), owner.usccNorm ? sql`roster84_uscc(${original.usccRaw}) = ${owner.usccNorm}` : sql`0`))
      const collection = schema.platformCollection
      const aliases = db.select({ name: schema.enterpriseAlias.nameNorm }).from(schema.enterpriseAlias).where(and(eq(schema.enterpriseAlias.enterpriseId, owner.id), eq(schema.enterpriseAlias.verificationStatus, 'confirmed'))).all()
      const keys = [owner.usccNorm ?? '', `name:${owner.nameNorm}`, ...aliases.map(a => `name:${a.name}`)]
      return !!db.select({ id: collection.id }).from(collection).where(and(inArray(collection.interface, ['apply_list', 'business_list']), or(inArray(collection.queryKey, keys), inArray(collection.id, related)))).limit(1).get()
    },
  })
}
export { scopeAnnualEvent, prepareAnnualObservations, projectAnnualProcess, type AnnualEventScope, type AnnualObservationFacts, admitAnnualComparison } from './event-annual-process-model'
