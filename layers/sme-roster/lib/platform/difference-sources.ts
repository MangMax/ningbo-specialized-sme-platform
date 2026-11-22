/** Request-local structured source reads for the difference workflow.
 * Candidate membership is deliberately broader than decision evidence admission. */
import { and, asc, desc, eq, exists, inArray, max, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as s from '../../../../db/schema'
import { targetSchema } from './target-schema'
import { identityFunctions, identityUsccSql } from '../roster/enterprise-read-snapshot'
import { normalizeUscc } from '../domain'
import { projectDifferenceCollectionScope, type DifferenceCollectionScopeRows } from './difference-collection-scope'

export { projectDifferenceCollectionScope, type DifferenceCollectionScopeRows } from './difference-collection-scope'

type Db = BetterSQLite3Database<typeof s>
const c = s.platformCollection, qa = s.platformLegacyQueryAlias
const { platformBusinessObservation: o, platformObservationAssignment: a, platformLegacyRelationAlias: ra } = targetSchema
const original = alias(a, 'difference_original'), newer = alias(a, 'difference_newer')
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
export interface DifferenceCollectionTarget {
  enterpriseId: number
  titleCode: string
  rdjb: string
  queryKeys: readonly string[]
  uscc: string | null
}
/** Request/chunk-local selection. Rank before hydrating collection scope metadata;
 * ownership is the latest assignment, exactly as in the single selector. */
export function selectDifferenceCollectionsBatch(db: Db, inputs: readonly DifferenceCollectionTarget[], normalizeIdentity: boolean) {
  identityFunctions(db)
  if (!inputs.length) return []
  const targets = db.$with('coverage_targets').as(db.select({
    slot: sql<number>`cast(key as integer)`.as('slot'),
    enterpriseId: sql<number>`json_extract(value,'$.enterpriseId')`.as('enterprise_id'),
    titleCode: sql<string>`json_extract(value,'$.titleCode')`.as('title_code'),
    rdjb: sql<string>`json_extract(value,'$.rdjb')`.as('rdjb'),
    queryKeys: sql<string>`json_extract(value,'$.queryKeys')`.as('query_keys'),
    uscc: sql<string | null>`json_extract(value,'$.uscc')`.as('uscc'),
  }).from(sql`json_each(${JSON.stringify(inputs)})`))
  // Drizzle SQL.Aliased CTE fields render bare aliases; qualify them explicitly
  // when joined to tables that also own enterprise_id/title_code/rdjb columns.
  const targetRef = {
    slot: sql<number>`"coverage_targets"."slot"`,
    enterpriseId: sql<number>`"coverage_targets"."enterprise_id"`,
    titleCode: sql<string>`"coverage_targets"."title_code"`,
    rdjb: sql<string>`"coverage_targets"."rdjb"`,
    queryKeys: sql<string>`"coverage_targets"."query_keys"`,
    uscc: sql<string | null>`"coverage_targets"."uscc"`,
  }
  const candidateRef = { slot: sql<number>`"coverage_candidates"."slot"`, collectionId: sql<number>`"coverage_candidates"."collection_id"`, id: sql<number>`"coverage_candidates"."query_id"` }
  const rankedRef = { slot: sql<number>`"coverage_ranked"."slot"`, collectionId: sql<number>`"coverage_ranked"."collection_id"`, id: sql<number>`"coverage_ranked"."query_id"`, matched: sql<number>`"coverage_ranked"."matched"`, rank: sql<number>`"coverage_ranked"."rank"` }
  const candidateColumns = { slot: targetRef.slot.as('slot'), collectionId: sql<number>`${c.id}`.as('collection_id'), id: sql<number>`${qa.oldId}`.as('query_id') }
  const keyed = db.select(candidateColumns).from(targets)
    .innerJoin(c, sql`${c.queryKey} in (select value from json_each(${targetRef.queryKeys}))`)
    .innerJoin(qa, eq(qa.collectionId, c.id))
  const related = db.select(candidateColumns).from(targets).innerJoin(a, eq(a.enterpriseId, targetRef.enterpriseId))
    .innerJoin(o, currentDifferenceAssignment(db)).innerJoin(c, eq(c.id, o.collectionId)).innerJoin(qa, eq(qa.collectionId, c.id))
  const distinctKeys = db.selectDistinct({ key: c.queryKey }).from(c).where(sql`instr(${c.queryKey},':')=0`)
  // SQLite's MATERIALIZED fence is not exposed by Drizzle's $with builder.
  // Keep this narrow SQL bridge: normalize each distinct original key once,
  // before target joins or repeated retries can multiply UDF evaluations.
  const normalizedKeys = db.$with('coverage_normalized_keys', {}).as(sql`
    with raw_keys as materialized (${distinctKeys.getSQL()}), normalized_keys as materialized (
      select query_key,${identityUsccSql(sql`query_key`)} as normalized_key from raw_keys
    ) select query_key,normalized_key from normalized_keys`)
  const normalized = db.select(candidateColumns).from(targets).innerJoin(normalizedKeys,
    and(sql`${targetRef.uscc} is not null`, eq(sql`"coverage_normalized_keys"."normalized_key"`, targetRef.uscc)))
    .innerJoin(c, eq(c.queryKey, sql`"coverage_normalized_keys"."query_key"`))
    .innerJoin(qa, eq(qa.collectionId, c.id))
  // UNION deduplicates collections observed more than once and overlapping keys.
  // Keep indexed key and ownership branches apart instead of a target×archive OR.
  const candidates = db.$with('coverage_candidates').as(normalizeIdentity ? keyed.union(related).union(normalized) : keyed.union(related))
  const owned = db.select({ id: o.id }).from(o).innerJoin(a, currentDifferenceAssignment(db))
    .where(and(eq(o.collectionId, c.id), eq(a.enterpriseId, targetRef.enterpriseId)))
  const ranked = db.$with('coverage_ranked').as(db.select({
    slot: targetRef.slot.as('slot'), collectionId: sql<number>`${c.id}`.as('collection_id'),
    id: sql<number>`${qa.oldId}`.as('query_id'),
    matched: sql<number>`${exists(owned)}`.as('matched'),
    rank: sql<number>`row_number() over (partition by ${targetRef.slot} order by ${c.queriedAt} desc,${qa.oldId} desc)`.as('rank'),
  }).from(candidates).innerJoin(targets, eq(targetRef.slot, candidateRef.slot)).innerJoin(c, eq(c.id, candidateRef.collectionId))
    .innerJoin(qa, eq(qa.oldId, candidateRef.id)).where(
    or(eq(c.interface, 'apply_list'), eq(c.titleCode, targetRef.titleCode),
      sql`instr(','||${c.rdjb}||',',','||${targetRef.rdjb}||',')>0`, and(eq(c.rdjb, ''), sql`${c.titleCode} is null`)),
  ))
  return db.with(targets, ...(normalizeIdentity ? [normalizedKeys] : []), candidates, ranked).select({ slot: rankedRef.slot, collection: c, id: rankedRef.id, matched: rankedRef.matched })
    .from(ranked).innerJoin(c, eq(c.id, rankedRef.collectionId)).where(sql`${rankedRef.rank}<=51`)
    .orderBy(asc(rankedRef.slot), asc(rankedRef.rank)).all()
}
export function readDifferenceCollectionScope(db: Db, collectionId: number, loaded?: DifferenceCollectionScopeRows) {
  const collection = loaded?.collection ?? db.select().from(c).where(eq(c.id, collectionId)).get()
  if (!collection) throw new Error('Difference collection not found')
  const pages = loaded?.pages ?? db.select().from(s.platformCollectionPage).where(eq(s.platformCollectionPage.collectionId, collectionId)).orderBy(s.platformCollectionPage.ordinal).all()
  const unfinished = loaded?.unfinished ?? db.select().from(s.platformCollectionUnfinished).where(eq(s.platformCollectionUnfinished.collectionId, collectionId)).orderBy(s.platformCollectionUnfinished.ordinal).all()
  const titles = loaded?.titles ?? db.select({ rdjb: targetSchema.platformQueryTitleScope.rdjb }).from(targetSchema.platformQueryTitleScope).where(eq(targetSchema.platformQueryTitleScope.collectionId, collectionId)).all().map(r => r.rdjb)
  const conditions = loaded?.conditions ?? db.select().from(s.platformCollectionCondition).where(eq(s.platformCollectionCondition.collectionId, collectionId)).all()
  return projectDifferenceCollectionScope({ collection, conditions, pages, unfinished, titles })
}

function prepareScopeQueries(db:Db) {
  const ids=sql`(select value from json_each(${sql.placeholder('ids')}))`
  return {
    conditions:db.select().from(s.platformCollectionCondition).where(sql`${s.platformCollectionCondition.collectionId} in ${ids}`).prepare(),
    pages:db.select().from(s.platformCollectionPage).where(sql`${s.platformCollectionPage.collectionId} in ${ids}`).orderBy(s.platformCollectionPage.ordinal).prepare(),
    unfinished:db.select().from(s.platformCollectionUnfinished).where(sql`${s.platformCollectionUnfinished.collectionId} in ${ids}`).orderBy(s.platformCollectionUnfinished.ordinal).prepare(),
    titles:db.select().from(targetSchema.platformQueryTitleScope).where(sql`${targetSchema.platformQueryTitleScope.collectionId} in ${ids}`).prepare(),
  }
}
const scopeQueries=new WeakMap<Db,ReturnType<typeof prepareScopeQueries>>()
/** One page-local batch. Compiled statements are reused; rows are always fresh. */
export function readDifferenceCollectionScopes(db: Db, collections: (typeof c.$inferSelect)[]) {
  const ids = [...new Set(collections.map(c => c.id))]
  if (!ids.length) return new Map<number, ReturnType<typeof readDifferenceCollectionScope>>()
  let queries=scopeQueries.get(db)
  if(!queries){queries=prepareScopeQueries(db);scopeQueries.set(db,queries)}
  const input={ids:JSON.stringify(ids)}
  const conditions = Map.groupBy(queries.conditions.all(input), r => r.collectionId)
  const pages = Map.groupBy(queries.pages.all(input), r => r.collectionId)
  const unfinished = Map.groupBy(queries.unfinished.all(input), r => r.collectionId)
  const titles = Map.groupBy(queries.titles.all(input), r => r.collectionId)
  return new Map(collections.map(collection => [collection.id, readDifferenceCollectionScope(db, collection.id, { collection,
    conditions: conditions.get(collection.id) ?? [], pages: pages.get(collection.id) ?? [], unfinished: unfinished.get(collection.id) ?? [], titles: (titles.get(collection.id) ?? []).map(t => t.rdjb),
  })]))
}
/** The collection selector shares current ownership, but leaves title/page admission to callers. */
function prepareCollectionSelector(db:Db,flags:{queryIds:boolean;normalize:boolean;title:boolean}) {
  const enterpriseId=sql.placeholder('enterpriseId')
  const related=db.select({id:o.collectionId}).from(o).innerJoin(a,currentDifferenceAssignment(db)).where(eq(a.enterpriseId,enterpriseId))
  const matched=sql<number>`${exists(db.select({id:o.id}).from(o).innerJoin(a,currentDifferenceAssignment(db)).where(and(eq(o.collectionId,c.id),eq(a.enterpriseId,enterpriseId))))}`
  return db.select({...collectionColumns,matched}).from(c).innerJoin(qa,eq(qa.collectionId,c.id)).where(and(
    flags.queryIds?sql`${qa.oldId} in (select value from json_each(${sql.placeholder('queryIds')}))`:or(
      sql`${c.queryKey} in (select value from json_each(${sql.placeholder('queryKeys')}))`,
      flags.normalize?and(sql`${sql.placeholder('uscc')} is not null`,sql`instr(${c.queryKey},':')=0`,eq(identityUsccSql(sql`${c.queryKey}`),sql.placeholder('uscc'))):undefined,
      inArray(c.id,related)),
    flags.title?or(eq(c.interface,'apply_list'),eq(c.titleCode,sql.placeholder('titleCode')),sql`instr(','||${c.rdjb}||',',${sql.placeholder('rdjb')})>0`,and(eq(c.rdjb,''),sql`${c.titleCode} is null`)):undefined,
  )).orderBy(desc(c.queriedAt),desc(qa.oldId)).limit(sql.placeholder('limit')).prepare()
}
function prepareCollectionInputs(db:Db) {
  return {
    enterprise:db.select().from(s.enterprise).where(eq(s.enterprise.id,sql.placeholder('enterpriseId'))).prepare(),
    aliases:db.select({name:s.enterpriseAlias.nameNorm}).from(s.enterpriseAlias).where(and(eq(s.enterpriseAlias.enterpriseId,sql.placeholder('enterpriseId')),eq(s.enterpriseAlias.verificationStatus,'confirmed'))).prepare(),
    selectors:new Map<string,ReturnType<typeof prepareCollectionSelector>>(),
  }
}
const collectionInputs=new WeakMap<Db,ReturnType<typeof prepareCollectionInputs>>()
export function selectDifferenceCollections(db: Db, enterpriseId: number, options: { titleCode?: string; rdjb?: string; queryIds?: readonly number[]; queryKeys?: string[]; normalizeIdentity?: boolean; limit?: number; confirmedAliases?: boolean } = {}) {
  identityFunctions(db)
  let input=collectionInputs.get(db)
  if(!input){input=prepareCollectionInputs(db);collectionInputs.set(db,input)}
  const enterprise = input.enterprise.get({enterpriseId})
  if (!enterprise) return []
  const aliases = options.confirmedAliases ? input.aliases.all({enterpriseId}) : []
  const flags={queryIds:options.queryIds!==undefined,normalize:!!options.normalizeIdentity,title:!!options.titleCode},key=JSON.stringify(flags)
  let selector=input.selectors.get(key)
  if(!selector){selector=prepareCollectionSelector(db,flags);input.selectors.set(key,selector)}
  return selector.all({enterpriseId,limit:options.limit??2147483647,
    ...(flags.queryIds?{queryIds:JSON.stringify(options.queryIds)}:{queryKeys:JSON.stringify(options.queryKeys??[enterprise.usccNorm??'',`name:${enterprise.nameNorm}`,...aliases.map(a=>`name:${a.name}`)]),...(flags.normalize?{uscc:enterprise.usccNorm?normalizeUscc(enterprise.usccNorm):null}:{})}),
    ...(flags.title?{titleCode:options.titleCode,rdjb:','+options.rdjb+','}:{}),
  })
}
