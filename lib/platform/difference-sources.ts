/** Request-local structured source reads for the difference workflow.
 * Candidate membership is deliberately broader than decision evidence admission. */
import { and, asc, desc, eq, exists, inArray, max, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as s from '../../db/schema'
import { targetSchema } from './target-schema'
import { sqliteConnection } from './target-connection'
import { requireH1cReady } from './h1c-catalog'
import { identityFunctions, identityUsccSql } from '../roster/enterprise-read-snapshot'
import { normalizeUscc } from '../domain'

type Db = BetterSQLite3Database<typeof s>
const c = s.platformCollection, qa = s.platformLegacyQueryAlias
const { platformBusinessObservation: o, platformObservationAssignment: a, platformLegacyRelationAlias: ra } = targetSchema
const original = alias(a, 'difference_original'), newer = alias(a, 'difference_newer')
export function differenceTargetSources(db: Db) {
  const connection = sqliteConnection(db), phase = Number(connection.pragma('user_version', { simple: true }))
  if (![0,71605,71606,71607,71608,71609,71610,71611,71612,71613].includes(phase)) throw new Error('Unsupported difference source schema version')
  const target = phase === 71611 || phase === 71612 || phase === 71613
  if (target) requireH1cReady(connection)
  return target
}
export function differenceTargetStorage(db: Db) {
  const connection = sqliteConnection(db)
  const target = [71612,71613].includes(Number(connection.pragma('user_version', { simple: true })))
  if (target) requireH1cReady(connection)
  return target
}
export function currentDifferenceAssignment(db: Db) {
  return and(eq(a.observationId, o.id), eq(a.revision, db.select({ n: max(newer.revision) }).from(newer).where(eq(newer.observationId, o.id))))
}
const observationColumns = {
  id: ra.oldId, observationId: o.id, collectionId: o.collectionId, queryId: qa.oldId,
  sequenceNo: o.sequenceNo, relationKey: o.sourceRelationKey, versionId: o.versionId,
  enterpriseId: a.enterpriseId, uscc: original.usccRaw, nameRaw: original.nameRaw,
  aliasNameRaw: original.aliasNameRaw, verificationStatus: a.verificationStatus, matchBasis: a.matchBasis,
}
export function readDifferenceObservation(db: Db, relationId: number) {
  return db.select(observationColumns).from(o).innerJoin(ra, eq(ra.observationId, o.id))
    .innerJoin(qa, eq(qa.collectionId, o.collectionId)).innerJoin(a, currentDifferenceAssignment(db))
    .innerJoin(original, and(eq(original.observationId, o.id), eq(original.revision, 1)))
    .where(eq(ra.oldId, relationId)).get()
}
export function readDifferenceObservations(db: Db, collectionId: number, afterId = 0, limit = 200) {
  return db.select(observationColumns).from(o).innerJoin(ra, eq(ra.observationId, o.id))
    .innerJoin(qa, eq(qa.collectionId, o.collectionId)).innerJoin(a, currentDifferenceAssignment(db))
    .innerJoin(original, and(eq(original.observationId, o.id), eq(original.revision, 1)))
    .where(and(eq(o.collectionId, collectionId), sql`${ra.oldId}>${afterId}`)).orderBy(asc(ra.oldId)).limit(limit).all()
}
export function readDifferenceCollection(db: Db, queryId: number) {
  return db.select({ ...collectionColumns }).from(c).innerJoin(qa, eq(qa.collectionId, c.id)).where(eq(qa.oldId, queryId)).get()
}
const collectionColumns = { collection: c, id: qa.oldId }
type ScopeRows = {
  collection: typeof c.$inferSelect
  conditions: (typeof s.platformCollectionCondition.$inferSelect)[]
  pages: (typeof s.platformCollectionPage.$inferSelect)[]
  unfinished: (typeof s.platformCollectionUnfinished.$inferSelect)[]
  titles: string[]
}
export function readDifferenceCollectionScope(db: Db, collectionId: number, loaded?: ScopeRows) {
  const collection = loaded?.collection ?? db.select().from(c).where(eq(c.id, collectionId)).get()
  if (!collection) throw new Error('Difference collection not found')
  const conditions: Record<string, unknown> = {}
  let conditionsKnown = true
  for (const row of loaded?.conditions ?? db.select().from(s.platformCollectionCondition).where(eq(s.platformCollectionCondition.collectionId, collectionId)).all()) {
    switch (row.valueKind) {
      case 'absent': break
      case 'null': conditions[row.name] = null; break
      case 'text': conditions[row.name] = row.textValue; break
      case 'integer': conditions[row.name] = row.integerValue; break
      case 'boolean': conditions[row.name] = !!row.integerValue; break
      default: conditionsKnown = false
    }
  }
  const pages = loaded?.pages ?? db.select().from(s.platformCollectionPage).where(eq(s.platformCollectionPage.collectionId, collectionId)).orderBy(s.platformCollectionPage.ordinal).all()
  const unfinished = loaded?.unfinished ?? db.select().from(s.platformCollectionUnfinished).where(eq(s.platformCollectionUnfinished.collectionId, collectionId)).orderBy(s.platformCollectionUnfinished.ordinal).all()
  const titles = loaded?.titles ?? db.select({ rdjb: targetSchema.platformQueryTitleScope.rdjb }).from(targetSchema.platformQueryTitleScope).where(eq(targetSchema.platformQueryTitleScope.collectionId, collectionId)).all().map(r => r.rdjb)
  const metadata = collection.parseState === 'valid' && conditionsKnown ? {
    source: collection.source, status: collection.evidenceStatus, effectiveConditions: conditions,
    titleScope: { mode: collection.scopeMode, rdjb: titles },
    pages: pages.map(p => ({ source: p.source, rdjb: p.rdjb, page: p.pageNo, maxPage: p.maxPage, declaredTotal: p.declaredTotal, fetchedCount: p.fetchedCount, status: p.status,
      error: p.errorCode === null && p.errorMessage === null ? null : { code: p.errorCode, message: p.errorMessage } })),
    completeness: collection.completeness, fullRange: collection.fullRange === null ? null : !!collection.fullRange,
    unfinished: unfinished.map(p => ({ source: p.source, rdjb: p.rdjb, page: p.pageNo })),
    error: collection.errorCode === null && collection.errorMessage === null ? null : { code: collection.errorCode, message: collection.errorMessage },
    limits: { maxRequests: collection.maxRequests, maxRows: collection.maxRows, maxDurationMs: collection.maxDurationMs, pageSize: collection.pageSize },
  } : null
  return { collection, conditions, conditionsKnown, pages, unfinished, metadata }
}
/** One page-local batch. No row payloads or archive bodies are hydrated. */
export function readDifferenceCollectionScopes(db: Db, collections: (typeof c.$inferSelect)[]) {
  const ids = [...new Set(collections.map(c => c.id))]
  if (!ids.length) return new Map<number, ReturnType<typeof readDifferenceCollectionScope>>()
  const conditions = Map.groupBy(db.select().from(s.platformCollectionCondition).where(inArray(s.platformCollectionCondition.collectionId, ids)).all(), r => r.collectionId)
  const pages = Map.groupBy(db.select().from(s.platformCollectionPage).where(inArray(s.platformCollectionPage.collectionId, ids)).orderBy(s.platformCollectionPage.ordinal).all(), r => r.collectionId)
  const unfinished = Map.groupBy(db.select().from(s.platformCollectionUnfinished).where(inArray(s.platformCollectionUnfinished.collectionId, ids)).orderBy(s.platformCollectionUnfinished.ordinal).all(), r => r.collectionId)
  const titles = Map.groupBy(db.select().from(targetSchema.platformQueryTitleScope).where(inArray(targetSchema.platformQueryTitleScope.collectionId, ids)).all(), r => r.collectionId)
  return new Map(collections.map(collection => [collection.id, readDifferenceCollectionScope(db, collection.id, { collection,
    conditions: conditions.get(collection.id) ?? [], pages: pages.get(collection.id) ?? [], unfinished: unfinished.get(collection.id) ?? [], titles: (titles.get(collection.id) ?? []).map(t => t.rdjb),
  })]))
}
/** The collection selector shares current ownership, but leaves title/page admission to callers. */
export function selectDifferenceCollections(db: Db, enterpriseId: number, options: { titleCode?: string; rdjb?: string; queryIds?: readonly number[]; queryKeys?: string[]; normalizeIdentity?: boolean; limit?: number; confirmedAliases?: boolean } = {}) {
  identityFunctions(db)
  const enterprise = db.select().from(s.enterprise).where(eq(s.enterprise.id, enterpriseId)).get()
  if (!enterprise) return []
  const aliases = options.confirmedAliases ? db.select({ name: s.enterpriseAlias.nameNorm }).from(s.enterpriseAlias).where(and(eq(s.enterpriseAlias.enterpriseId, enterpriseId), eq(s.enterpriseAlias.verificationStatus, 'confirmed'))).all() : []
  const related = db.select({ id: o.collectionId }).from(o).innerJoin(a, currentDifferenceAssignment(db)).where(eq(a.enterpriseId, enterpriseId))
  const matched = sql<number>`${exists(db.select({ id: o.id }).from(o).innerJoin(a, currentDifferenceAssignment(db)).where(and(eq(o.collectionId, c.id), eq(a.enterpriseId, enterpriseId))))}`
  return db.select({ ...collectionColumns, matched }).from(c).innerJoin(qa, eq(qa.collectionId, c.id))
    .where(and(options.queryIds ? inArray(qa.oldId, [...options.queryIds]) : or(
      inArray(c.queryKey, options.queryKeys ?? [enterprise.usccNorm ?? '', `name:${enterprise.nameNorm}`, ...aliases.map(a => `name:${a.name}`)]),
      options.normalizeIdentity && enterprise.usccNorm ? and(sql`instr(${c.queryKey},':')=0`, eq(identityUsccSql(sql`${c.queryKey}`), normalizeUscc(enterprise.usccNorm))) : undefined,
      inArray(c.id, related)),
      options.titleCode ? or(eq(c.interface, 'apply_list'), eq(c.titleCode, options.titleCode), sql`instr(','||${c.rdjb}||',',${',' + options.rdjb + ','})>0`, and(eq(c.rdjb, ''), sql`${c.titleCode} is null`)) : undefined))
    .orderBy(desc(c.queriedAt), desc(qa.oldId)).limit(options.limit ?? 2147483647).all()
}
